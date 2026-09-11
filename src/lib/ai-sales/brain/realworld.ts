import 'server-only';

/**
 * Real-world context intro, ported from the original Python implementation.
 *
 * One sentence (today's date + LA weather) spliced after the persona's
 * `# Persona` heading so the guide can ground replies in wall-clock reality.
 * Date is local (LA tz, no network); weather is Open-Meteo's free endpoint
 * (no API key). Caching was intentionally dropped for the standalone port —
 * one 5s-timeout fetch per turn, graceful degrade to date-only on any
 * failure, empty string only if the date itself can't be formatted.
 */

const NY_TZ = 'America/New_York';

// Open-Meteo current-weather — no API key, public free tier.
const OPEN_METEO_URL =
  'https://api.open-meteo.com/v1/forecast' +
  '?latitude=40.7128' +
  '&longitude=-74.0060' +
  '&current=temperature_2m,weather_code' +
  '&temperature_unit=fahrenheit' +
  '&timezone=America/New_York';

const WEATHER_TIMEOUT_MS = 5000;

// WMO weather-code → short phrase. Unknown codes fall back to "mild" so a new
// code can't break the prompt build. Source: https://open-meteo.com/en/docs
const WMO_CODES: Record<number, string> = {
  0: 'clear',
  1: 'mostly clear',
  2: 'partly cloudy',
  3: 'overcast',
  45: 'foggy',
  48: 'foggy',
  51: 'drizzly',
  53: 'drizzly',
  55: 'drizzly',
  56: 'with freezing drizzle',
  57: 'with freezing drizzle',
  61: 'rainy',
  63: 'rainy',
  65: 'rainy',
  66: 'with freezing rain',
  67: 'with freezing rain',
  71: 'snowy',
  73: 'snowy',
  75: 'snowy',
  77: 'with snow grains',
  80: 'with rain showers',
  81: 'with rain showers',
  82: 'with heavy rain showers',
  85: 'with snow showers',
  86: 'with heavy snow showers',
  95: 'stormy',
  96: 'stormy with hail',
  99: 'stormy with hail',
};

// Python strftime "%A, %B %-d, %Y" → "Monday, July 27, 2026".
function formatDateToday(): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date());
}

function describeWeather(code: number): string {
  return WMO_CODES[code] ?? 'mild';
}

async function fetchWeather(): Promise<{ temperatureF: number; condition: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEATHER_TIMEOUT_MS);
  try {
    const res = await fetch(OPEN_METEO_URL, { signal: controller.signal, cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      current?: { temperature_2m?: unknown; weather_code?: unknown };
    };
    const current = body?.current;
    if (!current || typeof current !== 'object') return null;
    const temp = current.temperature_2m;
    const code = current.weather_code;
    if (typeof temp !== 'number' || typeof code !== 'number') return null;
    return { temperatureF: Math.round(temp), condition: describeWeather(code) };
  } catch {
    // Transport error / abort / non-JSON — degrade to date-only upstream.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns the one-sentence intro, or empty string if even the date can't be
 * formatted (caller then skips the splice).
 *   full:      "Today is Monday, July 27, 2026, and the weather in New York is 74°F and clear."
 *   date-only: "Today is Monday, July 27, 2026 in New York."
 */
export async function buildRealworldContextIntro(): Promise<string> {
  let dateStr: string;
  try {
    dateStr = formatDateToday();
  } catch (err) {
    console.warn('[ai-sales] realworld date format failed', err);
    return '';
  }

  const weather = await fetchWeather();
  if (!weather) return `Today is ${dateStr} in New York.`;
  return `Today is ${dateStr}, and the weather in New York is ${weather.temperatureF}°F and ${weather.condition}.`;
}
