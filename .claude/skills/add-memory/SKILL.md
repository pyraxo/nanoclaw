---
name: add-memory
description: Add semantic memory to NanoClaw. Extracts learnings from conversations and injects relevant context into future prompts. Uses Ollama + nomic-embed-text embeddings. Triggers on "add memory", "install memory", "semantic memory", or "persistent memory".
---

# NanoClaw Semantic Memory

Installs a persistent semantic memory system that:
1. Extracts learnings from conversations on context compaction
2. Retrieves relevant memories and injects them into prompts
3. Uses Ollama + nomic-embed-text for embeddings

Reference: [claude-code-semantic-memory](https://github.com/zacdcook/claude-code-semantic-memory)

## 1. Check Prerequisites

```bash
# Check Docker is running
docker info >/dev/null 2>&1 && echo "Docker OK" || echo "Docker not running"

# Check NanoClaw is set up
[ -f .env ] && echo "Environment OK" || echo "Missing .env - run /setup first"
```

If Docker isn't running or .env is missing, tell the user to complete `/setup` first.

## 2. Install Ollama

Check if Ollama is installed:

```bash
which ollama && ollama --version || echo "Ollama not installed"
```

If not installed:

**Linux:**
```bash
curl -fsSL https://ollama.com/install.sh | sh
```

**macOS:**
```bash
brew install ollama
```

Start the Ollama service:

```bash
# Linux
sudo systemctl enable ollama
sudo systemctl start ollama

# macOS (runs automatically after install)
ollama serve &
```

Verify Ollama is running:

```bash
curl -s http://localhost:11434/api/tags | head -c 100 && echo " - Ollama running"
```

## 3. Pull Embedding Model

Pull the nomic-embed-text model:

```bash
ollama pull nomic-embed-text
```

Verify the model is available:

```bash
ollama list | grep nomic-embed-text
```

Test embedding generation:

```bash
curl -s http://localhost:11434/api/embeddings -d '{"model":"nomic-embed-text","prompt":"test"}' | head -c 100
```

## 4. Create Memory Daemon

Create the memory daemon directory and files:

```bash
mkdir -p memory-daemon
```

### 4a. Configuration File

Create `memory-daemon/config.json`:

```json
{
  "embeddingModel": "nomic-embed-text",
  "minSimilarity": 0.45,
  "duplicateThreshold": 0.92,
  "maxResults": 3,
  "timeoutMs": 2500,
  "port": 8741
}
```

### 4b. Requirements File

Create `memory-daemon/requirements.txt`:

```
flask==3.0.0
numpy==1.26.0
requests==2.31.0
gunicorn==21.2.0
```

### 4c. Server Implementation

Create `memory-daemon/server.py`:

```python
"""
NanoClaw Memory Daemon
Semantic memory API with Ollama embeddings
Adapted from claude-code-semantic-memory
"""

import os
import json
import uuid
import sqlite3
import struct
from datetime import datetime

from flask import Flask, request, jsonify
import numpy as np
import requests

app = Flask(__name__)

# Configuration
CONFIG_PATH = os.path.join(os.path.dirname(__file__), 'config.json')
with open(CONFIG_PATH) as f:
    CONFIG = json.load(f)

DB_PATH = os.environ.get('MEMORY_DB_PATH', os.path.join(os.path.dirname(__file__), 'data', 'memories.db'))
OLLAMA_URL = os.environ.get('OLLAMA_URL', 'http://localhost:11434')
EMBEDDING_DIM = 768

CATEGORIES = {
    'WORKING_SOLUTION',
    'GOTCHA',
    'PATTERN',
    'DECISION',
    'FAILURE',
    'PREFERENCE'
}


def get_db():
    """Get database connection"""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """Initialize database schema"""
    conn = get_db()
    conn.executescript('''
        CREATE TABLE IF NOT EXISTS memories (
            id TEXT PRIMARY KEY,
            content TEXT NOT NULL,
            context TEXT,
            category TEXT NOT NULL,
            embedding BLOB NOT NULL,
            confidence REAL DEFAULT 0.85,
            source_type TEXT NOT NULL,
            source_id TEXT,
            created_at TEXT NOT NULL,
            accessed_at TEXT,
            access_count INTEGER DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
        CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);
    ''')
    conn.commit()
    conn.close()


def get_embedding(text: str, task: str = 'search_document') -> np.ndarray:
    """Generate embedding via Ollama"""
    # nomic-embed-text uses task prefixes
    prefixed = f"{task}: {text}"

    try:
        response = requests.post(
            f"{OLLAMA_URL}/api/embeddings",
            json={"model": CONFIG['embeddingModel'], "prompt": prefixed},
            timeout=CONFIG['timeoutMs'] / 1000
        )
        response.raise_for_status()
        embedding = response.json()['embedding']
        return np.array(embedding, dtype=np.float32)
    except Exception as e:
        app.logger.error(f"Embedding failed: {e}")
        raise


def pack_embedding(embedding: np.ndarray) -> bytes:
    """Pack numpy array to bytes for SQLite"""
    return struct.pack(f'{EMBEDDING_DIM}f', *embedding.astype(np.float32))


def unpack_embedding(data: bytes) -> np.ndarray:
    """Unpack bytes to numpy array"""
    return np.array(struct.unpack(f'{EMBEDDING_DIM}f', data), dtype=np.float32)


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Compute cosine similarity"""
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(np.dot(a, b) / (norm_a * norm_b))


def check_duplicate(embedding: np.ndarray, conn) -> bool:
    """Check if memory is duplicate of existing"""
    cursor = conn.execute('SELECT embedding FROM memories')
    for row in cursor:
        existing = unpack_embedding(row['embedding'])
        if cosine_similarity(embedding, existing) >= CONFIG['duplicateThreshold']:
            return True
    return False


@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint"""
    try:
        # Check Ollama
        ollama_ok = requests.get(f"{OLLAMA_URL}/api/tags", timeout=0.5).ok

        # Check database
        conn = get_db()
        conn.execute('SELECT 1')
        conn.close()

        return jsonify({
            'status': 'healthy' if ollama_ok else 'degraded',
            'ollama': 'connected' if ollama_ok else 'unavailable',
            'model': CONFIG['embeddingModel']
        })
    except Exception as e:
        return jsonify({'status': 'unhealthy', 'error': str(e)}), 500


@app.route('/store', methods=['POST'])
def store_memory():
    """
    Store a new memory

    Request body:
    {
        "type": "WORKING_SOLUTION|GOTCHA|PATTERN|DECISION|FAILURE|PREFERENCE",
        "content": "The actual learning/insight",
        "context": "Optional context about when this applies",
        "confidence": 0.85,
        "session_source": "optional-session-id"
    }
    """
    data = request.get_json()

    if not data or 'content' not in data or 'type' not in data:
        return jsonify({'error': 'content and type required'}), 400

    content = data['content'].strip()
    category = data['type'].upper()
    context = data.get('context', '')
    confidence = data.get('confidence', 0.85)
    source_id = data.get('session_source')

    if category not in CATEGORIES:
        return jsonify({'error': f'Invalid type. Must be one of: {CATEGORIES}'}), 400

    if len(content) < 10:
        return jsonify({'error': 'Content too short (min 10 chars)'}), 400

    # Generate embedding
    try:
        embedding = get_embedding(content, task='search_document')
    except Exception as e:
        return jsonify({'error': f'Embedding failed: {e}'}), 500

    # Check for duplicates
    conn = get_db()
    if check_duplicate(embedding, conn):
        conn.close()
        return jsonify({'status': 'duplicate', 'message': 'Similar memory already exists'}), 200

    # Store memory
    memory_id = str(uuid.uuid4())
    conn.execute(
        '''INSERT INTO memories (id, content, context, category, embedding, confidence, source_type, source_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)''',
        (memory_id, content, context, category, pack_embedding(embedding), confidence, 'conversation', source_id, datetime.utcnow().isoformat())
    )
    conn.commit()
    conn.close()

    return jsonify({'status': 'stored', 'id': memory_id}), 201


@app.route('/recall', methods=['POST'])
def recall_memories():
    """
    Search memories by semantic similarity

    Request body:
    {
        "query": "What you're looking for",
        "categories": ["PATTERN", "GOTCHA"],  // optional filter
        "limit": 3  // optional, default 3
    }
    """
    data = request.get_json()

    if not data or 'query' not in data:
        return jsonify({'error': 'query required'}), 400

    query = data['query']
    categories = data.get('categories', list(CATEGORIES))
    limit = min(data.get('limit', CONFIG['maxResults']), 10)

    # Generate query embedding
    try:
        query_embedding = get_embedding(query, task='search_query')
    except Exception as e:
        return jsonify({'error': f'Embedding failed: {e}', 'results': []}), 200

    # Search all memories and compute similarity
    conn = get_db()

    placeholders = ','.join('?' * len(categories))
    cursor = conn.execute(
        f'SELECT id, content, context, category, embedding, confidence, created_at FROM memories WHERE category IN ({placeholders})',
        categories
    )

    results = []
    for row in cursor:
        embedding = unpack_embedding(row['embedding'])
        similarity = cosine_similarity(query_embedding, embedding)

        if similarity >= CONFIG['minSimilarity']:
            results.append({
                'id': row['id'],
                'type': row['category'],
                'content': row['content'],
                'context': row['context'],
                'confidence': row['confidence'],
                'created_at': row['created_at'],
                'similarity': round(similarity, 3)
            })

    # Sort by similarity and limit
    results.sort(key=lambda x: x['similarity'], reverse=True)
    results = results[:limit]

    # Update access counts
    for r in results:
        conn.execute(
            'UPDATE memories SET accessed_at = ?, access_count = access_count + 1 WHERE id = ?',
            (datetime.utcnow().isoformat(), r['id'])
        )
    conn.commit()
    conn.close()

    return jsonify({'results': results, 'count': len(results)})


@app.route('/stats', methods=['GET'])
def memory_stats():
    """Get memory statistics"""
    conn = get_db()

    total = conn.execute('SELECT COUNT(*) FROM memories').fetchone()[0]
    by_category = dict(conn.execute(
        'SELECT category, COUNT(*) FROM memories GROUP BY category'
    ).fetchall())

    conn.close()

    return jsonify({
        'total': total,
        'by_category': by_category
    })


@app.route('/memories/<memory_id>', methods=['DELETE'])
def delete_memory(memory_id):
    """Delete a memory by ID"""
    conn = get_db()
    cursor = conn.execute('DELETE FROM memories WHERE id = ?', (memory_id,))
    conn.commit()
    deleted = cursor.rowcount > 0
    conn.close()

    if deleted:
        return jsonify({'status': 'deleted'})
    return jsonify({'error': 'Memory not found'}), 404


if __name__ == '__main__':
    init_db()
    print(f"Memory daemon starting on port {CONFIG['port']}...")
    app.run(host='0.0.0.0', port=CONFIG['port'])
```

## 5. Create Daemon Scripts

### 5a. Start Script

Create `scripts/start-memory-daemon.sh`:

```bash
#!/bin/bash
# Start the memory daemon

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DAEMON_DIR="$PROJECT_ROOT/memory-daemon"

cd "$DAEMON_DIR"

# Create virtual environment if needed
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
fi

# Activate and install dependencies
source venv/bin/activate
pip install -q -r requirements.txt

# Create data directory
mkdir -p data

# Check if already running
if curl -s http://localhost:8741/health >/dev/null 2>&1; then
    echo "Memory daemon already running"
    exit 0
fi

# Start daemon
echo "Starting memory daemon..."
nohup python server.py > daemon.log 2>&1 &
echo $! > daemon.pid

# Wait for startup
for i in {1..10}; do
    if curl -s http://localhost:8741/health | grep -q healthy; then
        echo "Memory daemon started (PID: $(cat daemon.pid))"
        exit 0
    fi
    sleep 1
done

echo "Warning: Daemon may not be ready yet. Check daemon.log"
```

### 5b. Stop Script

Create `scripts/stop-memory-daemon.sh`:

```bash
#!/bin/bash
# Stop the memory daemon

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PID_FILE="$PROJECT_ROOT/memory-daemon/daemon.pid"

if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        echo "Stopping memory daemon (PID: $PID)..."
        kill "$PID"
        rm "$PID_FILE"
        echo "Stopped"
    else
        echo "Process not running, cleaning up PID file"
        rm "$PID_FILE"
    fi
else
    echo "No PID file found"
fi
```

Make scripts executable:

```bash
chmod +x scripts/start-memory-daemon.sh scripts/stop-memory-daemon.sh
```

## 6. Test Memory Daemon

Start the daemon:

```bash
./scripts/start-memory-daemon.sh
```

Test health:

```bash
curl http://localhost:8741/health
```

Test storing a memory:

```bash
curl -X POST http://localhost:8741/store \
  -H "Content-Type: application/json" \
  -d '{"type":"PATTERN","content":"Always use explicit error handling in async functions","confidence":0.9}'
```

Test recall:

```bash
curl -X POST http://localhost:8741/recall \
  -H "Content-Type: application/json" \
  -d '{"query":"error handling best practices"}'
```

Check stats:

```bash
curl http://localhost:8741/stats
```

## 7. Create Docker Network

Create the Docker network for container-to-host communication:

```bash
docker network create nanoclaw-network 2>/dev/null || echo "Network already exists"
```

## 8. Update Container Runner

Modify `src/container-runner.ts` to add network and host access for memory daemon.

In the `buildContainerArgs` function, add after the initial args:

```typescript
// Connect to nanoclaw network for memory daemon access
args.push('--network', 'nanoclaw-network');
args.push('--add-host', 'memory-daemon:host-gateway');
```

The memory daemon runs on the host, so containers access it via `http://memory-daemon:8741`.

## 9. Create Memory Client

Create `container/agent-runner/src/memory-client.ts`:

```typescript
/**
 * Memory client for semantic memory API
 */

const MEMORY_DAEMON_URL = process.env.MEMORY_DAEMON_URL || 'http://memory-daemon:8741';
const TIMEOUT_MS = 2500;

interface Memory {
  type: string;
  content: string;
  context?: string;
  similarity: number;
}

interface RecallResponse {
  results: Memory[];
  count: number;
}

interface Learning {
  type: string;
  content: string;
  context?: string;
  confidence: number;
}

/**
 * Query memories relevant to a prompt
 */
export async function recallMemories(query: string): Promise<Memory[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(`${MEMORY_DAEMON_URL}/recall`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit: 3 }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.error('[memory] Recall failed:', response.status);
      return [];
    }

    const data: RecallResponse = await response.json();
    return data.results;
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      console.error('[memory] Recall timed out');
    } else {
      console.error('[memory] Recall error:', err);
    }
    return [];
  }
}

/**
 * Store a learning in memory
 */
export async function storeMemory(learning: Learning, sessionId?: string): Promise<boolean> {
  try {
    const response = await fetch(`${MEMORY_DAEMON_URL}/store`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: learning.type,
        content: learning.content,
        context: learning.context,
        confidence: learning.confidence,
        session_source: sessionId
      })
    });

    if (!response.ok) {
      console.error('[memory] Store failed:', response.status);
      return false;
    }

    const data = await response.json();
    return data.status === 'stored' || data.status === 'duplicate';
  } catch (err) {
    console.error('[memory] Store error:', err);
    return false;
  }
}

/**
 * Format memories as XML for prompt injection
 */
export function formatMemoriesXml(memories: Memory[]): string {
  if (memories.length === 0) return '';

  const memoryTags = memories.map(m =>
    `<memory type="${m.type}" similarity="${m.similarity}">${m.content}</memory>`
  ).join('\n');

  return `<recalled-learnings>
${memoryTags}
</recalled-learnings>`;
}

/**
 * Check if daemon is healthy
 */
export async function checkDaemonHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${MEMORY_DAEMON_URL}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(500)
    });
    const data = await response.json();
    return data.status === 'healthy';
  } catch {
    return false;
  }
}
```

## 10. Update Agent Runner

Modify `container/agent-runner/src/index.ts` to integrate memory.

### 10a. Add Imports

At the top of the file, add:

```typescript
import { recallMemories, storeMemory, formatMemoriesXml, checkDaemonHealth } from './memory-client.js';
```

### 10b. Add Extraction Prompt

Add this constant for learning extraction:

```typescript
const EXTRACTION_PROMPT = `Analyze this conversation and extract learnings for semantic memory.

For each learning, provide:
- type: WORKING_SOLUTION | GOTCHA | PATTERN | DECISION | FAILURE | PREFERENCE
- content: Specific, actionable insight (include commands/code when relevant)
- context: Brief description of when this applies
- confidence: 0.70-1.0 based on how confirmed the learning is

Output ONLY valid JSONL (one JSON object per line).

Categories:
- WORKING_SOLUTION: Confirmed approach that solved a problem
- GOTCHA: Common mistake or unexpected behavior
- PATTERN: Recurring best practice or code pattern
- DECISION: Architectural or design decision with rationale
- FAILURE: What didn't work and why (to avoid repeating)
- PREFERENCE: User preference or style choice

Rules:
- Be specific with actual commands and code
- Prefer solutions over problems
- Include relevant context
- Skip generic programming knowledge
- Focus on user-specific patterns and preferences

<conversation>
{TRANSCRIPT}
</conversation>`;
```

### 10c. Add Extraction Function

Add this function for extracting learnings:

```typescript
async function extractLearnings(transcript: string, sessionId: string): Promise<void> {
  // Check if daemon is available
  if (!await checkDaemonHealth()) {
    log('Memory daemon unavailable, skipping extraction');
    return;
  }

  const prompt = EXTRACTION_PROMPT.replace('{TRANSCRIPT}', transcript);

  // Use Anthropic API directly for extraction (faster than spawning agent)
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log('No API key for extraction');
    return;
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      log(`Extraction API error: ${response.status}`);
      return;
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '';

    // Parse JSONL from response
    const lines = text.split('\n').filter((l: string) => l.trim().startsWith('{'));
    let stored = 0;

    for (const line of lines) {
      try {
        const learning = JSON.parse(line);
        if (learning.type && learning.content) {
          const success = await storeMemory(learning, sessionId);
          if (success) stored++;
        }
      } catch {
        // Skip malformed lines
      }
    }

    if (stored > 0) {
      log(`Extracted and stored ${stored} learnings`);
    }
  } catch (err) {
    log(`Extraction error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

### 10d. Update PreCompact Hook

In the `createPreCompactHook` function, after archiving the conversation, add extraction:

```typescript
// After: fs.writeFileSync(filePath, markdown);
// Add:
await extractLearnings(markdown, sessionId);
```

### 10e. Update Main Function

In the `main` function, before calling `query()`, add memory injection:

```typescript
// Query relevant memories
const memories = await recallMemories(input.prompt);
const memoryContext = formatMemoriesXml(memories);

// Inject memories into prompt
let enhancedPrompt = input.prompt;
if (memoryContext) {
  enhancedPrompt = `${memoryContext}\n\n${input.prompt}`;
  log(`Injected ${memories.length} relevant memories`);
}

// Use enhancedPrompt in the query() call instead of prompt
```

## 11. Rebuild Container

Rebuild the agent container with the memory client:

```bash
./container/build.sh
```

## 12. Update Main Process Startup

Modify `src/index.ts` to start the memory daemon on startup.

Add this function:

```typescript
async function ensureMemoryDaemon(): Promise<void> {
  const maxRetries = 3;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch('http://localhost:8741/health');
      if (response.ok) {
        logger.info('Memory daemon is healthy');
        return;
      }
    } catch {
      // Daemon not responding
    }

    if (i === 0) {
      logger.info('Starting memory daemon...');
      try {
        execSync('./scripts/start-memory-daemon.sh', { stdio: 'inherit', timeout: 30000 });
      } catch (err) {
        logger.warn({ err }, 'Failed to start memory daemon');
      }
    }

    await new Promise(r => setTimeout(r, 3000));
  }

  logger.warn('Memory daemon unavailable - continuing without semantic memory');
}
```

Call it in `main()` after `ensureDockerRunning()`:

```typescript
await ensureMemoryDaemon();
```

## 13. Test End-to-End

Rebuild NanoClaw:

```bash
npm run build
```

Start the memory daemon:

```bash
./scripts/start-memory-daemon.sh
```

Start NanoClaw:

```bash
npm run dev
```

Send a test message. Check the logs for memory injection:

```bash
tail -f groups/main/logs/container-*.log | grep -i memory
```

Trigger a long conversation to cause context compaction, then check if learnings were extracted:

```bash
curl http://localhost:8741/stats
```

## 14. Configure Systemd (Optional)

To run the memory daemon as a system service on Linux:

Create `/etc/systemd/system/nanoclaw-memory.service`:

```ini
[Unit]
Description=NanoClaw Memory Daemon
After=network.target ollama.service

[Service]
Type=simple
User=YOUR_USERNAME
WorkingDirectory=/path/to/nanoclaw/memory-daemon
ExecStart=/path/to/nanoclaw/memory-daemon/venv/bin/python server.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable nanoclaw-memory
sudo systemctl start nanoclaw-memory
```

## Troubleshooting

**Ollama not responding:**
```bash
# Check if running
curl http://localhost:11434/api/tags

# Restart
sudo systemctl restart ollama  # Linux
# or: brew services restart ollama  # macOS
```

**Memory daemon not starting:**
```bash
# Check logs
cat memory-daemon/daemon.log

# Check if port is in use
lsof -i :8741

# Manual start for debugging
cd memory-daemon && source venv/bin/activate && python server.py
```

**Container can't reach daemon:**
```bash
# Verify network exists
docker network ls | grep nanoclaw

# Test from container
docker run --rm --network nanoclaw-network --add-host memory-daemon:host-gateway curlimages/curl http://memory-daemon:8741/health
```

**No memories being recalled:**
```bash
# Check stats
curl http://localhost:8741/stats

# Test manual recall
curl -X POST http://localhost:8741/recall -H "Content-Type: application/json" -d '{"query":"test"}'
```

**Extraction not working:**
- Ensure ANTHROPIC_API_KEY is set in .env
- Check container logs for extraction errors
- Manually trigger by sending many messages to fill context
