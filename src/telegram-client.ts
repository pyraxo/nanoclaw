/**
 * Telegram client using grammY
 * Handles bot setup, message receiving, and reactions
 */

import { Bot, Context, Api, RawApi } from 'grammy';
import { Message, ReactionType } from 'grammy/types';
import { BOT_TOKEN, ASSISTANT_NAME } from './config.js';
import { SessionKey, TriggerConfig } from './types.js';
import {
  storeMessage,
  upsertChat,
  getMessage
} from './db.js';
import {
  isChatRegistered,
  getRegisteredChat,
  getSessionFolder,
  isMainFolder
} from './session-manager.js';
import { botLogger as logger } from './logger.js';

export type MessageHandler = (
  sessionKey: SessionKey,
  folder: string,
  content: string,
  senderName: string,
  messageId: number,
  replyToMessageId?: number
) => Promise<void>;

export type ReactionHandler = (
  sessionKey: SessionKey,
  folder: string,
  emoji: string,
  action: 'added' | 'removed',
  targetMessageId: number,
  reactorName: string
) => Promise<void>;

let bot: Bot<Context>;
let messageHandler: MessageHandler | null = null;
let reactionHandler: ReactionHandler | null = null;

// Debounce configuration
const DEBOUNCE_MS = 2000;

interface BufferedMessage {
  sessionKey: SessionKey;
  folder: string;
  content: string;
  senderName: string;
  messageId: number;
  replyToMessageId?: number;
  timestamp: number;
}

// Buffer per session key (chatId_topicId)
const messageBuffers = new Map<string, BufferedMessage[]>();
const debounceTimers = new Map<string, NodeJS.Timeout>();

function getBufferKey(sessionKey: SessionKey): string {
  return `${sessionKey.chatId}_${sessionKey.topicId}`;
}

/**
 * Flush buffered messages for a session and trigger the handler
 */
async function flushMessageBuffer(bufferKey: string): Promise<void> {
  const messages = messageBuffers.get(bufferKey);
  if (!messages || messages.length === 0 || !messageHandler) return;

  // Clear the buffer
  messageBuffers.delete(bufferKey);
  debounceTimers.delete(bufferKey);

  // Sort by timestamp to maintain order
  messages.sort((a, b) => a.timestamp - b.timestamp);

  // Combine messages from multiple senders
  const combined = messages.map(m => {
    const prefix = messages.length > 1 ? `[${m.senderName}]: ` : '';
    return prefix + m.content;
  }).join('\n');

  // Use first message's metadata for the batch
  const first = messages[0];
  const last = messages[messages.length - 1];

  logger.info({
    bufferKey,
    messageCount: messages.length,
    senders: [...new Set(messages.map(m => m.senderName))]
  }, 'Flushing message buffer');

  await messageHandler(
    first.sessionKey,
    first.folder,
    combined,
    messages.length === 1 ? first.senderName : 'Multiple users',
    last.messageId,  // Use last message ID for reply context
    first.replyToMessageId
  );
}

/**
 * Add a message to the buffer and reset the debounce timer
 */
function bufferMessage(msg: BufferedMessage): void {
  const bufferKey = getBufferKey(msg.sessionKey);

  // Add to buffer
  const buffer = messageBuffers.get(bufferKey) || [];
  buffer.push(msg);
  messageBuffers.set(bufferKey, buffer);

  // Clear existing timer
  const existingTimer = debounceTimers.get(bufferKey);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  // Set new timer
  const timer = setTimeout(() => {
    flushMessageBuffer(bufferKey).catch(err => {
      logger.error({ err, bufferKey }, 'Error flushing message buffer');
    });
  }, DEBOUNCE_MS);

  debounceTimers.set(bufferKey, timer);

  logger.debug({
    bufferKey,
    bufferSize: buffer.length,
    senderName: msg.senderName
  }, 'Message buffered');
}

/**
 * Initialize the Telegram bot
 */
export function initTelegramBot(): Bot<Context> {
  if (!BOT_TOKEN) {
    throw new Error('BOT_TOKEN environment variable is required');
  }

  bot = new Bot(BOT_TOKEN);

  // Handle text messages
  bot.on('message:text', handleTextMessage);

  // Handle reactions
  bot.on('message_reaction', handleReaction);

  // Handle new chat members (bot added to group)
  bot.on('my_chat_member', async (ctx) => {
    const chat = ctx.chat;
    const newStatus = ctx.myChatMember.new_chat_member.status;

    if (newStatus === 'member' || newStatus === 'administrator') {
      logger.info({ chatId: chat.id, chatType: chat.type }, 'Bot added to chat');
      // Store chat info
      const title = ('title' in chat && chat.title) ? chat.title : `Private ${chat.id}`;
      upsertChat(chat.id, chat.type, title);
    }
  });

  // Error handling
  bot.catch((err) => {
    logger.error({ err }, 'Telegram bot error');
  });

  return bot;
}

