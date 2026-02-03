/**
 * Database module using libsql (SQLite fork with vector search support)
 * Provides storage for messages, chats, topics, and scheduled tasks
 */

import Database from 'libsql';
import fs from 'fs';
import path from 'path';
import {
  NewMessage,
  ScheduledTask,
  TaskRunLog,
  ChatInfo,
  TopicInfo,
  StoredMessage
} from './types.js';
import { STORE_DIR } from './config.js';

let db: Database.Database;

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);

  // Create tables
  db.exec(`
    -- Chats (Telegram chats/groups)
    CREATE TABLE IF NOT EXISTS chats (
      chat_id INTEGER PRIMARY KEY,
      chat_type TEXT,
      chat_title TEXT,
      last_message_time TEXT
    );

    -- Topics within supergroups
    CREATE TABLE IF NOT EXISTS topics (
      chat_id INTEGER NOT NULL,
      topic_id INTEGER NOT NULL,
      topic_name TEXT,
      folder TEXT NOT NULL,
      trigger_mode TEXT DEFAULT 'mention',
      last_message_time TEXT,
      PRIMARY KEY (chat_id, topic_id)
    );
    CREATE INDEX IF NOT EXISTS idx_topics_folder ON topics(folder);

    -- Messages with topic support
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT NOT NULL,
      chat_id INTEGER NOT NULL,
      topic_id INTEGER DEFAULT 0,
      sender_id INTEGER,
      sender_name TEXT,
      content TEXT,
      type TEXT DEFAULT 'text',
      timestamp TEXT,
      is_bot INTEGER DEFAULT 0,
      reply_to_message_id INTEGER,
      reaction_emoji TEXT,
      reaction_action TEXT,
      target_message_id INTEGER,
      agent_session_id TEXT,
      PRIMARY KEY (chat_id, topic_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(chat_id, topic_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(type);

    -- Scheduled tasks with topic support
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      chat_id INTEGER NOT NULL,
      topic_id INTEGER DEFAULT 0,
      folder TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      context_mode TEXT DEFAULT 'isolated',
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON scheduled_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_folder ON scheduled_tasks(folder);

    -- Task run logs
    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    -- Metadata sync tracking
    CREATE TABLE IF NOT EXISTS sync_metadata (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT
    );
  `);
}

// ============== Chat Operations ==============

export function upsertChat(chatId: number, chatType: string, chatTitle: string, timestamp?: string): void {
  const ts = timestamp || new Date().toISOString();
  db.prepare(`
    INSERT INTO chats (chat_id, chat_type, chat_title, last_message_time) VALUES (?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      chat_type = excluded.chat_type,
      chat_title = excluded.chat_title,
      last_message_time = MAX(last_message_time, excluded.last_message_time)
  `).run(chatId, chatType, chatTitle, ts);
}

export function updateChatTitle(chatId: number, chatTitle: string): void {
  db.prepare(`UPDATE chats SET chat_title = ? WHERE chat_id = ?`).run(chatTitle, chatId);
}

export function getChat(chatId: number): ChatInfo | undefined {
  const row = db.prepare(`
    SELECT chat_id, chat_type, chat_title, last_message_time FROM chats WHERE chat_id = ?
  `).get(chatId) as { chat_id: number; chat_type: string; chat_title: string; last_message_time: string } | undefined;

  if (!row) return undefined;
  return {
    chatId: row.chat_id,
    chatType: row.chat_type,
    chatTitle: row.chat_title,
    lastMessageTime: row.last_message_time
  };
}

export function getAllChats(): ChatInfo[] {
  const rows = db.prepare(`
    SELECT chat_id, chat_type, chat_title, last_message_time
    FROM chats
    ORDER BY last_message_time DESC
  `).all() as { chat_id: number; chat_type: string; chat_title: string; last_message_time: string }[];

  return rows.map(row => ({
    chatId: row.chat_id,
    chatType: row.chat_type,
    chatTitle: row.chat_title,
    lastMessageTime: row.last_message_time
  }));
}

// ============== Topic Operations ==============

