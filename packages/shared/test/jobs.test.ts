import { describe, expect, it } from 'vitest';
import {
  Candidate,
  dedupeKey,
  Judgment,
  JudgmentJsonSchema,
  normalizeJobUrl,
  parseAtsJobUrl,
  PendingReason,
} from '../src';

const GOOD = {
  apply: true,
  rationale: 'Strong match on the backend stack.',
  fit: 4,
  pay_min: null,
  pay_max: null,
  currency: null,
  location_mode: 'remote',
  seniority: 'senior',
  application_deadline: '2026-12-01',
};

describe('Judgment', () => {
  it('accepts a complete judgment', () => {
    expect(Judgment.parse(GOOD).fit).toBe(4);
  });

  it('rejects a judgment missing apply', () => {
    const rest: Record<string, unknown> = { ...GOOD };
    delete rest.apply;
    expect(Judgment.safeParse(rest).success).toBe(false);
  });

  it('enforces fit 1..5, rationale length and deadline format', () => {
    expect(Judgment.safeParse({ ...GOOD, fit: 0 }).success).toBe(false);
    expect(Judgment.safeParse({ ...GOOD, fit: 6 }).success).toBe(false);
    expect(Judgment.safeParse({ ...GOOD, fit: 2.5 }).success).toBe(false);
    expect(Judgment.safeParse({ ...GOOD, rationale: 'x'.repeat(601) }).success).toBe(false);
    expect(Judgment.safeParse({ ...GOOD, rationale: 'x'.repeat(600) }).success).toBe(true);
    expect(Judgment.safeParse({ ...GOOD, application_deadline: '12/01/2026' }).success).toBe(false);
    expect(Judgment.safeParse({ ...GOOD, application_deadline: '2026-02-30' }).success).toBe(false);
    expect(Judgment.safeParse({ ...GOOD, application_deadline: null }).success).toBe(true);
  });

  it('exposes a JSON schema listing every field', () => {
    const props = Object.keys((JudgmentJsonSchema as { properties: object }).properties);
    expect(props.sort()).toEqual(Object.keys(GOOD).sort());
  });
});

describe('Candidate and enums', () => {
  it('defaults the optional fields', () => {
    const c = Candidate.parse({
      source: 'hn',
      title: 'Engineer',
      companyName: 'Acme',
      url: 'https://acme.test/j',
    });
    expect(c.ats).toBeNull();
    expect(c.description).toBeNull();
  });

  it('PendingReason lists the eleven reasons', () => {
    expect(PendingReason.options).toHaveLength(11);
    expect(PendingReason.safeParse('browser-error').success).toBe(true);
    expect(PendingReason.safeParse('nope').success).toBe(false);
  });
});

describe('normalizeJobUrl', () => {
  it('lowercases the host, drops fragment and trailing slash', () => {
    expect(normalizeJobUrl('https://Careers.Example.COM/Jobs/Eng/#apply')).toBe(
      'https://careers.example.com/Jobs/Eng',
    );
    expect(normalizeJobUrl('https://example.com/')).toBe('https://example.com');
  });

  it('strips tracking parameters but keeps gh_jid', () => {
    expect(
      normalizeJobUrl('https://example.com/careers?utm_source=x&gh_jid=123&ref=li&gclid=a'),
    ).toBe('https://example.com/careers?gh_jid=123');
    expect(normalizeJobUrl('https://example.com/careers?utm_source=x&fbclid=1')).toBe(
      'https://example.com/careers',
    );
  });

  it('cuts the three ATS shapes back to board and job id', () => {
    const lever = '0a1b2c3d-1111-2222-3333-444455556666';
    const ashby = 'AABBCCDD-1111-2222-3333-444455556666';
    expect(normalizeJobUrl('https://boards.greenhouse.io/Acme/jobs/4567?gh_src=abc#x')).toBe(
      'https://boards.greenhouse.io/Acme/jobs/4567',
    );
    expect(normalizeJobUrl('https://job-boards.greenhouse.io/acme/jobs/4567/')).toBe(
      'https://job-boards.greenhouse.io/acme/jobs/4567',
    );
    expect(normalizeJobUrl(`https://jobs.lever.co/acme/${lever}/apply?lever-source=x`)).toBe(
      `https://jobs.lever.co/acme/${lever}`,
    );
    expect(normalizeJobUrl(`https://jobs.ashbyhq.com/acme/${ashby}/application?utm_source=y`)).toBe(
      `https://jobs.ashbyhq.com/acme/${ashby}`,
    );
  });

  it('returns non-URLs trimmed', () => {
    expect(normalizeJobUrl('  not a url ')).toBe('not a url');
  });
});

