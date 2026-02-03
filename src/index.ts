import 'dotenv/config';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  MAIN_FOLDER,
  IPC_POLL_INTERVAL,
  TIMEZONE
} from './config.js';
import { SessionKey, sessionKeyToString, RegisteredChat } from './types.js';
import {
  initDatabase,
  getAllTasks,
  getTaskById,
  createTask,
  updateTask,
  deleteTask,
  getMessagesSince
} from './db.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { containerPool, writeTasksSnapshot, writeChatsSnapshot, AvailableChat } from './container-pool.js';
import {
  initSessionManager,
  loadRegisteredChats,
  getRegisteredChat,
  getAllRegisteredChats,
  registerChat,
  isChatRegistered,
  getSessionFolder,
  isMainFolder
} from './session-manager.js';
import {
  initTelegramBot,
  startBot,
  setMessageHandler,
  setReactionHandler,
  sendMessage as telegramSendMessage,
  reactToMessage
} from './telegram-client.js';
import { loadJson, saveJson } from './utils.js';
import { logger } from './logger.js';

// Sessions map folder -> Claude session ID
let sessions: Record<string, string> = {};
// Track last agent response timestamp per session for context windowing
let lastAgentTimestamp: Record<string, string> = {};

function loadState(): void {
  const statePath = path.join(DATA_DIR, 'router_state.json');
  const state = loadJson<{ last_agent_timestamp?: Record<string, string> }>(statePath, {});
  lastAgentTimestamp = state.last_agent_timestamp || {};
  sessions = loadJson(path.join(DATA_DIR, 'sessions.json'), {});
  logger.info('State loaded');
}

function saveState(): void {
  saveJson(path.join(DATA_DIR, 'router_state.json'), { last_agent_timestamp: lastAgentTimestamp });
  saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
}

/**
 * Get available chats list for the agent.
 */
function getAvailableChats(): AvailableChat[] {
  const registeredChats = getAllRegisteredChats();
  const registeredIds = new Set(registeredChats.map(c => c.chatId));

  return registeredChats.map(c => ({
    chatId: c.chatId,
    chatTitle: c.chatTitle,
    chatType: c.chatType,
    lastActivity: c.addedAt,
    isRegistered: registeredIds.has(c.chatId)
  }));
}

/**
 * Handle incoming messages that should trigger the agent
 */
async function handleMessage(
  sessionKey: SessionKey,
  folder: string,
  content: string,
  senderName: string,
  messageId: number,
  replyToMessageId?: number
): Promise<void> {
  const isMain = isMainFolder(folder);
  const registeredChat = getRegisteredChat(sessionKey.chatId);

  if (!registeredChat) {
    logger.warn({ chatId: sessionKey.chatId }, 'Message from unregistered chat');
    return;
  }

  // Get all messages since last agent interaction for context
  const sinceTimestamp = lastAgentTimestamp[folder] || '';
  const missedMessages = getMessagesSince(sessionKey.chatId, sessionKey.topicId, sinceTimestamp, ASSISTANT_NAME);

  const lines = missedMessages.map(m => {
    const escapeXml = (s: string) => s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    return `<message sender="${escapeXml(m.senderName)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`;
  });
  const prompt = `<messages>\n${lines.join('\n')}\n</messages>`;

  if (!prompt) return;

  logger.info({ folder, messageCount: missedMessages.length }, 'Processing message');

  const response = await runAgent(folder, registeredChat, sessionKey, prompt);

  if (response) {
    lastAgentTimestamp[folder] = new Date().toISOString();
    saveState();
    await telegramSendMessage(sessionKey.chatId, sessionKey.topicId, `${ASSISTANT_NAME}: ${response}`, messageId);
  }
}

/**
 * Handle reactions (when agent should respond to reactions)
 */
async function handleReaction(
  sessionKey: SessionKey,
  folder: string,
  emoji: string,
  action: 'added' | 'removed',
  targetMessageId: number,
  reactorName: string
): Promise<void> {
  const registeredChat = getRegisteredChat(sessionKey.chatId);
  if (!registeredChat) return;

  // Only respond to added reactions, not removed ones
  if (action !== 'added') return;

  const prompt = `<reaction>
<reactor>${reactorName}</reactor>
<emoji>${emoji}</emoji>
<target_message_id>${targetMessageId}</target_message_id>
</reaction>

The user reacted to a message. Consider if this requires a response.`;

  logger.info({ folder, emoji, reactor: reactorName }, 'Processing reaction');

  const response = await runAgent(folder, registeredChat, sessionKey, prompt);

  if (response) {
    lastAgentTimestamp[folder] = new Date().toISOString();
    saveState();
    await telegramSendMessage(sessionKey.chatId, sessionKey.topicId, `${ASSISTANT_NAME}: ${response}`);
  }
}

