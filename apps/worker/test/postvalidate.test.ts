import { describe, expect, it } from 'vitest';
import { profileModelOutputSchema, type ProfileModelOutput } from '@wma/shared';
import { postValidate, rangesOverlap } from '../src/profile/postvalidate';
import type { SourceBundle } from '../src/profile/types';
import clean from './fixtures/llm/clean.json';
import { GITHUB_TEXT, LINKEDIN_TEXT, RESUME_TEXT } from './fixtures/sources';

const base = (): ProfileModelOutput => profileModelOutputSchema.parse(structuredClone(clean));

const bundle = (over: Partial<SourceBundle> = {}): SourceBundle => ({
  accountEmail: 'account@example.test',
  links: { linkedin_url: null, github_url: null },
  sources: [
    { id: 'resume', kind: 'resume', text: RESUME_TEXT, partial: false },
    { id: 'linkedin', kind: 'linkedin', text: LINKEDIN_TEXT, partial: false },
    { id: 'github', kind: 'github', text: GITHUB_TEXT, partial: false },
  ],
  ...over,
});

const work = (
  employer: string,
  title: string,
  start: string | null,
  end: string | null,
  sources: string[],
) => ({
  employer,
  title,
  location: null,
  start_date: start,
  end_date: end,
  summary: null,
  highlights: [],
  sources,
});

describe('rule 2: provenance is required by the schema', () => {
  it('rejects an entry with no sources before post-validation', () => {
    const m = structuredClone(clean) as ProfileModelOutput;
    m.work_history[0]!.sources = [];
    expect(profileModelOutputSchema.safeParse(m).success).toBe(false);
  });
});

describe('rule 3: employer must appear in cited sources', () => {
  it('keeps a clean output unchanged with no flags', () => {
    const r = postValidate(base(), bundle());
    expect(r.flags).toEqual([]);
    expect(r.output.work_history).toHaveLength(2);
    expect(r.output.projects).toHaveLength(1);
    expect(r.output.education).toHaveLength(1);
  });

  it('drops an invented employer and flags it as unsupported_entry', () => {
    const m = base();
    m.work_history.push(work('Initech', 'Principal Engineer', '2016-01', '2018-05', ['resume']));
    const r = postValidate(m, bundle());
    expect(r.output.work_history.map((w) => w.employer)).toEqual(['Google', 'Acme Corp']);
    expect(r.flags).toHaveLength(1);
    expect(r.flags[0]).toMatchObject({
      kind: 'unsupported_entry',
      section: 'work_history',
      value: 'Initech',
      resolved: false,
    });
  });

  it('matches case-insensitively and across collapsed whitespace', () => {
    const m = base();
    m.work_history = [work('ACME   corp', 'Software Engineer', null, null, ['resume'])];
    expect(postValidate(m, bundle()).flags).toEqual([]);
  });

  it('Google (resume) and Google LLC (LinkedIn): the shorter stored form passes', () => {
    const m = base();
    m.work_history = [
      work('Google', 'Staff Software Engineer', '2021-03', null, ['resume', 'linkedin']),
    ];
    const r = postValidate(m, bundle());
    expect(r.flags).toEqual([]);
    expect(r.output.work_history).toHaveLength(1);
  });

  it('Google LLC citing only the resume is rejected and flagged (acceptable per brief)', () => {
    const m = base();
    m.work_history = [work('Google LLC', 'Staff Software Engineer', '2021-03', null, ['resume'])];
    const r = postValidate(m, bundle());
    expect(r.output.work_history).toHaveLength(0);
    expect(r.flags.map((f) => f.kind)).toEqual(['unsupported_entry']);
  });

  it('Google LLC citing both sources passes because LinkedIn contains it', () => {
    const m = base();
    m.work_history = [
      work('Google LLC', 'Staff Software Engineer', '2021-03', null, ['resume', 'linkedin']),
    ];
    expect(postValidate(m, bundle()).flags).toEqual([]);
  });

  it('only the cited sources count: a name present in an uncited source still fails', () => {
    const m = base();
    m.work_history = [work('Google LLC', 'Staff Software Engineer', null, null, ['resume'])];
    expect(postValidate(m, bundle()).output.work_history).toHaveLength(0);
  });

  it('a cited source id that is not in the bundle cannot support an entry', () => {
    const m = base();
    m.work_history = [work('Acme Corp', 'Software Engineer', null, null, ['drive:gone'])];
    const r = postValidate(m, bundle());
    expect(r.output.work_history).toHaveLength(0);
    expect(r.flags[0]?.kind).toBe('unsupported_entry');
  });

  it('a gap in employment and null dates produce no flag', () => {
    const m = base();
    m.work_history = [
      work('Google', 'Staff Software Engineer', '2021-03', null, ['resume']),
      work('Acme Corp', 'Software Engineer', null, null, ['resume']),
    ];
    expect(postValidate(m, bundle()).flags).toEqual([]);
  });
});

