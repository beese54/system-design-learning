// Blocks until the database is genuinely usable, then gets out of the way.
//
// Runnable on its own (`npm run db:wait`) so you can watch the seed finish
// without starting the whole lab.
import { basename } from 'node:path';
import { ping, CONFIG, pool } from './pool.js';

const DEADLINE_MS = Number(process.env.WAIT_MS || 90_000);
const EVERY_MS = 1000;

export async function waitForDb({ quiet = false } = {}) {
  const started = Date.now();
  let announced = false;
  let last = null;

  while (Date.now() - started < DEADLINE_MS) {
    try {
      return await ping();
    } catch (err) {
      last = err;
      if (!announced && !quiet) {
        // Only say this once, and only if the first attempt failed - a lab that
        // is already warm should start silently.
        console.log('  waiting for Postgres to finish seeding (first run takes a few seconds)…');
        announced = true;
      }
      await new Promise((r) => setTimeout(r, EVERY_MS));
    }
  }

  throw new Error(
    `Could not reach a seeded Postgres at ${CONFIG.host}:${CONFIG.port} after ${DEADLINE_MS / 1000}s.\n` +
    `  Last error: ${last?.message}\n` +
    '  Fix: run `npm run db:up` in this folder, then `docker compose logs -f db` to watch the seed.\n' +
    '  If Docker Desktop is not running, start it first - the lab cannot seed without it.'
  );
}

// Windows-safe "was I run directly?" check. process.argv[1] is a native path
// with backslashes; import.meta.url is a file:// URL with forward slashes. They
// can only be compared by basename, and basename() is the one way to take a
// basename that is correct on both platforms.
const invokedDirectly =
  process.argv[1] && import.meta.url.endsWith('/' + basename(process.argv[1]));

if (invokedDirectly) {
  try {
    const db = await waitForDb();
    console.log(`  ready: Postgres ${db.version.split(' ')[0]}, ${db.plays.toLocaleString('en-US')} plays, seeded ${new Date(db.seededAt).toISOString()}`);
    await pool.end();
  } catch (err) {
    console.error('\n  ' + err.message + '\n');
    await pool.end().catch(() => {});
    process.exit(1);
  }
}