describe('parseAtsJobUrl and dedupeKey', () => {
  const uuid = '0a1b2c3d-1111-2222-3333-444455556666';

  it('reads the three shapes', () => {
    expect(parseAtsJobUrl('https://boards.greenhouse.io/acme/jobs/99')).toEqual({
      ats: 'greenhouse',
      boardSlug: 'acme',
      atsJobId: '99',
      region: '',
    });
    expect(parseAtsJobUrl('https://job-boards.greenhouse.io/acme/jobs/99')?.ats).toBe('greenhouse');
    expect(parseAtsJobUrl(`https://jobs.lever.co/acme/${uuid}`)?.ats).toBe('lever');
    expect(parseAtsJobUrl(`https://jobs.ashbyhq.com/acme/${uuid}`)?.ats).toBe('ashby');
    expect(parseAtsJobUrl('https://example.com/jobs/1')).toBeNull();
    expect(parseAtsJobUrl('https://boards.greenhouse.io/acme')).toBeNull();
  });

  it('reads the embedded Greenhouse application form as (greenhouse, slug, token)', () => {
    const embed = 'https://boards.greenhouse.io/embed/job_app?for=Acme&token=12345';
    expect(parseAtsJobUrl(embed)).toEqual({
      ats: 'greenhouse',
      boardSlug: 'acme',
      atsJobId: '12345',
      region: '',
    });
    expect(
      parseAtsJobUrl('https://job-boards.greenhouse.io/embed/job_app?for=acme&token=7'),
    ).toMatchObject({ atsJobId: '7' });
    // without a numeric token or a board it is not an application link
    expect(parseAtsJobUrl('https://boards.greenhouse.io/embed/job_app?for=acme')).toBeNull();
    expect(parseAtsJobUrl('https://boards.greenhouse.io/embed/job_app?token=1')).toBeNull();
    expect(
      parseAtsJobUrl('https://boards.greenhouse.io/embed/job_app?for=acme&token=abc'),
    ).toBeNull();
    // two embedded applications are two keys, and they agree with the board's own URL for the job
    const other = 'https://boards.greenhouse.io/embed/job_app?for=acme&token=67890';
    expect(dedupeKey({ url: embed })).toBe('greenhouse:12345');
    expect(dedupeKey({ url: other })).not.toBe(dedupeKey({ url: embed }));
    expect(dedupeKey({ url: embed })).toBe(
      dedupeKey({ url: 'https://boards.greenhouse.io/acme/jobs/12345' }),
    );
  });

  it('normalizes an embedded application URL without collapsing it onto /embed/job_app', () => {
    expect(
      normalizeJobUrl(
        'https://Boards.greenhouse.io/embed/job_app/?token=12345&for=Acme&utm_source=x#frag',
      ),
    ).toBe('https://boards.greenhouse.io/embed/job_app?for=acme&token=12345');
  });

  it('reports the EU region of Lever and Greenhouse hosts', () => {
    expect(parseAtsJobUrl(`https://jobs.eu.lever.co/acme/${uuid}`)?.region).toBe('eu');
    expect(parseAtsJobUrl(`https://jobs.lever.co/acme/${uuid}`)?.region).toBe('');
    expect(parseAtsJobUrl('https://boards.eu.greenhouse.io/acme/jobs/9')?.region).toBe('eu');
  });

  it('uses ats:id when both fields are known', () => {
    expect(dedupeKey({ ats: 'lever', atsJobId: uuid.toUpperCase(), url: 'https://x.test/a' })).toBe(
      `lever:${uuid}`,
    );
  });

  it('derives ats:id from a hosted URL when the fields are missing, so HN and board agree', () => {
    const board = dedupeKey({
      ats: 'greenhouse',
      atsJobId: '99',
      url: 'https://boards.greenhouse.io/acme/jobs/99',
    });
    const hn = dedupeKey({ url: 'https://job-boards.greenhouse.io/acme/jobs/99?utm_source=hn' });
    expect(hn).toBe(board);
    expect(board).toBe('greenhouse:99');
  });

  it('falls back to the normalized URL', () => {
    expect(dedupeKey({ url: 'https://Example.com/jobs/7/?utm_medium=x#top' })).toBe(
      'https://example.com/jobs/7',
    );
  });
});
