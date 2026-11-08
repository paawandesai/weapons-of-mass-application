import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activity,
  getEmailThreadByGmailId,
  listEmailThreadsForApplication,
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

async function tenant() {
  const t = await env.makeTenant();
  await approve(t);
  await upsertMailSyncState(t.handle, t.userId, { historyId: 'h-1' });
  return t;
}

describe('rule 2: linking', () => {
  it('sender domain and title match one application: linked, thread row created, no linking call', async () => {
    const t = await tenant();
    const s = await seed(t);
    const f = fixture('confirmation', s);
    const gmail = new FakeInboxGmail();
    gmail.add(message(f));
    const llm = inboxLlm({ classify: classifyAnswers(f) });
    const { deps } = makeDeps(gmail, llm);
    await runMailSync(t.handle, t.userId, deps);

    const thread = await getEmailThreadByGmailId(t.handle, f.threadId);
    expect(thread).toMatchObject({
      applicationId: s.application.id,
      gmailThreadId: f.threadId,
      userId: t.userId,
    });
    expect(llm.calls.map((c) => c.prompt)).toEqual(['inbox-classify/v2']);
    const linked = (await activity.listByUser(t.handle, t.userId)).find(
      (e) => e.action === 'thread_linked',
    );
    expect(linked?.detail).toMatchObject({ method: 'deterministic' });
  });

  it('a company with two applications links to the one whose title matches, without the model', async () => {
    const t = await tenant();
    const a = await seed(t, { title: 'Staff Platform Engineer' });
    const b = await seed(t, { title: 'Design Lead', like: a });
    const f = fixture('confirmation', b);
    const gmail = new FakeInboxGmail();
    gmail.add(message(f));
    const llm = inboxLlm({ classify: classifyAnswers(f) });
    const { deps } = makeDeps(gmail, llm);
    await runMailSync(t.handle, t.userId, deps);
    const thread = await getEmailThreadByGmailId(t.handle, f.threadId);
    expect(thread?.applicationId).toBe(b.application.id);
    expect(llm.calls.map((c) => c.prompt)).not.toContain('inbox-link/v1');
  });

  it('several candidates with no title tie-breaker go to the model, which sees only those candidates', async () => {
    const t = await tenant();
    const a = await seed(t, { title: 'Staff Platform Engineer' });
    const b = await seed(t, { title: 'Design Lead', like: a });
    const f = fixture('other', a);
    const generic = {
      ...f,
      subject: 'Quick question about your application',
      body: 'Could you send a portfolio link?',
    };
    const gmail = new FakeInboxGmail();
    gmail.add(message(generic));
    const llm = inboxLlm({
      link: () => b.application.id,
      classify: { [generic.subject]: f.classification },
    });
    const { deps } = makeDeps(gmail, llm);
    await runMailSync(t.handle, t.userId, deps);
    const call = llm.calls.find((c) => c.prompt === 'inbox-link/v1')!;
    expect(call.user).toContain(a.application.id);
    expect(call.user).toContain(b.application.id);
    expect((await getEmailThreadByGmailId(t.handle, generic.threadId))?.applicationId).toBe(
      b.application.id,
    );
  });

  it('a model answer outside the candidate list, or null, leaves the message unlinked and unclassified', async () => {
    const t = await tenant();
    const a = await seed(t, { title: 'Staff Platform Engineer' });
    await seed(t, { title: 'Design Lead', like: a });
    const f = fixture('other', a);
    const generic = { ...f, subject: 'Hello from the team', body: 'Just saying hello.' };
    const gmail = new FakeInboxGmail();
    gmail.add(message(generic));
    const llm = inboxLlm({ link: () => '00000000-0000-4000-8000-000000000000', classify: {} });
    const { deps } = makeDeps(gmail, llm);
    const r = await runMailSync(t.handle, t.userId, deps);
    expect(r).toMatchObject({ unlinked: 1, linked: 0 });
    expect(llm.calls.map((c) => c.prompt)).toEqual(['inbox-link/v1']);
    expect(await listEmailThreadsForUser(t.handle, t.userId)).toHaveLength(0);
  });

  it('a personal-address recruiter is matched on the title and the model decides', async () => {
    const t = await tenant();
    const s = await seed(t);
    const f = fixture('other', s);
    const personal = { ...f, from: 'Dana Whitcomb <dana.w.recruits@gmail.com>' };
    const gmail = new FakeInboxGmail();
    gmail.add(message(personal));
    const llm = inboxLlm({ link: () => s.application.id, classify: classifyAnswers(f) });
    const { deps } = makeDeps(gmail, llm);
    await runMailSync(t.handle, t.userId, deps);
    expect(llm.calls.map((c) => c.prompt)).toEqual(['inbox-link/v1', 'inbox-classify/v2']);
    expect(await getEmailThreadByGmailId(t.handle, f.threadId)).toMatchObject({
      applicationId: s.application.id,
    });
  });

  it('no application matches: no thread row, the message is processed, no status change, nothing sent to the model', async () => {
    const t = await tenant();
    const s = await seed(t);
    const u = fixture('unrelated');
    const gmail = new FakeInboxGmail();
    gmail.add(message(u));
    const llm = inboxLlm({ classify: {} });
    const { deps } = makeDeps(gmail, llm);
    const r = await runMailSync(t.handle, t.userId, deps);
    expect(r).toMatchObject({ unlinked: 1 });
    expect(llm.calls).toHaveLength(0);
    expect(await listEmailThreadsForUser(t.handle, t.userId)).toHaveLength(0);
    expect(await listEmailThreadsForApplication(t.handle, s.application.id)).toHaveLength(0);
  });

  it('a new message on a linked thread updates the one row and keeps its link', async () => {
    const t = await tenant();
    const s = await seed(t);
    const first = fixture('confirmation', s);
    const gmail = new FakeInboxGmail();
    gmail.add(message(first));
    const reply = {
      ...fixture('other', s),
      id: 'msg-reply-2',
      threadId: first.threadId,
      date: '2026-03-15T10:00:00Z',
      subject: 'One more thing about your file',
      body: 'Following up with a question.',
    };
    const llm = inboxLlm({ classify: classifyAnswers(first, reply) });
    const { deps } = makeDeps(gmail, llm);
    await runMailSync(t.handle, t.userId, deps);
    const before = await getEmailThreadByGmailId(t.handle, first.threadId);

    gmail.add(message(reply));
    await runMailSync(t.handle, t.userId, deps);
    const threads = await listEmailThreadsForUser(t.handle, t.userId);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.id).toBe(before!.id);
    expect(threads[0]!.kind).toBe('other');
    expect(threads[0]!.lastMessageAt).toEqual(new Date(reply.date));
    expect(llm.calls.map((c) => c.prompt)).not.toContain('inbox-link/v1');
  });

  it('two tenants applied to the same company and title: a message in A is matched only against A', async () => {
    const a = await tenant();
    const b = await tenant();
    const sa = await seed(a);
    // Tenant B applied to the same board and role (a second posting row under B's tenant id).
    const sb = await seed(b, { like: sa });
    expect(sb.domain).toBe(sa.domain);
    expect(sb.title).toBe(sa.title);

    const f = fixture('confirmation', sa);
    const gmail = new FakeInboxGmail();
    gmail.add(message(f));
    const llm = inboxLlm({ classify: classifyAnswers(f) });
    const { deps } = makeDeps(gmail, llm);
    await runMailSync(a.handle, a.userId, deps);

    expect(await listEmailThreadsForUser(a.handle, a.userId)).toHaveLength(1);
    expect(await listEmailThreadsForApplication(a.handle, sa.application.id)).toHaveLength(1);
    expect(await listEmailThreadsForApplication(b.handle, sb.application.id)).toHaveLength(0);
    expect(await listEmailThreadsForUser(b.handle, b.userId)).toHaveLength(0);
    expect((await activity.listByUser(b.handle, b.userId)).length).toBe(0);
  });
});
