import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activity, getMailSyncState, listConnections, upsertMailSyncState } from '@wma/db';
import { runMailSync } from '../../src/inbox/sync';
import { connect } from '../helpers';
import {
  approve,
  authError,
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

describe('rule 17: invalid mailbox credentials', () => {
  it('a 401 leaves the mark unchanged, flags the user for re-authorization, logs, and does not throw', async () => {
    const t = await env.makeTenant();
    await approve(t);
    await connect(t, 'gmail', {});
    await upsertMailSyncState(t.handle, t.userId, { historyId: 'h-77' });
    const gmail = new FakeInboxGmail();
    gmail.fail = authError();
    const { deps } = makeDeps(gmail, inboxLlm({ classify: {} }));

    const r = await runMailSync(t.handle, t.userId, deps);
    expect(r).toEqual({ status: 'reauth_needed' });
    const state = await getMailSyncState(t.handle, t.userId);
    expect(state).toMatchObject({ historyId: 'h-77', reauthNeeded: true });
    const log = await activity.listByUser(t.handle, t.userId);
    expect(log.map((e) => e.action)).toEqual(
      expect.arrayContaining(['mailbox_reauth_needed', 'google_token_revoked']),
    );
    const gmailConn = (await listConnections(t.handle, t.userId)).find((c) => c.kind === 'gmail');
    expect(gmailConn?.status).toBe('disconnected');
    // One call, no retry within the run.
    expect(gmail.calls).toHaveLength(1);
  });

  it('a 401 in the middle of a batch keeps what already committed and still holds the mark', async () => {
    const t = await env.makeTenant();
    await approve(t);
    await upsertMailSyncState(t.handle, t.userId, { historyId: 'h-1' });
    const s = await seed(t);
    const a = fixture('confirmation', s);
    const b = fixture('other', s);
    const gmail = new FakeInboxGmail();
    gmail.historyId = 'h-9';
    gmail.add(message(a));
    gmail.add(message(b));
    gmail.onGetMessage = (id) => {
      if (id === b.id) throw authError();
    };
    const { deps } = makeDeps(gmail, inboxLlm({ classify: classifyAnswers(a, b) }));
    expect(await runMailSync(t.handle, t.userId, deps)).toEqual({ status: 'reauth_needed' });
    expect((await getMailSyncState(t.handle, t.userId))!.historyId).toBe('h-1');
  });

  it('an invalid_grant from the token refresh is treated the same way', async () => {
    const t = await env.makeTenant();
    await approve(t);
    const gmail = new FakeInboxGmail();
    gmail.fail = Object.assign(new Error('invalid_grant'), {
      response: { data: { error: 'invalid_grant' } },
    });
    const { deps } = makeDeps(gmail, inboxLlm({ classify: {} }));
    expect(await runMailSync(t.handle, t.userId, deps)).toEqual({ status: 'reauth_needed' });
  });

  it('while the flag is already set a further rejection does not log again', async () => {
    const t = await env.makeTenant();
    await approve(t);
    const gmail = new FakeInboxGmail();
    gmail.fail = authError();
    const { deps } = makeDeps(gmail, inboxLlm({ classify: {} }));
    await runMailSync(t.handle, t.userId, deps);
    await runMailSync(t.handle, t.userId, deps);
    const log = await activity.listByUser(t.handle, t.userId);
    expect(log.filter((e) => e.action === 'mailbox_reauth_needed')).toHaveLength(1);
  });

  it('a later successful sync clears the flag', async () => {
    const t = await env.makeTenant();
    await approve(t);
    await upsertMailSyncState(t.handle, t.userId, { historyId: 'h-1', reauthNeeded: true });
    const gmail = new FakeInboxGmail();
    gmail.historyId = 'h-2';
    const { deps } = makeDeps(gmail, inboxLlm({ classify: {} }));
    await runMailSync(t.handle, t.userId, deps);
    expect(await getMailSyncState(t.handle, t.userId)).toMatchObject({
      historyId: 'h-2',
      reauthNeeded: false,
    });
  });
});
