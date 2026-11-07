import { createDb } from '../client';
import { DEFAULT_DATABASE_URL, loadEnv } from '../env';
import { listDemoMessages } from '../repos/demo_mailbox';

// Prints the demo user's fake mailbox, oldest first: the recruiter's mail, the agent's messages to
// the user (slot offers with their confirm links) and the agent's replies. `pnpm gauntlet:mail`.
loadEnv();
const db = createDb(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
try {
  const demo = await db.demoUser();
  if (!demo) {
    console.log('no demo tenant in this database (run scripts/gauntlet.sh first)');
  } else {
    const messages = await listDemoMessages(db.forTenant(demo.tenantId), demo.userId);
    if (messages.length === 0) console.log('the mailbox is empty so far');
    for (const m of messages) {
      const from = m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress;
      console.log(`${'='.repeat(78)}\n${m.internalDate.toISOString()}  thread ${m.threadId}`);
      console.log(
        `From: ${from}\nTo: ${m.toAddress}\nSubject: ${m.subject}\n\n${m.bodyText.trim()}\n`,
      );
    }
  }
} finally {
  await db.close();
}
