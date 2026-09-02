// Blocks until the seeded database answers, so `npm start` can fail with a
// useful sentence instead of a connection-refused stack trace.
import { pool, ping, CONFIG } from './db.js';

const DEADLINE_MS = Number(process.env.WAIT_MS || 120_000);

export async function waitForDb({ quiet = false } = {}) {
  const until = Date.now() + DEADLINE_MS;
  let announced = false;
  for (;;) {
    try {
      return await ping();
    } catch (err) {
      if (Date.now() > until) {
        throw new Error(
          `Could not reach Postgres at ${CONFIG.host}:${CONFIG.port} after ${DEADLINE_MS / 1000}s.\n` +
          `  Last error: ${err.message}\n` +
          '  Fix: run `npm run db:up` in this folder, then `docker compose logs -f db` to watch the seed.'
        );
      }
      if (!quiet && !announced) {
        // The first run seeds a million rows; silence for a minute looks broken.
        console.log('  waiting for Postgres to finish seeding (first run takes 30-60s)...');
        announced = true;
      }
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

// Run directly (`npm run db:wait`) rather than imported? Then do the wait and
// exit. Comparing basenames keeps this working on Windows paths, where
// import.meta.url and argv[1] disagree about slashes.
const invokedDirectly = process.argv[1] && import.meta.url.endsWith('/' + process.argv[1].split(/[\\/]/).pop());
if (invokedDirectly) {
  waitForDb()
    .then(s => { console.log('database ready:', s.plays, 'plays'); return pool.end(); })
    .catch(e => { console.error(e.message); process.exit(1); });
}
