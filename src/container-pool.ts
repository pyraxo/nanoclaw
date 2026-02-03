/**
 * Container Pool Manager for NanoClaw
 * Maintains warm containers to reduce cold start latency
 *
 * Architecture:
 * - Warm containers stay alive with stdin open
 * - Messages are sent as JSON lines through stdin
 * - Responses come back through stdout with markers
 * - Containers signal "READY" to stderr after each message
 */

import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import {
  CONTAINER_IMAGE,
  CONTAINER_TIMEOUT,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_WARM_TIMEOUT,
  GROUPS_DIR,
  DATA_DIR,
  MAIN_FOLDER,
  GLOBAL_FOLDER
} from './config.js';
import { RegisteredChat } from './types.js';
import { validateAdditionalMounts } from './mount-security.js';
import { logger } from './logger.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const READY_MARKER = '---NANOCLAW_READY---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  folder: string;
  sessionKey: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  chatType?: string;  // 'private' for DMs, 'group'/'supergroup' for groups
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

interface GroupConfig {
  folder: string;
  name: string;
  containerConfig?: RegisteredChat['containerConfig'];
  chatType?: string;
}

interface WarmContainer {
  id: string;
  folder: string;
  name: string;
  process: ChildProcess;
  lastActive: number;
  ready: boolean;
  processing: boolean;
  containerConfig?: RegisteredChat['containerConfig'];
  isMain: boolean;
  outputBuffer: string;
  resolveMessage: ((output: ContainerOutput) => void) | null;
}

