# ibl.ai live guide

A real-time AI avatar that answers visitors' questions about [ibl.ai](https://ibl.ai).
The face and voice come from HeyGen's [LiveAvatar](https://liveavatar.com).
The answers come from an OpenAI-compatible brain: ibl.ai's own inference API by
default, or OpenAI when a key is set.

Built from HeyGen's open-source
[liveavatar-sales-agent](https://github.com/heygen-com/liveavatar-sales-agent)
(MIT), with the persona, the brain and the copy replaced.

## How it works

1. The browser asks this app for a session token. The app mints it with the
   LiveAvatar API and never exposes any key.
2. LiveAvatar streams the avatar to the browser over LiveKit and listens to
   the visitor's microphone.
3. On every turn LiveAvatar calls this app's brain route,
   `/api/chat/completions`, which assembles the ibl.ai persona and streams the
   answer back as OpenAI-style events.

## Quick start

Requires Node 22 or newer.

```bash
npm install
npm run setup     # asks for your LiveAvatar API key and creates the context
npm run dev       # http://localhost:3003
```

Add the brain to `.env.local`: either `OPENAI_API_KEY`, or `IBLAI_API_KEY`
and `IBLAI_ORG`. Locally the avatar greets you but answers with the account's
default model, because LiveAvatar cannot reach localhost. The brain is
connected once the app has a public URL (see Deploy).

Set `AI_SALES_SANDBOX=1` while wiring things up: sandbox sessions cost no
credits, use the public Wayne avatar and last one minute.

## Configuration

All variables are server-only. `npm run setup` fills in the LiveAvatar ones.

| Variable                                     | Purpose                                                          |
| -------------------------------------------- | ---------------------------------------------------------------- |
| `LIVEAVATAR_API_KEY`                         | LiveAvatar key, from app.liveavatar.com                          |
| `AI_SALES_AVATAR_ID`                         | Avatar to use; prefilled with the public demo avatar             |
| `AI_SALES_CONTEXT_ID`                        | Context that supplies the opening line                           |
| `AI_SALES_MAX_SESSION_DURATION`              | Session cap in seconds; free tier allows 120                     |
| `AI_SALES_AGENT_NAME`, `AI_SALES_AGENT_ROLE` | Who the avatar is; prefilled as Ivy, AI Guide                    |
| `OPENAI_API_KEY`, `OPENAI_MODEL`             | Use OpenAI as the brain (default model gpt-4.1)                  |
| `IBLAI_API_KEY`, `IBLAI_ORG`, `IBLAI_MODEL`  | Use ibl.ai as the brain (default google/gemini-3.1-flash-lite)   |
| `AI_SALES_LLM_CONFIG_API_KEY`                | Secret that protects the brain route; registered with LiveAvatar |
| `LLM_CONFIGURATION_ID`                       | LiveAvatar LLM configuration that points at this app             |
| `AI_SALES_SESSION_SIGNING_SECRET`            | Signs session ids for the session-end route                      |
| `AI_SALES_SANDBOX`                           | `1` for credit-free sandbox sessions; unset in production        |

Optional: `NOTION_TOKEN`, `NOTION_DATABASE_ID`, `SLACK_WEBHOOK_URL` write a
summary after each call. Leave them blank to skip.

## Deploy to Vercel

1. Import the repository in Vercel. Framework: Next.js.
2. Add the variables above from your `.env.local`, without `AI_SALES_SANDBOX`.
3. Deploy and note the production URL.
4. Point LiveAvatar at it. Either run
   `npm run setup -- --url https://your-app.vercel.app` and copy the resulting
   `LLM_CONFIGURATION_ID` into Vercel, or update an existing configuration:

   ```bash
   curl -X PUT https://api.liveavatar.com/v1/llm-configurations/<id> \
     -H "X-API-KEY: $LIVEAVATAR_API_KEY" -H "Content-Type: application/json" \
     -d '{"base_url":"https://your-app.vercel.app/api"}'
   ```

   `base_url` is the base. LiveAvatar appends `/chat/completions` itself.

5. Open the URL, enter a name, allow the microphone and ask a question.

Live minutes cost LiveAvatar credits: two per minute in FULL mode, ten a
month on the free tier.

## The persona

The system prompt is assembled from the Markdown files in
`src/lib/ai-sales/brain/prompt-parts/`, in filename order: who Ivy is, how
she speaks, what ibl.ai is, published pricing and customers, resources and
guardrails. Everything in them comes from the public ibl.ai website. Facts
that are not published are listed explicitly so the avatar declines instead
of guessing. Edit the files, or point `PROMPT_PARTS_DIR` at your own folder.

## Scripts

```bash
npm run dev         # local server on port 3003
npm run build       # production build
npm test            # unit tests
npm run lint        # eslint
npm run typecheck   # tsc
```

## License

MIT. See LICENSE and THIRD_PARTY_NOTICES.md.
