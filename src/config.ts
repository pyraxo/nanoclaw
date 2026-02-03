import path from 'path';

// Bot configuration
export const BOT_TOKEN = process.env.BOT_TOKEN || '';
export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Nanomi';

// Polling and timing
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;
export const IPC_POLL_INTERVAL = 1000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || '/home/user';

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'nanoclaw', 'mount-allowlist.json');
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_FOLDER = 'main';
export const GLOBAL_FOLDER = 'global';

// Container configuration
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT || '300000', 10);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760', 10); // 10MB default

// Warm container pool configuration
export const CONTAINER_WARM_TIMEOUT = parseInt(process.env.CONTAINER_WARM_TIMEOUT || '1800000', 10); // 30 min default
export const CONTAINER_PREWARM_COUNT = parseInt(process.env.CONTAINER_PREWARM_COUNT || '1', 10);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Slugify a string for use as a folder name
 */
export function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')  // Remove special chars
    .replace(/\s+/g, '-')       // Replace spaces with hyphens
    .replace(/-+/g, '-')        // Collapse multiple hyphens
    .replace(/^-|-$/g, '')      // Trim hyphens from ends
    .slice(0, 50);              // Limit length
}
