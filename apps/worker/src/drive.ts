import type { Readable } from 'node:stream';
import { getDriveClient, isInvalidGrant, withGoogle } from '@wma/google';
import type { DriveCollection, DriveFileText, DrivePort } from './profile/bundle';

export const MAX_DRIVE_FILES = 20;
export const MAX_DRIVE_FILE_BYTES = 2 * 1024 * 1024;

const GOOGLE_DOC = 'application/vnd.google-apps.document';
const TEXT_TYPES = ['text/plain', 'text/markdown'];
const ID_RE = /^[A-Za-z0-9_-]+$/;

class TooLargeError extends Error {}

/** Reads a response stream as UTF-8, stopping (and destroying the stream) past `max` bytes. */
export async function readLimited(stream: Readable, max: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      total += buf.byteLength;
      if (total > max) throw new TooLargeError();
      chunks.push(buf);
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Reads Google Docs (exported as plain text) and plain-text or markdown files directly inside the
 * selected folders: at most 20 files, each at most 2 MB (measured in bytes while downloading).
 * Subfolders are not walked. One file or folder failing does not discard the rest: successful
 * files are kept and each failure is reported so the build can flag it as a partial source.
 * A revoked Google grant still fails the whole read.
 */
export const googleDrivePort: DrivePort = {
  async collectFiles(handle, userId, folderIds): Promise<DriveCollection> {
    return withGoogle(handle, userId, async () => {
      const drive = await getDriveClient(handle, userId);
      const files: DriveFileText[] = [];
      const failed: DriveCollection['failed'] = [];
      const types = [GOOGLE_DOC, ...TEXT_TYPES].map((t) => `mimeType = '${t}'`).join(' or ');
      for (const folderId of folderIds) {
        if (files.length >= MAX_DRIVE_FILES) break;
        if (!ID_RE.test(folderId)) continue;
        let listed;
        try {
          listed = await drive.files.list({
            q: `'${folderId}' in parents and trashed = false and (${types})`,
            fields: 'files(id, name, mimeType, size)',
            orderBy: 'modifiedTime desc',
            pageSize: MAX_DRIVE_FILES,
          });
        } catch (e) {
          if (isInvalidGrant(e)) throw e;
          failed.push({ id: folderId, name: `folder ${folderId}` });
          continue;
        }
        for (const f of listed.data.files ?? []) {
          if (files.length >= MAX_DRIVE_FILES) break;
          if (!f.id || !f.name) continue;
          if (f.size && Number(f.size) > MAX_DRIVE_FILE_BYTES) continue;
          try {
            const res =
              f.mimeType === GOOGLE_DOC
                ? await drive.files.export(
                    { fileId: f.id, mimeType: 'text/plain' },
                    { responseType: 'stream' },
                  )
                : await drive.files.get({ fileId: f.id, alt: 'media' }, { responseType: 'stream' });
            const text = await readLimited(res.data as unknown as Readable, MAX_DRIVE_FILE_BYTES);
            files.push({ id: f.id, name: f.name, text: text.replaceAll('\u0000', '') });
          } catch (e) {
            if (e instanceof TooLargeError) continue; // over the limit: skipped, like a large listed size
            if (isInvalidGrant(e)) throw e;
            failed.push({ id: f.id, name: f.name });
          }
        }
      }
      return { files, failed };
    });
  },
};
