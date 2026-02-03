/**
 * Session Manager - Maps Telegram chat/topic pairs to session folders
 * Each topic gets its own isolated folder with CLAUDE.md and logs
 */

import fs from 'fs';
import path from 'path';
import { SessionKey, sessionKeyToString, RegisteredChat } from './types.js';
import { GROUPS_DIR, DATA_DIR, MAIN_FOLDER, GLOBAL_FOLDER, slugify } from './config.js';
import { getTopic, upsertTopic, getTopicByFolder } from './db.js';

// Cache of registered chats
let registeredChats: Map<number, RegisteredChat> = new Map();
const REGISTERED_CHATS_PATH = path.join(DATA_DIR, 'registered_chats.json');

/**
 * Load registered chats from JSON file
 */
export function loadRegisteredChats(): void {
  registeredChats.clear();

  if (fs.existsSync(REGISTERED_CHATS_PATH)) {
    const data = JSON.parse(fs.readFileSync(REGISTERED_CHATS_PATH, 'utf-8'));
    for (const chat of data) {
      registeredChats.set(chat.chatId, chat);
    }
  }
}

/**
 * Save registered chats to JSON file
 */
function saveRegisteredChats(): void {
  fs.mkdirSync(path.dirname(REGISTERED_CHATS_PATH), { recursive: true });
  fs.writeFileSync(
    REGISTERED_CHATS_PATH,
    JSON.stringify(Array.from(registeredChats.values()), null, 2)
  );
}

/**
 * Check if a chat is registered
 */
export function isChatRegistered(chatId: number): boolean {
  return registeredChats.has(chatId);
}

/**
 * Get registered chat configuration
 */
export function getRegisteredChat(chatId: number): RegisteredChat | undefined {
  return registeredChats.get(chatId);
}

/**
 * Get all registered chats
 */
export function getAllRegisteredChats(): RegisteredChat[] {
  return Array.from(registeredChats.values());
}

/**
 * Register a new chat
 */
export function registerChat(chat: RegisteredChat): void {
  registeredChats.set(chat.chatId, chat);
  saveRegisteredChats();
}

/**
 * Update a registered chat
 */
export function updateRegisteredChat(chatId: number, updates: Partial<RegisteredChat>): void {
  const existing = registeredChats.get(chatId);
  if (existing) {
    registeredChats.set(chatId, { ...existing, ...updates });
    saveRegisteredChats();
  }
}

/**
 * Unregister a chat
 */
export function unregisterChat(chatId: number): void {
  registeredChats.delete(chatId);
  saveRegisteredChats();
}

/**
 * Get shared folder based on chat type (for CLAUDE.md instructions)
 * DMs → main/, groups → global/
 */
export function getSharedFolder(chatType: string): string {
  return chatType === 'private' ? MAIN_FOLDER : GLOBAL_FOLDER;
}

/**
 * Get session folder for a chat/topic pair
 * Creates unique folder per chat/topic for isolation
 */
export function getSessionFolder(key: SessionKey, chatTitle: string, topicName: string): string {
  // Check if topic already has a folder assigned
  const existing = getTopic(key.chatId, key.topicId);
  if (existing) {
    ensureFolderExists(existing.folder);
    return existing.folder;
  }

  // Generate a unique folder name
  const folder = generateFolderName(chatTitle, topicName, key);

  // Create the topic entry in database
  upsertTopic(key.chatId, key.topicId, topicName, folder);

  // Ensure the folder exists
  ensureFolderExists(folder);

  return folder;
}

/**
 * Generate a unique folder name for a chat/topic
 */
function generateFolderName(chatTitle: string, topicName: string, key: SessionKey): string {
  const chatSlug = slugify(chatTitle);
  const topicSlug = key.topicId === 0 ? '' : slugify(topicName);

  let baseName = topicSlug ? `${chatSlug}-${topicSlug}` : chatSlug;
  if (!baseName) {
    baseName = `chat-${key.chatId}`;
  }

  // Check if this folder already exists (used by another topic)
  let folder = baseName;
  let counter = 1;
  while (getTopicByFolder(folder)) {
    folder = `${baseName}-${counter}`;
    counter++;
  }

  return folder;
}


/**
 * Ensure a session folder exists with required subdirectories
 * Note: CLAUDE.md is NOT created here - it's mounted from the shared folder
 */
function ensureFolderExists(folder: string): void {
  const folderPath = path.join(GROUPS_DIR, folder);

  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });

    // Create logs directory
    const logsPath = path.join(folderPath, 'logs');
    fs.mkdirSync(logsPath, { recursive: true });
  }
}

/**
 * Get the full path to a session folder
 */
export function getSessionFolderPath(folder: string): string {
  return path.join(GROUPS_DIR, folder);
}

/**
 * Check if a folder is the main admin folder
 */
export function isMainFolder(folder: string): boolean {
  return folder === MAIN_FOLDER;
}

/**
 * Get session key string from folder name (for IPC)
 */
export function getSessionKeyFromFolder(folder: string): string | null {
  const topic = getTopicByFolder(folder);
  if (!topic) return null;
  return sessionKeyToString({ chatId: topic.chatId, topicId: topic.topicId });
}

/**
 * Get folder from session key string
 */
export function getFolderFromSessionKey(sessionKeyStr: string): string | null {
  const [chatIdStr, topicIdStr] = sessionKeyStr.split('_');
  const chatId = parseInt(chatIdStr, 10);
  const topicId = parseInt(topicIdStr || '0', 10);

  const topic = getTopic(chatId, topicId);
  return topic?.folder ?? null;
}

/**
 * Initialize session manager (call on startup)
 */
export function initSessionManager(): void {
  // Ensure groups directory exists
  fs.mkdirSync(GROUPS_DIR, { recursive: true });

  // Ensure main folder exists
  ensureFolderExists(MAIN_FOLDER);

  // Load registered chats
  loadRegisteredChats();
}
