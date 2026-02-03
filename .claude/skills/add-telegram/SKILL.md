---
name: add-telegram
description: Add Telegram as a messaging channel to NanoClaw. Guides through BotFather setup, bot token configuration, and main channel registration. Triggers on "add telegram", "setup telegram", "telegram bot", or "connect telegram".
---

# Add Telegram Channel

This skill adds Telegram as the messaging channel for NanoClaw.

**These are sequential steps. Check what's already done and skip completed steps.**

## Step 1: Install grammy

```bash
npm install grammy
```

## Step 2: Verify telegram-client.ts exists

If `src/telegram-client.ts` is missing, pull the latest code or use `/customize` to add Telegram from scratch.

## Step 3: Create Telegram Bot and Configure Token

Tell the user to message **@BotFather** on Telegram:
1. Send `/newbot`
2. Choose a display name and username (must end in `bot`)
3. Copy the token (looks like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

Store in `.env`:
```bash
echo "BOT_TOKEN=PASTE_TOKEN_HERE" >> .env
```

Verify:
```bash
source .env && curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getMe"
```

## Step 4: Configure Assistant Name (Optional)

```bash
echo "ASSISTANT_NAME=Nanomi" >> .env
```

## Step 5: Set Up Main Channel

The main channel triggers on all messages (no mention needed).

Have user send a message to the bot, then detect the chat ID:
```bash
source .env
curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?limit=5"
```

Register it in `data/registered_chats.json` as an array:
```json
[
  {
    "chatId": CHAT_ID_NUMBER,
    "chatType": "private",
    "chatTitle": "Main",
    "defaultTrigger": { "mode": "always" },
    "addedAt": "2024-01-01T00:00:00.000Z"
  }
]
```

## Step 6: Create Folders

```bash
mkdir -p groups/main/logs groups/global/logs
```

Create `groups/main/CLAUDE.md` for DM instructions and `groups/global/CLAUDE.md` for group instructions.

## Architecture: Folder Routing

Each chat/topic gets a **unique folder** for isolation (logs, IPC, session data). The folder name is generated from the chat title (e.g., `private-49398386`).

However, **CLAUDE.md instructions are shared**:
- **DMs (private chats)** → Use `groups/main/CLAUDE.md`
- **Groups/supergroups** → Use `groups/global/CLAUDE.md`

This is achieved by mounting the shared CLAUDE.md read-only into each container's `/workspace/group/CLAUDE.md`.

Key files:
- `src/config.ts` - Defines `MAIN_FOLDER` and `GLOBAL_FOLDER` constants
- `src/session-manager.ts` - `getSessionFolder()` generates unique folders, `getSharedFolder()` returns main/global based on chat type
- `src/container-runner.ts` / `src/container-pool.ts` - Mount shared CLAUDE.md based on `chatType`

## Step 7: Build and Test

```bash
npm run build && npm run start
```

## Step 8: Systemd Service (Linux)

```bash
mkdir -p systemd
cat > systemd/nanoclaw.service << EOF
[Unit]
Description=NanoClaw Personal Assistant
After=network.target docker.service

[Service]
Type=simple
User=$USER
WorkingDirectory=$(pwd)
ExecStart=$(which node) $(pwd)/dist/index.js
Restart=always
EnvironmentFile=$(pwd)/.env

[Install]
WantedBy=multi-user.target
EOF

sudo cp systemd/nanoclaw.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now nanoclaw
```

## Troubleshooting

- **Bot doesn't respond**: Check logs, verify chat is registered, ensure bot is admin in groups
- **"Conflict: terminated by other getUpdates request"**: Stop other instances with `pkill -f nanoclaw`
- **Token invalid**: Get new token from @BotFather with `/token`
- **Check logs**: `tail -100 logs/nanoclaw-$(date +%Y-%m-%d).log`
