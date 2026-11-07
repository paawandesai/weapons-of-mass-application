import { createDb } from '../client';
import { DEFAULT_DATABASE_URL, loadEnv } from '../env';
import { listDemoMessages } from '../repos/demo_mailbox';
import { pickConfirmLink } from './autopilot';

/**
 * The automated user for golden runs. It does the one thing a person does in the loop that the
 * agent may not do for them: open a confirm link from a "Pick an interview time" email and press
 * Confirm. It picks the second offered time (the first is the most likely to clash with a real
 * calendar; any deterministic choice would do). Nothing else: no replies, no approvals, no
 * answering flags. Booking links, pay questions and vague times are the user's to handle by
 * hand, and a golden run checks that the agent flagged them and stopped.
 *
 *   pnpm gauntlet:autopilot            confirm every open offer once
 *   pnpm gauntlet:autopilot --watch    keep confirming new offers until stopped
 *
 * `API_ORIGIN` (default http://127.0.0.1:3000) is where the confirm links are posted.
 */
loadEnv();
const api = (process.env.API_ORIGIN ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const watch = process.argv.includes('--watch');
const db = createDb(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
const done = new Set<string>();

async function pass(): Promise<number> {
  const demo = await db.demoUser();
  if (!demo) throw new Error('no demo tenant in this database (run scripts/gauntlet.sh first)');
  const offers = (await listDemoMessages(db.forTenant(demo.tenantId), demo.userId)).filter(
    (m) => m.subject.startsWith('Pick an interview time') && !done.has(m.gmailMessageId),
  );
  let confirmed = 0;
  for (const offer of offers) {
    done.add(offer.gmailMessageId);
    const token = pickConfirmLink(offer.bodyText);
    if (!token) continue;
    const res = await fetch(`${api}/confirm/${token}`, { method: 'POST' });
    // 410: already confirmed, or the offer closed (the recruiter moved on); neither is ours to force.
    console.log(
      `${res.status === 200 ? 'confirmed' : `skipped (${res.status})`}  ${offer.subject}`,
    );
    if (res.status === 200) confirmed++;
  }
  return confirmed;
}

try {
  if (!watch) {
    const n = await pass();
    console.log(n === 0 ? 'no open offers' : `${n} confirmed`);
  } else {
    console.log('watching for offers (Ctrl-C to stop)');
    for (;;) {
      await pass();
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
} finally {
  await db.close();
}
