import { getUserById, listActiveConnections, type TenantHandle } from '@wma/db';
import type { BundleSource, SourceBundle } from './types';

/** Max characters of one source passed to the model and to post-validation. */
export const MAX_SOURCE_CHARS = 60_000;

export interface DriveFileText {
  id: string;
  name: string;
  text: string;
}

/** What a Drive read produced: the readable files, and the files (or folders) that failed. */
export interface DriveCollection {
  files: DriveFileText[];
  failed: Array<{ id: string; name: string }>;
}

/** Reads Drive files (exported as text) for the selected folders. Injected so tests use a fake. */
export interface DrivePort {
  collectFiles(handle: TenantHandle, userId: string, folderIds: string[]): Promise<DriveCollection>;
}

const cfg = (c: unknown): Record<string, unknown> =>
  c && typeof c === 'object' ? (c as Record<string, unknown>) : {};
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const clip = (s: string) => s.slice(0, MAX_SOURCE_CHARS);

/**
 * Gathers the source texts once. Disconnected connections are never read. Resume, LinkedIn and
 * GitHub text was cached on the connection when it was connected; Drive files are exported now.
 */
export async function gatherBundle(
  handle: TenantHandle,
  userId: string,
  deps: { drive?: DrivePort } = {},
): Promise<SourceBundle> {
  const user = await getUserById(handle, userId);
  const connections = await listActiveConnections(handle, userId);
  const sources: BundleSource[] = [];
  const links: SourceBundle['links'] = { linkedin_url: null, github_url: null };

  for (const conn of connections) {
    const config = cfg(conn.config);
    switch (conn.kind) {
      case 'resume': {
        const text = str(config.text);
        sources.push({
          id: 'resume',
          kind: 'resume',
          text: clip(text),
          partial: conn.status === 'partial',
          label: 'Resume',
        });
        break;
      }
      case 'linkedin': {
        links.linkedin_url = str(config.url) || null;
        sources.push({
          id: 'linkedin',
          kind: 'linkedin',
          text: clip(str(config.text)),
          partial: conn.status === 'partial',
          label: 'LinkedIn',
        });
        break;
      }
      case 'github': {
        const username = str(config.username);
        links.github_url = username ? `https://github.com/${username}` : null;
        sources.push({
          id: 'github',
          kind: 'github',
          text: clip(str(config.text)),
          partial: conn.status === 'partial',
          label: 'GitHub',
        });
        break;
      }
      case 'drive': {
        const folderIds = Array.isArray(config.folder_ids)
          ? config.folder_ids.filter((x): x is string => typeof x === 'string')
          : [];
        if (folderIds.length === 0) break;
        try {
          if (!deps.drive) throw new Error('drive reader not configured');
          const { files, failed } = await deps.drive.collectFiles(handle, userId, folderIds);
          for (const f of files) {
            sources.push({
              id: `drive:${f.id}`,
              kind: 'drive',
              text: clip(f.text),
              partial: false,
              label: `Drive file ${f.name}`,
            });
          }
          // A file that could not be read is a partial source of its own; the others are kept.
          for (const f of failed) {
            sources.push({
              id: `drive:${f.id}`,
              kind: 'drive',
              text: '',
              partial: true,
              label: `Drive file ${f.name}`,
            });
          }
          // Folders selected but nothing usable came out (empty, unsupported files, all too large).
          if (files.length === 0 && failed.length === 0) {
            sources.push({
              id: 'drive',
              kind: 'drive',
              text: '',
              partial: true,
              label: 'Google Drive',
            });
          }
        } catch {
          sources.push({
            id: 'drive',
            kind: 'drive',
            text: '',
            partial: true,
            label: 'Google Drive',
          });
        }
        break;
      }
      default:
        break; // gmail and calendar are not profile sources
    }
  }
  return { sources, accountEmail: user.email, links };
}
