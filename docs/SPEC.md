# Quick Reference

## Architecture

```
Telegram (grammY) → SQLite → Docker Container (Claude SDK) → Response
```

## Key Paths

| Path | Purpose |
|------|---------|
| `groups/main/` | DM sessions, admin control |
| `groups/global/` | Shared memory for group sessions |
| `groups/{folder}/` | Per-topic folders |
| `data/sessions.json` | Claude session IDs |
| `data/registered_chats.json` | Chat configurations |
| `store/messages.db` | SQLite database |
| `logs/nanoclaw-*.log` | Runtime logs |

## Environment Variables

```bash
BOT_TOKEN=...                    # From BotFather
ASSISTANT_NAME=Nanomi            # Trigger word
CLAUDE_CODE_OAUTH_TOKEN=...      # Or ANTHROPIC_API_KEY
CONTAINER_WARM_TIMEOUT=1800000   # 30 min default
```

## MCP Tools (inside container)

| Tool | Purpose |
|------|---------|
| `schedule_task` | Create recurring/one-time task |
| `list_tasks` | View tasks |
| `pause_task` / `resume_task` | Control tasks |
| `cancel_task` | Delete task |
| `send_message` | Send Telegram message |
| `add_reaction` | React to message |

## Trigger Modes

- `always` - Respond to all messages
- `mention` - Only when @mentioned
- `disabled` - Ignore

## Service Commands

```bash
sudo systemctl start nanoclaw
sudo systemctl stop nanoclaw
sudo systemctl status nanoclaw
tail -f logs/nanoclaw-$(date +%Y-%m-%d).log
```

## Container Mounts

| Container Path | Host Path |
|----------------|-----------|
| `/workspace/group` | `groups/{folder}/` |
| `/workspace/shared` | `groups/main/` or `groups/global/` |
| `/workspace/extra/*` | Additional configured mounts |
| `/home/node/.claude/` | `data/sessions/{folder}/.claude/` |
