# CLAUDE.md

Read **[AGENTS.md](AGENTS.md)** first — it is the single source of truth for
agents working in this repo: architecture and callback flow, code map, the
pieces you're most likely to change, commands, conventions, and the gotchas
that don't announce themselves (fail-closed auth, persona caching, why brain
traffic never hits localhost).

Quick anchors:

- Operating the app (setup, deploy, env vars): [README.md](README.md) and
  [docs/PROVISIONING.md](docs/PROVISIONING.md)
- The system prompt: `src/lib/ai-sales/brain/prompt-parts/*.md`
- Before finishing any change: `npm run lint && npm run typecheck && npm run test`
  (lint fails on a single warning; dev server runs on port 3003, not 3000)