/**
 * Start the bot (long polling)
 */
export async function startBot(): Promise<void> {
  logger.info('Starting Telegram bot...');
  await bot.start({
    onStart: (info) => {
      logger.info({ username: info.username }, 'Bot started');
    }
  });
}

/**
 * Stop the bot gracefully
 */
export async function stopBot(): Promise<void> {
  // Flush any pending message buffers before stopping
  logger.info('Flushing message buffers before shutdown...');
  for (const [bufferKey, timer] of debounceTimers) {
    clearTimeout(timer);
    await flushMessageBuffer(bufferKey);
  }
  await bot.stop();
}

/**
 * Get the bot API for sending messages
 */
export function getBotApi(): Api<RawApi> {
  return bot.api;
}

/**
 * Set the message handler (called when a triggering message is received)
 */
export function setMessageHandler(handler: MessageHandler): void {
  messageHandler = handler;
}

/**
 * Set the reaction handler (called when a reaction is added/removed)
 */
export function setReactionHandler(handler: ReactionHandler): void {
  reactionHandler = handler;
}

/**
 * Handle incoming text messages
 */
async function handleTextMessage(ctx: Context): Promise<void> {
  const message = ctx.message;
  if (!message || !message.text) return;

  const chatId = message.chat.id;
  const topicId = message.message_thread_id || 0;
  const sessionKey: SessionKey = { chatId, topicId };

  // Get sender info early for logging
  const sender = message.from;
  const senderName = sender
    ? (sender.first_name + (sender.last_name ? ` ${sender.last_name}` : ''))
    : 'Unknown';

  // Check if chat is registered
  if (!isChatRegistered(chatId)) {
    logger.debug({ chatId, chatType: message.chat.type, senderName }, 'Message from unregistered chat');
    return; // Ignore messages from unregistered chats
  }

  const registeredChat = getRegisteredChat(chatId);
  if (!registeredChat) return;

  // Get chat and topic info
  const chatTitle = ('title' in message.chat && message.chat.title) ? message.chat.title : `Private ${chatId}`;
  const topicName = getTopicName(message);

  // Update chat info
  upsertChat(chatId, message.chat.type, chatTitle);

  // Get or create session folder (unique per chat/topic)
  const folder = getSessionFolder(sessionKey, chatTitle, topicName);

  // Get remaining sender info
  const senderId = sender?.id || 0;
  const isBot = sender?.is_bot || false;

  // Store the message
  storeMessage(
    message.message_id.toString(),
    chatId,
    topicId,
    senderId,
    senderName,
    message.text,
    'text',
    isBot,
    message.reply_to_message?.message_id
  );

  // Check if we should trigger the agent
  const shouldTrigger = checkTrigger(
    message.text,
    registeredChat.defaultTrigger,
    folder
  );

  if (shouldTrigger && messageHandler) {
    // Strip the trigger word if it's a mention trigger
    const content = stripTrigger(message.text, registeredChat.defaultTrigger);

    // Buffer the message for debounced processing
    bufferMessage({
      sessionKey,
      folder,
      content,
      senderName,
      messageId: message.message_id,
      replyToMessageId: message.reply_to_message?.message_id,
      timestamp: message.date * 1000  // Telegram uses seconds
    });
  }
}

/**
 * Handle reaction updates
 */
