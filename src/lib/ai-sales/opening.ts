/**
 * Picks the agent's opening line based on the visitor's Referer so the first
 * spoken sentence is at least loosely tuned to where they came from.
 *
 * The picked line is PATCHed onto the LiveAvatar Context record before each
 * session token is minted — the LiveKit agent reads `context.opening_text`
 * at session start and says it through TTS as the first turn.
 *
 * Keeping this in code (rather than in the Context record) so it can vary
 * per-visit. The rest of the persona lives in the prompt parts
 * (`src/lib/ai-sales/brain/prompt-parts/`).
 *
 * The agent's name/role/product come from `agent-identity.ts` (env-overridable),
 * so renaming the agent for your own deployment means setting
 * AI_SALES_AGENT_NAME / AI_SALES_AGENT_ROLE / AI_SALES_PRODUCT_NAME — not
 * editing the copy below.
 */
import { agentIdentity, type AgentIdentity } from '@/lib/ai-sales/brain/agent-identity';
import type { LeadProfile } from '@/lib/ai-sales/lead';

type OpeningInput = {
  referer: string | null;
};

type OpeningCategory = 'pricing' | 'integration' | 'build-in-public' | 'default';

function variants({ name, role, product }: AgentIdentity): Record<OpeningCategory, string[]> {
  return {
    pricing: [
      `Hey — saw you were checking out pricing. I'm ${name}, ${role} at ${product}. Want me to walk you through the plans, or do you have a specific use case in mind?`,
      `Hi there! I'm ${name} from ${product}. Pricing got you curious? Tell me a bit about what you're building and I can point you to the right plan.`,
    ],
    integration: [
      `Hey, I'm ${name} from ${product}. Looks like you were poking around the docs — are you evaluating us for a build? Happy to talk SDKs, FULL mode, or anything else.`,
      `Hi! I'm ${name}, ${role} at ${product}. What are you trying to integrate? I can walk you through the SDK, session flow, or the custom LLM hooks.`,
    ],
    'build-in-public': [
      `Hey, welcome! I'm ${name} — the avatar the ${product} team is building in public. Ask me anything about how this was put together, pricing, or the product.`,
      `Hi there! I'm ${name}, ${product}'s AI sales rep. We're building this in public — what brought you by?`,
    ],
    default: [
      `Hey there! I'm ${name}, ${role} at ${product}. What brought you in today?`,
      `Hi! I'm ${name} from ${product}. Happy to talk through product, pricing, or integration — what's on your mind?`,
    ],
  };
}

// Hostname matcher: exact match OR a true subdomain of `domain`. Using
// `host.endsWith('twitter.com')` alone would match `eviltwitter.com`, and
// `host.includes('twitter.com')` would match anywhere in the string, so
// each call requires both an exact-equality and a dot-prefixed-suffix check.
function isHostOf(host: string, domain: string): boolean {
  return host === domain || host.endsWith('.' + domain);
}

function categorize(referer: string | null): OpeningCategory {
  if (!referer) return 'default';
  let parsed: URL;
  try {
    parsed = new URL(referer);
  } catch {
    return 'default';
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();

  // Internal referer from our own marketing site — category by path.
  const isInternal = isHostOf(host, 'liveavatar.com') || isHostOf(host, 'liveavatar.dev');
  if (isInternal) {
    if (path.includes('/pricing')) return 'pricing';
    if (path.includes('/docs') || path.includes('/developers')) return 'integration';
    return 'default';
  }

  // External referers: social/build-in-public channels get a tailored opener.
  // `ycombinator.com` covers both the marketing site and HN (`news.ycombinator.com`)
  // via the subdomain branch of `isHostOf`.
  if (
    isHostOf(host, 'twitter.com') ||
    isHostOf(host, 'x.com') ||
    isHostOf(host, 'linkedin.com') ||
    isHostOf(host, 'ycombinator.com')
  ) {
    return 'build-in-public';
  }

  return 'default';
}

function pickRandom<T>(items: T[]): T {
  const i = Math.floor(Math.random() * items.length);
  return items[i] as T;
}

export function pickOpening({ referer }: OpeningInput): string {
  const category = categorize(referer);
  return pickRandom(variants(agentIdentity())[category]);
}

// Opening used when we already know the visitor's name (deep link, or the
// setup form). Said via TTS the moment the room connects, before any model is
// in the loop, so it has to be a static string. The prompt handles the agent's
// own self-introduction on the first conversational turn — these deliberately
// don't name the rep.
const namedOpeningVariants = ({ product }: AgentIdentity): readonly string[] => [
  'Hey {name}! Nice to meet you — what brings you here today?',
  "Hi {name}! Happy to chat — what's on your mind?",
  `What's up {name}? Happy to tell you more about ${product}.`,
  'Hey {name} — good to meet you. What can I help with?',
  'Hi {name}! What brought you by today?',
  'Hey {name}! Glad you stopped in. What are you looking to do?',
  `What's going on {name}? Happy to dig into anything ${product}.`,
  'Hi {name}, nice meeting you! What are you hoping to figure out?',
  'Hey {name}! Welcome — what brings you in?',
  `Hi {name} — what's the ${product} question on your mind?`,
];

export function buildOpeningIntro(lead: LeadProfile | null, fallbackName?: string): string {
  const name = lead?.first_name ?? fallbackName ?? null;
  if (!name) return 'Hey there! What brings you in today?';
  const variant = pickRandom([...namedOpeningVariants(agentIdentity())]);
  return variant.replace(/\{(\w+)\}/g, (_match, key) => (key === 'name' ? name : ''));
}
