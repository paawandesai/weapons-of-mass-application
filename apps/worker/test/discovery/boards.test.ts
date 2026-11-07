import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  boardApiUrl,
  boardPublicUrl,
  createHttp,
  nameWords,
  parseBoardUrl,
  resolveBoard,
  slugVariants,
} from '@wma/discovery';
import { createWorld, delay, fastHttp, http, HttpResponse } from './support';

const w = createWorld();
beforeAll(() => w.server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => w.reset());
afterAll(() => w.server.close());

describe('slug variants (documented in docs/discovery.md)', () => {
  it('hyphenated, concatenated, then hints; legal suffixes and punctuation dropped', () => {
    expect(slugVariants('Northwind Labs')).toEqual(['northwind-labs', 'northwindlabs']);
    expect(slugVariants('Acme, Inc.')).toEqual(['acme']);
    expect(slugVariants('Tallow & Wick', ['tallowandwick', 'Tallow_Wick!'])).toEqual([
      'tallow-and-wick',
      'tallowandwick',
      'tallowwick',
    ]);
    expect(slugVariants('Café Zoë GmbH')).toEqual(['cafe-zoe', 'cafezoe']);
  });
  it('caps at six and drops hints that are not slugs', () => {
    const v = slugVariants('A B', ['x1', 'x2', 'x3', 'x4', 'x5', '!!!']);
    expect(v).toHaveLength(6);
    expect(v).not.toContain('');
  });
  it('nameWords keeps a lone legal-looking word', () => {
    expect(nameWords('Company')).toEqual(['company']);
  });
});

describe('parseBoardUrl', () => {
  it.each([
    ['https://boards.greenhouse.io/northwind-labs', 'greenhouse', 'northwind-labs', ''],
    [
      'https://job-boards.greenhouse.io/Northwind-Labs/jobs/4001001',
      'greenhouse',
      'northwind-labs',
      '',
    ],
    [
      'https://boards.greenhouse.io/embed/job_board?for=northwind-labs',
      'greenhouse',
      'northwind-labs',
      '',
    ],
    ['jobs.lever.co/quillbase', 'lever', 'quillbase', ''],
    [
      'https://jobs.eu.lever.co/quillbase/0c7c1a52-3f0e-4c63-8b8e-5a1f6d2b9e11',
      'lever',
      'quillbase',
      'eu',
    ],
    ['https://boards.eu.greenhouse.io/acme', 'greenhouse', 'acme', 'eu'],
    ['https://jobs.ashbyhq.com/brightforge', 'ashby', 'brightforge', ''],
  ])('%s', (url, ats, slug, region) => {
    expect(parseBoardUrl(url)).toEqual({ ats, boardSlug: slug, region });
  });
  it('rejects other hosts and empty boards', () => {
    expect(parseBoardUrl('https://example.com/careers')).toBeNull();
    expect(parseBoardUrl('https://jobs.lever.co/')).toBeNull();
    expect(parseBoardUrl('not a url at all')).toBeNull();
    expect(parseBoardUrl('ftp://jobs.lever.co/x')).toBeNull();
  });
  it('builds public and API urls', () => {
    expect(boardPublicUrl('ashby', 'x')).toBe('https://jobs.ashbyhq.com/x');
    expect(boardApiUrl('lever', 'x')).toBe('https://api.lever.co/v0/postings/x?mode=json');
  });
  it('keeps the Lever EU region in both the public URL and the API endpoint', () => {
    const board = parseBoardUrl('https://jobs.eu.lever.co/quillbase')!;
    expect(boardPublicUrl(board.ats, board.boardSlug, board.region)).toBe(
      'https://jobs.eu.lever.co/quillbase',
    );
    expect(boardApiUrl(board.ats, board.boardSlug, { region: board.region })).toBe(
      'https://api.eu.lever.co/v0/postings/quillbase?mode=json',
    );
    expect(boardApiUrl('greenhouse', 'acme', { region: 'eu', full: true })).toBe(
      'https://boards-api.eu.greenhouse.io/v1/boards/acme/jobs?content=true',
    );
    // Ashby has no EU host: the region is ignored
    expect(boardApiUrl('ashby', 'x', { region: 'eu' })).toBe(boardApiUrl('ashby', 'x'));
  });
});

