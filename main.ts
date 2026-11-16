// github-forge: a GitHub-compatible git forge in one process.
//
// Serves git smart HTTP, REST v3, GraphQL and MCP from its own in-memory
// store. Run as `node main.ts` on Node 22 (erasable TypeScript only, no
// build step, no dependencies beyond the standard library).
//
// Trial lifecycle: bind an ephemeral loopback port, tell the trial
// environment which port it is, then poll the environment until it
// reports the trial is done. Without a trial environment the server just
// serves until it is stopped.

import { createApp } from './src/app.ts';
import { Forge } from './src/store.ts';
import { trialNowSec } from './src/util.ts';

const POLL_INTERVAL_MS = 500;
const REGISTER_RETRIES = 60;
const REGISTER_RETRY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** POST the listening port to the trial environment, retrying while it warms up. */
async function register(envUrl: string, port: number): Promise<boolean> {
  for (let attempt = 0; attempt < REGISTER_RETRIES; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.ok) return true;
    } catch {
      // The environment is not answering yet; retry below.
    }
    await sleep(REGISTER_RETRY_MS);
  }
  return false;
}

/** Poll the trial environment until it reports the trial is done. */
async function waitForDone(envUrl: string): Promise<void> {
  for (;;) {
    await sleep(POLL_INTERVAL_MS);
    try {
      const response = await fetch(`${envUrl}/done`);
      if (!response.ok) continue;
      const payload: unknown = await response.json();
      if (
        payload !== null &&
        typeof payload === 'object' &&
        (payload as Record<string, unknown>).done === true
      ) {
        return;
      }
    } catch {
      // A failed poll is transient; the next one follows shortly.
    }
  }
}

async function main(): Promise<void> {
  const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const forge = new Forge(trialNowSec(process.env));
  const { server } = createApp({ forge, token });

  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    server.close(() => process.exit(0));
    // Never hang on a lingering socket: exit shortly after closing.
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  if (port === 0) {
    console.error('[forge] could not determine the listening port');
    process.exit(1);
  }

  if (envUrl === '') {
    console.error(`[forge] listening on 127.0.0.1:${port} (no trial environment; serving until stopped)`);
    return;
  }
  const registered = await register(envUrl, port);
  if (!registered) {
    console.error('[forge] could not register with the trial environment');
    process.exit(1);
  }
  await waitForDone(envUrl);
  shutdown();
}

main().catch((err: unknown) => {
  console.error(`[forge] fatal: ${(err as Error).message}`);
  process.exit(1);
});