describe('rule 4: education and projects follow the same rule', () => {
  it('drops an invented institution', () => {
    const m = base();
    m.education.push({
      institution: 'Hogwarts',
      degree: null,
      field: null,
      start_date: null,
      end_date: null,
      sources: ['resume'],
    });
    const r = postValidate(m, bundle());
    expect(r.output.education.map((e) => e.institution)).toEqual(['University of Porto']);
    expect(r.flags[0]).toMatchObject({
      kind: 'unsupported_entry',
      section: 'education',
      value: 'Hogwarts',
    });
  });

  it('a project may cite github and the repository name counts as source text', () => {
    const r = postValidate(base(), bundle());
    expect(r.output.projects.map((p) => p.name)).toEqual(['tinyqueue']);
  });

  it('drops a project whose name is in no cited source', () => {
    const m = base();
    m.projects.push({ ...m.projects[0]!, name: 'skynet', sources: ['github'] });
    const r = postValidate(m, bundle());
    expect(r.output.projects).toHaveLength(1);
    expect(r.flags[0]).toMatchObject({ section: 'projects', value: 'skynet' });
  });
});

describe('rule 5: skills must appear in some source, dropped silently', () => {
  it('drops unsupported skills without a flag and keeps supported ones', () => {
    const m = base();
    m.skills.push({ name: 'Haskell', category: null }, { name: 'Go', category: null });
    const r = postValidate(m, bundle());
    expect(r.output.skills.map((s) => s.name)).toEqual(['TypeScript', 'PostgreSQL', 'Kubernetes']);
    expect(r.flags).toEqual([]);
  });

  it('matches whole tokens only ("Go" does not match "going")', () => {
    const m = base();
    m.skills = [{ name: 'Go', category: null }];
    const b = bundle({
      sources: [
        { id: 'resume', kind: 'resume', text: 'Going places with Kubernetes', partial: false },
      ],
    });
    expect(postValidate(m, b).output.skills).toEqual([]);
  });

  it('handles skills with punctuation such as C++', () => {
    const m = base();
    m.skills = [{ name: 'C++', category: null }];
    const b = bundle({
      sources: [{ id: 'resume', kind: 'resume', text: 'Skills: C++, Rust', partial: false }],
    });
    expect(postValidate(m, b).output.skills).toHaveLength(1);
  });
});

describe('rule 6: date conflicts', () => {
  const conflicting = () => {
    const m = base();
    m.work_history.push(
      work('Acme Corp', 'Senior Software Engineer', '2019-01', '2021-06', ['linkedin']),
    );
    return m;
  };

  it('same employer, overlapping ranges, different titles from different sources: one flag, both kept', () => {
    const r = postValidate(conflicting(), bundle());
    const conflicts = r.flags.filter((f) => f.kind === 'date_conflict');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ section: 'work_history', value: 'Acme Corp' });
    expect(conflicts[0]!.sources.sort()).toEqual(['linkedin', 'resume']);
    // The flag names both entries, so editing or removing either one resolves it.
    const acme = r.output.work_history.map((w, i) => [w.employer, i] as const);
    const idx = acme.filter(([e]) => e === 'Acme Corp').map(([, i]) => `work_history.${i}`);
    expect(conflicts[0]!.paths).toEqual(idx);
    expect(r.output.work_history.filter((w) => w.employer === 'Acme Corp')).toHaveLength(2);
  });

  it('a null end date overlaps any later start (null end = 9999-12)', () => {
    const m = base();
    m.work_history = [
      work('Google', 'Staff Software Engineer', '2021-03', null, ['resume']),
      work('Google', 'Principal Engineer', '2024-06', '2025-01', ['linkedin']),
    ];
    const r = postValidate(m, bundle());
    expect(r.flags.filter((f) => f.kind === 'date_conflict')).toHaveLength(1);
  });

  it('Google and Google LLC count as the same employer', () => {
    const m = base();
    m.work_history = [
      work('Google', 'Staff Software Engineer', '2021-03', null, ['resume']),
      work('Google LLC', 'Senior Engineer', '2021-01', '2022-01', ['linkedin']),
    ];
    expect(postValidate(m, bundle()).flags.filter((f) => f.kind === 'date_conflict')).toHaveLength(
      1,
    );
  });

  it('no flag for non-overlapping ranges, equal titles, shared sources or unknown dates', () => {
    const cases = [
      [
        work('Acme Corp', 'A', '2018-01', '2019-01', ['resume']),
        work('Acme Corp', 'B', '2019-02', '2020-01', ['linkedin']),
      ],
      [
        work('Acme Corp', 'Engineer', '2018-01', null, ['resume']),
        work('Acme Corp', 'engineer', '2019-01', null, ['linkedin']),
      ],
      [
        work('Acme Corp', 'A', '2018-01', null, ['resume']),
        work('Acme Corp', 'B', '2019-01', null, ['resume']),
      ],
      [
        work('Acme Corp', 'A', null, null, ['resume']),
        work('Acme Corp', 'B', '2019-01', null, ['linkedin']),
      ],
    ];
    for (const c of cases) {
      const m = base();
      m.work_history = c;
      expect(postValidate(m, bundle()).flags.filter((f) => f.kind === 'date_conflict')).toEqual([]);
    }
  });

  it('touching ranges overlap (start1 <= end2)', () => {
    expect(
      rangesOverlap(
        { start_date: '2020-01', end_date: '2020-06' },
        { start_date: '2020-06', end_date: null },
      ),
    ).toBe(true);
    expect(
      rangesOverlap(
        { start_date: '2020-01', end_date: '2020-05' },
        { start_date: '2020-06', end_date: null },
      ),
    ).toBe(false);
  });

  it('treats a year-only date as the whole year when comparing ranges', () => {
    // 2019 as an end covers December 2019, so a role starting 2019-12 overlaps it.
    expect(
      rangesOverlap(
        { start_date: '2018', end_date: '2019' },
        { start_date: '2019-12', end_date: null },
      ),
    ).toBe(true);
    expect(
      rangesOverlap(
        { start_date: '2018', end_date: '2019' },
        { start_date: '2020-01', end_date: null },
      ),
    ).toBe(false);
    // 2020 as a start begins in January, so it overlaps a role that ended in 2020-01.
    expect(
      rangesOverlap(
        { start_date: '2019-01', end_date: '2020-01' },
        { start_date: '2020', end_date: null },
      ),
    ).toBe(true);
    expect(
      rangesOverlap(
        { start_date: '2019', end_date: '2019' },
        { start_date: '2019', end_date: '2019' },
      ),
    ).toBe(true);
  });

  it('does not flag when one of the entries was dropped as unsupported', () => {
    const m = conflicting();
    m.work_history[2]!.sources = ['github']; // github text does not contain the employer
    const r = postValidate(m, bundle());
    expect(r.flags.map((f) => f.kind)).toEqual(['unsupported_entry']);
  });
});

