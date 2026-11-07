import { activity } from '../index';
import { createDb } from '../client';
import { DEFAULT_DATABASE_URL, loadEnv } from '../env';
import { listApplications } from '../repos/applications';
import { listCompaniesByIds } from '../repos/companies';
import { listDemoThread } from '../repos/demo_mailbox';
import { listInterviewsForApplication } from '../repos/interviews';
import { listJobsByIds } from '../repos/jobs';
import { listOutgoingMessagesForApplication } from '../repos/outgoing_messages';
import { GAUNTLET_POSTINGS } from './catalog';
import { render, score, type EmployerRows } from './scorecard';

// Scores a golden run against the contract in scorecard.ts and exits 1 if any employer failed.
// `pnpm gauntlet:score`, or `scripts/gauntlet.sh --golden`, which runs the loop first.
loadEnv();
const db = createDb(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
try {
  const demo = await db.demoUser();
  if (!demo)
    throw new Error('no demo tenant in this database (run scripts/gauntlet.sh golden first)');
  const handle = db.forTenant(demo.tenantId);
  const apps = await listApplications(handle, demo.userId);
  const jobs = new Map(
    (
      await listJobsByIds(
        handle,
        apps.map((a) => a.jobId),
      )
    ).map((j) => [j.id, j]),
  );
  const companies = new Map(
    (
      await listCompaniesByIds(handle, [
        ...new Set([...jobs.values()].flatMap((j) => (j.companyId ? [j.companyId] : []))),
      ])
    ).map((c) => [c.id, c]),
  );
  const rows: EmployerRows[] = [];
  for (const posting of GAUNTLET_POSTINGS) {
    const app = apps.find((a) => {
      const job = jobs.get(a.jobId);
      return job?.companyId && companies.get(job.companyId)?.boardSlug === posting.slug;
    });
    if (!app) {
      rows.push({
        slug: posting.slug,
        title: posting.title,
        application: null,
        interviews: [],
        flags: [],
        outgoing: [],
        recruiterMail: [],
      });
      continue;
    }
    const entries = await activity.listByApplication(handle, app.id, { limit: 500 });
    rows.push({
      slug: posting.slug,
      title: posting.title,
      application: {
        status: app.status,
        formAnswers: (app.formAnswers as Record<string, unknown> | null) ?? null,
        followedUpAt: app.followedUpAt,
      },
      interviews: (await listInterviewsForApplication(handle, app.id)).map((i) => ({
        confirmedAt: i.confirmedAt,
        calendarEventId: i.calendarEventId,
        replySentAt: i.replySentAt,
        startsAt: i.startsAt,
      })),
      flags: entries
        .filter((e) => e.action === 'digest_flag')
        .map((e) => String((e.detail as { kind?: unknown })?.kind ?? '')),
      outgoing: (await listOutgoingMessagesForApplication(handle, app.id)).map((o) => ({
        kind: o.kind,
        bodyText: o.bodyText,
        blocked: o.blocked,
      })),
      recruiterMail: (await listDemoThread(handle, `sim-thread-${app.id}`)).map((m) =>
        String((m.headers as Record<string, string>)['X-WMA-Simulated-Kind'] ?? ''),
      ),
    });
  }
  const scores = await score(rows);
  console.log(render(scores));
  process.exitCode = scores.every((s) => s.passed) ? 0 : 1;
} finally {
  await db.close();
}
