/**
 * React hook that pre-warms the /api/ai-sales/session token mint.
 *
 * The session-mint POST is the long pole between user click and avatar
 * speaking. When the visitor has settled their setup (form complete) and
 * granted mic permission but hasn't yet clicked "Start chatting" (i.e.
 * ReadyStage is rendering), we kick off the same POST in the background.
 * AiSales.handleStart awaits the resulting promise instead of issuing a
 * fresh request — saving roughly one round-trip of perceived latency for
 * the email-deeplink-with-cached-mic flow.
 */
import { useEffect, useRef, type MutableRefObject } from 'react';

export type PreMintTokenResponse = {
  session_id: string;
  session_token: string;
  session_signature: string | null;
  api_base: string;
  lead: { first_name: string | null; company: string | null; is_liveavatar_user: boolean } | null;
};

export type UsePrewarmMintParams = {
  hasSetupComplete: boolean;
  permissionGranted: boolean;
  hasUserGesture: boolean;
  hasAttemptedStart: boolean;
  name: string;
  email: string;
};

export function usePrewarmMint(
  params: UsePrewarmMintParams,
): MutableRefObject<Promise<PreMintTokenResponse> | null> {
  const ref = useRef<Promise<PreMintTokenResponse> | null>(null);

  useEffect(() => {
    if (!params.hasSetupComplete) return;
    if (!params.permissionGranted) return;
    if (params.hasUserGesture) return;
    if (params.hasAttemptedStart) return;
    if (ref.current !== null) return;
    const name = params.name.trim();
    const email = params.email.trim();
    if (!name || !email) return;
    ref.current = (async (): Promise<PreMintTokenResponse> => {
      const res = await fetch('/api/ai-sales/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Failed to start session (${res.status}): ${text}`);
      }
      return (await res.json()) as PreMintTokenResponse;
    })().catch((err) => {
      console.warn('[ai-sales] pre-warm mint failed; will retry on Start', err);
      ref.current = null;
      throw err;
    });
  }, [
    params.hasSetupComplete,
    params.permissionGranted,
    params.hasUserGesture,
    params.hasAttemptedStart,
    params.name,
    params.email,
  ]);

  return ref;
}
