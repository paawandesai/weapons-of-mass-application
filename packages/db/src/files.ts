import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

/** Anything that knows its tenant: a TenantHandle satisfies this. */
export interface FileScope {
  readonly tenantId: string;
}

export class FileScopeError extends Error {
  readonly code = 'file_scope' as const;
  constructor(message: string) {
    super(message);
    this.name = 'FileScopeError';
  }
}

export function fileStoreDir(): string {
  return process.env.FILE_STORE_DIR ?? './data/files';
}

/** Resolves a store-relative path, refusing anything that escapes the store directory. */
export function resolveInStore(storeDir: string, fileRef: string): string {
  const root = resolve(storeDir);
  const abs = resolve(root, fileRef);
  if (abs !== root && !abs.startsWith(root + sep))
    throw new Error('file ref escapes the file store');
  return abs;
}

export async function deleteStoredFile(storeDir: string, fileRef: string): Promise<void> {
  await rm(resolveInStore(storeDir, fileRef), { force: true });
}

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function segment(label: string, value: string): string {
  if (!SEGMENT_RE.test(value) || value.includes('..')) {
    throw new FileScopeError(`${label} is not a safe path segment`);
  }
  return value;
}

/** `tenants/<tenant>/applications/<application>/<name>`, e.g. resume.pdf, captcha-1.png, failure-1.png. */
export function applicationFileKey(tenantId: string, applicationId: string, name: string): string {
  return `tenants/${segment('tenantId', tenantId)}/applications/${segment('applicationId', applicationId)}/${segment('name', name)}`;
}

function assertInTenant(scope: FileScope, key: string): void {
  const prefix = `tenants/${segment('tenantId', scope.tenantId)}/`;
  if (!key.startsWith(prefix) || key.split('/').some((s) => s === '..' || s === '.' || s === '')) {
    throw new FileScopeError('file key is outside the tenant folder');
  }
}

export async function putFile(
  scope: FileScope,
  key: string,
  bytes: Uint8Array,
  storeDir: string = fileStoreDir(),
): Promise<void> {
  assertInTenant(scope, key);
  const abs = resolveInStore(storeDir, key);
  await mkdir(dirname(abs), { recursive: true });
  const tmp = `${abs}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, bytes);
    await rename(tmp, abs);
  } finally {
    await rm(tmp, { force: true });
  }
}

/** The file's bytes, or null when it does not exist. */
export async function getFile(
  scope: FileScope,
  key: string,
  storeDir: string = fileStoreDir(),
): Promise<Buffer | null> {
  assertInTenant(scope, key);
  try {
    return await readFile(resolveInStore(storeDir, key));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export async function deleteFile(
  scope: FileScope,
  key: string,
  storeDir: string = fileStoreDir(),
): Promise<void> {
  assertInTenant(scope, key);
  await deleteStoredFile(storeDir, key);
}
