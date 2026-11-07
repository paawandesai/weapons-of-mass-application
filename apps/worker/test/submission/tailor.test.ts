import { describe, expect, it } from 'vitest';
import { applicationFileKey } from '@wma/db';
import {
  compareFacts,
  compareSkills,
  normalizeName,
  tailorResume,
} from '../../src/submission/tailor';
import { factsFromContent, parseDate } from '../../src/submission/tailor/facts';
import type { ResumeFacts } from '../../src/submission/tailor/schema';
import type { RenderedPdf } from '../../src/submission/pdf';
import { ResumeTooLongError, RenderError } from '../../src/submission/pdf';
import {
  APPLICATION_ID,
  callsTo,
  GOOD_FACTS,
  GOOD_RESUME,
  makeCtx,
  PROFILE,
  scripted,
  TENANT_ID,
} from '../fixtures/submission';

const facts = (over: Partial<ResumeFacts>): ResumeFacts => ({ ...GOOD_FACTS, ...over });

describe('normalizeName', () => {
  it('lowercases, strips punctuation and trailing legal suffixes', () => {
    expect(normalizeName('Google LLC')).toBe('google');
    expect(normalizeName('Acme Corp.')).toBe('acme');
    expect(normalizeName('Acme Co., Ltd.')).toBe('acme');
    expect(normalizeName('Müller GmbH')).toBe('muller');
    expect(normalizeName('Co')).toBe('co');
  });
});

