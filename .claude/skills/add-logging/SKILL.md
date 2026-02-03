---
name: add-logging
description: Set up pino logging across the entire repository. Use when user wants to add structured logging, replace console.log calls, or configure log files. Triggers on "add logging", "setup logging", "configure pino", or "replace console.log".
---

# Add Pino Logging

Set up structured logging with pino across the entire NanoClaw codebase. This creates a shared logger module and replaces all console.log/error/warn calls.

## Overview

Pino is already installed. This skill will:
1. Create a shared logger module (`src/logger.ts`)
2. Replace all `console.log/error/warn` calls with the logger
3. Configure dual output: pretty console + JSON file
4. Set up log rotation awareness
5. Add child loggers for different components

## 1. Create the Logger Module

Create `src/logger.ts`:

```typescript
import pino from 'pino';
import path from 'path';
import fs from 'fs';

const LOG_DIR = path.join(process.cwd(), 'logs');

// Ensure logs directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Get current date for log file names (YYYY-MM-DD)
function getDateSuffix(): string {
  return new Date().toISOString().split('T')[0];
}

// Log file paths with date suffix
const getLogFile = () => path.join(LOG_DIR, `nanoclaw-${getDateSuffix()}.log`);
const getErrorLogFile = () => path.join(LOG_DIR, `nanoclaw-error-${getDateSuffix()}.log`);

// Create multi-destination transport: pretty console + dated JSON files (split by level)
const transport = pino.transport({
  targets: [
    // Console: pretty-printed, all levels
    {
      target: 'pino-pretty',
      level: process.env.LOG_LEVEL || 'info',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname'
      }
    },
    // Main log file: trace through info (normal operations)
    {
      target: 'pino/file',
      level: process.env.LOG_LEVEL || 'info',
      options: {
        destination: getLogFile(),
        mkdir: true
      }
    },
    // Error log file: warn and above (problems only)
    {
      target: 'pino/file',
      level: 'warn',
      options: {
        destination: getErrorLogFile(),
        mkdir: true
      }
    }
  ]
});

export const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    base: { pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime
  },
  transport
);

// Child loggers for different components
export const botLogger = logger.child({ component: 'bot' });
export const containerLogger = logger.child({ component: 'container' });
export const schedulerLogger = logger.child({ component: 'scheduler' });
export const dbLogger = logger.child({ component: 'db' });
export const sessionLogger = logger.child({ component: 'session' });

export default logger;
```

**Note:** The date suffix is determined at startup. For long-running processes, logs will continue to the same file until restart. For automatic daily rotation, see the Log Rotation section below.

## 2. Update All Source Files

### Pattern for replacing console calls

| Old | New |
|-----|-----|
| `console.log(msg)` | `logger.info(msg)` |
| `console.error(msg)` | `logger.error(msg)` |
| `console.warn(msg)` | `logger.warn(msg)` |
| `console.log(\`text ${var}\`)` | `logger.info({ var }, 'text')` |
| `console.error('Error:', err)` | `logger.error({ err }, 'Error message')` |

### Files to update

Search for all console.log/error/warn calls:

```bash
grep -rn "console\.\(log\|error\|warn\|info\)" src/
```

For each file found:

1. Add import at the top:
   ```typescript
   import { logger } from './logger.js';
   // Or use a child logger:
   import { botLogger as logger } from './logger.js';
   ```

2. Replace each console call with the appropriate logger method

3. For structured data, use pino's object-first pattern:
   ```typescript
   // Instead of:
   console.log(`Processing message from ${userId} in chat ${chatId}`);

   // Use:
   logger.info({ userId, chatId }, 'Processing message');
   ```

### Special case: index.ts

The `index.ts` file already creates a local pino logger. Replace it with the import:

```typescript
// Remove this:
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

// Add this:
import { logger, containerLogger, schedulerLogger } from './logger.js';
```

### Special case: telegram-client.ts

Use the botLogger child:

```typescript
import { botLogger as logger } from './logger.js';

// Replace:
console.log(`Bot added to chat: ${chat.id} (${chat.type})`);
// With:
logger.info({ chatId: chat.id, chatType: chat.type }, 'Bot added to chat');

// Replace:
console.error('Telegram bot error:', err);
// With:
logger.error({ err }, 'Telegram bot error');
```

### Special case: ASCII art boxes (index.ts Docker warning)

