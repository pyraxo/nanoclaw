# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to Telegram via grammY, routes messages to Claude Agent SDK running in Docker containers. Each chat/topic has isolated filesystem and memory. Uses libsql for SQLite storage.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main app: Telegram bot, message routing, IPC |
| `src/telegram-client.ts` | grammY bot setup, message/reaction handlers |
| `src/session-manager.ts` | Maps chat_id+topic_id to session folders |
| `src/config.ts` | Bot token, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations (libsql) |
| `groups/{folder}/CLAUDE.md` | Per-topic memory (isolated) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, bot token, container setup |
| `/customize` | Adding integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/add-logging` | Set up pino structured logging, replace console.log |
| `/add-telegram` | Add Telegram channel to new deployments |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management (systemd on Linux):
```bash
sudo systemctl start nanoclaw
sudo systemctl stop nanoclaw
sudo systemctl status nanoclaw
```

## Viewing Logs

Logs are in `logs/` with date suffixes:
- `logs/nanoclaw-YYYY-MM-DD.log` - All logs (info and above)
- `logs/nanoclaw-error-YYYY-MM-DD.log` - Errors only (warn and above)

When debugging issues, check logs:
```bash
# Today's logs
tail -100 logs/nanoclaw-$(date +%Y-%m-%d).log

# Today's errors only
tail -100 logs/nanoclaw-error-$(date +%Y-%m-%d).log

# Systemd daemon logs (if running as service)
sudo journalctl -u nanoclaw -n 100 --no-pager

# Live tail daemon logs
sudo journalctl -u nanoclaw -f
```
