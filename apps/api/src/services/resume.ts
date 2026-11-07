import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import mammoth from 'mammoth';
import {
  deleteStoredFile,
  disconnectConnection,
  resolveInStore,
  upsertConnection,
  withUserLock,
  type SourceConnectionRow,
  type TenantHandle,
} from '@wma/db';
import { PDFParse } from 'pdf-parse';
import { cleanText } from './connections';

export const MAX_RESUME_BYTES = 10 * 1024 * 1024;

export class ResumeError extends Error {
  constructor(
    readonly code: 'unsupported_type' | 'too_large' | 'unreadable_file',
    message: string,
  ) {
    super(message);
    this.name = 'ResumeError';
  }
}

export type ResumeFormat = 'pdf' | 'docx';

const startsWith = (b: Uint8Array, sig: number[]) => sig.every((x, i) => b[i] === x);

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Decides the format from the bytes (a renamed PNG is not a PDF). DOCX is a zip named .docx. */
export function detectFormat(bytes: Uint8Array, filename: string, mime: string): ResumeFormat {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf'; // %PDF-
  const zip = startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
  if (zip && (filename.toLowerCase().endsWith('.docx') || mime === DOCX_MIME)) return 'docx';
  throw new ResumeError('unsupported_type', 'Upload a PDF or DOCX file.');
}

export async function extractResumeText(bytes: Uint8Array, format: ResumeFormat): Promise<string> {
  try {
    if (format === 'pdf') {
      const parser = new PDFParse({ data: new Uint8Array(bytes) });
      try {
        const result = await parser.getText();
        return cleanText(result.text);
      } finally {
        await parser.destroy();
      }
    }
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return cleanText(result.value);
  } catch {
    throw new ResumeError('unreadable_file', 'The file could not be read. Try exporting it again.');
  }
}

export interface PreparedResume {
  format: ResumeFormat;
  text: string;
  filename: string;
  size: number;
}

/** Validates an uploaded resume and extracts its text. Touches no state. */
export async function prepareResume(args: {
  filename: string;
  mime: string;
  bytes: Uint8Array;
}): Promise<PreparedResume> {
  const { bytes } = args;
  if (bytes.byteLength > MAX_RESUME_BYTES) {
    throw new ResumeError('too_large', 'The file is larger than 10 MB.');
  }
  const format = detectFormat(bytes, args.filename, args.mime);
  const text = await extractResumeText(bytes, format);
  if (text === '') {
    throw new ResumeError(
      'unreadable_file',
      'No text could be read from the file. Scanned files are not supported.',
    );
  }
  return {
    format,
    text,
    filename: basename(args.filename).slice(0, 200),
    size: bytes.byteLength,
  };
}

const resumeRef = (tenantId: string, userId: string, format: ResumeFormat) =>
  join(tenantId, userId, `resume.${format}`);

/**
 * Replaces the user's resume: stores the file under <store>/<tenant>/<user>/ and upserts the
 * connection. The whole replacement runs under a per-user advisory lock, so concurrent uploads,
 * format changes and disconnects take turns. The bytes go to a uniquely named temp file first and
 * are renamed into place only after the connection row is written (inside the open transaction),
 * so a failure leaves the previous file and row untouched.
 */
export async function replaceResume(args: {
  handle: TenantHandle;
  storeDir: string;
  tenantId: string;
  userId: string;
  prepared: PreparedResume;
  bytes: Uint8Array;
}): Promise<SourceConnectionRow> {
  const { handle, storeDir, tenantId, userId, prepared, bytes } = args;
  const fileRef = resumeRef(tenantId, userId, prepared.format);
  const abs = resolveInStore(storeDir, fileRef);
  const tmp = `${abs}.${randomUUID()}.tmp`;
  return withUserLock(handle, userId, async (h) => {
    await mkdir(dirname(abs), { recursive: true });
    try {
      await writeFile(tmp, bytes);
      const row = await upsertConnection(h, {
        userId,
        kind: 'resume',
        status: 'connected',
        fileRef,
        config: {
          filename: prepared.filename,
          format: prepared.format,
          size: prepared.size,
          text: prepared.text,
        },
      });
      await rename(tmp, abs);
      // A previous upload in the other format must not linger.
      const other = prepared.format === 'pdf' ? 'docx' : 'pdf';
      await rm(resolveInStore(storeDir, resumeRef(tenantId, userId, other)), { force: true });
      return row;
    } finally {
      await rm(tmp, { force: true });
    }
  });
}

/** Disconnects a source under the same per-user lock; removes the stored file (resume) with it. */
export async function disconnectSource(args: {
  handle: TenantHandle;
  storeDir: string;
  userId: string;
  kind: Parameters<typeof disconnectConnection>[2];
}): Promise<SourceConnectionRow | null> {
  const { handle, storeDir, userId, kind } = args;
  return withUserLock(handle, userId, async (h) => {
    const previous = await disconnectConnection(h, userId, kind);
    if (previous?.fileRef) await deleteStoredFile(storeDir, previous.fileRef);
    return previous;
  });
}