describe('rule 7: partial sources', () => {
  it('a source with no text yields partial_source and the rest still validates', () => {
    const b = bundle({
      sources: [
        { id: 'resume', kind: 'resume', text: RESUME_TEXT, partial: false },
        { id: 'linkedin', kind: 'linkedin', text: '', partial: false },
      ],
    });
    const m = base();
    m.work_history = m.work_history.map((w) => ({ ...w, sources: ['resume'] }));
    m.projects = [];
    const r = postValidate(m, b);
    expect(r.flags).toHaveLength(1);
    expect(r.flags[0]).toMatchObject({ kind: 'partial_source', sources: ['linkedin'] });
    expect(r.output.work_history).toHaveLength(2);
  });

  it('a connection marked partial is flagged even with some text', () => {
    const b = bundle({
      sources: [
        { id: 'resume', kind: 'resume', text: RESUME_TEXT, partial: false },
        { id: 'linkedin', kind: 'linkedin', text: 'Mara Quill - Engineer', partial: true },
      ],
    });
    const m = base();
    m.work_history = [work('Acme Corp', 'Software Engineer', null, null, ['resume'])];
    m.projects = [];
    expect(postValidate(m, b).flags.map((f) => f.kind)).toEqual(['partial_source']);
  });
});

describe('contact details are not invented', () => {
  it('falls back to the account email and connection links; drops phone and website that no source states', () => {
    const m = base();
    m.contact = {
      email: 'made.up@nowhere.test',
      phone: '+1 555 123 4567',
      linkedin_url: 'https://www.linkedin.com/in/someone-else',
      github_url: null,
      website_url: 'https://invented.example.org',
    };
    const r = postValidate(
      m,
      bundle({
        links: {
          linkedin_url: 'https://www.linkedin.com/in/mara-quill',
          github_url: 'https://github.com/mara-quill',
        },
      }),
    );
    expect(r.output.contact).toEqual({
      email: 'account@example.test',
      phone: null,
      linkedin_url: 'https://www.linkedin.com/in/mara-quill',
      github_url: 'https://github.com/mara-quill',
      website_url: null,
    });
  });

  it('keeps contact details the resume states', () => {
    const r = postValidate(base(), bundle());
    expect(r.output.contact.email).toBe('mara.quill@example.com');
    expect(r.output.contact.phone).toBe('+351 910 000 000');
    expect(r.output.contact.linkedin_url).toBe('https://www.linkedin.com/in/mara-quill');
  });
});