export function upsertTopic(
  chatId: number,
  topicId: number,
  topicName: string,
  folder: string,
  triggerMode: string = 'mention'
): void {
  db.prepare(`
    INSERT INTO topics (chat_id, topic_id, topic_name, folder, trigger_mode, last_message_time)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id, topic_id) DO UPDATE SET
      topic_name = excluded.topic_name,
      folder = excluded.folder,
      trigger_mode = COALESCE(excluded.trigger_mode, trigger_mode)
  `).run(chatId, topicId, topicName, folder, triggerMode, new Date().toISOString());
}

export function getTopic(chatId: number, topicId: number): TopicInfo | undefined {
  const row = db.prepare(`
    SELECT chat_id, topic_id, topic_name, folder, trigger_mode, last_message_time
    FROM topics WHERE chat_id = ? AND topic_id = ?
  `).get(chatId, topicId) as { chat_id: number; topic_id: number; topic_name: string; folder: string; trigger_mode: string; last_message_time: string | null } | undefined;

  if (!row) return undefined;
  return {
    chatId: row.chat_id,
    topicId: row.topic_id,
    topicName: row.topic_name,
    folder: row.folder,
    triggerMode: row.trigger_mode,
    lastMessageTime: row.last_message_time
  };
}

export function getTopicByFolder(folder: string): TopicInfo | undefined {
  const row = db.prepare(`
    SELECT chat_id, topic_id, topic_name, folder, trigger_mode, last_message_time
    FROM topics WHERE folder = ?
  `).get(folder) as { chat_id: number; topic_id: number; topic_name: string; folder: string; trigger_mode: string; last_message_time: string | null } | undefined;

  if (!row) return undefined;
  return {
    chatId: row.chat_id,
    topicId: row.topic_id,
    topicName: row.topic_name,
    folder: row.folder,
    triggerMode: row.trigger_mode,
    lastMessageTime: row.last_message_time
  };
}

export function getTopicsForChat(chatId: number): TopicInfo[] {
  const rows = db.prepare(`
    SELECT chat_id, topic_id, topic_name, folder, trigger_mode, last_message_time
    FROM topics WHERE chat_id = ? ORDER BY topic_name
  `).all(chatId) as { chat_id: number; topic_id: number; topic_name: string; folder: string; trigger_mode: string; last_message_time: string | null }[];

  return rows.map(row => ({
    chatId: row.chat_id,
    topicId: row.topic_id,
    topicName: row.topic_name,
    folder: row.folder,
    triggerMode: row.trigger_mode,
    lastMessageTime: row.last_message_time
  }));
}

export function getAllTopics(): TopicInfo[] {
  const rows = db.prepare(`
    SELECT chat_id, topic_id, topic_name, folder, trigger_mode, last_message_time
    FROM topics ORDER BY last_message_time DESC
  `).all() as { chat_id: number; topic_id: number; topic_name: string; folder: string; trigger_mode: string; last_message_time: string | null }[];

  return rows.map(row => ({
    chatId: row.chat_id,
    topicId: row.topic_id,
    topicName: row.topic_name,
    folder: row.folder,
    triggerMode: row.trigger_mode,
    lastMessageTime: row.last_message_time
  }));
}

export function updateTopicTriggerMode(chatId: number, topicId: number, triggerMode: string): void {
  db.prepare(`UPDATE topics SET trigger_mode = ? WHERE chat_id = ? AND topic_id = ?`)
    .run(triggerMode, chatId, topicId);
}

export function updateTopicTimestamp(chatId: number, topicId: number): void {
  db.prepare(`UPDATE topics SET last_message_time = ? WHERE chat_id = ? AND topic_id = ?`)
    .run(new Date().toISOString(), chatId, topicId);
}

// ============== Message Operations ==============

