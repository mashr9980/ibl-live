import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLeadResolver, resetLeadResolverCache, selectLeadResolver, stubLeadResolver } from '..';

/**
 * `vi.spyOn` on an already-spied method reuses the existing mock (and its call
 * history), so clear it explicitly — every test asserts on its own calls.
 */
function spyOnFetch(response?: Response) {
  const spy = vi.spyOn(globalThis, 'fetch');
  spy.mockReset();
  if (response) spy.mockResolvedValue(response);
  return spy;
}

describe('selectLeadResolver', () => {
  it('defaults to the no-op stub when unset or blank', () => {
    for (const value of [undefined, '', '   ']) {
      expect(selectLeadResolver(value).resolver).toBe(stubLeadResolver);
    }
  });

  it('maps the "off" aliases to the stub', () => {
    for (const value of ['stub', 'none', 'noop', 'off', 'NONE', ' Stub ']) {
      expect(selectLeadResolver(value).resolver.id).toBe('stub');
    }
  });

  it('falls back to the stub on an unknown name instead of throwing', () => {
    const { resolver, note } = selectLeadResolver('salesforce');
    expect(resolver).toBe(stubLeadResolver);
    expect(note).toMatch(/unknown/);
  });
});

describe('getLeadResolver', () => {
  const original = process.env.AI_SALES_LEAD_RESOLVER;

  beforeEach(() => {
    resetLeadResolverCache();
  });

  afterEach(() => {
    if (original === undefined) delete process.env.AI_SALES_LEAD_RESOLVER;
    else process.env.AI_SALES_LEAD_RESOLVER = original;
    resetLeadResolverCache();
    vi.restoreAllMocks();
  });

  it('returns the stub by default, silently and memoised', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env.AI_SALES_LEAD_RESOLVER;
    const first = getLeadResolver();
    expect(first).toBe(stubLeadResolver);
    // Memoised: repeat calls return the same instance and stay quiet.
    expect(getLeadResolver()).toBe(first);
    expect(getLeadResolver()).toBe(first);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns exactly once for a typo’d selector', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.AI_SALES_LEAD_RESOLVER = 'my_crm';
    expect(getLeadResolver()).toBe(stubLeadResolver);
    getLeadResolver();
    getLeadResolver();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('honours an explicit "off" selector', () => {
    process.env.AI_SALES_LEAD_RESOLVER = 'off';
    expect(getLeadResolver()).toBe(stubLeadResolver);
  });
});

describe('stub resolver', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = spyOnFetch();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves to null without any network call or log output', async () => {
    await expect(stubLeadResolver.resolve('ada@example.com')).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('makes no network call even for garbage input', async () => {
    await expect(stubLeadResolver.resolve('not-an-email')).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
