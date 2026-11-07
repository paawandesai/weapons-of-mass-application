import { and, eq, sql } from 'drizzle-orm';
import type { TenantHandle, Tx } from '../client';
import { logActivity } from '../activity';
import { secrets, vaultKeys } from '../schema';
import { open, randomKey, seal } from './cipher';
import { masterKey } from './master-key';

export {
  assertVaultConfigured,
  loadMasterKey,
  VaultConfigError,
  MASTER_KEY_ERROR,
} from './master-key';

export type SecretKind = (typeof secrets.$inferSelect)['kind'];
export type GetResult =
  { ok: true; value: string } | { ok: false; reason: 'not_found' | 'corrupt' };
export type RotateResult = { ok: true } | { ok: false; reason: 'not_found' | 'corrupt' };

export const MAX_SECRET_BYTES = 8 * 1024;
export const MAX_REF_LENGTH = 200;

export class VaultInputError extends Error {
  readonly code = 'vault_input' as const;
  constructor(message: string) {
    super(message);
    this.name = 'VaultInputError';
  }
}

/** The tenant's stored DEK could not be unwrapped (tampered row or wrong master key). */
export class VaultKeyError extends Error {
  readonly code = 'vault_key' as const;
  constructor() {
    super('vault: data key could not be unwrapped');
    this.name = 'VaultKeyError';
  }
}

const aadFor = (tenantId: string, kind: string, ref: string) =>
  Buffer.from(`${tenantId}${kind}${ref}`, 'utf8');
const wrapAad = (tenantId: string) => Buffer.from(tenantId, 'utf8');

function validate(kind: string, ref: string): void {
  if (kind !== 'google_refresh_token' && kind !== 'ats_password')
    throw new VaultInputError('vault: unknown kind');
  if (ref.length === 0 || ref.length > MAX_REF_LENGTH)
    throw new VaultInputError(`vault: ref must be 1..${MAX_REF_LENGTH} chars`);
}

function unwrapDek(tenantId: string, row: typeof vaultKeys.$inferSelect): Buffer | null {
  return open(
    masterKey(),
    { ciphertext: row.wrappedDek, iv: row.wrapIv, tag: row.wrapTag },
    wrapAad(tenantId),
  );
}

async function readDek(tx: Tx, tenantId: string): Promise<Buffer | 'missing' | 'corrupt'> {
  const [row] = await tx.select().from(vaultKeys).where(eq(vaultKeys.tenantId, tenantId));
  if (!row) return 'missing';
  return unwrapDek(tenantId, row) ?? 'corrupt';
}

/** Existing DEK or a new one. Concurrent first puts serialize on the unique index; the loser re-reads. */
async function dekForWrite(tx: Tx, tenantId: string): Promise<Buffer> {
  const existing = await readDek(tx, tenantId);
  if (existing === 'corrupt') throw new VaultKeyError();
  if (existing !== 'missing') return existing;
  const dek = randomKey();
  const wrapped = seal(masterKey(), dek, wrapAad(tenantId));
  const inserted = await tx
    .insert(vaultKeys)
    .values({
      tenantId,
      wrappedDek: wrapped.ciphertext,
      wrapIv: wrapped.iv,
      wrapTag: wrapped.tag,
    })
    .onConflictDoNothing({ target: vaultKeys.tenantId })
    .returning({ id: vaultKeys.id });
  if (inserted.length > 0) return dek;
  const winner = await readDek(tx, tenantId);
  if (winner === 'missing' || winner === 'corrupt') throw new VaultKeyError();
  return winner;
}

/** Creates or overwrites a secret; the DEK (if new), the secret and the log entry commit together. */
export async function put(
  handle: TenantHandle,
  userId: string,
  kind: SecretKind,
  ref: string,
  plaintext: string,
): Promise<void> {
  validate(kind, ref);
  const bytes = Buffer.from(plaintext, 'utf8');
  if (bytes.length > MAX_SECRET_BYTES) throw new VaultInputError('vault: secret exceeds 8 KiB');
  await handle.transaction(async (h) => {
    const dek = await h.run((tx) => dekForWrite(tx, h.tenantId));
    const sealed = seal(dek, bytes, aadFor(h.tenantId, kind, ref));
    await h.run((tx) =>
      tx
        .insert(secrets)
        .values({ tenantId: h.tenantId, kind, ref, ...sealed })
        .onConflictDoUpdate({
          target: [secrets.tenantId, secrets.kind, secrets.ref],
          set: { ...sealed, rotatedAt: sql`now()` },
        }),
    );
    await logActivity(h, { userId, actor: 'agent', action: 'vault_put', detail: { kind, ref } });
  });
}