/**
 * Run the agent in a container
 */
async function runAgent(
  folder: string,
  registeredChat: RegisteredChat,
  sessionKey: SessionKey,
  prompt: string
): Promise<string | null> {
  const isMain = isMainFolder(folder);
  const sessionId = sessions[folder];
  const sessionKeyStr = sessionKeyToString(sessionKey);

  // Update tasks snapshot for container to read
  const tasks = getAllTasks();
  writeTasksSnapshot(folder, isMain, tasks.map(t => ({
    id: t.id,
    folder: t.folder,
    prompt: t.prompt,
    scheduleType: t.scheduleType,
    scheduleValue: t.scheduleValue,
    status: t.status,
    nextRun: t.nextRun
  })));

  // Update available chats snapshot (main only)
  const availableChats = getAvailableChats();
  const registeredIds = new Set(getAllRegisteredChats().map(c => c.chatId));
  writeChatsSnapshot(folder, isMain, availableChats, registeredIds);

  try {
    const output = await containerPool.runContainer(
      folder,
      registeredChat.chatTitle,
      {
        prompt,
        sessionId,
        folder,
        sessionKey: sessionKeyStr,
        isMain,
        chatType: registeredChat.chatType
      },
      registeredChat.containerConfig
    );

    if (output.newSessionId) {
      sessions[folder] = output.newSessionId;
      saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
    }

    if (output.status === 'error') {
      logger.error({ folder, error: output.error }, 'Container agent error');
      return null;
    }

    return output.result;
  } catch (err) {
    logger.error({ folder, err }, 'Agent error');
    return null;
  }
}

/**
 * Start the IPC watcher for container communication
 */
function startIpcWatcher(): void {
  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter(f => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    for (const sourceFolder of groupFolders) {
      const isMain = isMainFolder(sourceFolder);
      const messagesDir = path.join(ipcBaseDir, sourceFolder, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceFolder, 'tasks');

      // Process messages from this folder's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs.readdirSync(messagesDir).filter(f => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

              if (data.type === 'message' && data.chatId !== undefined && data.text) {
                const targetChat = getRegisteredChat(data.chatId);
                // Authorization check
                if (isMain || (targetChat && sourceFolder === MAIN_FOLDER)) {
                  const topicId = data.topicId || 0;
                  await telegramSendMessage(data.chatId, topicId, `${ASSISTANT_NAME}: ${data.text}`);
                  logger.info({ chatId: data.chatId, sourceFolder }, 'IPC message sent');
                } else {
                  logger.warn({ chatId: data.chatId, sourceFolder }, 'Unauthorized IPC message attempt blocked');
                }
              } else if (data.type === 'reaction' && data.chatId !== undefined && data.messageId && data.emoji) {
                // React to a message
                const targetChat = getRegisteredChat(data.chatId);
                if (isMain || targetChat) {
                  await reactToMessage(data.chatId, data.messageId, data.emoji);
                  logger.info({ chatId: data.chatId, messageId: data.messageId, emoji: data.emoji }, 'IPC reaction sent');
                } else {
                  logger.warn({ chatId: data.chatId, sourceFolder }, 'Unauthorized IPC reaction attempt blocked');
                }
              }

              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error({ file, sourceFolder, err }, 'Error processing IPC message');
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(filePath, path.join(errorDir, `${sourceFolder}-${file}`));
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceFolder }, 'Error reading IPC messages directory');
      }

      // Process tasks from this folder's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs.readdirSync(tasksDir).filter(f => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              await processTaskIpc(data, sourceFolder, isMain);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error({ file, sourceFolder, err }, 'Error processing IPC task');
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(filePath, path.join(errorDir, `${sourceFolder}-${file}`));
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceFolder }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started');
}

