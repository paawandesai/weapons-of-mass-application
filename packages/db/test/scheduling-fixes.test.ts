import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyTransition,
  clearConfirmationForReschedule,
  confirmSlotByTokenHash,
  getApplication,
  getDigestCheckpoint,
  getInterview,
  getSlotByTokenHash,
  insertInterview,
  insertInterviewSlot,
  listFlaggedThreads,
  listInterviewsAwaitingBooking,
  lockInterview,
  setDigestCheckpoint,
  updateApplication,
  updateInterview,
  updateInterviewIfGeneration,
  upsertEmailThread,
} from '../src';
import { makeApplication, setupEnv, type TestEnv } from './helpers';

let env: TestEnv;
let A: Awaited<ReturnType<TestEnv['makeTenant']>>;
let B: Awaited<ReturnType<TestEnv['makeTenant']>>;

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const gid = () => `g-${randomBytes(6).toString('hex')}`;
const H = 3_600_000;

beforeAll(async () => {
  env = await setupEnv();
  A = await env.makeTenant();
  B = await env.makeTenant();
});
afterAll(async () => {
  await env.cleanup();
});

async function interviewWithSlot(t: typeof A, startsAt: Date) {
  const { application } = await makeApplication(t);
  const thread = await upsertEmailThread(t.handle, {
    userId: t.userId,
    gmailThreadId: gid(),
    kind: 'interview',
    applicationId: application.id,
  });
  const { interview } = await insertInterview(t.handle, {
    userId: t.userId,
    applicationId: application.id,
    threadId: thread.id,
  });
  const tk = token();
  await insertInterviewSlot(t.handle, {
    interviewId: interview.id,
    startsAt,
    endsAt: new Date(startsAt.getTime() + H),
    tokenHash: hash(tk),
  });
  return { application, thread, interview, token: tk };
}

describe('confirmation rejects slots that already started (database clock)', () => {
  it('the open-state read is false and confirming writes nothing', async () => {
    const past = await interviewWithSlot(A, new Date(Date.now() - 2 * H));
    const view = await getSlotByTokenHash(A.handle, hash(past.token));
    expect(view?.open).toBe(false);
    expect(await confirmSlotByTokenHash(A.handle, hash(past.token))).toEqual({
      ok: false,
      reason: 'no_longer_open',
    });
    const row = await getInterview(A.handle, past.interview.id);
    expect(row?.confirmedSlotId).toBeNull();
    expect(row?.confirmedGeneration).toBe(0);
  });

  it('a future slot confirms, reports its times and bumps the generation', async () => {
    const future = await interviewWithSlot(A, new Date(Date.now() + 2 * H));
    expect((await getSlotByTokenHash(A.handle, hash(future.token)))?.open).toBe(true);
    const out = await confirmSlotByTokenHash(A.handle, hash(future.token));
    expect(out).toMatchObject({ ok: true, interviewId: future.interview.id, generation: 1 });
    expect((await getInterview(A.handle, future.interview.id))?.confirmedGeneration).toBe(1);
  });
});