describe('compareFacts (rule 6)', () => {
  it('passes the truthful facts', () => {
    expect(compareFacts(PROFILE, GOOD_FACTS)).toEqual([]);
  });

  it('fails an invented employer', () => {
    const f = compareFacts(
      PROFILE,
      facts({
        employers: ['Google', 'Acme Corp', 'Initech'],
        roles: [
          ...GOOD_FACTS.roles,
          { employer: 'Initech', title: 'CTO', start_date: '2015', end_date: '2017' },
        ],
      }),
    );
    expect(f.some((x) => x.includes('"Initech"'))).toBe(true);
  });

  it('passes "Google" against "Google LLC" and "Acme Corporation-style" suffix differences', () => {
    const f = compareFacts(
      { ...PROFILE, work_history: PROFILE.work_history.map((w) => ({ ...w })) },
      facts({
        employers: ['Google LLC', 'Acme Corp.'],
        roles: [
          { ...GOOD_FACTS.roles[0]!, employer: 'Google LLC' },
          { ...GOOD_FACTS.roles[1]!, employer: 'ACME Corp.' },
        ],
      }),
    );
    expect(f).toEqual([]);
  });

  it('fails an invented title', () => {
    const f = compareFacts(
      PROFILE,
      facts({ roles: [{ ...GOOD_FACTS.roles[0]!, title: 'VP of Engineering' }] }),
    );
    expect(f).toEqual([expect.stringContaining('Title "VP of Engineering"')]);
  });

  it('fails a start date before the profile range', () => {
    const f = compareFacts(
      PROFILE,
      facts({ roles: [{ ...GOOD_FACTS.roles[1]!, start_date: '2016-01' }] }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]).toContain('start before');
  });

  it('fails an end date after the profile range and a current role the profile ended', () => {
    const later = compareFacts(
      PROFILE,
      facts({ roles: [{ ...GOOD_FACTS.roles[1]!, end_date: '2022-05' }] }),
    );
    expect(later[0]).toContain('end after');
    const current = compareFacts(
      PROFILE,
      facts({ roles: [{ ...GOOD_FACTS.roles[1]!, end_date: 'present' }] }),
    );
    expect(current[0]).toContain('shown as current');
  });

  it('allows a year-only date inside the range and a shorter range', () => {
    const f = compareFacts(
      PROFILE,
      facts({ roles: [{ ...GOOD_FACTS.roles[1]!, start_date: '2019', end_date: '2020' }] }),
    );
    expect(f).toEqual([]);
  });

  it('accepts Mar 2021 style dates', () => {
    const f = compareFacts(
      PROFILE,
      facts({ roles: [{ ...GOOD_FACTS.roles[0]!, start_date: 'Mar 2021', end_date: 'Present' }] }),
    );
    expect(f).toEqual([]);
  });

  it('fails an invented institution, degree and certification', () => {
    expect(
      compareFacts(
        PROFILE,
        facts({ education: [{ institution: 'MIT', degree: 'BSc Computer Science' }] }),
      )[0],
    ).toContain('Institution "MIT"');
    expect(
      compareFacts(
        PROFILE,
        facts({ education: [{ institution: 'University of Porto', degree: 'PhD Physics' }] }),
      )[0],
    ).toContain('Degree "PhD Physics"');
    expect(
      compareFacts(PROFILE, facts({ certifications: ['AWS Solutions Architect'] }))[0],
    ).toContain('Certification');
  });

  it('fails closed on a date it cannot interpret, including an invented ISO day', () => {
    for (const bad of ['2010-01-01', '2019-13', 'sometime in 2019', '1800', 'Q3 2019']) {
      const f = compareFacts(
        PROFILE,
        facts({ roles: [{ ...GOOD_FACTS.roles[1]!, start_date: bad }] }),
      );
      expect(f, bad).toEqual([expect.stringContaining('not a valid date')]);
    }
    const end = compareFacts(
      PROFILE,
      facts({ roles: [{ ...GOOD_FACTS.roles[1]!, end_date: '2019-00' }] }),
    );
    expect(end[0]).toContain('not a valid date');
    expect(parseDate('2019-12')).toEqual({ year: 2019, month: 12 });
    expect(parseDate('2019-13')).toBe('invalid');
    expect(parseDate('')).toBeNull();
  });

  it('rejects a reversed range even when each endpoint passes its own bound', () => {
    // Profile range is 2018-06 to 2021-02: 2030-2019 passes "start >= 2018" and "end <= 2021".
    const crossed = compareFacts(
      PROFILE,
      facts({ roles: [{ ...GOOD_FACTS.roles[1]!, start_date: '2030', end_date: '2019' }] }),
    );
    expect(crossed.join('\n')).toContain('end before they start');
    const inside = compareFacts(
      PROFILE,
      facts({ roles: [{ ...GOOD_FACTS.roles[1]!, start_date: '2020-06', end_date: '2019-01' }] }),
    );
    expect(inside).toEqual([expect.stringContaining('end before they start')]);
  });

  it('checks both endpoints against the profile interval', () => {
    const f = compareFacts(
      PROFILE,
      facts({ roles: [{ ...GOOD_FACTS.roles[1]!, start_date: '2021-06', end_date: '2021-09' }] }),
    );
    expect(f.join('\n')).toContain('start after');
    expect(f.join('\n')).toContain('end after');
  });

  it('checks the education field, so a bare degree cannot hide an invented subject', () => {
    const edu = (field: string | null, degree: string | null = 'BSc') => ({
      education: [{ institution: 'University of Porto', degree, field }],
    });
    expect(compareFacts(PROFILE, facts(edu('Computer Science')))).toEqual([]);
    expect(compareFacts(PROFILE, facts(edu('Astrophysics')))[0]).toContain('Degree');
    expect(compareFacts(PROFILE, facts(edu('Astrophysics', null)))[0]).toContain('Degree');
    // The same check on what the structured resume prints.
    const printed = factsFromContent({
      ...GOOD_RESUME,
      education: [
        {
          institution: 'University of Porto',
          degree: 'BSc',
          field: 'Astrophysics',
          start_date: null,
          end_date: null,
        },
      ],
    });
    expect(printed.education[0]).toMatchObject({ degree: 'BSc', field: 'Astrophysics' });
    expect(compareFacts(PROFILE, printed)[0]).toContain('Degree');
  });

  it('accepts a certification only when the profile states it as held', () => {
    const claim = facts({ certifications: ['AWS Solutions Architect'] });
    // Prose that merely mentions the certification is not evidence.
    const prose = {
      ...PROFILE,
      identity: {
        ...PROFILE.identity,
        summary: 'Studying for AWS Solutions Architect. Not AWS Solutions Architect certified.',
      },
    };
    expect(compareFacts(prose, claim)[0]).toContain('Certification');
    expect(compareFacts(PROFILE, claim)[0]).toContain('Certification');
    const held = {
      ...PROFILE,
      certifications: [{ name: 'AWS Solutions Architect', issuer: 'Amazon', sources: ['cv'] }],
    };
    expect(compareFacts(held, claim)).toEqual([]);
    expect(
      compareFacts(held, facts({ certifications: ['Amazon AWS Solutions Architect'] })),
    ).toEqual([]);
    expect(
      compareFacts(held, facts({ certifications: ['Amazon aws solutions architect'] })),
    ).toEqual([]);
    expect(compareFacts(held, facts({ certifications: ['CKA'] }))[0]).toContain('Certification');
  });

  it('accepts the degree and field combined or separate', () => {
    for (const degree of ['BSc', 'BSc Computer Science', 'BSc in Computer Science']) {
      const f = compareFacts(
        PROFILE,
        facts({ education: [{ institution: 'University of Porto', degree }] }),
      );
      expect(f).toEqual([]);
    }
  });
});

