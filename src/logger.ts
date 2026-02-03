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
    // Main log file: all logs (info and above)
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