describe('generation-conditioned writes', () => {
  it('a booking write on an old generation changes nothing after a reschedule', async () => {
    const x = await interviewWithSlot(A, new Date(Date.now() + 5 * H));
    const confirmed = await confirmSlotByTokenHash(A.handle, hash(x.token));
    if (!confirmed.ok) throw new Error('not confirmed');
    expect(
      await updateInterviewIfGeneration(A.handle, x.interview.id, confirmed.generation, {
        replySentAt: new Date(),
      }),
    ).not.toBeNull();

    const cleared = await clearConfirmationForReschedule(A.handle, x.interview.id);
    expect(cleared).toMatchObject({
      confirmedSlotId: null,
      confirmedAt: null,
      replySentAt: null,
      confirmedGeneration: 2,
    });
    expect(
      await updateInterviewIfGeneration(A.handle, x.interview.id, confirmed.generation, {
        replySentAt: new Date(),
      }),
    ).toBeNull();
    expect((await getInterview(A.handle, x.interview.id))?.replySentAt).toBeNull();
  });

  it('lockInterview blocks a second transaction until the first ends', async () => {
    const x = await interviewWithSlot(A, new Date(Date.now() + 5 * H));
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const first = A.handle.transaction(async (h) => {
      await lockInterview(h, x.interview.id);
      order.push('first locked');
      await held;
      order.push('first done');
    });
    await new Promise((r) => setTimeout(r, 50));
    const second = A.handle.transaction(async (h) => {
      await lockInterview(h, x.interview.id);
      order.push('second locked');
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(order).toEqual(['first locked']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first locked', 'first done', 'second locked']);
  });
});

describe('what still awaits booking', () => {
  it('compares the booked generation with the confirmed one and ignores started interviews', async () => {
    const x = await interviewWithSlot(A, new Date(Date.now() + 5 * H));
    const c = await confirmSlotByTokenHash(A.handle, hash(x.token));
    if (!c.ok) throw new Error('not confirmed');
    const ids = async () =>
      (await listInterviewsAwaitingBooking(A.handle, A.userId)).map((i) => i.id);
    expect(await ids()).toContain(x.interview.id);

    // Reply and event done for generation 1.
    await updateInterview(A.handle, x.interview.id, {
      replySentAt: new Date(),
      calendarEventId: 'evt',
      bookedGeneration: c.generation,
    });
    expect(await ids()).not.toContain(x.interview.id);

    // A reschedule confirmed again: the retained event id does not count as done.
    await clearConfirmationForReschedule(A.handle, x.interview.id);
    await updateInterview(A.handle, x.interview.id, {
      confirmedSlotId: c.slotId,
      confirmedAt: new Date(),
      replySentAt: new Date(),
      startsAt: new Date(Date.now() + 6 * H),
      endsAt: new Date(Date.now() + 7 * H),
    });
    expect(await ids()).toContain(x.interview.id);

    // Once its time has begun it is no longer requeued.
    await updateInterview(A.handle, x.interview.id, {
      startsAt: new Date(Date.now() - 2 * H),
      endsAt: new Date(Date.now() - H),
    });
    expect(await ids()).not.toContain(x.interview.id);
  });
});

describe('applyTransition', () => {
  it('computes the change from the stored status, never from a stale snapshot', async () => {
    const { application } = await makeApplication(A);
    await updateApplication(A.handle, application.id, { status: 'applied' });
    const [interview, rejection] = await Promise.all([
      applyTransition(A.handle, application.id, 'interview'),
      applyTransition(A.handle, application.id, 'rejection'),
    ]);
    expect((await getApplication(A.handle, application.id))?.status).toBe('closed');
    // Whichever ran second saw the other's result.
    if (interview.changed && rejection.changed) {
      expect(rejection).toMatchObject({ from: 'interviewing', to: 'closed' });
    }
    expect(await applyTransition(A.handle, application.id, 'offer')).toMatchObject({
      changed: false,
      reason: 'no_change',
    });
  });

  it('a confirmation moves a pending card to applied with the email source; other tenants are invisible', async () => {
    const { application } = await makeApplication(A);
    expect(application.status).toBe('pending');
    expect(await applyTransition(A.handle, application.id, 'confirmation')).toMatchObject({
      changed: true,
      to: 'applied',
    });
    const row = await getApplication(A.handle, application.id);
    expect(row).toMatchObject({ status: 'applied', confirmationSource: 'email' });
    expect(await applyTransition(B.handle, application.id, 'rejection')).toMatchObject({
      changed: false,
      reason: 'not_found',
    });
  });
});

describe('digest checkpoint and flagged threads', () => {
  it('the checkpoint only moves forward and is per tenant', async () => {
    expect(await getDigestCheckpoint(A.handle, A.userId)).toBeNull();
    const t1 = new Date('2030-01-01T10:00:00Z');
    const t2 = new Date('2030-01-02T10:00:00Z');
    await setDigestCheckpoint(A.handle, A.userId, t2);
    await setDigestCheckpoint(A.handle, A.userId, t1);
    expect(await getDigestCheckpoint(A.handle, A.userId)).toEqual(t2);
    expect(await getDigestCheckpoint(B.handle, B.userId)).toBeNull();
    expect(await getDigestCheckpoint(B.handle, A.userId)).toBeNull();
  });

  it('lists threads of open applications with a pay flag or a link, not closed ones', async () => {
    const open = await makeApplication(A);
    const closed = await makeApplication(A);
    const plain = await makeApplication(A);
    const mk = (
      applicationId: string,
      extra: { compensationFlag?: boolean; bookingLink?: string },
    ) =>
      upsertEmailThread(A.handle, {
        userId: A.userId,
        gmailThreadId: gid(),
        kind: 'other',
        applicationId,
        ...extra,
      });
    const flagged = await mk(open.application.id, { compensationFlag: true });
    await mk(closed.application.id, { bookingLink: 'https://cal.example.test/x' });
    await updateApplication(A.handle, closed.application.id, { status: 'closed' });
    await mk(plain.application.id, {});
    const listed = await listFlaggedThreads(A.handle, A.userId);
    expect(listed.map((x) => x.threadId)).toContain(flagged.id);
    expect(listed.map((x) => x.applicationId)).not.toContain(closed.application.id);
    expect(listed.map((x) => x.applicationId)).not.toContain(plain.application.id);
    expect(await listFlaggedThreads(B.handle, B.userId)).toEqual([]);
  });
});
