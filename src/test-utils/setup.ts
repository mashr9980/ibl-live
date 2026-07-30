import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
}));

// Override jsdom's native fetch with a vitest mock function.
// Tests configure responses via vi.mocked(fetch).mockResolvedValueOnce(...)
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