async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    scheduleType?: string;
    scheduleValue?: string;
    contextMode?: string;
    folder?: string;
    chatId?: number;
    topicId?: number;
    // For register_chat
    chatType?: string;
    chatTitle?: string;
    triggerMode?: string;
    containerConfig?: RegisteredChat['containerConfig'];
    // For service_control
    action?: string;
  },
  sourceFolder: string,
  isMain: boolean
): Promise<void> {
  const { CronExpressionParser } = await import('cron-parser');

  switch (data.type) {
    case 'schedule_task':
      if (data.prompt && data.scheduleType && data.scheduleValue && data.folder && data.chatId !== undefined) {
        const targetFolder = data.folder;
        if (!isMain && targetFolder !== sourceFolder) {
          logger.warn({ sourceFolder, targetFolder }, 'Unauthorized schedule_task attempt blocked');
          break;
        }

        const scheduleType = data.scheduleType as 'cron' | 'interval' | 'once';
        const topicId = data.topicId || 0;

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.scheduleValue, { tz: TIMEZONE });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn({ scheduleValue: data.scheduleValue }, 'Invalid cron expression');
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.scheduleValue, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn({ scheduleValue: data.scheduleValue }, 'Invalid interval');
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.scheduleValue);
          if (isNaN(scheduled.getTime())) {
            logger.warn({ scheduleValue: data.scheduleValue }, 'Invalid timestamp');
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode = (data.contextMode === 'group' || data.contextMode === 'isolated')
          ? data.contextMode
          : 'isolated';

        createTask({
          id: taskId,
          chatId: data.chatId,
          topicId,
          folder: targetFolder,
          prompt: data.prompt,
          scheduleType,
          scheduleValue: data.scheduleValue,
          contextMode,
          nextRun,
          status: 'active',
          createdAt: new Date().toISOString()
        });
        logger.info({ taskId, sourceFolder, targetFolder, contextMode }, 'Task created via IPC');
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.folder === sourceFolder)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info({ taskId: data.taskId, sourceFolder }, 'Task paused via IPC');
        } else {
          logger.warn({ taskId: data.taskId, sourceFolder }, 'Unauthorized task pause attempt');
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.folder === sourceFolder)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info({ taskId: data.taskId, sourceFolder }, 'Task resumed via IPC');
        } else {
          logger.warn({ taskId: data.taskId, sourceFolder }, 'Unauthorized task resume attempt');
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.folder === sourceFolder)) {
          deleteTask(data.taskId);
          logger.info({ taskId: data.taskId, sourceFolder }, 'Task cancelled via IPC');
        } else {
          logger.warn({ taskId: data.taskId, sourceFolder }, 'Unauthorized task cancel attempt');
        }
      }
      break;

    case 'register_chat':
      if (!isMain) {
        logger.warn({ sourceFolder }, 'Unauthorized register_chat attempt blocked');
        break;
      }
      if (data.chatId !== undefined && data.chatType && data.chatTitle) {
        const newChat: RegisteredChat = {
          chatId: data.chatId,
          chatType: data.chatType as RegisteredChat['chatType'],
          chatTitle: data.chatTitle,
          defaultTrigger: {
            mode: (data.triggerMode as 'always' | 'mention' | 'disabled') || 'mention'
          },
          addedAt: new Date().toISOString(),
          containerConfig: data.containerConfig
        };
        registerChat(newChat);
        logger.info({ chatId: data.chatId, chatTitle: data.chatTitle }, 'Chat registered via IPC');
      } else {
        logger.warn({ data }, 'Invalid register_chat request - missing required fields');
      }
      break;

    case 'service_control':
      // Only main folder can control the service
      if (!isMain) {
        logger.warn({ sourceFolder }, 'Unauthorized service control attempt blocked');
        break;
      }
      if (data.action === 'restart') {
        logger.info('Service restart requested via IPC - exiting (systemd will restart)');
        setTimeout(() => process.exit(0), 1000);
      } else if (data.action === 'rebuild') {
        logger.info('Rebuild and restart requested via IPC');
        setTimeout(() => {
          try {
            execSync('npm run build', { cwd: path.resolve(import.meta.dirname, '..'), stdio: 'inherit' });
            logger.info('Build complete - exiting (systemd will restart)');
            process.exit(0);
          } catch (err) {
            logger.error({ err }, 'Failed to rebuild');
          }
        }, 1000);
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

function ensureDockerRunning(): void {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 10000 });
    logger.debug('Docker daemon is running');
  } catch {
    logger.fatal(`
╔════════════════════════════════════════════════════════════════╗
║  FATAL: Docker is not running                                  ║
║                                                                ║
║  Agents cannot run without Docker. To fix:                     ║
║  Linux: sudo systemctl start docker                            ║
║  macOS: Start Docker Desktop                                   ║
║                                                                ║
║  Install from: https://docker.com/products/docker-desktop      ║
╚════════════════════════════════════════════════════════════════╝`);
    throw new Error('Docker is required but not running');
  }
}

async function main(): Promise<void> {
  ensureDockerRunning();
  initDatabase();
  logger.info('Database initialized');
  initSessionManager();
  logger.info('Session manager initialized');
  loadState();

  // Initialize container pool
  await containerPool.init();

  // Initialize Telegram bot
  initTelegramBot();
  setMessageHandler(handleMessage);
  setReactionHandler(handleReaction);

  // Start scheduler
  startSchedulerLoop({
    sendMessage: telegramSendMessage,
    getRegisteredChat,
    getSessions: () => sessions
  });

  // Start IPC watcher
  startIpcWatcher();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await containerPool.shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Start the bot
  logger.info(`Starting NanoClaw (trigger: @${ASSISTANT_NAME})`);
  await startBot();
}

main().catch(err => {
  logger.error({ err }, 'Failed to start NanoClaw');
  process.exit(1);
});