describe('resolveBoard', () => {
  it('resolves the first slug variant that answers 200 on each ATS', async () => {
    const r = await resolveBoard('Northwind Labs', [], { http: fastHttp() });
    expect(r).toEqual({
      status: 'resolved',
      partial: false,
      boards: [
        {
          ats: 'greenhouse',
          boardSlug: 'northwind-labs',
          region: '',
          boardUrl: 'https://boards.greenhouse.io/northwind-labs',
        },
      ],
    });
  });
  it('can resolve on more than one ATS and uses hints', async () => {
    w.world.lever['brightforge-hq'] = [];
    const r = await resolveBoard('Brightforge', ['brightforge-hq'], { http: fastHttp() });
    expect(
      r.status === 'resolved' && r.boards.map((b) => `${b.ats}:${b.boardSlug}`).sort(),
    ).toEqual(['ashby:brightforge', 'lever:brightforge-hq']);
  });
  it('is unresolved when every ATS answers 404', async () => {
    expect(await resolveBoard('Nonesuch Industries', [], { http: fastHttp() })).toEqual({
      status: 'unresolved',
    });
  });
  it('is unavailable (not unresolved) when an ATS times out and nothing else resolved', async () => {
    w.server.use(
      http.get('https://api.lever.co/v0/postings/:slug', async () => {
        await delay('infinite');
        return HttpResponse.json([]);
      }),
    );
    const r = await resolveBoard('Nonesuch Industries', [], {
      http: createHttp({ timeoutMs: 50, retries: 0 }),
    });
    expect(r).toEqual({ status: 'unavailable' });
  });
  it('a 5xx on one ATS does not hide a board found on another; the result is marked partial', async () => {
    w.world.failing.add('lever:northwind-labs');
    w.world.failing.add('lever:northwindlabs');
    const r = await resolveBoard('Northwind Labs', [], { http: fastHttp() });
    expect(r.status).toBe('resolved');
    expect(r.status === 'resolved' && r.partial).toBe(true);
  });
  it('retries a 503 and succeeds when the ATS recovers', async () => {
    let n = 0;
    w.server.use(
      http.get('https://api.ashbyhq.com/posting-api/job-board/:slug', () =>
        ++n < 2 ? new HttpResponse('x', { status: 503 }) : HttpResponse.json({ jobs: [] }),
      ),
    );
    const r = await resolveBoard('Whatever', [], { http: fastHttp() });
    expect(r.status === 'resolved' && r.boards[0]!.ats).toBe('ashby');
  });
  it('treats a 200 that is not a board as missing', async () => {
    w.server.use(
      http.get('https://api.lever.co/v0/postings/:slug', () => HttpResponse.json({ ok: true })),
    );
    const r = await resolveBoard('Northwind Labs', [], { http: fastHttp() });
    expect(r.status === 'resolved' && r.boards.map((b) => b.ats)).toEqual(['greenhouse']);
  });
});

describe('per-host concurrency', () => {
  const body = (onDone: () => void) =>
    new ReadableStream<Uint8Array>({
      async start(controller) {
        // headers go out at once; the body trickles in afterwards
        controller.enqueue(new TextEncoder().encode('{'));
        await new Promise((r) => setTimeout(r, 25));
        controller.enqueue(new TextEncoder().encode('}'));
        controller.close();
        onDone();
      },
    });

  it('never has more than 2 requests in flight to one host', async () => {
    let active = 0;
    let max = 0;
    w.server.use(
      http.get('https://boards-api.greenhouse.io/v1/boards/:slug/jobs', async () => {
        max = Math.max(max, ++active);
        await delay(20);
        active--;
        return new HttpResponse('{}', { status: 404 });
      }),
    );
    const client = fastHttp();
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        client.get(`https://boards-api.greenhouse.io/v1/boards/s${i}/jobs`),
      ),
    );
    expect(max).toBe(2);
  });

  it('holds the permit until the body has been read, not just until the headers arrive', async () => {
    let active = 0;
    let max = 0;
    w.server.use(
      http.get('https://boards-api.greenhouse.io/v1/boards/:slug/jobs', () => {
        max = Math.max(max, ++active);
        return new HttpResponse(
          body(() => active--),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const client = fastHttp();
    const texts = await Promise.all(
      Array.from({ length: 8 }, async (_, i) =>
        (await client.get(`https://boards-api.greenhouse.io/v1/boards/s${i}/jobs`)).text(),
      ),
    );
    expect(texts.every((t) => t === '{}')).toBe(true);
    expect(max).toBe(2);
  });
});
