# ibl.ai live guide

A real-time AI avatar that answers visitors' questions about [ibl.ai](https://ibl.ai):
the face and voice are HeyGen's [LiveAvatar](https://liveavatar.com), the brain
is ibl.ai's own platform. Built from HeyGen's open-source
[liveavatar-sales-agent](https://github.com/heygen-com/liveavatar-sales-agent)
(MIT), with the persona, the brain and the copy replaced.

## What's in the box

- **Real-time avatar session** — browser ↔ LiveKit via `@heygen/liveavatar-web-sdk`.
- **The brain** (`/api/chat/completions`) — an OpenAI-compatible endpoint the
  avatar calls each turn. Assembles the ibl.ai persona (prompt parts) plus
  today's date and optional visitor context, then streams ibl.ai's
  OpenAI-compatible chat endpoint back as OpenAI-shaped SSE.
- **Session close** (`/api/ai-sales/session-end`) — optional summary through
  ibl.ai → Notion → Slack. All env-gated; leave blank to skip.

## Quick start

```bash
# 1. Install (Node >= 22)
npm install

# 2. Provision your LiveAvatar account and write .env.local
npm run setup        # asks for your LiveAvatar API key, then provisions what's missing

# 3. Add the ibl.ai brain to .env.local
#    IBLAI_API_KEY=<Platform API Token>   IBLAI_ORG=<organization key>

# 4. Run (port 3003)
npm run dev
```

`npm run setup` picks an avatar, creates the context that supplies the opening
line, and generates the local signing secret. Connecting the brain needs a URL
LiveAvatar can reach, so re-run with `--url https://<your deployment>` once
deployed; until then the avatar answers with the account's default LLM.

## Deploy to Vercel

1. Push this repo to GitHub and import it in Vercel (framework: Next.js, no
   build settings to change).
2. In the Vercel project, Settings → Environment Variables, add every
   non-empty value from your local `.env.local` **except** `AI_SALES_SANDBOX`
   (leave it unset in production) and set `AI_SALES_MAX_SESSION_DURATION`
   to what your LiveAvatar tier allows (free tier: `120`).
3. Deploy. Note the production URL, for example `https://ibl-live.vercel.app`.
4. Point LiveAvatar's LLM configuration at it, so the avatar's turns reach
   this app's brain over the internet:

   ```bash
   npm run setup -- --url https://ibl-live.vercel.app
   ```

   This creates (or reuses) the secret and the LLM configuration and writes
   `LLM_CONFIGURATION_ID` to `.env.local`. Copy that value into Vercel too and
   redeploy. If a configuration already exists from a tunnel or an earlier URL,
   update its `base_url` instead:

   ```bash
   curl -X PUT https://api.liveavatar.com/v1/llm-configurations/<id> \
     -H "X-API-KEY: $LIVEAVATAR_API_KEY" -H 'Content-Type: application/json' \
     -d '{"base_url":"https://ibl-live.vercel.app/api"}'
   ```

   `base_url` is the base; LiveAvatar appends `/chat/completions` itself.

5. Open the production URL, give a name, allow the microphone, and ask a
   question. Each live minute costs LiveAvatar credits (2 per minute in FULL
   mode); the free tier has 10 credits a month.

## The agent's prompt

The system prompt is assembled from the Markdown files in
`src/lib/ai-sales/brain/prompt-parts/`, concatenated in filename order
(`00_prompt_outline.md`, `01_agent_info.md`, …). Edit a part and redeploy to
change the agent's behavior. Rules:

- Every `*.md` in the directory is a part — adding or removing one needs no
  code change.
- Files prefixed with `_` are ignored, so you can park a part without
  deleting it.
- YAML frontmatter and HTML comments are stripped, so `<!-- … -->` notes are
  documentation for you, not input for the model.
- `{{AGENT_NAME}}`, `{{AGENT_ROLE}}`, `{{PRODUCT_NAME}}` and
  `{{COMPANY_NAME}}` are substituted from the `AI_SALES_AGENT_*` /
  `AI_SALES_PRODUCT_NAME` / `AI_SALES_COMPANY_NAME` env vars.

Several parts ship as scaffolds with an `OPERATOR SCAFFOLD` comment marking
where to add your own pricing, competitor handling, and customer stories.

Set `PROMPT_PARTS_DIR` to point at a different directory to replace the
bundled prompt wholesale at deploy time — useful for keeping a real sales
prompt outside the repo.

The parts directory is bundled into the serverless functions at build time
via `outputFileTracingIncludes` in `next.config.js`.

## Configuration

Grouped the same way as `.env.example`.

**1. The session** — who the agent is and how it connects. `npm run setup`
fills all of this in; the API key is the only value it can't invent.

| Var                                                                                               | Required | Purpose                                                               |
| ------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------- |
| `LIVEAVATAR_API_KEY`                                                                              | ✅       | Sent as `X-API-KEY` when minting a session                            |
| `AI_SALES_AVATAR_ID`                                                                              | ✅       | Avatar UUID; prefilled with the public demo avatar, so it works as-is |
| `AI_SALES_CONTEXT_ID`                                                                             | ✅       | Supplies the spoken opening line — see below                          |
| `AI_SALES_AGENT_NAME` / `AI_SALES_AGENT_ROLE` / `AI_SALES_PRODUCT_NAME` / `AI_SALES_COMPANY_NAME` | —        | Agent identity, in both the prompt and the UI; prefilled              |
| `AI_SALES_VOICE_ID`                                                                               | —        | Voice UUID; blank uses the avatar's default voice                     |
| `AI_SALES_LANGUAGE`                                                                               | —        | Spoken language (default `en`)                                        |
| `AI_SALES_MAX_SESSION_DURATION`                                                                   | —        | Per-session cap in seconds (default `600`), ≤ your tier's limit       |
| `LIVEAVATAR_API_URL`                                                                              | —        | Override the API host                                                 |

**2. The brain** — what the agent actually says. Skip this section and the
avatar still connects and greets people, but answers come from your account's
default LLM rather than this app's prompt.

| Var                           | Required | Purpose                                                                   |
| ----------------------------- | -------- | ------------------------------------------------------------------------- |
| `IBLAI_API_KEY` / `IBLAI_ORG` | ✅       | ibl.ai Platform API Token and organization key: the brain                 |
| `IBLAI_MODEL`                 | —        | `provider/model` on the platform (default `google/gemini-3.1-flash-lite`) |
| `IBLAI_ASGI_URL`              | —        | Streaming host; only for self-hosted ibl.ai                               |
| `AI_SALES_LLM_CONFIG_API_KEY` | ✅       | Protects this app's `/api/chat/completions` — see below                   |
| `LLM_CONFIGURATION_ID`        | —        | Routes each turn to this app's brain; blank = account default LLM         |
| `PROMPT_PARTS_DIR`            | —        | Override the bundled prompt-parts directory                               |
| `AI_SALES_LEAD_RESOLVER`      | —        | Lead-enrichment implementation; blank = no-op stub, no lookups            |

**3. After the call** — summary fan-out on disconnect. Both integrations are
independent; leave either blank to skip it.

| Var                                   | Required | Purpose                                          |
| ------------------------------------- | -------- | ------------------------------------------------ |
| `AI_SALES_SESSION_SIGNING_SECRET`     | ✅       | HMAC binding session-end to a session you minted |
| `NOTION_TOKEN` / `NOTION_DATABASE_ID` | —        | CRM upsert on session end                        |
| `SLACK_WEBHOOK_URL`                   | —        | Slack ping on session end                        |

### The opening line

`AI_SALES_CONTEXT_ID` is required. A context supplies the avatar's
`opening_text` — the first thing it says the moment the room connects, spoken
before any model is in the loop. Mint a session without one and the avatar
connects and then stays silent.

Create a context once (`POST /v1/contexts`, or in the dashboard). To get the
per-visitor greeting this app builds — which uses the visitor's name and, if a
lead resolver is configured, their company — include the placeholder
`${opening_intro}` in the context's opening text. The mint passes the generated
line through `dynamic_variables` and LiveAvatar substitutes it at dispatch.

Everything the avatar says _after_ that first line comes from this app's prompt
via `LLM_CONFIGURATION_ID`, so the context's own knowledge fields can stay
minimal — it's carrying the greeting, not the persona.

### Connecting the brain

`/api/chat/completions` is an OpenAI-compatible endpoint served by this app.
LiveAvatar calls it over the public internet on every conversational turn, so
it has to be reachable and it has to be authenticated. Wire it up once:

Easiest path — `npm run setup` provisions all of it and writes `.env.local`:

```bash
npm run setup -- --url https://your-deployment.example.com
```

It inspects the account first and only creates what's missing, so it's safe to
re-run. Doing it by hand instead:

```bash
# 1. Register the key that will protect your endpoint. Pick any strong random
#    value — this is the same string you put in AI_SALES_LLM_CONFIG_API_KEY.
curl -X POST https://api.liveavatar.com/v1/secrets \
  -H "X-API-KEY: $LIVEAVATAR_API_KEY" -H 'Content-Type: application/json' \
  -d '{"secret_type":"OPENAI_API_KEY","secret_name":"sales-agent-brain","secret_value":"<your-value>"}'

# 2. Point an LLM configuration at your deployed endpoint.
curl -X POST https://api.liveavatar.com/v1/llm-configurations \
  -H "X-API-KEY: $LIVEAVATAR_API_KEY" -H 'Content-Type: application/json' \
  -d '{"secret_id":"<from step 1>","display_name":"sales-agent","model_name":"sales-agent","base_url":"<your-api-url>"}'
```

Note `base_url` is the **base**, not the full route — LiveAvatar appends
`/chat/completions` itself, exactly as an OpenAI client would. Passing the
complete route produces a doubled path that 404s: the avatar speaks its opening
line and then goes silent, with nothing in your logs, because the request never
reaches a function.

Put the returned id in `LLM_CONFIGURATION_ID` and redeploy. At runtime
LiveAvatar presents the key back as `Authorization: Bearer <value>`, exactly as
it would to OpenAI, and the app compares the two in constant time.

Leave `LLM_CONFIGURATION_ID` unset and sessions fall back to your account's
default LLM — the avatar still talks, but not with this app's prompt. That's a
useful first step when checking the session flow locally, since step 2 needs a
publicly reachable URL (deploy a preview, or tunnel with ngrok/cloudflared).

### Session mint

`/api/ai-sales/session` mints the browser's session token via
`POST /v1/sessions/token` on the public LiveAvatar API, authenticated with
`LIVEAVATAR_API_KEY` and created in **FULL** mode. It needs an API key, an
avatar id, and — to route the conversation through this app's own brain — an
`LLM_CONFIGURATION_ID`. Sessions run up to `AI_SALES_MAX_SESSION_DURATION`
seconds.

When the account is at its concurrency ceiling or out of credits, the mint
returns `503 { error: { code: "busy" } }` and the UI shows a busy state with a
retry button.

## After the call

When a session disconnects, the app summarizes the transcript through ibl.ai
and fans the result out to Notion and Slack. Both are optional and independent
— leave either set of env vars blank and that half is skipped silently.

`npm run setup` does **not** provision these; they're your own workspaces.

**Notion.** Create an internal integration at
[notion.so/my-integrations](https://www.notion.so/my-integrations), share your
database with it, then set `NOTION_TOKEN` and `NOTION_DATABASE_ID`. The app
upserts by email — one page per lead, with each conversation appended — so the
database needs matching properties.

We've published the template we use, so you can duplicate it instead of
building the schema by hand:

**[LiveAvatar Sales Agent — Notion template](https://heygen.notion.site/liveavatar-sales-agent-template?v=725449792c6983be965d883ac3eaa894)**

**Slack.** Create an incoming webhook and set `SLACK_WEBHOOK_URL`. The webhook
URL is bound to a single channel when you create it, so you choose the
destination there rather than in this app. Notion runs first so its page link
can be included in the Slack message.

Add `?debug=1` to the page URL during testing — it prefixes the Notion row with
`[test]` so QA sessions stay filterable from real traffic.

## Scripts

```bash
npm run dev          # dev server, port 3003
npm run build        # production build
npm run start        # serve the build
npm run setup        # provision a few setups
npm run lint         # eslint (max-warnings 0)
npm run typecheck    # tsc --noEmit
npm run test         # vitest
```

## License

MIT — see [LICENSE](LICENSE).