class ContainerPool extends EventEmitter {
  private containers: Map<string, WarmContainer> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.startCleanupTimer();
  }

  /**
   * Run a container agent (warm if available, cold fallback)
   */
  async runContainer(
    folder: string,
    name: string,
    input: ContainerInput,
    containerConfig?: RegisteredChat['containerConfig']
  ): Promise<ContainerOutput> {
    // If warm containers are disabled, always use cold
    if (CONTAINER_WARM_TIMEOUT <= 0) {
      return this.runColdContainer(folder, name, input, containerConfig);
    }

    // Check for existing warm container
    const existing = this.containers.get(folder);
    if (existing && existing.ready && !existing.processing) {
      logger.info({ folder }, 'Using warm container');
      return this.sendToWarmContainer(existing, input, containerConfig?.timeout);
    }

    // If container exists but is processing, fall back to cold
    if (existing && existing.processing) {
      logger.info({ folder }, 'Container busy, using cold container');
      return this.runColdContainer(folder, name, input, containerConfig);
    }

    // Try to spawn warm container, fall back to cold on failure
    try {
      const warm = await this.spawnWarmContainer(folder, name, input.isMain, containerConfig, input.chatType);
      return this.sendToWarmContainer(warm, input, containerConfig?.timeout);
    } catch (err) {
      logger.warn({ folder, error: err }, 'Failed to spawn warm container, falling back to cold');
      return this.runColdContainer(folder, name, input, containerConfig);
    }
  }

  /**
   * Send a message to a warm container and wait for response
   */
  private sendToWarmContainer(
    container: WarmContainer,
    input: ContainerInput,
    timeout?: number
  ): Promise<ContainerOutput> {
    const startTime = Date.now();
    container.processing = true;
    container.lastActive = Date.now();
    container.outputBuffer = '';

    return new Promise((resolve) => {
      const timeoutMs = timeout || CONTAINER_TIMEOUT;
      let resolved = false;

      const cleanupAndResolve = (output: ContainerOutput) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeoutHandle);
        container.processing = false;
        container.lastActive = Date.now();
        container.resolveMessage = null;
        resolve(output);
      };

      const timeoutHandle = setTimeout(() => {
        logger.error({ folder: container.folder }, 'Container message timeout');
        // Kill the container on timeout
        container.process.kill('SIGTERM');
        this.containers.delete(container.folder);
        cleanupAndResolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${timeoutMs}ms`
        });
      }, timeoutMs);

      // Set up resolver for when we receive output
      container.resolveMessage = (output) => {
        const duration = Date.now() - startTime;
        logger.info({
          folder: container.folder,
          duration,
          status: output.status,
          warm: true
        }, 'Warm container completed');
        this.logContainerRun(container, input, container.outputBuffer, duration);
        cleanupAndResolve(output);
      };

      // Write input to stdin
      try {
        const inputJson = JSON.stringify(input) + '\n';
        container.process.stdin?.write(inputJson, (err) => {
          if (err) {
            logger.error({ folder: container.folder, error: err }, 'Error writing to container stdin');
            cleanupAndResolve({
              status: 'error',
              result: null,
              error: `Error writing to container: ${err.message}`
            });
          }
        });
        logger.debug({ folder: container.folder }, 'Input sent to warm container');
      } catch (err) {
        logger.error({ folder: container.folder, error: err }, 'Error writing to container stdin');
        cleanupAndResolve({
          status: 'error',
          result: null,
          error: `Error writing to container: ${err instanceof Error ? err.message : String(err)}`
        });
      }
    });
  }

  /**
   * Spawn a warm container that stays alive for multiple messages
   */
  private async spawnWarmContainer(
    folder: string,
    name: string,
    isMain: boolean,
    containerConfig?: RegisteredChat['containerConfig'],
    chatType?: string
  ): Promise<WarmContainer> {
    const groupDir = path.join(GROUPS_DIR, folder);
    fs.mkdirSync(groupDir, { recursive: true });

    const group: GroupConfig = { folder, name, containerConfig, chatType };
    const mounts = this.buildVolumeMounts(group, isMain);
    const containerArgs = this.buildContainerArgs(mounts, true);
    const containerId = `warm-${folder}-${Date.now()}`;

    logger.info({ folder, containerId }, 'Spawning warm container');

    const containerProcess = spawn('docker', containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const warmContainer: WarmContainer = {
      id: containerId,
      folder,
      name,
      process: containerProcess,
      lastActive: Date.now(),
      ready: false,
      processing: false,
      containerConfig,
      isMain,
      outputBuffer: '',
      resolveMessage: null
    };

    // Handle stdout - collect output and parse when complete
    containerProcess.stdout?.on('data', (data) => {
      const chunk = data.toString();
      warmContainer.outputBuffer += chunk;

      // Check if we have a complete response
      const startIdx = warmContainer.outputBuffer.indexOf(OUTPUT_START_MARKER);
      const endIdx = warmContainer.outputBuffer.indexOf(OUTPUT_END_MARKER);

      if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx && warmContainer.resolveMessage) {
        try {
          const jsonLine = warmContainer.outputBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          const output: ContainerOutput = JSON.parse(jsonLine);
          warmContainer.resolveMessage(output);
        } catch (err) {
          logger.error({ folder, output: warmContainer.outputBuffer.slice(-500) }, 'Failed to parse warm container output');
          warmContainer.resolveMessage({
            status: 'error',
            result: null,
            error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`
          });
        }
      }
    });

    // Handle stderr - log and check for READY signal
    containerProcess.stderr?.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');

      for (const line of lines) {
        if (line.includes(READY_MARKER)) {
          warmContainer.ready = true;
          warmContainer.outputBuffer = ''; // Clear buffer for next message
          logger.debug({ folder }, 'Warm container ready');
        } else if (line) {
          logger.debug({ container: folder }, line);
        }
      }
    });

    // Wait for initial READY signal
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        containerProcess.kill('SIGTERM');
        reject(new Error('Container failed to become ready within 30s'));
      }, 30000);

      const checkReady = () => {
        if (warmContainer.ready) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(checkReady, 100);
        }
      };
      checkReady();
    });

    // Handle container exit
    containerProcess.on('close', (code) => {
      logger.info({ folder, code }, 'Warm container exited');
      if (warmContainer.resolveMessage) {
        warmContainer.resolveMessage({
          status: 'error',
          result: null,
          error: `Container exited unexpectedly with code ${code}`
        });
      }
      this.containers.delete(folder);
    });

    containerProcess.on('error', (err) => {
      logger.error({ folder, error: err }, 'Warm container error');
      if (warmContainer.resolveMessage) {
        warmContainer.resolveMessage({
          status: 'error',
          result: null,
          error: `Container error: ${err.message}`
        });
      }
      this.containers.delete(folder);
    });

    this.containers.set(folder, warmContainer);
    return warmContainer;
  }

  /**
   * Run a message through a cold container (original behavior)
   */
  async runColdContainer(
    folder: string,
    name: string,
    input: ContainerInput,
    containerConfig?: RegisteredChat['containerConfig']
  ): Promise<ContainerOutput> {
    const startTime = Date.now();
    const isMain = input.isMain;

    const groupDir = path.join(GROUPS_DIR, folder);
    fs.mkdirSync(groupDir, { recursive: true });

    const group: GroupConfig = { folder, name, containerConfig, chatType: input.chatType };
    const mounts = this.buildVolumeMounts(group, isMain);
    const containerArgs = this.buildContainerArgs(mounts, false);

    logger.info({
      folder,
      mountCount: mounts.length,
      isMain,
      chatType: input.chatType
    }, 'Spawning cold container');

    return new Promise((resolve) => {
      const container = spawn('docker', containerArgs, {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      let stdoutTruncated = false;
      let stderrTruncated = false;

      setTimeout(() => {
        container.stdin.write(JSON.stringify(input));
        container.stdin.end();
      }, 100);

      container.stdout.on('data', (data) => {
        if (stdoutTruncated) return;
        const chunk = data.toString();
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn({ folder }, 'Container stdout truncated');
        } else {
          stdout += chunk;
        }
      });

      container.stderr.on('data', (data) => {
        const chunk = data.toString();
        const lines = chunk.trim().split('\n');
        for (const line of lines) {
          if (line) logger.debug({ container: folder }, line);
        }
        if (stderrTruncated) return;
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
        if (chunk.length > remaining) {
          stderr += chunk.slice(0, remaining);
          stderrTruncated = true;
        } else {
          stderr += chunk;
        }
      });

      const timeout = setTimeout(() => {
        logger.error({ folder }, 'Container timeout, killing');
        container.kill('SIGKILL');
        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${containerConfig?.timeout || CONTAINER_TIMEOUT}ms`
        });
      }, containerConfig?.timeout || CONTAINER_TIMEOUT);

      container.on('close', (code) => {
        clearTimeout(timeout);
        const duration = Date.now() - startTime;

        this.writeContainerLog(folder, name, input, isMain, mounts, containerArgs, stdout, stderr, duration, code, stdoutTruncated, stderrTruncated);

        if (code !== 0) {
          logger.error({ folder, code, duration, stderr: stderr.slice(-500) }, 'Container exited with error');
          resolve({
            status: 'error',
            result: null,
            error: `Container exited with code ${code}: ${stderr.slice(-200)}`
          });
          return;
        }

        try {
          const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
          const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

          let jsonLine: string;
          if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
            jsonLine = stdout.slice(startIdx + OUTPUT_START_MARKER.length, endIdx).trim();
          } else {
            const lines = stdout.trim().split('\n');
            jsonLine = lines[lines.length - 1];
          }

          const output: ContainerOutput = JSON.parse(jsonLine);
          logger.info({ folder, duration, status: output.status, warm: false }, 'Container completed');
          resolve(output);
        } catch (err) {
          logger.error({ folder, stdout: stdout.slice(-500), error: err }, 'Failed to parse container output');
          resolve({
            status: 'error',
            result: null,
            error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`
          });
        }
      });

      container.on('error', (err) => {
        clearTimeout(timeout);
        logger.error({ folder, error: err }, 'Container spawn error');
        resolve({
          status: 'error',
          result: null,
          error: `Container spawn error: ${err.message}`
        });
      });
    });
  }

  private buildVolumeMounts(group: GroupConfig, isMain: boolean): VolumeMount[] {
    const mounts: VolumeMount[] = [];
    const projectRoot = process.cwd();

    // Determine shared folder for CLAUDE.md based on chat type
    // DMs (private) use main/, groups use global/
    const sharedFolder = group.chatType === 'private' ? MAIN_FOLDER : GLOBAL_FOLDER;
    const sharedClaudeMd = path.join(GROUPS_DIR, sharedFolder, 'CLAUDE.md');

    if (isMain) {
      mounts.push({
        hostPath: projectRoot,
        containerPath: '/workspace/project',
        readonly: false
      });
      mounts.push({
        hostPath: path.join(GROUPS_DIR, group.folder),
        containerPath: '/workspace/group',
        readonly: false
      });
    } else {
      mounts.push({
        hostPath: path.join(GROUPS_DIR, group.folder),
        containerPath: '/workspace/group',
        readonly: false
      });

      // Mount shared CLAUDE.md into the group folder (read-only)
      // This provides shared instructions from main/ (DMs) or global/ (groups)
      if (fs.existsSync(sharedClaudeMd)) {
        mounts.push({
          hostPath: sharedClaudeMd,
          containerPath: '/workspace/group/CLAUDE.md',
          readonly: true
        });
      }

      const globalDir = path.join(GROUPS_DIR, 'global');
      if (fs.existsSync(globalDir)) {
        mounts.push({
          hostPath: globalDir,
          containerPath: '/workspace/global',
          readonly: true
        });
      }
    }

    const groupSessionsDir = path.join(DATA_DIR, 'sessions', group.folder, '.claude');
    fs.mkdirSync(groupSessionsDir, { recursive: true });
    mounts.push({
      hostPath: groupSessionsDir,
      containerPath: '/home/node/.claude',
      readonly: false
    });

    const groupIpcDir = path.join(DATA_DIR, 'ipc', group.folder);
    fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
    fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
    mounts.push({
      hostPath: groupIpcDir,
      containerPath: '/workspace/ipc',
      readonly: false
    });

    const envDir = path.join(DATA_DIR, 'env');
    fs.mkdirSync(envDir, { recursive: true });
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      const envContent = fs.readFileSync(envFile, 'utf-8');
      const allowedVars = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];
      const filteredLines = envContent
        .split('\n')
        .filter(line => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) return false;
          return allowedVars.some(v => trimmed.startsWith(`${v}=`));
        });

      if (filteredLines.length > 0) {
        fs.writeFileSync(path.join(envDir, 'env'), filteredLines.join('\n') + '\n');
        mounts.push({
          hostPath: envDir,
          containerPath: '/workspace/env-dir',
          readonly: true
        });
      }
    }

    if (group.containerConfig?.additionalMounts) {
      const validatedMounts = validateAdditionalMounts(
        group.containerConfig.additionalMounts,
        group.name,
        isMain
      );
      mounts.push(...validatedMounts);
    }

    return mounts;
  }

  private buildContainerArgs(mounts: VolumeMount[], warm: boolean): string[] {
    const args: string[] = ['run', '-i'];

    if (!warm) {
      args.push('--rm');
    } else {
      // For warm containers, add --name so we can track them
      args.push('--rm'); // Still auto-remove on exit
    }

    for (const mount of mounts) {
      if (mount.readonly) {
        args.push('-v', `${mount.hostPath}:${mount.containerPath}:ro`);
      } else {
        args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
      }
    }

    if (warm) {
      args.push('-e', 'WARM_MODE=true');
      args.push('-e', `IDLE_TIMEOUT=${Math.floor(CONTAINER_WARM_TIMEOUT / 1000)}`);
    }

    args.push(CONTAINER_IMAGE);

    return args;
  }

  private startCleanupTimer(): void {
    // Check every minute for idle containers
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [folder, container] of this.containers) {
        if (!container.processing && now - container.lastActive > CONTAINER_WARM_TIMEOUT) {
          logger.info({ folder }, 'Killing idle warm container');
          container.process.kill('SIGTERM');
          this.containers.delete(folder);
        }
      }
    }, 60000);
  }

  private logContainerRun(container: WarmContainer, input: ContainerInput, output: string, duration: number): void {
    const logsDir = path.join(GROUPS_DIR, container.folder, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logFile = path.join(logsDir, `container-${timestamp}.log`);
    const isVerbose = process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

    const logLines = [
      `=== Container Run Log (Warm) ===`,
      `Timestamp: ${new Date().toISOString()}`,
      `Container ID: ${container.id}`,
      `Folder: ${container.folder}`,
      `Name: ${container.name}`,
      `IsMain: ${container.isMain}`,
      `Duration: ${duration}ms`,
      ``
    ];

    if (isVerbose) {
      logLines.push(
        `=== Input ===`,
        JSON.stringify(input, null, 2),
        ``,
        `=== Output ===`,
        output
      );
    } else {
      logLines.push(
        `=== Input Summary ===`,
        `Prompt length: ${input.prompt.length} chars`,
        `Session ID: ${input.sessionId || 'new'}`,
        ``
      );
    }

    fs.writeFileSync(logFile, logLines.join('\n'));
    logger.debug({ logFile }, 'Container log written');
  }

  private writeContainerLog(
    folder: string,
    name: string,
    input: ContainerInput,
    isMain: boolean,
    mounts: VolumeMount[],
    containerArgs: string[],
    stdout: string,
    stderr: string,
    duration: number,
    code: number | null,
    stdoutTruncated: boolean,
    stderrTruncated: boolean
  ): void {
    const logsDir = path.join(GROUPS_DIR, folder, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logFile = path.join(logsDir, `container-${timestamp}.log`);
    const isVerbose = process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

    const logLines = [
      `=== Container Run Log ===`,
      `Timestamp: ${new Date().toISOString()}`,
      `Folder: ${folder}`,
      `Name: ${name}`,
      `IsMain: ${isMain}`,
      `Duration: ${duration}ms`,
      `Exit Code: ${code}`,
      `Stdout Truncated: ${stdoutTruncated}`,
      `Stderr Truncated: ${stderrTruncated}`,
      ``
    ];

    if (isVerbose) {
      logLines.push(
        `=== Input ===`,
        JSON.stringify(input, null, 2),
        ``,
        `=== Container Args ===`,
        containerArgs.join(' '),
        ``,
        `=== Mounts ===`,
        mounts.map(m => `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`).join('\n'),
        ``,
        `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
        stderr,
        ``,
        `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
        stdout
      );
    } else {
      logLines.push(
        `=== Input Summary ===`,
        `Prompt length: ${input.prompt.length} chars`,
        `Session ID: ${input.sessionId || 'new'}`,
        ``,
        `=== Mounts ===`,
        mounts.map(m => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`).join('\n'),
        ``
      );

      if (code !== 0) {
        logLines.push(
          `=== Stderr (last 500 chars) ===`,
          stderr.slice(-500),
          ``
        );
      }
    }

    fs.writeFileSync(logFile, logLines.join('\n'));
    logger.debug({ logFile }, 'Container log written');
  }

  /**
   * Initialize the pool (called on startup)
   */
  async init(): Promise<void> {
    logger.info({ warmTimeout: CONTAINER_WARM_TIMEOUT }, 'Container pool initialized');
  }

  /**
   * Shutdown all containers
   */
  async shutdown(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    for (const [folder, container] of this.containers) {
      logger.info({ folder }, 'Shutting down warm container');
      container.process.kill('SIGTERM');
    }

    this.containers.clear();
  }

  /**
   * Get pool statistics
   */
  getStats(): { warmContainers: number; folders: string[] } {
    return {
      warmContainers: this.containers.size,
      folders: Array.from(this.containers.keys())
    };
  }
}

export const containerPool = new ContainerPool();

// Re-export types and helpers from container-runner for compatibility
export { writeTasksSnapshot, writeChatsSnapshot, type AvailableChat } from './container-runner.js';