For important startup warnings that should stand out, keep them visually distinct but use the logger:

```typescript
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
```

## 3. Update .env.example

Add logging configuration:

```bash
# Logging
LOG_LEVEL=info  # trace, debug, info, warn, error, fatal
```

## 4. Update .gitignore

Ensure logs are ignored (should already be there, but verify):

```bash
grep -q "^logs/" .gitignore || echo "logs/" >> .gitignore
```

## 5. Verify the Setup

After making changes:

```bash
# Build to check for TypeScript errors
npm run build

# Run briefly to test logging
timeout 5 npm run dev || true

# Check that log files were created (dated files)
ls -la logs/

# View today's logs
cat logs/nanoclaw-$(date +%Y-%m-%d).log | head -20

# Check error log exists (may be empty if no errors)
ls -la logs/nanoclaw-error-*.log
```

## Log Levels

| Level | When to use |
|-------|-------------|
| `trace` | Very detailed debugging (message contents, IPC data) |
| `debug` | Debugging info (function entry/exit, state changes) |
| `info` | Normal operations (bot started, message processed) |
| `warn` | Recoverable issues (rate limited, retry needed) |
| `error` | Errors that don't crash the app (API failure, timeout) |
| `fatal` | Unrecoverable errors (Docker not running, no API key) |

## Reading Logs

Log files are split by date and severity:
- `logs/nanoclaw-YYYY-MM-DD.log` - All logs (info and above)
- `logs/nanoclaw-error-YYYY-MM-DD.log` - Errors only (warn and above)

For the user:
```bash
# Live console output (when running with npm run dev)
npm run dev

# Tail today's logs
tail -f logs/nanoclaw-$(date +%Y-%m-%d).log

# Tail today's errors only
tail -f logs/nanoclaw-error-$(date +%Y-%m-%d).log

# Pretty-print JSON logs
cat logs/nanoclaw-$(date +%Y-%m-%d).log | pino-pretty

# Filter by component
cat logs/nanoclaw-$(date +%Y-%m-%d).log | jq 'select(.component == "bot")'

# View all log files
ls -la logs/
```

For Claude Code:
```bash
# Read recent logs (today)
tail -100 logs/nanoclaw-$(date +%Y-%m-%d).log

# Read recent errors (today)
tail -100 logs/nanoclaw-error-$(date +%Y-%m-%d).log

# Search for errors across all days
grep '"level":50' logs/nanoclaw-*.log  # errors
grep '"level":60' logs/nanoclaw-*.log  # fatal

# Systemd daemon logs (if running as service)
sudo journalctl -u nanoclaw -n 100 --no-pager

# Live tail daemon logs
sudo journalctl -u nanoclaw -f
```

## 6. Update CLAUDE.md

Add log viewing instructions to CLAUDE.md so Claude knows how to check logs when debugging:

```markdown
## Viewing Logs

Logs are in `logs/` with date suffixes:
- `logs/nanoclaw-YYYY-MM-DD.log` - All logs (info and above)
- `logs/nanoclaw-error-YYYY-MM-DD.log` - Errors only (warn and above)

When debugging issues, check logs:
\`\`\`bash
# Today's logs
tail -100 logs/nanoclaw-$(date +%Y-%m-%d).log

# Today's errors only
tail -100 logs/nanoclaw-error-$(date +%Y-%m-%d).log

# Systemd daemon logs (if running as service)
sudo journalctl -u nanoclaw -n 100 --no-pager

# Live tail daemon logs
sudo journalctl -u nanoclaw -f
\`\`\`
```

## Log Rotation & Cleanup

Since logs are date-suffixed, you get automatic daily separation on restart. For cleanup of old logs:

**Option 1: Cron job to delete old logs**
```bash
# Add to crontab: delete logs older than 30 days
0 0 * * * find /path/to/nanoclaw/logs -name "nanoclaw-*.log" -mtime +30 -delete
```

**Option 2: Logrotate (compress old files)**

Create `/etc/logrotate.d/nanoclaw`:
```
/path/to/nanoclaw/logs/nanoclaw-*.log {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    nocreate
}
```

**Note on long-running processes:** The date suffix is set at startup. If the process runs for multiple days without restart, logs continue to the same file. For true daily rotation in long-running processes, consider using `pino-roll` (requires adding the dependency) or scheduling daily restarts via systemd/cron.
