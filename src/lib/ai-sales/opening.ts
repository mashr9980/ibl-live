import { agentIdentity, type AgentIdentity } from '@/lib/ai-sales/brain/agent-identity';
import type { LeadProfile } from '@/lib/ai-sales/lead';

/**
 * The avatar's first spoken line, chosen before any model is in the loop.
 * The picked line is passed as `${opening_intro}` through the session's
 * dynamic variables and substituted into the LiveAvatar Context.
 */

type OpeningInput = {
  referer: string | null;
};

type OpeningCategory = 'pricing' | 'docs' | 'solutions' | 'social' | 'default';

function variants({ name, role, product }: AgentIdentity): Record<OpeningCategory, string[]> {
  return {
    pricing: [
      `Hi, I'm ${name}, ${role} at ${product}. Looking at pricing? Tell me what you'd like to build and I'll point you to the right way to start.`,
      `Hey there, I'm ${name} from ${product}. Happy to explain how pricing works, from the free start to pilots. What are you planning?`,
    ],
    docs: [
      `Hi, I'm ${name} from ${product}. Reading the docs? Ask me about agents, the API, self-hosting, or the open-source OS.`,
      `Hey, I'm ${name}, ${role} at ${product}. Want a quick tour of how you build and deploy agents with us?`,
    ],
    solutions: [
      `Hi, I'm ${name}, ${role} at ${product}. Curious how universities and companies use our agents? Tell me about your organization.`,
      `Hey there, I'm ${name} from ${product}. Ask me anything about what we do for learners, faculty, and teams.`,
    ],
    social: [
      `Hi and welcome, I'm ${name}, the live guide at ${product}. Ask me anything about what ${product} does.`,
      `Hey, I'm ${name} from ${product}. What brought you by today?`,
    ],
    default: [
      `Hi, I'm ${name}, ${role} at ${product}. What would you like to know?`,
      `Hey there, I'm ${name} from ${product}. Ask me anything about our AI agents, the platform, or how to get started.`,
    ],
  };
}

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
  if (isHostOf(host, 'ibl.ai')) {
    if (path.includes('/pricing') || path.includes('/ai-cost-calculator')) return 'pricing';
    if (path.includes('/docs') || path.includes('/developer')) return 'docs';
    if (path.includes('/solutions')) return 'solutions';
    return 'default';
  }
  if (
    isHostOf(host, 'twitter.com') ||
    isHostOf(host, 'x.com') ||
    isHostOf(host, 'linkedin.com') ||
    isHostOf(host, 'ycombinator.com')
  ) {
    return 'social';
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

const namedOpeningVariants = ({ product }: AgentIdentity): readonly string[] => [
  'Hi {name}, nice to meet you. What would you like to know?',
  `Hey {name}, welcome. Ask me anything about ${product}.`,
  `Hi {name}, glad you stopped by. What are you hoping to figure out about ${product}?`,
  'Hey {name}, good to meet you. What can I help with today?',
  `Hi {name}. What's the ${product} question on your mind?`,
];

export function buildOpeningIntro(lead: LeadProfile | null, fallbackName?: string): string {
  const name = lead?.first_name ?? fallbackName ?? null;
  if (!name) return 'Hi there, welcome. What would you like to know?';
  const variant = pickRandom([...namedOpeningVariants(agentIdentity())]);
  return variant.replace(/\{(\w+)\}/g, (_match, key) => (key === 'name' ? name : ''));
}
