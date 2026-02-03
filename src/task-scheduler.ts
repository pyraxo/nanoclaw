import fs from 'fs';
import path from 'path';
import pino from 'pino';
import { CronExpressionParser } from 'cron-parser';
import { getDueTasks, updateTaskAfterRun, logTaskRun, getTaskById, getAllTasks, getTopic } from './db.js';
import { ScheduledTask, RegisteredChat, sessionKeyToString } from './types.js';
import { GROUPS_DIR, SCHEDULER_POLL_INTERVAL, MAIN_FOLDER, TIMEZONE } from './config.js';
import { containerPool, writeTasksSnapshot } from './container-pool.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

export interface SchedulerDependencies {
  sendMessage: (chatId: number, topicId: number, text: string) => Promise<unknown>;
  getRegisteredChat: (chatId: number) => RegisteredChat | undefined;
  getSessions: () => Record<string, string>;
}

async function runTask(task: ScheduledTask, deps: SchedulerDependencies): Promise<void> {
  const startTime = Date.now();
  const groupDir = path.join(GROUPS_DIR, task.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info({ taskId: task.id, folder: task.folder }, 'Running scheduled task');

  const registeredChat = deps.getRegisteredChat(task.chatId);
  const topic = getTopic(task.chatId, task.topicId);

  if (!registeredChat) {
    logger.error({ taskId: task.id, chatId: task.chatId }, 'Chat not registered for task');
    logTaskRun({
      taskId: task.id,
      runAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Chat not registered: ${task.chatId}`
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by folder)
  const isMain = task.folder === MAIN_FOLDER;
  const tasks = getAllTasks();
  writeTasksSnapshot(task.folder, isMain, tasks.map(t => ({
    id: t.id,
    folder: t.folder,
    prompt: t.prompt,
    scheduleType: t.scheduleType,
    scheduleValue: t.scheduleValue,
    status: t.status,
    nextRun: t.nextRun
  })));

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId = task.contextMode === 'group' ? sessions[task.folder] : undefined;
  const sessionKey = sessionKeyToString({ chatId: task.chatId, topicId: task.topicId });
  const chatTitle = registeredChat.chatTitle;
  const topicName = topic?.topicName || 'General';

  try {
    const output = await containerPool.runContainer(
      task.folder,
      `${chatTitle} - ${topicName}`,
      {
        prompt: task.prompt,
        sessionId,
        folder: task.folder,
        sessionKey,
        isMain,
        isScheduledTask: true,
        chatType: registeredChat.chatType
      },
      registeredChat.containerConfig
    );

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else {
      result = output.result;
    }

    logger.info({ taskId: task.id, durationMs: Date.now() - startTime }, 'Task completed');
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    taskId: task.id,
    runAt: new Date().toISOString(),
    durationMs,
    status: error ? 'error' : 'success',
    result,
    error
  });

  let nextRun: string | null = null;
  if (task.scheduleType === 'cron') {
    const interval = CronExpressionParser.parse(task.scheduleValue, { tz: TIMEZONE });
    nextRun = interval.next().toISOString();
  } else if (task.scheduleType === 'interval') {
    const ms = parseInt(task.scheduleValue, 10);
    nextRun = new Date(Date.now() + ms).toISOString();
  }
  // 'once' tasks have no next run

  const resultSummary = error ? `Error: ${error}` : (result ? result.slice(0, 200) : 'Completed');
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        await runTask(currentTask, deps);
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}
