# Design Decisions

Notes on why things are built the way they are.

## Core Principles

- **One process** - No microservices, message queues, or complexity
- **Container isolation** - Agents in Docker, not permission checks
- **Skills over features** - Add capabilities via `/skill` commands, not PRs
- **AI-native** - Setup and debugging via Claude Code, not dashboards

## Why Telegram

- Topics for per-conversation isolation
- Reaction support (bidirectional)
- grammY is clean TypeScript
- Better bot API than WhatsApp

## Why Docker

- Works on macOS and Linux
- Mature tooling
- Filesystem isolation is real, not simulated

## Why libsql

- SQLite compatible, drop-in replacement
- Vector search support (future: semantic memory)
- Single file database

## Session Model

- DMs → `groups/main/` (private admin)
- Groups → each topic gets `groups/{slug}/`
- Memory hierarchy: topic CLAUDE.md ← shared CLAUDE.md (main or global)

## Warm Containers

- Pool of pre-spawned containers with stdin open
- Avoids cold start latency
- Messages sent as JSON lines, responses via stdout markers
