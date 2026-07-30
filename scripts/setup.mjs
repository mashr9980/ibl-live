#!/usr/bin/env node
/**
 * One-shot provisioning for a fresh deployment.
 *
 *   npm run setup -- --url https://your-app.vercel.app
 *
 * Walks the LiveAvatar account, creates only what's missing, and writes the
 * results into .env.local. Safe to re-run: every resource is looked up by name
 * first, so a second run reports "exists" instead of creating duplicates.
 *
 * If .env.local doesn't exist it is seeded from .env.example first, so the
 * operator keeps every documented variable and its comments.
 *
 * A LiveAvatar API key is required up front — every step is an authenticated
 * call. It is read from .env.local, then the environment, then prompted for,
 * and verified before anything else runs.
 *
 * In your LiveAvatar account:
 *   1. Avatar     — the public demo avatar, unless AI_SALES_AVATAR_ID is set
 *   2. Context    — supplies the spoken opening line (${opening_intro})
 *   3. Secret     — the API key protecting this app's /api/chat/completions
 *   4. LLM config — points that endpoint back at your deployment
 *
 * Steps 3 and 4 are a pair and both need a publicly reachable URL: the secret
 * exists only to be referenced by the LLM configuration, so without --url
 * neither is created. Re-run with --url once you've deployed.
 *
 * Anything already named in .env.local is reused as-is and never re-created.
 *
 * Then, purely local (no API calls, nothing registered upstream):
 *   - AI_SALES_SESSION_SIGNING_SECRET, the HMAC key that stops anyone from
 *     POSTing forged transcripts at /api/ai-sales/session-end.
 */
import { randomBytes } from 'node:crypto';
import { copyFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const ENV_PATH = '.env.local';
const ENV_TEMPLATE = '.env.example';
const DEFAULT_API_BASE = 'https://api.liveavatar.com';

// Labels for the resources this script creates. Nothing is looked up by them —
// .env.local is the source of truth for what already exists — so they only
// need to be recognisable in the LiveAvatar dashboard.
// Wayne, the public demo avatar — shared across all accounts, so it is a safe
// default for a fresh deployment. Overridden by AI_SALES_AVATAR_ID.
const DEFAULT_AVATAR_ID = 'dd73ea75-1218-4ef3-92ce-606d5f7fbc0a';

const CONTEXT_NAME = 'liveavatar-sales-agent';
const SECRET_NAME = 'liveavatar-sales-agent-brain';
const LLM_CONFIG_NAME = 'liveavatar-sales-agent';

// The model name is cosmetic — the real model is chosen inside this app's
// /api/chat/completions. It only has to be non-empty.
const LLM_MODEL_NAME = 'sales-agent';

// Spoken verbatim the moment the room connects, so it holds the placeholder
// and nothing else — the app generates the whole greeting per visitor and
// substitutes it here. Anything extra in this string gets read out loud.
const OPENING_TEXT = '${opening_intro}';

// The context's own persona. Only reached if no custom LLM is attached; once
// LLM_CONFIGURATION_ID is set, this app's prompt-parts drive the conversation.
// Kept short and usable rather than describing the plumbing.
const CONTEXT_PROMPT =
  'You are a friendly, concise sales agent. Answer questions about the ' +
  'product honestly, ask what the visitor is trying to build, and suggest a ' +
  'next step. Never invent pricing or capabilities you are unsure of.';

const rl = createInterface({ input: stdin, output: stdout });
const ask = async (q, fallback = '') => (await rl.question(q)).trim() || fallback;

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};
const ok = (s) => console.log(`  ${c.green('✓')} ${s}`);
const info = (s) => console.log(`  ${c.dim('·')} ${c.dim(s)}`);
const warn = (s) => console.log(`  ${c.yellow('!')} ${s}`);

/**
 * Parse .env.local into a map. Values may carry a trailing `# comment` (the
 * template is full of them), so an unquoted value is cut at the first
 * whitespace-preceded hash — a bare `#` inside a secret is left alone.
 */