const fakeRender = async (): Promise<RenderedPdf> => ({
  bytes: Buffer.from('%PDF-fake'),
  pageCount: 1,
  fontStep: 0,
});

const BAD_RESUME = {
  ...GOOD_RESUME,
  experience: [
    ...GOOD_RESUME.experience,
    {
      employer: 'Initech',
      title: 'CTO',
      location: null,
      start_date: '2015',
      end_date: '2017',
      bullets: ['Ran everything.'],
    },
  ],
};
const BAD_FACTS = {
  ...GOOD_FACTS,
  employers: [...GOOD_FACTS.employers, 'Initech'],
  roles: [
    ...GOOD_FACTS.roles,
    { employer: 'Initech', title: 'CTO', start_date: '2015', end_date: '2017' },
  ],
};

describe('compareSkills', () => {
  const withSkills = (skills: string[], technologies = ['TypeScript']) => ({
    ...GOOD_RESUME,
    skills,
    projects: GOOD_RESUME.projects.map((p) => ({ ...p, technologies })),
  });

  it('passes profile skills and project technologies, ignoring case and spacing', () => {
    expect(compareSkills(PROFILE, GOOD_RESUME)).toEqual([]);
    expect(compareSkills(PROFILE, withSkills(['typescript', ' PostgreSQL ']))).toEqual([]);
  });

  it('fails skills inferred from highlights and posting synonyms', () => {
    expect(compareSkills(PROFILE, withSkills(['Team leadership', 'SQL', 'PostgreSQL']))).toEqual([
      'Skill "Team leadership" is not in the profile.',
      'Skill "SQL" is not in the profile.',
    ]);
  });

  it('checks project technologies and keeps symbols distinct', () => {
    expect(compareSkills(PROFILE, withSkills(['TypeScript'], ['TypeScript', 'Rust']))).toEqual([
      'Skill "Rust" is not in the profile.',
    ]);
    const cSharp = { ...PROFILE, skills: [{ name: 'C#', category: null }] };
    expect(compareSkills(cSharp, withSkills(['C++'], []))).toEqual([
      'Skill "C++" is not in the profile.',
    ]);
  });
});

