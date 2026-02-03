# Warm Container Pool

Implement a container pooling system to reduce latency by keeping containers warm and pre-warming idle containers.

## Configuration

Add to `src/config.ts`:
```typescript
export const CONTAINER_WARM_TIMEOUT = parseInt(process.env.CONTAINER_WARM_TIMEOUT || '1800000'); // 30 min default
export const CONTAINER_PREWARM_COUNT = parseInt(process.env.CONTAINER_PREWARM_COUNT || '1');
```

## Architecture

### Current Flow (Cold Start)
```
Message → Spawn Container → Process → Exit
~2-3s startup overhead per message
```

### New Flow (Warm Pool)
```
Message → Get/Create Warm Container → Send via FIFO → Process → Keep Alive
~0.1s if container warm, falls back to cold start if needed
```

## Implementation Steps

### 1. Update Container Entrypoint

Modify `container/Dockerfile` entrypoint to accept multiple messages via a named FIFO:

```bash
#!/bin/bash
set -e
[ -f /workspace/env-dir/env ] && export $(cat /workspace/env-dir/env | xargs)

# Create FIFO for message input
FIFO="/workspace/ipc/input.fifo"
mkfifo -m 600 "$FIFO" 2>/dev/null || true

# Signal ready
echo "READY" > /workspace/ipc/status

# Process messages in a loop
while true; do
  if read -t ${IDLE_TIMEOUT:-1800} line < "$FIFO"; then
    echo "$line" | node /app/dist/index.js
    echo "READY" > /workspace/ipc/status
  else
    echo "TIMEOUT" > /workspace/ipc/status
    exit 0
  fi
done
```

### 2. Create Container Pool Manager

Create `src/container-pool.ts`:

```typescript
interface WarmContainer {
  id: string;
  folder: string | null;  // null = pre-warmed, available for any folder
  process: ChildProcess;
  lastActive: number;
  inputFifo: string;
  statusFile: string;
}

class ContainerPool {
  private containers: Map<string, WarmContainer> = new Map();
  private prewarmQueue: WarmContainer[] = [];

  async getContainer(folder: string): Promise<WarmContainer> {
    // 1. Check for existing warm container for this folder
    // 2. Check for available pre-warmed container
    // 3. Fall back to cold start
  }

  async sendMessage(container: WarmContainer, input: ContainerInput): Promise<ContainerOutput> {
    // Write to FIFO, wait for response
  }

  private async spawnWarmContainer(folder?: string): Promise<WarmContainer> {
    // Spawn with keep-alive entrypoint
  }

  private startCleanupTimer(): void {
    // Check for timed-out containers every minute
  }

  async prewarm(count: number): Promise<void> {
    // Spawn pre-warmed containers
  }
}

export const containerPool = new ContainerPool();
```

### 3. Update agent-runner for Multi-Message Mode

Modify `container/agent-runner/src/index.ts` to support processing multiple messages:

```typescript
// Add loop mode that reads from stdin continuously
async function runLoop(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin });

  for await (const line of rl) {
    if (line === 'SHUTDOWN') break;

    try {
      const input = JSON.parse(line);
      await processMessage(input);
    } catch (err) {
      writeOutput({ status: 'error', result: null, error: err.message });
    }
  }
}
```

### 4. Update container-runner.ts

Replace direct spawn with pool manager:

```typescript
import { containerPool } from './container-pool.js';

export async function runContainerAgent(input: ContainerInput, group: RegisteredChat): Promise<ContainerResult> {
  const container = await containerPool.getContainer(input.folder);
  return containerPool.sendMessage(container, input);
}
```

### 5. Initialize Pool on Startup

In `src/index.ts`:

```typescript
import { containerPool } from './container-pool.js';
import { CONTAINER_PREWARM_COUNT } from './config.js';

async function main() {
  // ... existing init ...

  // Pre-warm containers
  await containerPool.prewarm(CONTAINER_PREWARM_COUNT);
  logger.info({ count: CONTAINER_PREWARM_COUNT }, 'Pre-warmed containers ready');
}
```

## File Changes Summary

| File | Change |
|------|--------|
| `src/config.ts` | Add CONTAINER_WARM_TIMEOUT, CONTAINER_PREWARM_COUNT |
| `src/container-pool.ts` | NEW - Pool manager |
| `src/container-runner.ts` | Use pool instead of direct spawn |
| `src/index.ts` | Initialize pool on startup |
| `container/Dockerfile` | New multi-message entrypoint |
| `container/agent-runner/src/index.ts` | Support loop mode |

## Testing

1. Start service: `sudo systemctl restart nanoclaw`
2. Send message, check logs for "Using warm container" vs "Cold start"
3. Send another message within 30min, should be faster
4. Check `docker ps` - container should stay running

## Rollback

Set `CONTAINER_PREWARM_COUNT=0` and `CONTAINER_WARM_TIMEOUT=0` to disable pooling and revert to cold-start behavior.