function readEnvFile() {
  if (!existsSync(ENV_PATH)) return {};
  const out = {};
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2] ?? '';
    const quoted = /^(["'])(.*)\1/.exec(value);
    if (quoted) {
      value = quoted[2];
    } else if (value.startsWith('#')) {
      // The whole "value" is an inline comment on an unset key.
      value = '';
    } else {
      value = value.split(/\s+#/)[0].trim();
    }
    out[m[1]] = value;
  }
  return out;
}

/**
 * Merge keys into .env.local, rewriting existing lines in place and appending
 * the rest. Never drops unrelated lines or comments.
 */
function writeEnvFile(updates) {
  const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8').split('\n') : [];
  const remaining = { ...updates };
  const rewritten = lines.map((line) => {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (m && m[1] in remaining) {
      const key = m[1];
      const value = remaining[key];
      delete remaining[key];
      const comment = line.includes('#') ? `   ${line.slice(line.indexOf('#'))}` : '';
      return `${key}=${value}${comment}`;
    }
    return line;
  });
  const appended = Object.entries(remaining).map(([k, v]) => `${k}=${v}`);
  if (appended.length) {
    if (rewritten.at(-1)?.trim() !== '') rewritten.push('');
    rewritten.push('# Added by `npm run setup`', ...appended, '');
  }
  writeFileSync(ENV_PATH, rewritten.join('\n'));
}

async function api(apiBase, apiKey, path, init = {}) {
  const res = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      'X-API-KEY': apiKey,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}\n${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text).data;
  } catch {
    throw new Error(`${path} returned non-JSON:\n${text.slice(0, 200)}`);
  }
}