async function handleReaction(ctx: Context): Promise<void> {
  const update = ctx.messageReaction;
  if (!update) return;

  const chatId = update.chat.id;
  const topicId = (update as { message_thread_id?: number }).message_thread_id || 0;
  const sessionKey: SessionKey = { chatId, topicId };

  // Check if chat is registered
  if (!isChatRegistered(chatId)) return;

  const registeredChat = getRegisteredChat(chatId);
  if (!registeredChat) return;

  // Get chat info and session folder
  const chatTitle = ('title' in update.chat && update.chat.title) ? update.chat.title : `Private ${chatId}`;
  const folder = getSessionFolder(sessionKey, chatTitle, `topic-${topicId}`);

  // Get reactor info
  const reactor = update.user;
  const reactorName = reactor
    ? (reactor.first_name + (reactor.last_name ? ` ${reactor.last_name}` : ''))
    : 'Unknown';
  const reactorId = reactor?.id || 0;

  // Process new reactions
  const newReactions = update.new_reaction || [];
  const oldReactions = update.old_reaction || [];

  // Find added reactions
  for (const reaction of newReactions) {
    if (!oldReactions.some(r => reactionsEqual(r, reaction))) {
      const emoji = getReactionEmoji(reaction);
      if (emoji) {
        // Store the reaction
        storeMessage(
          `reaction_${update.message_id}_${reactorId}_${Date.now()}`,
          chatId,
          topicId,
          reactorId,
          reactorName,
          emoji,
          'reaction',
          false,
          undefined,
          emoji,
          'added',
          update.message_id
        );

        // Check if the reaction is to a bot message and trigger is 'always'
        if (reactionHandler) {
          const targetMessage = getMessage(chatId, topicId, update.message_id.toString());
          if (targetMessage?.isBot || registeredChat.defaultTrigger.mode === 'always') {
            await reactionHandler(
              sessionKey,
              folder,
              emoji,
              'added',
              update.message_id,
              reactorName
            );
          }
        }
      }
    }
  }

  // Find removed reactions
  for (const reaction of oldReactions) {
    if (!newReactions.some(r => reactionsEqual(r, reaction))) {
      const emoji = getReactionEmoji(reaction);
      if (emoji) {
        // Store the reaction removal
        storeMessage(
          `reaction_${update.message_id}_${reactorId}_${Date.now()}`,
          chatId,
          topicId,
          reactorId,
          reactorName,
          emoji,
          'reaction',
          false,
          undefined,
          emoji,
          'removed',
          update.message_id
        );
      }
    }
  }
}

/**
 * Send a text message to a chat/topic
 */
export async function sendMessage(
  chatId: number,
  topicId: number,
  text: string,
  replyToMessageId?: number
): Promise<Message.TextMessage> {
  const options: Parameters<typeof bot.api.sendMessage>[2] = {};

  if (topicId !== 0) {
    options.message_thread_id = topicId;
  }

  if (replyToMessageId) {
    options.reply_parameters = { message_id: replyToMessageId };
  }

  const message = await bot.api.sendMessage(chatId, text, options);

  // Store the bot's message
  const botInfo = await bot.api.getMe();
  storeMessage(
    message.message_id.toString(),
    chatId,
    topicId,
    botInfo.id,
    botInfo.first_name,
    text,
    'agent_response',
    true
  );

  return message;
}

/**
 * React to a message
 */
export async function reactToMessage(
  chatId: number,
  messageId: number,
  emoji: string
): Promise<void> {
  // Cast to ReactionTypeEmoji - Telegram only accepts specific emojis
  // If the emoji is not supported, the API will reject it
  await bot.api.setMessageReaction(chatId, messageId, [
    { type: 'emoji', emoji } as { type: 'emoji'; emoji: string }
  ] as Parameters<typeof bot.api.setMessageReaction>[2]);
}

/**
 * Get topic name from message
 */
function getTopicName(message: Message): string {
  // If it's a forum topic, try to get the topic name
  if (message.is_topic_message && message.reply_to_message?.forum_topic_created) {
    return message.reply_to_message.forum_topic_created.name;
  }

  // Otherwise use a default based on topic ID
  const topicId = message.message_thread_id || 0;
  if (topicId === 0) {
    return 'General';
  }

  return `Topic ${topicId}`;
}

/**
 * Check if message should trigger the agent
 */
function checkTrigger(text: string, trigger: TriggerConfig, folder: string): boolean {
  // Main folder always triggers (admin channel)
  if (isMainFolder(folder)) {
    return true;
  }

  switch (trigger.mode) {
    case 'always':
      return true;
    case 'disabled':
      return false;
    case 'mention':
    default:
      // Check for @BotName or custom pattern
      const pattern = trigger.mentionPattern || `@${ASSISTANT_NAME}`;
      return text.toLowerCase().includes(pattern.toLowerCase());
  }
}

/**
 * Strip trigger word from message text
 */
function stripTrigger(text: string, trigger: TriggerConfig): string {
  if (trigger.mode !== 'mention') {
    return text;
  }

  const pattern = trigger.mentionPattern || `@${ASSISTANT_NAME}`;
  const regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return text.replace(regex, '').trim();
}

/**
 * Get emoji string from reaction type
 */
function getReactionEmoji(reaction: ReactionType): string | null {
  if (reaction.type === 'emoji') {
    return reaction.emoji;
  }
  if (reaction.type === 'custom_emoji') {
    return reaction.custom_emoji_id;
  }
  return null;
}

/**
 * Check if two reactions are equal
 */
function reactionsEqual(a: ReactionType, b: ReactionType): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'emoji' && b.type === 'emoji') {
    return a.emoji === b.emoji;
  }
  if (a.type === 'custom_emoji' && b.type === 'custom_emoji') {
    return a.custom_emoji_id === b.custom_emoji_id;
  }
  return false;
}
