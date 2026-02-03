export interface AdditionalMount {
  hostPath: string;      // Absolute path on host (supports ~ for home)
  containerPath: string; // Path inside container (under /workspace/extra/)
  readonly?: boolean;    // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number;  // Default: 300000 (5 minutes)
  env?: Record<string, string>;
}

// ============== Telegram Types ==============

/**
 * Session key for topic-based sessions
 * Each chat+topic combination gets its own isolated session
 */
export interface SessionKey {
  chatId: number;
  topicId: number;  // 0 for non-forum chats or General topic
}

export function sessionKeyToString(key: SessionKey): string {
  return `${key.chatId}_${key.topicId}`;
}

export function stringToSessionKey(str: string): SessionKey {
  const [chatId, topicId] = str.split('_').map(Number);
  return { chatId, topicId: topicId || 0 };
}

/**
 * Trigger configuration for a chat or topic
 */
export interface TriggerConfig {
  mode: 'always' | 'mention' | 'disabled';
  mentionPattern?: string;  // Custom pattern (default: bot username)
}

/**
 * Registered chat configuration (stored in JSON)
 */
export interface RegisteredChat {
  chatId: number;
  chatType: 'private' | 'group' | 'supergroup' | 'channel';
  chatTitle: string;
  defaultTrigger: TriggerConfig;
  addedAt: string;
  addedBy?: number;  // User ID who registered
  containerConfig?: ContainerConfig;
}

/**
 * Topic within a supergroup (stored in SQLite)
 */
export interface RegisteredTopic {
  chatId: number;
  topicId: number;
  topicName: string;
  folder: string;  // Session folder name
  triggerMode: 'always' | 'mention' | 'disabled';
  lastMessageTime?: string;
}

/**
 * Session mapping (group folder to session ID)
 */
export interface Session {
  [key: string]: string;  // key is sessionKeyToString format: "chatId_topicId"
}

/**
 * Message from database
 */
export interface StoredMessage {
  id: string;
  chatId: number;
  topicId: number;
  senderId: number;
  senderName: string;
  content: string;
  type: 'text' | 'reaction' | 'agent_response';
  timestamp: string;
  isBot: boolean;
  replyToMessageId?: number;
  // Reaction-specific fields
  reactionEmoji?: string;
  reactionAction?: 'added' | 'removed';
  targetMessageId?: number;
  // Agent response fields
  agentSessionId?: string;
}

/**
 * New message for processing (simplified view)
 */
export interface NewMessage {
  id: string;
  chatId: number;
  topicId: number;
  senderId: number;
  senderName: string;
  content: string;
  timestamp: string;
}

/**
 * Scheduled task with topic support
 */
export interface ScheduledTask {
  id: string;
  chatId: number;
  topicId: number;
  folder: string;  // Session folder
  prompt: string;
  scheduleType: 'cron' | 'interval' | 'once';
  scheduleValue: string;
  contextMode: 'group' | 'isolated';
  nextRun: string | null;
  lastRun: string | null;
  lastResult: string | null;
  status: 'active' | 'paused' | 'completed';
  createdAt: string;
}

export interface TaskRunLog {
  taskId: string;
  runAt: string;
  durationMs: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

/**
 * Chat info from database
 */
export interface ChatInfo {
  chatId: number;
  chatType: string;
  chatTitle: string;
  lastMessageTime: string;
}

/**
 * Topic info from database
 */
export interface TopicInfo {
  chatId: number;
  topicId: number;
  topicName: string;
  folder: string;
  triggerMode: string;
  lastMessageTime: string | null;
}