async function decryptRow(
  h: TenantHandle,
  userId: string,
  kind: SecretKind,
  ref: string,
  opts: { lockRow?: boolean } = {},
): Promise<
  { ok: true; value: Buffer; dek: Buffer } | { ok: false; reason: 'not_found' | 'corrupt' }
> {
  const found = await h.run(async (tx) => {
    const dek = await readDek(tx, h.tenantId);
    if (dek === 'missing') return 'not_found' as const;
    const query = tx
      .select()
      .from(secrets)
      .where(and(eq(secrets.tenantId, h.tenantId), eq(secrets.kind, kind), eq(secrets.ref, ref)));
    const [row] = await (opts.lockRow ? query.for('update') : query);
    if (!row) return 'not_found' as const;
    if (dek === 'corrupt') return 'corrupt' as const;
    const value = open(dek, row, aadFor(h.tenantId, kind, ref));
    return value ? { value, dek } : ('corrupt' as const);
  });
  if (found === 'not_found') return { ok: false, reason: 'not_found' };
  if (found === 'corrupt') {
    await logActivity(h, {
      userId,
      actor: 'agent',
      action: 'vault_decrypt_failed',
      detail: { kind, ref },
    });
    return { ok: false, reason: 'corrupt' };
  }
  return { ok: true, ...found };
}

export async function get(
  handle: TenantHandle,
  userId: string,
  kind: SecretKind,
  ref: string,
): Promise<GetResult> {
  validate(kind, ref);
  const r = await decryptRow(handle, userId, kind, ref);
  return r.ok ? { ok: true, value: r.value.toString('utf8') } : r;
}

/** Removes the secret. Returns false (and writes no log entry) when there was nothing to delete. */
export async function del(
  handle: TenantHandle,
  userId: string,
  kind: SecretKind,
  ref: string,
): Promise<boolean> {
  validate(kind, ref);
  return handle.transaction(async (h) => {
    const rows = await h.run((tx) =>
      tx
        .delete(secrets)
        .where(and(eq(secrets.tenantId, h.tenantId), eq(secrets.kind, kind), eq(secrets.ref, ref)))
        .returning({ id: secrets.id }),
    );
    if (rows.length === 0) return false;
    await logActivity(h, { userId, actor: 'agent', action: 'vault_delete', detail: { kind, ref } });
    return true;
  });
}

/** Re-encrypts the same plaintext under the same DEK with a fresh IV and sets rotated_at. */
export async function rotate(
  handle: TenantHandle,
  userId: string,
  kind: SecretKind,
  ref: string,
): Promise<RotateResult> {
  validate(kind, ref);
  return handle.transaction(async (h) => {
    // The row stays locked until commit, so a concurrent put or delete cannot interleave with the
    // read-decrypt-rewrite below.
    const r = await decryptRow(h, userId, kind, ref, { lockRow: true });
    if (!r.ok) return r;
    const sealed = seal(r.dek, r.value, aadFor(h.tenantId, kind, ref));
    const updated = await h.run((tx) =>
      tx
        .update(secrets)
        .set({ ...sealed, rotatedAt: sql`now()` })
        .where(and(eq(secrets.tenantId, h.tenantId), eq(secrets.kind, kind), eq(secrets.ref, ref)))
        .returning({ id: secrets.id }),
    );
    if (updated.length !== 1) return { ok: false, reason: 'not_found' } as const;
    await logActivity(h, { userId, actor: 'agent', action: 'vault_rotate', detail: { kind, ref } });
    return { ok: true } as const;
  });
}

export { del as delete };
