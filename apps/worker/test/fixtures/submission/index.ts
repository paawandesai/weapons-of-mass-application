import { readFileSync } from 'node:fs';
import { FakeLlm, type StructuredLlm } from '@wma/llm';
import type { Judgment, ProfileDocument } from '@wma/shared';
import type { ResumeFacts, TailoredResume } from '../../../src/submission/tailor/schema';
import type { SubmissionContext } from '../../../src/submission/types';

/** Fictional person (Mara Quill); the model-output part is the existing profile-build fixture. */
const built = JSON.parse(
  readFileSync(new URL('../llm/clean.json', import.meta.url), 'utf8'),
) as Pick<
  ProfileDocument,
  'identity' | 'contact' | 'work_history' | 'projects' | 'skills' | 'education'
>;

export const PROFILE: ProfileDocument = {
  ...built,
  preferences: { target_titles: ['Staff Engineer'], locations: ['Porto'], remote: 'remote' },
  survey: {
    target_roles: ['Staff Engineer'],
    salary_floor: 90000,
    work_life_balance: null,
    family_constraints: null,
    willing_to_relocate: false,
    career_direction: null,
    daily_target: 12,
  },
  standard_answers: {
    work_authorization: 'Authorized to work in the EU',
    visa_sponsorship_required: false,
    start_date: '2026-12-01',
    earliest_start_date: '2026-12-01',
    notice_period: '30 days',
    reasons_for_change: 'Looking for a larger platform scope.',
  },
  flags: [],
};

export const TENANT_ID = '11111111-1111-4111-8111-111111111111';
export const APPLICATION_ID = '22222222-2222-4222-8222-222222222222';

export const JOB = {
  id: '33333333-3333-4333-8333-333333333333',
  title: 'Staff Backend Engineer',
  url: 'https://boards.greenhouse.io/initrode/jobs/42',
  location: 'Remote (EU)',
  description:
    'Initrode builds payment infrastructure. You will own streaming data pipelines on Kubernetes and PostgreSQL, mentor engineers, and hold a CKA certification. Experience with Rust is required.',
};

export const JUDGMENT: Judgment = {
  apply: true,
  rationale: 'Strong fit.',
  fit: 5,
  pay_min: null,
  pay_max: null,
  currency: null,
  location_mode: 'remote',
  seniority: 'staff',
  application_deadline: null,
};

/** A truthful tailored resume for JOB. */
export const GOOD_RESUME: TailoredResume = {
  headline: 'Staff Backend Engineer',
  summary:
    'Backend engineer who moves batch pipelines to streaming, with production TypeScript and PostgreSQL experience.',
  experience: [
    {
      employer: 'Google',
      title: 'Staff Software Engineer',
      location: null,
      start_date: '2021-03',
      end_date: 'present',
      bullets: ['Led the move of batch pipelines to streaming, cutting latency by half.'],
    },
    {
      employer: 'Acme Corp',
      title: 'Software Engineer',
      location: null,
      start_date: '2018-06',
      end_date: '2021-02',
      bullets: ['Built the ingestion service in TypeScript on PostgreSQL.'],
    },
  ],
  projects: [
    {
      name: 'tinyqueue',
      description: 'A small Postgres-backed job queue',
      technologies: ['TypeScript'],
    },
  ],
  education: [
    {
      institution: 'University of Porto',
      degree: 'BSc',
      field: 'Computer Science',
      start_date: '2014-09',
      end_date: '2018-06',
    },
  ],
  skills: ['TypeScript', 'PostgreSQL', 'Kubernetes'],
  unmet_requirements: ['Rust', 'CKA certification'],
};

/** What a correct fact extraction of GOOD_RESUME looks like. */
export const GOOD_FACTS: ResumeFacts = {
  employers: ['Google', 'Acme Corp'],
  roles: [
    {
      employer: 'Google',
      title: 'Staff Software Engineer',
      start_date: '2021-03',
      end_date: 'present',
    },
    {
      employer: 'Acme Corp',
      title: 'Software Engineer',
      start_date: '2018-06',
      end_date: '2021-02',
    },
  ],
  education: [{ institution: 'University of Porto', degree: 'BSc Computer Science' }],
  certifications: [],
};

export function memoryFiles() {
  const store = new Map<string, Buffer>();
  return {
    store,
    put: async (key: string, bytes: Uint8Array) => void store.set(key, Buffer.from(bytes)),
    get: async (key: string) => store.get(key) ?? null,
    delete: async (key: string) => void store.delete(key),
  };
}

export function makeCtx(
  llm: StructuredLlm,
  over: Partial<{ profile: ProfileDocument }> = {},
): SubmissionContext & { files: ReturnType<typeof memoryFiles> } {
  const files = memoryFiles();
  return {
    handle: { tenantId: TENANT_ID },
    userId: '44444444-4444-4444-8444-444444444444',
    application: { id: APPLICATION_ID },
    job: JOB,
    profile: over.profile ?? PROFILE,
    judgment: JUDGMENT,
    llm,
    files,
  } as unknown as SubmissionContext & { files: ReturnType<typeof memoryFiles> };
}

/**
 * A FakeLlm that answers each prompt id from its own list, in order (the last entry repeats).
 * `llm.calls` records every request.
 */
export function scripted(map: Record<string, unknown[]>): FakeLlm {
  const used: Record<string, number> = {};
  return new FakeLlm([
    (req: { prompt: string }) => {
      const list = map[req.prompt];
      if (!list) throw new Error(`unexpected prompt ${req.prompt}`);
      const i = used[req.prompt] ?? 0;
      used[req.prompt] = i + 1;
      return list[Math.min(i, list.length - 1)];
    },
  ]);
}

export const callsTo = (llm: FakeLlm, prompt: string) =>
  llm.calls.filter((c) => c.prompt === prompt);
