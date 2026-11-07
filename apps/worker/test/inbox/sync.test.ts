import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activity,
  getApplication,
  getMailSyncState,
  isMessageProcessed,
  listEmailThreadsForUser,
  upsertMailSyncState,
} from '@wma/db';
import { runMailSync } from '../../src/inbox/sync';
import {
  approve,
  classifyAnswers,
  FakeInboxGmail,
  fixture,
  inboxLlm,
  makeDeps,
  message,
  NOW,
  seed,
  setupInboxEnv,
  type InboxEnv,
} from './support';

let env: InboxEnv;
beforeAll(async () => {
  env = await setupInboxEnv();
});
afterAll(async () => {
  await env.cleanup();
});

async function setup() {
  const t = await env.makeTenant();
  await approve(t);
  const s = await seed(t);
  await upsertMailSyncState(t.handle, t.userId, { historyId: 'h-100' });
  return { t, s };
}

describe('rule 1: mailbox sync', () => {
  it('processes exactly the new messages and moves the mark past them', async () => {
    const { t, s } = await setup();
    const conf = fixture('confirmation', s);
    const other = fixture('other', s);
    const unrelated = fixture('unrelated');
    const gmail = new FakeInboxGmail();
    gmail.historyId = 'h-200';
    for (const f of [conf, other, unrelated]) gmail.add(message(f));
    const { deps } = makeDeps(gmail, inboxLlm({ classify: classifyAnswers(conf, other) }));

    const r = await runMailSync(t.handle, t.userId, deps);
    expect(r).toMatchObject({
      status: 'ok',
      mode: 'history',
      messages: 3,
      linked: 2,
      unlinked: 1,
      failed: 0,
    });
    for (const f of [conf, other, unrelated])
      expect(await isMessageProcessed(t.handle, f.id)).toBe(true);
    expect((await getMailSyncState(t.handle, t.userId))!.historyId).toBe('h-200');
    expect(gmail.calls).toContain('listHistory:h-100');
  });

  it('running twice processes each message once and creates no duplicate threads', async () => {
    const { t, s } = await setup();
    const conf = fixture('confirmation', s);
    const gmail = new FakeInboxGmail();
    gmail.add(message(conf));
    const llm = inboxLlm({ classify: classifyAnswers(conf) });
    const { deps } = makeDeps(gmail, llm);

    await runMailSync(t.handle, t.userId, deps);
    const classifyCalls = llm.calls.length;
    // The same window is reported again (history id did not move on the mailbox side).
    gmail.history = [conf.id];
    const second = await runMailSync(t.handle, t.userId, deps);
    expect(second).toMatchObject({ status: 'ok', messages: 0, duplicates: 1 });
    expect(llm.calls.length).toBe(classifyCalls);
    expect(gmail.fetched).toEqual([conf.id]);
    expect(await listEmailThreadsForUser(t.handle, t.userId)).toHaveLength(1);
  });

  it('advances the high-water mark only after the batch has committed', async () => {
    const { t, s } = await setup();
    const a = fixture('confirmation', s);
    const b = fixture('other', s);
    const gmail = new FakeInboxGmail();
    gmail.historyId = 'h-300';
    gmail.add(message(a));
    gmail.add(message(b));
    const seen: Array<{ mark: string | null | undefined; firstDone: boolean }> = [];
    gmail.onGetMessage = async (id) => {
      seen.push({
        mark: (await getMailSyncState(t.handle, t.userId))?.historyId,
        firstDone: await isMessageProcessed(t.handle, a.id),
      });
      void id;
    };
    const { deps } = makeDeps(gmail, inboxLlm({ classify: classifyAnswers(a, b) }));
    await runMailSync(t.handle, t.userId, deps);
    // While fetching the second message the first is committed but the mark has not moved.
    expect(seen[1]).toEqual({ mark: 'h-100', firstDone: true });
    expect((await getMailSyncState(t.handle, t.userId))!.historyId).toBe('h-300');
  });

  it('a Gmail failure mid-batch leaves the mark and the next run resumes with the rest', async () => {
    const { t, s } = await setup();
    const a = fixture('confirmation', s);
    const b = fixture('other', s);
    const gmail = new FakeInboxGmail();
    gmail.historyId = 'h-400';
    gmail.add(message(a));
    gmail.add(message(b));
    const { deps } = makeDeps(gmail, inboxLlm({ classify: classifyAnswers(a, b) }));
    gmail.onGetMessage = (id) => {
      if (id === b.id) throw new Error('503 backend error');
    };
    await expect(runMailSync(t.handle, t.userId, deps)).rejects.toThrow('503');
    expect((await getMailSyncState(t.handle, t.userId))!.historyId).toBe('h-100');
    expect(await isMessageProcessed(t.handle, a.id)).toBe(true);
    expect(await isMessageProcessed(t.handle, b.id)).toBe(false);

    gmail.onGetMessage = () => {};
    gmail.history = [a.id, b.id]; // the queue retries from the same mark
    const r = await runMailSync(t.handle, t.userId, deps);
    expect(r).toMatchObject({ status: 'ok', messages: 1, duplicates: 1, linked: 1 });
    expect((await getMailSyncState(t.handle, t.userId))!.historyId).toBe('h-400');
  });

  it('falls back to the dated listing when the history id has expired', async () => {
    const { t, s } = await setup();
    const conf = fixture('confirmation', s);
    const gmail = new FakeInboxGmail();
    gmail.historyId = 'h-500';
    gmail.expired = true;
    gmail.add(message(conf), { inHistory: false });
    const { deps } = makeDeps(gmail, inboxLlm({ classify: classifyAnswers(conf) }));
    const r = await runMailSync(t.handle, t.userId, deps);
    expect(r).toMatchObject({
      status: 'ok',
      mode: 'dated',
      messages: 1,
      linked: 1,
      historyId: 'h-500',
    });
    // Starts one day before the first application (2026-03-10).
    expect(gmail.calls.find((c) => c.startsWith('listSince'))).toBe(
      'listSince:2026-03-09T09:00:00.000Z',
    );
    expect((await getMailSyncState(t.handle, t.userId))!.historyId).toBe('h-500');
  });

  it('first sync with no mark reads the history id before listing and goes by date', async () => {
    const t = await env.makeTenant();
    await approve(t);
    const s = await seed(t);
    const conf = fixture('confirmation', s);
    const gmail = new FakeInboxGmail();
    gmail.historyId = 'h-600';
    gmail.add(message(conf), { inHistory: false });
    const { deps } = makeDeps(gmail, inboxLlm({ classify: classifyAnswers(conf) }));
    const r = await runMailSync(t.handle, t.userId, deps);
    expect(r).toMatchObject({ status: 'ok', mode: 'dated', linked: 1 });
    expect(gmail.calls.indexOf('currentHistoryId')).toBeLessThan(
      gmail.calls.findIndex((c) => c.startsWith('listSince')),
    );
    const state = await getMailSyncState(t.handle, t.userId);
    expect(state).toMatchObject({ historyId: 'h-600', reauthNeeded: false });
    expect(state!.lastSyncedAt).toEqual(NOW);
  });

  it('a failing message is recorded as failed and skipped; the others commit and the mark advances', async () => {
    const { t, s } = await setup();
    const bad = fixture('other', s);
    const good = fixture('confirmation', s);
    const gmail = new FakeInboxGmail();
    gmail.historyId = 'h-700';
    gmail.add(message(bad));
    gmail.add(message(good));
    const llm = inboxLlm({ classify: classifyAnswers(good) });
    // The classifier answers the bad message with garbage twice (the retry), the good one normally.
    const { deps } = makeDeps(gmail, llm);
    const real = llm.generateStructured.bind(llm);
    llm.generateStructured = async (req) =>
      req.user.includes(bad.subject) && req.prompt === 'inbox-classify/v1'
        ? { output: { classification: 'banana' }, usage: { input_tokens: 0, output_tokens: 0 } }
        : real(req);
    const r = await runMailSync(t.handle, t.userId, deps);
    expect(r).toMatchObject({ status: 'ok', failed: 1, linked: 1 });
    expect(await isMessageProcessed(t.handle, bad.id)).toBe(true);
    const log = await activity.listByUser(t.handle, t.userId);
    expect(log.find((e) => e.action === 'processing_failed')?.detail).toMatchObject({
      gmail_message_id: bad.id,
    });
    expect((await getMailSyncState(t.handle, t.userId))!.historyId).toBe('h-700');
    // A later run does not retry it.
    gmail.history = [bad.id];
    expect(await runMailSync(t.handle, t.userId, deps)).toMatchObject({
      messages: 0,
      duplicates: 1,
    });
  });

  it("the user's own sent mail and notifications to themselves are not processed", async () => {
    const { t, s } = await setup();
    const sent = fixture('other', s);
    const self = fixture('confirmation', s);
    const gmail = new FakeInboxGmail();
    gmail.add(message(sent, { labelIds: ['SENT'] }));
    gmail.add(
      message(self, { from: `Mara Quill <${t.email}>`, id: 'msg-self', threadId: 'thr-self' }),
    );
    const llm = inboxLlm({ classify: classifyAnswers(sent, self) });
    const { deps } = makeDeps(gmail, llm);
    const r = await runMailSync(t.handle, t.userId, deps);
    expect(r).toMatchObject({ unlinked: 2, linked: 0 });
    expect(llm.calls).toHaveLength(0);
    expect(await listEmailThreadsForUser(t.handle, t.userId)).toHaveLength(0);
    expect((await getApplication(t.handle, s.application.id))!.status).toBe('applied');
  });
});