async function main() {
  console.log(`\n${c.bold('LiveAvatar Sales Agent — setup')}\n`);

  // Seed from the template so the operator ends up with every documented var
  // and its comments, not just the handful this script fills in.
  if (!existsSync(ENV_PATH) && existsSync(ENV_TEMPLATE)) {
    copyFileSync(ENV_TEMPLATE, ENV_PATH);
    ok(`created ${ENV_PATH} from ${ENV_TEMPLATE}`);
    console.log('');
  }

  const env = readEnvFile();
  const urlArg = process.argv.indexOf('--url');
  let appUrl = urlArg !== -1 ? process.argv[urlArg + 1] : '';

  const apiBase = (env.LIVEAVATAR_API_URL || DEFAULT_API_BASE).replace(/\/+$/, '');

  // ── 0. API key ─────────────────────────────────────────────────────────────
  // Everything below is an authenticated call, so resolve and verify the key
  // before doing anything else — a bad key should fail here with one clear
  // message, not three steps in with an opaque 401.
  console.log(c.bold('0. LiveAvatar API key'));
  const fromFile = Boolean(env.LIVEAVATAR_API_KEY);
  const apiKey =
    env.LIVEAVATAR_API_KEY ||
    process.env.LIVEAVATAR_API_KEY ||
    (await ask(`  Not found in ${ENV_PATH}. Paste your API key: `));

  if (!apiKey) {
    console.error(
      c.red('\n  No API key given.') +
        `\n  Create one at app.liveavatar.com, then either add it to ${ENV_PATH}:\n` +
        c.dim('      LIVEAVATAR_API_KEY=la_...\n') +
        '  or re-run and paste it when asked.\n',
    );
    process.exit(1);
  }

  try {
    await api(apiBase, apiKey, '/v1/avatars?page_size=1');
  } catch (err) {
    const rejected = /→ 40[13]/.test(err.message);
    console.error(
      c.red(`\n  ${rejected ? 'That API key was rejected.' : 'Could not reach the API.'}`) +
        `\n  ${rejected ? 'Check it at app.liveavatar.com.' : `Tried ${apiBase}.`}\n` +
        c.dim(`  ${err.message.split('\n')[0]}\n`),
    );
    process.exit(1);
  }
  ok(`key verified ${c.dim(fromFile ? `(from ${ENV_PATH})` : '(will be saved)')}`);

  const updates = { LIVEAVATAR_API_KEY: apiKey };

  // ── 1. Avatar ──────────────────────────────────────────────────────────────
  console.log(c.bold('\n1. Avatar'));
  const avatarId = env.AI_SALES_AVATAR_ID || DEFAULT_AVATAR_ID;
  if (env.AI_SALES_AVATAR_ID) {
    ok(`using ${avatarId} ${c.dim('(from .env.local)')}`);
  } else {
    ok(`using Wayne, the public demo avatar ${c.dim(avatarId)}`);
    info('set AI_SALES_AVATAR_ID to use one of your own — see /v1/avatars');
  }
  updates.AI_SALES_AVATAR_ID = avatarId;

  // ── 2. Context ─────────────────────────────────────────────────────────────
  // Required: without one the avatar connects and then says nothing. We don't
  // search by name — an id in .env.local is authoritative, and anything else
  // gets a fresh context so a hand-edited one is never silently adopted.
  console.log(c.bold('\n2. Context (the spoken opening line)'));
  if (env.AI_SALES_CONTEXT_ID) {
    ok(`using ${env.AI_SALES_CONTEXT_ID} ${c.dim('(from .env.local)')}`);
    updates.AI_SALES_CONTEXT_ID = env.AI_SALES_CONTEXT_ID;
  } else {
    const created = await api(apiBase, apiKey, '/v1/contexts', {
      method: 'POST',
      body: JSON.stringify({
        name: CONTEXT_NAME,
        prompt: CONTEXT_PROMPT,
        opening_text: OPENING_TEXT,
      }),
    });
    ok(`created "${CONTEXT_NAME}" ${c.dim(created.id)}`);
    info('opening text is just ${opening_intro} — the app fills it per visitor');
    updates.AI_SALES_CONTEXT_ID = created.id;
  }

  // ── 3 + 4. Brain wiring ────────────────────────────────────────────────────
  // The secret exists only to be referenced by the LLM configuration, so the
  // two are created together or not at all. Both need a URL LiveAvatar can
  // reach — it calls /api/chat/completions over the public internet, so
  // localhost is not an option.
  console.log(c.bold('\n3. Connecting the brain'));
  if (!appUrl) {
    appUrl = await ask(`  Public URL of your deployment ${c.dim('(blank to skip)')}: `);
  }

  if (!appUrl) {
    warn('skipped — needs a publicly reachable URL');
    info('sessions will fall back to your account default LLM: the avatar talks,');
    info("but not with this app's prompt. Deploy (or tunnel), then re-run:");
    info('  npm run setup -- --url https://your-deployment.example.com');
  } else if (env.LLM_CONFIGURATION_ID) {
    ok(`using ${env.LLM_CONFIGURATION_ID} ${c.dim('(from .env.local)')}`);
    updates.LLM_CONFIGURATION_ID = env.LLM_CONFIGURATION_ID;
  } else {
    // LiveAvatar appends `/chat/completions` itself, the same way an OpenAI
    // client treats a base URL — so this is the base, NOT the full route.
    // Including the route yields a doubled path that 404s silently: the avatar
    // speaks its opening line and then goes quiet, with nothing in the logs
    // because the request never reaches a function.
    const baseUrl = `${appUrl.replace(/\/+$/, '')}/api`;

    // Generated here rather than asked for: it only has to match on both
    // sides, and both sides are written by this script.
    const brainKey = env.AI_SALES_LLM_CONFIG_API_KEY || randomBytes(32).toString('hex');
    const secret = await api(apiBase, apiKey, '/v1/secrets', {
      method: 'POST',
      body: JSON.stringify({
        // Our endpoint speaks the OpenAI chat/completions protocol, so it is
        // registered as an OpenAI-compatible key.
        secret_type: 'OPENAI_API_KEY',
        secret_name: `${SECRET_NAME}-${Date.now()}`,
        secret_value: brainKey,
      }),
    });
    ok(`registered the endpoint key ${c.dim(secret.id)}`);
    updates.AI_SALES_LLM_CONFIG_API_KEY = brainKey;

    const created = await api(apiBase, apiKey, '/v1/llm-configurations', {
      method: 'POST',
      body: JSON.stringify({
        display_name: LLM_CONFIG_NAME,
        model_name: LLM_MODEL_NAME,
        secret_id: secret.id,
        base_url: baseUrl,
      }),
    });
    ok(`created LLM configuration ${c.dim(created.id)}`);
    info(`base_url → ${baseUrl}`);
    updates.LLM_CONFIGURATION_ID = created.id;
  }

  // ── Local secrets ──────────────────────────────────────────────────────────
  // Independent of everything above: never sent to LiveAvatar, needed whether
  // or not the LLM configuration got created.
  console.log(c.bold('\nLocal secrets') + c.dim(' (not registered with LiveAvatar)'));
  if (env.AI_SALES_SESSION_SIGNING_SECRET) {
    ok('AI_SALES_SESSION_SIGNING_SECRET already set');
  } else {
    updates.AI_SALES_SESSION_SIGNING_SECRET = randomBytes(32).toString('hex');
    ok('generated AI_SALES_SESSION_SIGNING_SECRET');
    info('signs the session id at mint so /api/ai-sales/session-end can reject');
    info('forged transcripts — without it the Notion/Slack fan-out is open to all');
  }
  if (!env.ANTHROPIC_API_KEY) {
    warn('ANTHROPIC_API_KEY is not set — the agent cannot think without it');
    info('add it to .env.local by hand');
  }

  writeEnvFile(updates);
  console.log(`\n${c.green('Done.')} Wrote ${Object.keys(updates).length} keys to ${ENV_PATH}.`);
  console.log(`Run ${c.bold('npm run dev')} and open http://localhost:3003\n`);
}

main()
  .catch((err) => {
    console.error(`\n${c.red('Setup failed:')} ${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
