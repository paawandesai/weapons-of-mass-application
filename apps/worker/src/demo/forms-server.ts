import { createServer, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The saved ATS forms the demo applies to; served under `/forms/`. */
export const FORMS_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../test/fixtures/forms',
);

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

export interface FormsServer {
  /** `http://127.0.0.1:<port>` */
  origin: string;
  port: number;
  close(): Promise<void>;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolves `/forms/<rest>` to a file under `root`. A path naming a file is served as is
 * (`/forms/greenhouse/form.html`, `/forms/_shared/fixture.js`); `/forms/<vendor>/<id>` with no
 * such file serves that vendor's `form.html` (a posting id), so a seeded job URL needs no file of
 * its own. Anything that would leave `root` resolves to nothing.
 */
export async function resolveFormPath(root: string, urlPath: string): Promise<string | null> {
  if (!urlPath.startsWith('/forms/')) return null;
  let rest: string;
  try {
    rest = decodeURIComponent(urlPath.slice('/forms/'.length));
  } catch {
    return null;
  }
  if (rest.includes('\0')) return null;
  const abs = normalize(join(root, rest));
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  if (await isFile(abs)) return abs;
  const parts = rest.split('/').filter(Boolean);
  if (parts.length === 2 && !parts[1]!.includes('.') && parts[0] !== '_shared') {
    const form = normalize(join(root, parts[0]!, 'form.html'));
    if (form.startsWith(root + sep) && (await isFile(form))) return form;
  }
  return null;
}

/** Starts the fixture form server on 127.0.0.1. Port 0 picks a free one. */
export function startFormsServer(
  opts: { port: number; root?: string } = { port: 4310 },
): Promise<FormsServer> {
  const root = normalize(opts.root ?? FORMS_ROOT);
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    resolveFormPath(root, path)
      .then(async (file) => {
        if (!file) {
          res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
          return;
        }
        const body = await readFile(file);
        res
          .writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' })
          .end(req.method === 'HEAD' ? undefined : body);
      })
      .catch(() => {
        res.writeHead(500, { 'Content-Type': 'text/plain' }).end('error');
      });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}

/** Starts the server when `DEMO_FORMS_PORT` is set (the worker's main does this); else null. */
export async function startFormsServerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<FormsServer | null> {
  const raw = env.DEMO_FORMS_PORT;
  if (!raw) return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`DEMO_FORMS_PORT must be a port number, got "${raw}"`);
  }
  return startFormsServer({ port });
}