export function storeMessage(
  id: string,
  chatId: number,
  topicId: number,
  senderId: number,
  senderName: string,
  content: string,
  type: string = 'text',
  isBot: boolean = false,
  replyToMessageId?: number,
  reactionEmoji?: string,
  reactionAction?: string,
  targetMessageId?: number,
  agentSessionId?: string
): void {
  const timestamp = new Date().toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO messages
    (id, chat_id, topic_id, sender_id, sender_name, content, type, timestamp, is_bot,
     reply_to_message_id, reaction_emoji, reaction_action, target_message_id, agent_session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, chatId, topicId, senderId, senderName, content, type, timestamp, isBot ? 1 : 0,
    replyToMessageId ?? null, reactionEmoji ?? null, reactionAction ?? null,
    targetMessageId ?? null, agentSessionId ?? null
  );

  // Update topic timestamp
  updateTopicTimestamp(chatId, topicId);
}

export function getMessage(chatId: number, topicId: number, messageId: string): StoredMessage | undefined {
  const row = db.prepare(`
    SELECT * FROM messages WHERE chat_id = ? AND topic_id = ? AND id = ?
  `).get(chatId, topicId, messageId) as Record<string, unknown> | undefined;

  if (!row) return undefined;
  return rowToStoredMessage(row);
}

export function getMessagesSince(
  chatId: number,
  topicId: number,
  sinceTimestamp: string,
  botName: string
): NewMessage[] {
  const rows = db.prepare(`
    SELECT id, chat_id, topic_id, sender_id, sender_name, content, timestamp
    FROM messages
    WHERE chat_id = ? AND topic_id = ? AND timestamp > ?
      AND type = 'text' AND content NOT LIKE ?
    ORDER BY timestamp
  `).all(chatId, topicId, sinceTimestamp, `${botName}:%`) as { id: string; chat_id: number; topic_id: number; sender_id: number; sender_name: string; content: string; timestamp: string }[];

  return rows.map(row => ({
    id: row.id,
    chatId: row.chat_id,
    topicId: row.topic_id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    content: row.content,
    timestamp: row.timestamp
  }));
}

