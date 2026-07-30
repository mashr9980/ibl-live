# Provisioning

Everything needed to take this repo from clone to a working avatar session.

The short version: **deploy first, provision second.** The LLM configuration
has to point at a URL LiveAvatar can reach, so the deployment must exist before
you can finish wiring it up.

- [What you need](#what-you-need)
- [Fast path](#fast-path)
- [Manual path](#manual-path)
- [Deploying to Vercel](#deploying-to-vercel)
- [Troubleshooting](#troubleshooting)
- [API quirks worth knowing](#api-quirks-worth-knowing)

## What you need

| Thing                | Where                                                      |
| -------------------- | ---------------------------------------------------------- |
| A LiveAvatar API key | [app.liveavatar.com](https://app.liveavatar.com)           |
| An Anthropic API key | [console.anthropic.com](https://console.anthropic.com)     |
| Somewhere to deploy  | Vercel is assumed below; anything publicly reachable works |

You do **not** need your own avatar. `.env.example` ships the public demo
avatar, which every LiveAvatar account can use.

## Fast path

```bash
npm install
npm run setup                       # seeds .env.local, provisions the session
# add your ANTHROPIC_API_KEY to .env.local
npm run dev                         # http://localhost:3003
```

At this point the avatar connects and greets you, but answers come from your
account's **default LLM** — not this app's prompt. That's expected: connecting
the brain needs a public URL, which localhost isn't.

Once deployed, re-run against the deployment and the brain gets wired:

```bash
npm run setup -- --url https://your-app.vercel.app
```

`npm run setup` is safe to re-run. Anything already in `.env.local` is reused,
never recreated.

## Manual path

If you'd rather do it by hand, or want to understand what the script does.

**1. Register the key that protects your endpoint.** You invent this value; it
is not issued to you. Generate something strong:

```bash
openssl rand -hex 32
```

```bash
curl -X POST https://api.liveavatar.com/v1/secrets \
  -H "X-API-KEY: $LIVEAVATAR_API_KEY" -H 'Content-Type: application/json' \
  -d '{"secret_type":"OPENAI_API_KEY","secret_name":"sales-agent-brain","secret_value":"<the value you generated>"}'
```

`secret_type` is **`OPENAI_API_KEY`** — this app's endpoint speaks the OpenAI
chat/completions protocol, so that's the correct type. Returns a `secret_id`.

**2. Create the LLM configuration.**

```bash
curl -X POST https://api.liveavatar.com/v1/llm-configurations \
  -H "X-API-KEY: $LIVEAVATAR_API_KEY" -H 'Content-Type: application/json' \
  -d '{"secret_id":"<from step 1>","display_name":"sales-agent","model_name":"sales-agent","base_url":"https://your-app.vercel.app/api"}'
```

**`base_url` is the base, not the route.** LiveAvatar appends
`/chat/completions` itself, the way any OpenAI client does. See
[Troubleshooting](#troubleshooting) — getting this wrong is the single most
confusing failure in the whole setup. Returns an `llm_configuration_id`.

**3. Create a context.** This supplies the line the avatar speaks the instant
the room connects, before any model is involved.

```bash
curl -X POST https://api.liveavatar.com/v1/contexts \
  -H "X-API-KEY: $LIVEAVATAR_API_KEY" -H 'Content-Type: application/json' \
  -d '{"name":"sales-agent","prompt":"You are a friendly, concise sales agent.","opening_text":"${opening_intro}"}'
```

Two things about `opening_text`:

- **It is spoken verbatim.** Anything you put there gets read out loud, so
  don't leave notes to yourself in it.
- **Keep `${opening_intro}` exactly as written.** This app generates a greeting
  per visitor — using their name, and their company if you've wired a lead
  resolver — and passes it through `dynamic_variables` for substitution. Replace
  the placeholder with static text and every visitor hears the same line. It
  will look like it's working.

**4. Fill in `.env.local`** with the `secret_value` from step 1
(`AI_SALES_LLM_CONFIG_API_KEY`), the id from step 2 (`LLM_CONFIGURATION_ID`),
and the id from step 3 (`AI_SALES_CONTEXT_ID`).

## Deploying to Vercel

The ordering matters, because of the circular dependency.

```bash
vercel link                 # interactive; create a new project
vercel --prod               # deploy — succeeds with no env vars set at all
```

The build reads no configuration, so this works before anything is provisioned.
It gives you the production URL you need for the next step.

```bash
npm run setup -- --url https://your-app.vercel.app
```

**Use the production domain, not a preview URL.** Preview deployments get a new
URL per commit, so an LLM configuration pointed at one silently breaks on your
next push.

Then get the env vars into Vercel — `.env.local` is gitignored and never
deploys. In **Project → Settings → Environment Variables**, the dashboard
accepts a pasted `.env` file, so you can copy the contents of `.env.local`
straight in and review the list before saving.

Skip `VERCEL_OIDC_TOKEN` if it's present — Vercel injects that one itself.

```bash
vercel --prod               # env changes only apply to new deployments
```

## Troubleshooting

| Symptom                                                                         | Cause                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Avatar speaks its opening line, then **silence** — and **nothing** in your logs | `base_url` includes `/chat/completions`. LiveAvatar appends the route, so the request goes to a doubled path, 404s, and never reaches a function — which is why there's nothing to log. Set `base_url` to `https://your-app/api`. |
| Avatar connects but **never says anything at all**                              | No `AI_SALES_CONTEXT_ID`. The context supplies `opening_text`; without one there's nothing to speak.                                                                                                                              |
| Every visitor hears the **same greeting**                                       | The context's `opening_text` is missing the `${opening_intro}` placeholder.                                                                                                                                                       |
| Mint fails: `Provide exactly one of avatar_persona or voice_agent`              | FULL mode requires one of them. This app always sends `avatar_persona`, so you shouldn't hit this unless you've edited the mint route.                                                                                            |
| Mint fails with a 422 on `dynamic_variables`                                    | A value exceeded 1000 characters. The app clamps on a word boundary, so this only bites if you've added your own variables.                                                                                                       |
| Brain returns **500**                                                           | `AI_SALES_LLM_CONFIG_API_KEY` is unset on the deployment. Fail-closed by design.                                                                                                                                                  |
| Brain returns **401**                                                           | The key is set but doesn't match the registered secret. Secret values can't be read back — register a new one and update both sides.                                                                                              |
| Session end writes nothing                                                      | `AI_SALES_SESSION_SIGNING_SECRET` unset. The route fail-closes with a 500 rather than accepting unsigned requests.                                                                                                                |
| Env changes had no effect                                                       | Vercel applies env vars at deploy time. Redeploy.                                                                                                                                                                                 |
| Running locally, no brain requests anywhere                                     | Expected. LiveAvatar calls the deployed `base_url`, never your machine — the calls appear in your **deployment's** logs even when you mint from localhost.                                                                        |

Verifying the endpoint directly is the fastest way to isolate a problem:

```bash
curl -i -X POST https://your-app.vercel.app/api/chat/completions \
  -H "Authorization: Bearer $AI_SALES_LLM_CONFIG_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"sales-agent","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

`200` with `text/event-stream` means the endpoint, the key, and your Anthropic
key are all fine — and the problem is in the configuration pointing at it.

## API quirks worth knowing

Things the API reference doesn't currently make obvious, all discovered while
building this:

- **`base_url` is a base.** `/chat/completions` is appended for you.
- **`POST /v1/llm-configurations` uses a hyphen.** Some docs write
  `llm_configurations` with an underscore; that path 404s.
- **`secret_type` has no `LLM_API_KEY`.** The enum is `OPENAI_API_KEY`,
  `ELEVENLABS_API_KEY`, `GEMINI_API_KEY`.
- **FULL mode requires exactly one of `avatar_persona` or `voice_agent`**,
  though both are documented as optional. Omitting both is a 422.
- **A context is effectively required.** `context_id` is documented as optional,
  but without one the avatar has nothing to say when the room opens.
- **`GET /v1/llm-configurations` omits `base_url`** from list items. Fetch a
  single configuration by id to see it — the list view will look like the field
  was never set.
- **If you use `voice_agent` instead of `avatar_persona`**, `dynamic_variables`
  must move inside the `voice_agent` object; setting both it and the top-level
  field is a 400.
