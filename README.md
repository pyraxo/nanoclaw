# Nanomi

My personal Claude assistant, built on [NanoClaw](https://github.com/gavrielc/nanoclaw).

## What This Is

This is the open-source release of my own NanoClaw-based agent. It runs Claude in isolated Docker containers, accessible via Telegram. I use it for:

- **Personal automation** - Scheduling tasks, reminders, and recurring workflows
- **Research assistant** - Web searches, summarization, and note-taking
- **Project context** - Each Telegram topic gets its own memory and filesystem

The agent has full bash access (sandboxed in containers), web search, and can send messages back to me on schedule.

## How It Works

```
Telegram (grammY) → SQLite → Docker Container (Claude Agent SDK) → Response
```

Single Node.js process. Each chat/topic gets isolated memory (`groups/{folder}/CLAUDE.md`) and filesystem. Agents execute in warm Docker containers with only mounted directories visible.

## Getting Started

```bash
git clone https://github.com/aaronkzhou/nanomi.git
cd nanomi
claude
```

Then run `/setup`.

## Syncing Features from Upstream

This fork may drift from the original NanoClaw. To pull in specific features:

**Option 1: Cherry-pick commits**
```bash
git remote add upstream https://github.com/gavrielc/nanoclaw.git
git fetch upstream
git cherry-pick <commit-hash>
```

**Option 2: Use skills from upstream**
Copy specific skill files from upstream's `.claude/skills/` directory into your fork, then run them:
```bash
# Example: copy a skill
cp -r ../nanoclaw-upstream/.claude/skills/add-slack .claude/skills/
# Then run it
claude
/add-slack
```

**Option 3: Manual merge of specific files**
```bash
git fetch upstream
git checkout upstream/main -- path/to/specific/file.ts
```

The skills-over-features philosophy means most new capabilities are self-contained in `.claude/skills/` directories, making selective adoption straightforward.

## Original Project

**[NanoClaw](https://github.com/gavrielc/nanoclaw)** - The base framework this is built on. Go there for:
- Full documentation and setup guides
- Contributing guidelines
- Issue tracking
- Community skills

## License

MIT
