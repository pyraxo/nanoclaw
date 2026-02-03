# Security Notes

## Trust Model

- **Main channel (DM)** - Trusted, admin control
- **Other chats** - Untrusted, sandboxed
- **Container agents** - Isolated, limited to mounts

## What Containers Can Access

| Main Channel | Other Chats |
|--------------|-------------|
| Project root (rw) | Own folder only |
| All tasks | Own tasks only |
| Send to any chat | Own chat only |

## Mount Allowlist

Located at `~/.config/nanoclaw/mount-allowlist.json` (outside project, never mounted).

Blocked patterns by default:
```
.ssh, .gnupg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, id_rsa, id_ed25519, private_key, .secret
```

## Credential Exposure

Claude auth tokens are mounted into containers so the SDK can authenticate. This means agents can technically read them via Bash. No good workaround found yet.

## Prompt Injection

Mitigated by:
- Container isolation limits blast radius
- Only registered chats processed
- Trigger mode reduces accidental execution
