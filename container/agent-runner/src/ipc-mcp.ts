/**
 * IPC-based MCP Server for NanoClaw
 * Writes messages and tasks to files for the host process to pick up
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

export interface IpcMcpContext {
  sessionKey: string;  // Format: chatId_topicId
  folder: string;
  isMain: boolean;
}

function parseSessionKey(sessionKey: string): { chatId: number; topicId: number } {
  const [chatIdStr, topicIdStr] = sessionKey.split('_');
  return {
    chatId: parseInt(chatIdStr, 10),
    topicId: parseInt(topicIdStr || '0', 10)
  };
}

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

export function createIpcMcp(ctx: IpcMcpContext) {
  const { sessionKey, folder, isMain } = ctx;
  const { chatId, topicId } = parseSessionKey(sessionKey);

  return createSdkMcpServer({
    name: 'nanoclaw',
    version: '1.0.0',
    tools: [
      tool(
        'send_message',
        'Send a message to the current Telegram chat/topic. Use this to proactively share information or updates.',
        {
          text: z.string().describe('The message text to send')
        },
        async (args) => {
          const data = {
            type: 'message',
            chatId,
            topicId,
            text: args.text,
            folder,
            timestamp: new Date().toISOString()
          };

          const filename = writeIpcFile(MESSAGES_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Message queued for delivery (${filename})`
            }]
          };
        }
      ),

      tool(
        'react_to_message',
        'React to a message with an emoji. Use standard Telegram reaction emojis.',
        {
          message_id: z.number().describe('The message ID to react to'),
          emoji: z.string().describe('The emoji to react with (e.g., "👍", "❤", "🔥", "👏", "😁")')
        },
        async (args) => {
          const data = {
            type: 'reaction',
            chatId,
            messageId: args.message_id,
            emoji: args.emoji,
            folder,
            timestamp: new Date().toISOString()
          };

          const filename = writeIpcFile(MESSAGES_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Reaction queued (${filename}): ${args.emoji} on message ${args.message_id}`
            }]
          };
        }
      ),

      tool(
        'schedule_task',
        `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
• "group" (recommended for most tasks): Task runs in the group's conversation context, with access to chat history and memory. Use for tasks that need context about ongoing discussions, user preferences, or previous interactions.
• "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, ask the user. Examples:
- "Remind me about our discussion" → group (needs conversation context)
- "Check the weather every morning" → isolated (self-contained task)
- "Follow up on my request" → group (needs to know what was requested)
- "Generate a daily report" → isolated (just needs instructions in prompt)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
• cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
• interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
• once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
        {
          prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
          schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
          schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
          context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
          target_folder: z.string().optional().describe('Target folder (main only, defaults to current folder)')
        },
        async (args) => {
          // Validate schedule_value before writing IPC
          if (args.schedule_type === 'cron') {
            try {
              CronExpressionParser.parse(args.schedule_value);
            } catch (err) {
              return {
                content: [{ type: 'text', text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
                isError: true
              };
            }
          } else if (args.schedule_type === 'interval') {
            const ms = parseInt(args.schedule_value, 10);
            if (isNaN(ms) || ms <= 0) {
              return {
                content: [{ type: 'text', text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
                isError: true
              };
            }
          } else if (args.schedule_type === 'once') {
            const date = new Date(args.schedule_value);
            if (isNaN(date.getTime())) {
              return {
                content: [{ type: 'text', text: `Invalid timestamp: "${args.schedule_value}". Use ISO 8601 format like "2026-02-01T15:30:00".` }],
                isError: true
              };
            }
          }

          // Non-main groups can only schedule for themselves
          const targetFolder = isMain && args.target_folder ? args.target_folder : folder;

          const data = {
            type: 'schedule_task',
            prompt: args.prompt,
            scheduleType: args.schedule_type,
            scheduleValue: args.schedule_value,
            contextMode: args.context_mode || 'group',
            folder: targetFolder,
            chatId,
            topicId,
            createdBy: folder,
            timestamp: new Date().toISOString()
          };

          const filename = writeIpcFile(TASKS_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}`
            }]
          };
        }
      ),

      // Reads from current_tasks.json which host keeps updated
      tool(
        'list_tasks',
        'List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group\'s tasks.',
        {},
        async () => {
          const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

          try {
            if (!fs.existsSync(tasksFile)) {
              return {
                content: [{
                  type: 'text',
                  text: 'No scheduled tasks found.'
                }]
              };
            }

            const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

            const tasks = isMain
              ? allTasks
              : allTasks.filter((t: { folder: string }) => t.folder === folder);

            if (tasks.length === 0) {
              return {
                content: [{
                  type: 'text',
                  text: 'No scheduled tasks found.'
                }]
              };
            }

            const formatted = tasks.map((t: { id: string; prompt: string; scheduleType: string; scheduleValue: string; status: string; nextRun: string | null }) =>
              `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.scheduleType}: ${t.scheduleValue}) - ${t.status}, next: ${t.nextRun || 'N/A'}`
            ).join('\n');

            return {
              content: [{
                type: 'text',
                text: `Scheduled tasks:\n${formatted}`
              }]
            };
          } catch (err) {
            return {
              content: [{
                type: 'text',
                text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`
              }]
            };
          }
        }
      ),

      tool(
        'pause_task',
        'Pause a scheduled task. It will not run until resumed.',
        {
          task_id: z.string().describe('The task ID to pause')
        },
        async (args) => {
          const data = {
            type: 'pause_task',
            taskId: args.task_id,
            folder,
            isMain,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Task ${args.task_id} pause requested.`
            }]
          };
        }
      ),

      tool(
        'resume_task',
        'Resume a paused task.',
        {
          task_id: z.string().describe('The task ID to resume')
        },
        async (args) => {
          const data = {
            type: 'resume_task',
            taskId: args.task_id,
            folder,
            isMain,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Task ${args.task_id} resume requested.`
            }]
          };
        }
      ),

      tool(
        'cancel_task',
        'Cancel and delete a scheduled task.',
        {
          task_id: z.string().describe('The task ID to cancel')
        },
        async (args) => {
          const data = {
            type: 'cancel_task',
            taskId: args.task_id,
            folder,
            isMain,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Task ${args.task_id} cancellation requested.`
            }]
          };
        }
      ),

      tool(
        'register_chat',
        `Register a new Telegram chat so the agent can respond to messages there. Main group only.

Use available_chats.json to find the chat ID. The folder name should be lowercase with hyphens (e.g., "family-chat").`,
        {
          chat_id: z.number().describe('The Telegram chat ID'),
          chat_type: z.enum(['private', 'group', 'supergroup', 'channel']).describe('Type of chat'),
          chat_title: z.string().describe('Display name for the chat'),
          trigger_mode: z.enum(['always', 'mention', 'disabled']).default('mention').describe('When to respond: always=all messages, mention=only when mentioned, disabled=never')
        },
        async (args) => {
          if (!isMain) {
            return {
              content: [{ type: 'text', text: 'Only the main group can register new chats.' }],
              isError: true
            };
          }

          const data = {
            type: 'register_chat',
            chatId: args.chat_id,
            chatType: args.chat_type,
            chatTitle: args.chat_title,
            triggerMode: args.trigger_mode,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Chat "${args.chat_title}" (${args.chat_id}) registered with trigger mode: ${args.trigger_mode}. It will start receiving messages immediately.`
            }]
          };
        }
      ),

      tool(
        'service_control',
        'Control the NanoClaw service (main group only). Use to restart after code changes or rebuild the project.',
        {
          action: z.enum(['restart', 'rebuild']).describe('restart=restart service, rebuild=npm run build then restart')
        },
        async (args) => {
          if (!isMain) {
            return {
              content: [{ type: 'text', text: 'Only the main group can control the service.' }],
              isError: true
            };
          }

          const data = {
            type: 'service_control',
            action: args.action,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Service ${args.action} requested. The service will ${args.action === 'rebuild' ? 'rebuild and ' : ''}restart shortly.`
            }]
          };
        }
      )
    ]
  });
}
