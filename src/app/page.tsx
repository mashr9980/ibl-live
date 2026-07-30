import { Suspense } from 'react';

import { agentIdentity } from '@/lib/ai-sales/brain/agent-identity';
import AiSales from '@/sections/ai-sales/AiSales';

export default function Page() {
  // Resolved server-side and passed down so the UI copy matches the prompt's
  // idea of who the agent is. Threaded as a prop rather than exposed via
  // NEXT_PUBLIC_* vars — one source of truth, nothing extra in the client env.
  return (
    <main>
      <Suspense>
        <AiSales identity={agentIdentity()} />
      </Suspense>
    </main>
  );
}
