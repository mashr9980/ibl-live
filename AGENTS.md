# AGENTS.md — working on this repo as a coding agent

Read this before editing anything. The README covers _operating_ the app;
this file covers _changing_ it — the architecture, the pieces you're most
likely to touch, and the failure modes that don't announce themselves.

## What this is

A single Next.js 15 (App Router) app: an AI sales agent ("Wayne") built on
[LiveAvatar](https://liveavatar.com). One page, three API routes, no database.
The browser talks to a real-time avatar over LiveKit; the avatar's brain is an
OpenAI-compatible endpoint served **by this same app** and called back by
LiveAvatar's cloud on every conversational turn.

That callback shape is the single most important thing to understand:

```
Browser                      This app (deployed)                LiveAvatar cloud
  │                                │                                  │
  │ POST /api/ai-sales/session ───▶│ POST /v1/sessions/token ────────▶│  (FULL mode,
  │ ◀── token + HMAC signature ────│ ◀── session_token ───────────────│   X-API-KEY)
  │                                │                                  │
  │ startSession(token) ══════════ LiveKit room (WebRTC) ════════════▶│
  │                                │                                  │
  │        (each turn)             │ ◀── POST /api/chat/completions ──│  (Bearer key,
  │                                │ ──── OpenAI-shaped SSE ─────────▶│   OpenAI protocol)
  │                                │                                  │
  │ on DISCONNECTED:               │                                  │
  │ POST /api/ai-sales/session-end▶│──▶ Claude summary → Notion → Slack
```

- **`/api/ai-sales/session`** (`src/app/api/ai-sales/session/route.ts`) —
  mints the browser's session token via the public LiveAvatar API. Resolves
  the visitor's email through the lead resolver, builds a personalized opening
  line, passes it as `dynamic_variables` (substituted into the context's
  `${opening_intro}` placeholder), and HMAC-signs the `session_id` so
  session-end can prove the caller minted through us.
- **`/api/chat/completions`** (`src/app/api/chat/completions/route.ts`) — the
  brain. Auth (constant-time Bearer vs `AI_SALES_LLM_CONFIG_API_KEY`) → rate
  limit → assemble system prompt (persona + date/weather + lead profile +
  Notion history, concurrent, best-effort) → stream Anthropic as OpenAI SSE.
  The real model is `LLM_MODEL` in `src/lib/ai-sales/brain/streaming.ts`
  (currently `claude-haiku-4-5`); the `model` field on the wire is a cosmetic
  label and never reaches Anthropic.
- **`/api/ai-sales/session-end`** (`src/app/api/ai-sales/session-end/route.ts`)
  — fire-and-forget fan-out on disconnect: verify HMAC → Claude summary →
  Notion CRM upsert (by email) → Slack webhook. Always returns 200; partial
  failures are reported in the body and logged, never thrown.
- **The page** (`src/app/page.tsx` → `src/sections/ai-sales/AiSales.tsx`) — a
  client-side stage machine: `setup → mic → ready → connecting → connected →
ended`, plus a `busy` stage for upstream capacity exhaustion.

## Map of the code

```
src/app/                          App Router: page, layout, the 3 API routes
src/sections/ai-sales/            Client UI — AiSales.tsx (stage machine,
                                  live transcript pane) + small components
src/lib/ai-sales/                 Server-side logic
  brain/                          Everything /api/chat/completions uses
    prompt-parts/*.md             THE SYSTEM PROMPT — one file per section
    persona.ts                    Assembles prompt-parts (rules documented inline)
    streaming.ts                  Anthropic → OpenAI SSE adapter; LLM_MODEL lives here
    agent-identity.ts             {{AGENT_NAME}} etc. — the one place identity lives
    messages.ts / prompt.ts       OpenAI→Anthropic message mapping, prompt layout
    lead-client.ts / lead-block.ts / notion-history.ts / realworld.ts
  lead-resolver/                  Swappable lead enrichment (only a no-op stub ships)
  session-mint.ts / session-end.ts / session-auth.ts / opening.ts
src/lib/vendor/liveavatar-react/  Vendored React wrapper over @heygen/liveavatar-web-sdk
scripts/setup.mjs                 One-shot provisioning against the LiveAvatar API
docs/PROVISIONING.md              Clone → working avatar, incl. troubleshooting table
.env.example                      Every env var, grouped and documented — read it
```

Tests are colocated in `__tests__/` directories next to what they test.

## The pieces you'll most likely change

| Change                                | Where                                      | Notes                                                                                                                                            |
| ------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| What the agent says / persona         | `src/lib/ai-sales/brain/prompt-parts/*.md` | Assembled in filename order; see rules below                                                                                                     |
| Agent name / role / product / company | `AI_SALES_AGENT_*` env vars                | Flows through `agent-identity.ts` into prompt **and** UI. Never hardcode "Wayne" in new code — use `agentIdentity()` / the `identity` prop       |
| Conversation model                    | `LLM_MODEL` in `brain/streaming.ts`        | Summary model is separate: `SUMMARY_MODEL` in `session-end.ts`                                                                                   |
| The first spoken line                 | `src/lib/ai-sales/opening.ts`              | Generated pre-LLM, delivered via the context's `${opening_intro}` placeholder                                                                    |
| Lead enrichment (CRM lookup)          | `src/lib/ai-sales/lead-resolver/`          | Implement `LeadResolver` (start from `stub.ts`), register in `RESOLVERS`, select with `AI_SALES_LEAD_RESOLVER`. Nothing else changes             |
| Post-call CRM / notifications         | `src/lib/ai-sales/session-end.ts`          | Notion upsert + Slack webhook; both optional and independent                                                                                     |
| Avatar appearance / voice             | `AI_SALES_AVATAR_ID` / `AI_SALES_VOICE_ID` | Env only                                                                                                                                         |
| UI / stages / transcript              | `src/sections/ai-sales/AiSales.tsx`        | Heavily commented; the comments record real cross-browser constraints (iOS Safari autoplay, WebKit grid sizing) — read them before "simplifying" |

### Prompt-part assembly rules (persona.ts)

- Every `*.md` in the directory is a part, concatenated in ascending filename
  order — that's why files carry `00_`, `01_` prefixes. Leave gaps to slot
  parts in. Adding/removing a part needs **no code change**.
- Files prefixed `_` are ignored (parked, not deleted).
- YAML frontmatter and HTML comments are **stripped before the model sees
  anything** — `<!-- … -->` blocks are operator notes, safe to write freely.
- `{{AGENT_NAME}}` / `{{AGENT_ROLE}}` / `{{PRODUCT_NAME}}` / `{{COMPANY_NAME}}`
  are substituted; unknown `{{TOKENS}}` pass through verbatim so typos are visible.
- `PROMPT_PARTS_DIR` swaps the whole directory at deploy time.

## Commands

```bash
npm run dev          # port 3003 — NOT 3000
npm run build
npm run lint         # eslint --max-warnings 0 (a single warning fails)
npm run typecheck    # tsc --noEmit
npm run test         # vitest run (jsdom)
npm run prettier     # prettier --write .
npm run setup        # provisions LiveAvatar resources, writes .env.local; safe to re-run
```

Node >= 22 required. Before declaring work done, run `lint`, `typecheck`, and
`test` — lint tolerates zero warnings.

## Conventions

- **No `NEXT_PUBLIC_*` env vars, deliberately.** Every var is server-only and
  no key ever reaches the browser. Don't introduce one without a very good
  reason — the browser gets exactly a session token and an HMAC signature.
- Server-only modules declare `import 'server-only'`. Vitest aliases that
  package to a stub (`src/lib/__test-stubs__/server-only.ts`) so tests can
  exercise server code — see `vitest.config.ts`.
- Import LiveAvatar SDK pieces from `@/lib/vendor/liveavatar-react`, not from
  `@heygen/liveavatar-web-sdk` directly — the vendor layer re-exports the SDK
  and adds the React context/hooks.
- Path alias: `@/` → `src/`.
- All three API routes are `runtime = 'nodejs'` + `force-dynamic`. The brain
  needs Node for fs reads of prompt parts; keep it that way.
- This codebase is comment-dense on purpose: comments record constraints,
  threat models, and browser quirks that the code can't show. Match that
  density when editing, and don't strip existing comments as "cleanup".
- Prettier config lives in `package.json` (single quotes, 100 cols, trailing
  commas).

## Gotchas — read before debugging or "fixing"

**Brain traffic never hits localhost.** LiveAvatar calls the `base_url`
registered in the LLM configuration — a public URL. Running `npm run dev` and
minting a session locally still sends every conversational turn to the
_deployed_ endpoint (or nowhere, if none is configured). To test the brain
locally, curl it directly:

```bash
curl -i -X POST http://localhost:3003/api/chat/completions \
  -H "Authorization: Bearer $AI_SALES_LLM_CONFIG_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"sales-agent","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

**`base_url` is a base, not a route.** LiveAvatar appends `/chat/completions`
itself. Registering the full route produces a doubled path that 404s — symptom:
avatar speaks its opening line, then silence, with _nothing_ in the logs
because the request never reaches a function. Top failure in the whole setup.

**Persona is cached per process.** `loadPersona()` memoizes in module scope
(once per lambda cold start). Editing a prompt part in dev requires a server
restart to take effect. Don't burn time wondering why your edit "didn't work".

**Prompt parts are fs reads and must be traced.** `next.config.js` bundles
`prompt-parts/**/*.md` into each serverless function that calls
`loadPersona()` via `outputFileTracingIncludes`. If you add a new route that
loads the persona, add it there too — otherwise it works locally and
ENOENTs only on Vercel.

**Auth fails closed by design.** `/api/chat/completions` returns 500 while
`AI_SALES_LLM_CONFIG_API_KEY` is unset; `/api/ai-sales/session-end` returns
500 while `AI_SALES_SESSION_SIGNING_SECRET` is unset. These are not bugs.
Never "fix" either route to serve unauthenticated — the first protects the
Anthropic key and the full system prompt; the second stops anyone with the
public URL from spamming the Notion/Slack/Anthropic fan-out.

**The session mint payload is fragile in documented-as-optional ways.**
FULL mode requires exactly one of `avatar_persona` | `voice_agent` (omitting
both is a 422). With `avatar_persona`, `dynamic_variables` sits at the top
level; the `voice_agent` form nests its own and rejects the top-level field.
Dynamic-variable values are clamped to 1000 chars on a word boundary.
`docs/PROVISIONING.md` has the full list of API quirks.

**`AI_SALES_CONTEXT_ID` is required in practice** (the API says optional).
The context supplies `opening_text` — without one the avatar connects and sits
silent. And the context's opening text must keep the literal `${opening_intro}`
placeholder, or every visitor hears the same static greeting.

**The busy shape is a contract.** The mint route returns
`503 { error: { code: 'busy', message } }` when the account is at its
concurrency ceiling or out of credits, and the UI has a dedicated retry stage
keyed on exactly that shape. Keep it intact on both sides.

**session-end always returns 200.** Notion and Slack failures land in the
response body (`notion_error`, `slack_error`) and the logs, never as an HTTP
error — the client treats the call as fire-and-forget.

**`?debug=1`** on the page URL prefixes the Notion row with `[test]` (QA
traffic stays filterable) and renders the debug inspector panel.

## Testing notes

- `vitest` + jsdom + Testing Library; setup file at `src/test-utils/setup.ts`.
- Server modules with process-lifetime caches expose test-only resets
  (`resetPersonaCache()`, `resetLeadResolverCache()`) — use them instead of
  fighting the memoization.
- Route tests live next to routes (e.g.
  `src/app/api/ai-sales/session/__tests__/route.test.ts`) and call the exported
  `POST` handler directly with a constructed `NextRequest`.