describe('tailorResume (task 2.3)', () => {
  it('first draft passes: stores the PDF and returns the unmet requirements', async () => {
    const llm = scripted({
      'tailor-resume/v1': [GOOD_RESUME],
      'extract-resume-facts/v1': [GOOD_FACTS],
    });
    const ctx = makeCtx(llm);
    const r = await tailorResume(ctx, { render: fakeRender });
    const key = applicationFileKey(TENANT_ID, APPLICATION_ID, 'resume.pdf');
    expect(r).toEqual({
      ok: true,
      pdfKey: key,
      pageCount: 1,
      unmetRequirements: ['Rust', 'CKA certification'],
      regenerated: false,
    });
    expect(ctx.files.store.get(key)?.toString()).toBe('%PDF-fake');
    const [gen] = callsTo(llm, 'tailor-resume/v1');
    expect(gen?.user).toContain('Staff Backend Engineer');
    expect(gen?.user).not.toContain('salary_floor');
    expect(gen?.user).not.toContain('Authorized to work');
    expect(gen?.user).not.toContain('<rejected>');
  });

  it('regenerates once with the failures quoted, then passes', async () => {
    const llm = scripted({
      'tailor-resume/v1': [BAD_RESUME, GOOD_RESUME],
      'extract-resume-facts/v1': [BAD_FACTS, GOOD_FACTS],
    });
    const r = await tailorResume(makeCtx(llm), { render: fakeRender });
    expect(r.ok && r.regenerated).toBe(true);
    const gens = callsTo(llm, 'tailor-resume/v1');
    expect(gens).toHaveLength(2);
    expect(gens[1]?.user).toContain('<rejected>');
    expect(gens[1]?.user).toContain('Employer "Initech" is not in the profile.');
  });

  it('regenerates when the skills list claims a skill the profile lacks', async () => {
    const llm = scripted({
      'tailor-resume/v1': [
        { ...GOOD_RESUME, skills: ['TypeScript', 'Team leadership'] },
        GOOD_RESUME,
      ],
      'extract-resume-facts/v1': [GOOD_FACTS],
    });
    const r = await tailorResume(makeCtx(llm), { render: fakeRender });
    expect(r.ok && r.regenerated).toBe(true);
    expect(callsTo(llm, 'tailor-resume/v1')[1]?.user).toContain(
      'Skill "Team leadership" is not in the profile.',
    );
  });

  it('fails with tailoring-check-failed after the second failed check, storing nothing', async () => {
    const llm = scripted({
      'tailor-resume/v1': [BAD_RESUME],
      'extract-resume-facts/v1': [BAD_FACTS],
    });
    const ctx = makeCtx(llm);
    const r = await tailorResume(ctx, { render: fakeRender });
    expect(r).toEqual({
      ok: false,
      reason: 'tailoring-check-failed',
      detail: 'invalid_facts',
      failures: ['Employer "Initech" is not in the profile.'],
    });
    expect(callsTo(llm, 'tailor-resume/v1')).toHaveLength(2);
    expect(ctx.files.store.size).toBe(0);
  });

  it('catches an invention the extractor missed by checking the structured resume too', async () => {
    const llm = scripted({
      'tailor-resume/v1': [BAD_RESUME],
      'extract-resume-facts/v1': [GOOD_FACTS],
    });
    const r = await tailorResume(makeCtx(llm), { render: fakeRender });
    expect(r.ok).toBe(false);
  });

  it('takes the profile name as the document name and ignores the posting-side skill gap', async () => {
    const llm = scripted({
      'tailor-resume/v1': [GOOD_RESUME],
      'extract-resume-facts/v1': [GOOD_FACTS],
    });
    let seen = '';
    await tailorResume(makeCtx(llm), {
      render: async (doc) => {
        seen = doc.name;
        return fakeRender();
      },
    });
    expect(seen).toBe('Mara Quill');
  });

  it('maps a too-long render to tailoring-check-failed / too_long without regenerating', async () => {
    const llm = scripted({
      'tailor-resume/v1': [GOOD_RESUME],
      'extract-resume-facts/v1': [GOOD_FACTS],
    });
    const r = await tailorResume(makeCtx(llm), {
      render: async () => {
        throw new ResumeTooLongError(3);
      },
    });
    expect(r).toMatchObject({ ok: false, reason: 'tailoring-check-failed', detail: 'too_long' });
    expect(callsTo(llm, 'tailor-resume/v1')).toHaveLength(1);
  });

  it('lets a render failure propagate for the caller to map to render-failed', async () => {
    const llm = scripted({
      'tailor-resume/v1': [GOOD_RESUME],
      'extract-resume-facts/v1': [GOOD_FACTS],
    });
    await expect(
      tailorResume(makeCtx(llm), {
        render: async () => {
          throw new RenderError('boom');
        },
      }),
    ).rejects.toMatchObject({ code: 'render-failed' });
  });

  it('retries a schema-invalid reply once, then throws', async () => {
    const llm = scripted({
      'tailor-resume/v1': [{ nope: 1 }, GOOD_RESUME],
      'extract-resume-facts/v1': [GOOD_FACTS],
    });
    const r = await tailorResume(makeCtx(llm), { render: fakeRender });
    expect(r.ok).toBe(true);
    expect(callsTo(llm, 'tailor-resume/v1')[1]?.user).toContain('previous reply was rejected');
  });
});