export function getNewMessages(
  folders: string[],
  lastTimestamp: string,
  botName: string
): { messages: NewMessage[]; newTimestamp: string } {
  if (folders.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  // Get chat_id/topic_id pairs for the given folders
  const placeholders = folders.map(() => '?').join(',');
  const topicRows = db.prepare(`
    SELECT chat_id, topic_id FROM topics WHERE folder IN (${placeholders})
  `).all(...folders) as { chat_id: number; topic_id: number }[];

  if (topicRows.length === 0) {
    return { messages: [], newTimestamp: lastTimestamp };
  }

  // Build query for all relevant chat/topic pairs
  const conditions = topicRows.map(() => '(chat_id = ? AND topic_id = ?)').join(' OR ');
  const args: (string | number)[] = [lastTimestamp];
  for (const row of topicRows) {
    args.push(row.chat_id, row.topic_id);
  }
  args.push(`${botName}:%`);

  const rows = db.prepare(`
    SELECT id, chat_id, topic_id, sender_id, sender_name, content, timestamp
    FROM messages
    WHERE timestamp > ? AND (${conditions}) AND type = 'text' AND content NOT LIKE ?
    ORDER BY timestamp
  `).all(...args) as { id: string; chat_id: number; topic_id: number; sender_id: number; sender_name: string; content: string; timestamp: string }[];

  let newTimestamp = lastTimestamp;
  const messages = rows.map(row => {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
    return {
      id: row.id,
      chatId: row.chat_id,
      topicId: row.topic_id,
      senderId: row.sender_id,
      senderName: row.sender_name,
      content: row.content,
      timestamp: row.timestamp
    };
  });

  return { messages, newTimestamp };
}

function rowToStoredMessage(row: Record<string, unknown>): StoredMessage {
  return {
    id: row.id as string,
    chatId: row.chat_id as number,
    topicId: row.topic_id as number,
    senderId: row.sender_id as number,
    senderName: row.sender_name as string,
    content: row.content as string,
    type: row.type as 'text' | 'reaction' | 'agent_response',
    timestamp: row.timestamp as string,
    isBot: (row.is_bot as number) === 1,
    replyToMessageId: row.reply_to_message_id as number | undefined,
    reactionEmoji: row.reaction_emoji as string | undefined,
    reactionAction: row.reaction_action as 'added' | 'removed' | undefined,
    targetMessageId: row.target_message_id as number | undefined,
    agentSessionId: row.agent_session_id as string | undefined
  };
}

// ============== Task Operations ==============

export function createTask(task: Omit<ScheduledTask, 'lastRun' | 'lastResult'>): void {
  db.prepare(`
    INSERT INTO scheduled_tasks
    (id, chat_id, topic_id, folder, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.id,
    task.chatId,
    task.topicId,
    task.folder,
    task.prompt,
    task.scheduleType,
    task.scheduleValue,
    task.contextMode || 'isolated',
    task.nextRun,
    task.status,
    task.createdAt
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  const row = db.prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return rowToTask(row);
}

export function getTasksForFolder(folder: string): ScheduledTask[] {
  const rows = db.prepare(`
    SELECT * FROM scheduled_tasks WHERE folder = ? ORDER BY created_at DESC
  `).all(folder) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

export function getAllTasks(): ScheduledTask[] {
  const rows = db.prepare(`SELECT * FROM scheduled_tasks ORDER BY created_at DESC`).all() as Record<string, unknown>[];
  return rows.map(rowToTask);
}

export function updateTask(id: string, updates: Partial<Pick<ScheduledTask, 'prompt' | 'scheduleType' | 'scheduleValue' | 'nextRun' | 'status'>>): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) { fields.push('prompt = ?'); values.push(updates.prompt); }
  if (updates.scheduleType !== undefined) { fields.push('schedule_type = ?'); values.push(updates.scheduleType); }
  if (updates.scheduleValue !== undefined) { fields.push('schedule_value = ?'); values.push(updates.scheduleValue); }
  if (updates.nextRun !== undefined) { fields.push('next_run = ?'); values.push(updates.nextRun); }
  if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(`UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteTask(id: string): void {
  db.prepare(`DELETE FROM task_run_logs WHERE task_id = ?`).run(id);
  db.prepare(`DELETE FROM scheduled_tasks WHERE id = ?`).run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  const rows = db.prepare(`
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `).all(now) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

export function updateTaskAfterRun(id: string, nextRun: string | null, lastResult: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?,
        status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(`
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(log.taskId, log.runAt, log.durationMs, log.status, log.result, log.error);
}

export function getTaskRunLogs(taskId: string, limit = 10): TaskRunLog[] {
  const rows = db.prepare(`
    SELECT task_id, run_at, duration_ms, status, result, error
    FROM task_run_logs WHERE task_id = ?
    ORDER BY run_at DESC LIMIT ?
  `).all(taskId, limit) as { task_id: string; run_at: string; duration_ms: number; status: string; result: string | null; error: string | null }[];

  return rows.map(row => ({
    taskId: row.task_id,
    runAt: row.run_at,
    durationMs: row.duration_ms,
    status: row.status as 'success' | 'error',
    result: row.result,
    error: row.error
  }));
}

function rowToTask(row: Record<string, unknown>): ScheduledTask {
  return {
    id: row.id as string,
    chatId: row.chat_id as number,
    topicId: row.topic_id as number,
    folder: row.folder as string,
    prompt: row.prompt as string,
    scheduleType: row.schedule_type as 'cron' | 'interval' | 'once',
    scheduleValue: row.schedule_value as string,
    contextMode: (row.context_mode as 'group' | 'isolated') || 'isolated',
    nextRun: row.next_run as string | null,
    lastRun: row.last_run as string | null,
    lastResult: row.last_result as string | null,
    status: row.status as 'active' | 'paused' | 'completed',
    createdAt: row.created_at as string
  };
}

// ============== Sync Metadata ==============

export function getSyncMetadata(key: string): string | null {
  const row = db.prepare(`SELECT value FROM sync_metadata WHERE key = ?`).get(key) as { value: string } | undefined;
  if (!row) return null;
  return row.value;
}

export function setSyncMetadata(key: string, value: string): void {
  db.prepare(`INSERT OR REPLACE INTO sync_metadata (key, value, updated_at) VALUES (?, ?, ?)`)
    .run(key, value, new Date().toISOString());
}
