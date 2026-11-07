import {
  getAtsCredential,
  insertAtsCredential,
  markAtsCredentialRejected,
  markAtsCredentialVerified,
  startAtsRegistration,
  upsertCompany,
  withCredentialLock,
  type AtsCredentialRow,
  type JobRow,
} from '@wma/db';
import { parseAtsJobUrl, type AtsId } from '@wma/shared';
import { describeError, SubmissionFailure } from '../failure';
import { recordStep } from '../record';
import type { PageLike } from '../deps';
import type { FormAdapter, SignInOutcome, SubmissionContext } from '../types';
import { generatePassword } from './password';
import { enterVerificationCode, waitForVerification } from './verification';

export { generatePassword } from './password';
export { extractVerification } from './verification';

export type AccountOutcome = 'created' | 'signed-in';

/** Vault reference for a company account: `<ats>:<company_id>`. */
export const credentialRef = (ats: AtsId, companyId: string) => `${ats}:${companyId}`;

/** The company row an account belongs to; derived from the posting URL when the job has none. */
async function companyIdFor(ctx: SubmissionContext, job: JobRow, ats: AtsId): Promise<string> {
  if (job.companyId) return job.companyId;
  const ref = parseAtsJobUrl(job.url);
  const slug = ref?.boardSlug ?? new URL(job.url).hostname;
  const company = await upsertCompany(ctx.handle, {
    name: slug,
    ats,
    boardSlug: slug,
    createdBy: 'llm',
  });
  return company.id;
}

/** A browser failure while a password is in play: the message is cleaned of that password. */
async function withSecret<T>(secret: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof SubmissionFailure) throw e;
    throw new SubmissionFailure('browser-error', describeError(e, [secret]));
  }
}

async function signInWith(
  ctx: SubmissionContext,
  adapter: FormAdapter,
  page: PageLike,
  username: string,
  password: string,
): Promise<SignInOutcome> {
  return withSecret(password, () => adapter.signIn(page, { username, password }));
}

async function signInStored(
  ctx: SubmissionContext,
  adapter: FormAdapter,
  page: PageLike,
  credential: AtsCredentialRow,
  companyId: string,
): Promise<void> {
  const secret = await ctx.vault.get(credential.vaultRef);
  if (!secret.ok) {
    throw new SubmissionFailure('credential-rejected', { detail: `vault_${secret.reason}` });
  }
  const outcome = await signInWith(ctx, adapter, page, credential.username, secret.value);
  if (outcome === 'rejected') {
    await markAtsCredentialRejected(ctx.handle, credential.id);
    throw new SubmissionFailure('credential-rejected', { detail: 'sign_in_rejected' });
  }
  await recordStep(ctx, {
    action: 'account-signed-in',
    detail: { ats: adapter.ats, company_id: companyId },
  });
}

/**
 * Takes a registering credential through sign-up and verification. A resumed credential reuses
 * the vaulted password: the sign-up is submitted again, and when the vendor says the account is
 * already there (the earlier attempt got that far) a sign-in with the same password completes it.
 */
async function register(
  ctx: SubmissionContext,
  adapter: FormAdapter,
  page: PageLike,
  credential: AtsCredentialRow,
  password: string,
  companyId: string,
  resumed: boolean,
): Promise<AccountOutcome> {
  const ats = adapter.ats;
  const started = await startAtsRegistration(ctx.handle, credential.id, ctx.clock.now());
  const since = started?.registrationStartedAt ?? ctx.clock.now();

  try {
    await withSecret(password, () =>
      adapter.signUp(page, { email: credential.username, password }),
    );
  } catch (e) {
    if (!resumed) throw e;
    const outcome = await signInWith(ctx, adapter, page, credential.username, password);
    if (outcome === 'rejected') {
      // The account may still be awaiting verification; leave the credential registering.
      throw new SubmissionFailure('credential-rejected', { detail: 'resume_sign_in_rejected' });
    }
    await markAtsCredentialVerified(ctx.handle, credential.id);
    await recordStep(ctx, {
      action: 'account-signed-in',
      detail: { ats, company_id: companyId, resumed: true },
    });
    return 'signed-in';
  }
  await recordStep(ctx, {
    action: 'account-created',
    detail: { ats, company_id: companyId, ...(resumed ? { resumed: true } : {}) },
  });

  // A page that no longer asks for an account has no verification step to complete.
  if (!(await adapter.requiresAccount(page))) {
    await markAtsCredentialVerified(ctx.handle, credential.id);
    return 'created';
  }

  const verification = await waitForVerification(ctx, since);
  if (verification.kind === 'link') {
    await page.goto(verification.url);
    await adapter.load(page, ctx.job.url);
    if (await adapter.requiresAccount(page)) {
      await signInStored(ctx, adapter, page, credential, companyId);
    }
  } else {
    await enterVerificationCode(page, verification.code);
  }
  await markAtsCredentialVerified(ctx.handle, credential.id);
  await recordStep(ctx, {
    action: 'account-verified',
    detail: {
      ats,
      company_id: companyId,
      via: verification.kind,
      message_id: verification.messageId,
    },
  });
  return 'created';
}

/**
 * Called when the form requires an account. The whole operation runs under an advisory lock keyed
 * on (user, ats, company), so two applications at one company cannot generate competing
 * passwords. A verified credential signs in; a `registering` one resumes with its vaulted
 * password; otherwise a password is generated and written to the vault and `ats_credentials`
 * BEFORE the sign-up form is submitted, so a crash after submit cannot lose it.
 */
export async function ensureAccount(
  ctx: SubmissionContext,
  adapter: FormAdapter,
  page: PageLike,
  email: string,
): Promise<AccountOutcome> {
  const ats = adapter.ats;
  const companyId = await companyIdFor(ctx, ctx.job, ats);
  const ref = credentialRef(ats, companyId);

  return withCredentialLock(ctx.handle, { userId: ctx.userId, ats, companyId }, async () => {
    const existing = await getAtsCredential(ctx.handle, ctx.userId, ats, companyId);

    if (existing) {
      if (existing.rejectedAt || existing.status === 'rejected') {
        throw new SubmissionFailure('credential-rejected', { detail: 'previously_rejected' });
      }
      if (existing.status === 'verified') {
        await signInStored(ctx, adapter, page, existing, companyId);
        return 'signed-in';
      }
      const secret = await ctx.vault.get(existing.vaultRef);
      if (!secret.ok) {
        throw new SubmissionFailure('credential-rejected', { detail: `vault_${secret.reason}` });
      }
      return register(ctx, adapter, page, existing, secret.value, companyId, true);
    }

    const password = generatePassword();
    await ctx.vault.put(ref, password);
    const credential = await insertAtsCredential(ctx.handle, {
      userId: ctx.userId,
      ats,
      companyId,
      username: email,
      vaultRef: ref,
    });
    return register(ctx, adapter, page, credential, password, companyId, false);
  });
}
