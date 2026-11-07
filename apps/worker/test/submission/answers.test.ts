import { FakeLlm } from '@wma/llm';
import { describe, expect, it } from 'vitest';
import {
  classifyFields,
  firstBlocker,
  resolveAnswers,
  resolveFreeText,
  resolveStandardFields,
  standardKeyFor,
  toFieldValues,
  toFormAnswers,
} from '../../src/submission/answers';
import type { FieldClassification, FieldDescriptor } from '../../src/submission/types';
import { callsTo, makeCtx, PROFILE, scripted } from '../fixtures/submission';

const field = (over: Partial<FieldDescriptor> & { label: string }): FieldDescriptor => ({
  id: over.id ?? over.label,
  type: 'text',
  required: false,
  maxLength: null,
  classification: 'free-text',
  ...over,
});

type Row = [string, FieldDescriptor['type'], FieldClassification, string[]?];
const YES_NO = ['Yes', 'No'];
const EEO = ['Male', 'Female', 'Decline to self identify'];

// Label strings as the three vendors render them.
const LABELS: Array<[vendor: string, rows: Row[]]> = [
  [
    'greenhouse',
    [
      ['First Name', 'text', 'standard'],
      ['Last Name', 'text', 'standard'],
      ['Email', 'text', 'standard'],
      ['Phone', 'text', 'standard'],
      ['Resume/CV', 'file', 'resume'],
      ['Cover Letter', 'file', 'free-text'],
      ['LinkedIn Profile', 'text', 'standard'],
      ['Website', 'text', 'standard'],
      ['Are you legally authorized to work in the United States?', 'select', 'standard', YES_NO],
      [
        'Will you now or in the future require sponsorship for employment visa status?',
        'select',
        'standard',
        YES_NO,
      ],
      ['Why do you want to work at Initrode?', 'textarea', 'free-text'],
      ['How did you hear about this job?', 'text', 'free-text'],
      ['Gender', 'select', 'self-identification', EEO],
      ['Are you Hispanic/Latino?', 'select', 'self-identification', YES_NO],
      ['Race', 'select', 'self-identification', ['Asian', 'White', 'Decline to self identify']],
      [
        'Veteran Status',
        'select',
        'self-identification',
        ['I am not a protected veteran', 'Decline'],
      ],
      ['Disability Status', 'select', 'self-identification'],
    ],
  ],
  [
    'lever',
    [
      ['Full name', 'text', 'standard'],
      ['Email', 'text', 'standard'],
      ['Phone', 'text', 'standard'],
      ['Current location', 'text', 'standard'],
      ['Current company', 'text', 'standard'],
      ['LinkedIn URL', 'text', 'standard'],
      ['GitHub URL', 'text', 'standard'],
      ['Portfolio URL', 'text', 'standard'],
      ['Resume/CV', 'file', 'resume'],
      ['Additional information', 'textarea', 'free-text'],
      ['What is your notice period?', 'text', 'standard'],
      ['Gender identity', 'select', 'self-identification', EEO],
      ['Race', 'checkbox', 'self-identification'],
      ['Veteran status', 'select', 'self-identification', ['Yes', 'No', 'Prefer not to say']],
      ['Pronouns', 'text', 'self-identification'],
      ['Sexual orientation', 'select', 'self-identification', EEO],
    ],
  ],
  [
    'ashby',
    [
      ['Name', 'text', 'standard'],
      ['Email', 'text', 'standard'],
      ['Phone number', 'text', 'standard'],
      ['Resume', 'file', 'resume'],
      ['Location', 'text', 'standard'],
      ['What is your desired start date?', 'date', 'standard'],
      ['Are you authorized to work in the US without sponsorship?', 'radio', 'standard', YES_NO],
      ['Reasons for leaving your current role', 'textarea', 'standard'],
      ['Please describe your experience with Kubernetes.', 'textarea', 'free-text'],
      ['Tell us about a project you are proud of', 'textarea', 'free-text'],
      ['Current job title', 'text', 'standard'],
      ['Do you identify as a person with a disability?', 'radio', 'self-identification', YES_NO],
      [
        'Are you a veteran or active member of the military?',
        'radio',
        'self-identification',
        YES_NO,
      ],
      ['Ethnicity', 'select', 'self-identification'],
      ['Gender', 'select', 'self-identification', EEO],
      ['Are you transgender?', 'radio', 'self-identification', YES_NO],
      ['Voluntary Self-Identification of Disability', 'checkbox', 'self-identification'],
    ],
  ],
];
const ALL = LABELS.flatMap(([v, rows]) => rows.map((r) => ({ vendor: v, row: r })));

describe('classifyFields (task 3.1)', () => {
  it('has at least 30 labels across the three vendors', () => {
    expect(ALL.length).toBeGreaterThanOrEqual(30);
  });

  it.each(ALL.map((x) => [`${x.vendor}: ${x.row[0]}`, x.row] as const))(
    '%s',
    async (_name, [label, type, expected, options]) => {
      const [out] = await classifyFields([field({ label, type, options })]);
      expect(out?.classification).toBe(expected);
    },
  );

  it('never classifies a self-identification label as anything else, with or without a model', async () => {
    const eeo = ALL.filter((x) => x.row[2] === 'self-identification');
    const fields = eeo.map((x, i) =>
      field({ id: `f${i}`, label: x.row[0], type: x.row[1], options: x.row[3] }),
    );
    const hostile = new FakeLlm([
      { fields: fields.map((f) => ({ id: f.id, classification: 'free-text' })) },
    ]);
    const out = await classifyFields(fields, hostile);
    expect(out.every((f) => f.classification === 'self-identification')).toBe(true);
    expect(hostile.calls).toHaveLength(0);
  });

  it('sends only unrecognised labels to the model, in one batch', async () => {
    const llm = new FakeLlm([
      {
        fields: [
          { id: 'a', classification: 'self-identification' },
          { id: 'b', classification: 'standard' },
        ],
      },
    ]);
    const out = await classifyFields(
      [
        field({ id: 'a', label: 'Identify your community', type: 'select' }),
        field({ id: 'b', label: 'Favourite colour', type: 'text' }),
        field({ id: 'c', label: 'Email', type: 'text' }),
      ],
      llm,
    );
    expect(out.map((f) => f.classification)).toEqual([
      'self-identification',
      'free-text',
      'standard',
    ]);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.prompt).toBe('classify-form-field/v1');
    expect(llm.calls[0]?.user).not.toContain('"Email"');
  });

  it('falls back to free-text when the model fails or is absent', async () => {
    const f = [field({ label: 'Favourite colour' })];
    expect((await classifyFields(f))[0]?.classification).toBe('free-text');
    expect((await classifyFields(f, new FakeLlm([new Error('down')])))[0]?.classification).toBe(
      'free-text',
    );
  });

  it('maps standard labels to profile keys', () => {
    expect(standardKeyFor('Will you now or in the future require sponsorship?')).toBe(
      'visa_sponsorship',
    );
    expect(standardKeyFor('Phone number')).toBe('phone');
    expect(standardKeyFor('Why do you want to work here?')).toBeNull();
  });
});

describe('resolveStandardFields (task 3.2)', () => {
  const fields = (): FieldDescriptor[] => [
    field({ label: 'Email', classification: 'standard', required: true }),
    field({ label: 'Work authorization', classification: 'standard', required: true }),
    field({ label: 'Notice period', classification: 'standard', required: false }),
    field({
      label: 'Will you require sponsorship?',
      classification: 'standard',
      required: true,
      type: 'select',
      options: ['Yes', 'No'],
    }),
    field({ label: 'Why us?', classification: 'free-text' }),
  ];

  it('fills from the profile verbatim, skips non-standard fields', () => {
    const out = resolveStandardFields({ profile: PROFILE }, fields());
    expect(out).toHaveLength(4);
    expect(out[0]).toMatchObject({
      status: 'filled',
      value: 'mara.quill@example.com',
      source: 'profile',
    });
    expect(out[1]).toMatchObject({ status: 'filled', value: 'Authorized to work in the EU' });
    expect(out[2]).toMatchObject({ status: 'filled', value: '30 days' });
    expect(out[3]).toMatchObject({ status: 'filled', value: 'No' });
  });

  it('reports missing-profile-field naming the field when work authorization is absent', () => {
    const profile = {
      ...PROFILE,
      standard_answers: { ...PROFILE.standard_answers, work_authorization: null },
    };
    const out = resolveStandardFields({ profile }, fields());
    expect(out[1]).toEqual({
      fieldId: 'Work authorization',
      question: 'Work authorization',
      status: 'missing-profile-field',
      profileField: 'standard_answers.work_authorization',
    });
    expect(firstBlocker(out)?.reason).toBe('missing-profile-field');
  });

  it('blanks an optional field the profile lacks', () => {
    const profile = {
      ...PROFILE,
      standard_answers: { ...PROFILE.standard_answers, notice_period: null },
    };
    expect(resolveStandardFields({ profile }, fields())[2]).toMatchObject({
      status: 'blank',
      reason: 'optional-unanswerable',
    });
  });

  it('makes no model call', () => {
    const llm = new FakeLlm([{}]);
    resolveStandardFields({ profile: PROFILE, llm } as never, fields());
    expect(llm.calls).toHaveLength(0);
  });
});

const grounded = (answer: string) => ({
  answer,
  grounded: true,
  unanswerable: false,
  ungrounded_claims: [],
});
const UNANSWERABLE = { answer: '', grounded: true, unanswerable: true, ungrounded_claims: [] };

describe('resolveFreeText (task 3.3, 3.4, rule 8)', () => {
  const run = (llm: FakeLlm, f: FieldDescriptor) => resolveFreeText(makeCtx(llm), f);

  it('returns a grounded answer and tells the model the 500 character cap', async () => {
    const llm = scripted({
      'answer-form-question/v1': [grounded('I moved Google batch pipelines to streaming.')],
    });
    const r = await run(llm, field({ label: 'Why Initrode?', type: 'textarea', maxLength: 500 }));
    expect(r).toMatchObject({
      status: 'filled',
      source: 'generated',
      value: 'I moved Google batch pipelines to streaming.',
    });
    expect(callsTo(llm, 'answer-form-question/v1')[0]?.user).toContain('"max_length_chars":500');
  });

  it('defaults the cap to 1200 characters', async () => {
    const llm = scripted({ 'answer-form-question/v1': [grounded('ok')] });
    await run(llm, field({ label: 'Q', type: 'textarea' }));
    expect(llm.calls[0]?.user).toContain('"max_length_chars":1200');
  });

  it('three question types stay within 500 characters', async () => {
    for (const label of [
      'Why do you want to work here?',
      'Describe a hard bug you fixed',
      'Anything else?',
    ]) {
      const llm = scripted({ 'answer-form-question/v1': [grounded('a'.repeat(480))] });
      const r = await run(llm, field({ label, type: 'textarea', maxLength: 500 }));
      expect(r.status === 'filled' && String(r.value).length).toBeLessThanOrEqual(500);
    }
  });

  it('optional + unanswerable -> blank; required + unanswerable -> unanswerable, no retry', async () => {
    const llm = scripted({ 'answer-form-question/v1': [UNANSWERABLE] });
    expect(await run(llm, field({ label: 'Certification number' }))).toMatchObject({
      status: 'blank',
      reason: 'optional-unanswerable',
    });
    expect(await run(llm, field({ label: 'Certification number', required: true }))).toEqual({
      fieldId: 'Certification number',
      question: 'Certification number',
      status: 'unanswerable',
    });
    expect(llm.calls).toHaveLength(2);
  });

  it('ungrounded -> one retry quoting the claim, then accepts a grounded answer', async () => {
    const llm = scripted({
      'answer-form-question/v1': [
        {
          answer: 'I led a team at Initech.',
          grounded: false,
          unanswerable: false,
          ungrounded_claims: ['led a team at Initech'],
        },
        grounded('I led pipeline work at Google.'),
      ],
    });
    const r = await run(llm, field({ label: 'Tell us about leadership', required: true }));
    expect(r).toMatchObject({ status: 'filled', value: 'I led pipeline work at Google.' });
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]?.user).toContain('"led a team at Initech"');
  });

  it('ungrounded twice -> unanswerable handling (blank when optional, unanswerable when required)', async () => {
    const bad = { answer: 'x', grounded: false, unanswerable: false, ungrounded_claims: ['x'] };
    const llm = scripted({ 'answer-form-question/v1': [bad] });
    expect(await run(llm, field({ label: 'Q1' }))).toMatchObject({ status: 'blank' });
    expect(await run(llm, field({ label: 'Q2', required: true }))).toMatchObject({
      status: 'unanswerable',
    });
    expect(llm.calls).toHaveLength(4);
  });

  it('retries once on an over-length answer, then cuts a grounded one at a sentence end', async () => {
    const long = 'First sentence. ' + 'b'.repeat(60);
    const llm = scripted({ 'answer-form-question/v1': [grounded(long)] });
    const r = await run(llm, field({ label: 'Q', maxLength: 40 }));
    expect(r).toMatchObject({ status: 'filled', value: 'First sentence.' });
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]?.user).toContain('the maximum is 40');
  });

  it('over-length with no sentence end -> unanswerable handling', async () => {
    const llm = scripted({ 'answer-form-question/v1': [grounded('c'.repeat(100))] });
    expect(await run(llm, field({ label: 'Q', maxLength: 40, required: true }))).toMatchObject({
      status: 'unanswerable',
    });
  });

  it('requires an exact option for choice fields', async () => {
    const f = field({ label: 'Remote?', type: 'select', options: ['Yes', 'No'], required: true });
    const llm = scripted({ 'answer-form-question/v1': [grounded('Sure'), grounded('yes')] });
    expect(await run(llm, f)).toMatchObject({ status: 'filled', value: 'Yes' });
    expect(llm.calls[1]?.user).toContain('exactly one of: Yes | No');
  });

  it('never asks the model about file fields', async () => {
    const llm = scripted({ 'answer-form-question/v1': [grounded('x')] });
    expect(await run(llm, field({ label: 'Writing sample', type: 'file' }))).toMatchObject({
      status: 'blank',
    });
    expect(
      await run(llm, field({ label: 'Writing sample', type: 'file', required: true })),
    ).toMatchObject({ status: 'unanswerable' });
    expect(llm.calls).toHaveLength(0);
  });
});

describe('resolveAnswers (rule 7)', () => {
  const form: FieldDescriptor[] = [
    field({
      id: 'name',
      label: 'Full name',
      type: 'text',
      required: true,
      classification: 'standard',
    }),
    field({
      id: 'resume',
      label: 'Resume/CV',
      type: 'file',
      required: true,
      classification: 'resume',
    }),
    field({
      id: 'why',
      label: 'Why do you want to work here?',
      type: 'textarea',
      required: true,
      maxLength: 500,
    }),
    field({ id: 'cert', label: 'Describe your certification number', type: 'textarea' }),
    field({
      id: 'gender',
      label: 'Gender',
      type: 'select',
      options: ['Male', 'Female', 'Decline to self identify'],
      required: true,
    }),
    field({ id: 'vet', label: 'Veteran Status', type: 'select', options: ['Yes', 'No'] }),
  ];

  it('resolves every field, skips self-identification, and makes no model call for it', async () => {
    const llm = scripted({
      'answer-form-question/v1': [
        grounded('I want to build payments infrastructure.'),
        UNANSWERABLE,
      ],
    });
    const out = await resolveAnswers(makeCtx(llm), form);
    expect(out.map((r) => r.status)).toEqual([
      'filled',
      'filled',
      'filled',
      'blank',
      'skipped',
      'skipped',
    ]);
    expect(out[4]).toEqual({
      fieldId: 'gender',
      question: 'Gender',
      status: 'skipped',
      skipped: 'self-identification',
    });
    expect(
      callsTo(llm, 'answer-form-question/v1')
        .map((c) => c.user)
        .join(),
    ).not.toContain('Gender');
    expect(firstBlocker(out)).toBeNull();

    expect(toFormAnswers(out)).toEqual({
      'Full name': 'Mara Quill',
      'Resume/CV': 'resume.pdf',
      'Why do you want to work here?': 'I want to build payments infrastructure.',
      'Describe your certification number': null,
      Gender: { skipped: 'self-identification' },
      'Veteran Status': { skipped: 'self-identification' },
    });
    expect(toFieldValues(out, form)).toEqual({
      name: 'Mara Quill',
      why: 'I want to build payments infrastructure.',
    });
  });

  it('reports the first blocker: unanswerable-question for a required unanswerable question', async () => {
    const llm = scripted({ 'answer-form-question/v1': [UNANSWERABLE] });
    const out = await resolveAnswers(makeCtx(llm), [
      field({ id: 'c', label: 'Security clearance number', required: true, type: 'text' }),
    ]);
    expect(firstBlocker(out)).toMatchObject({ reason: 'unanswerable-question' });
    expect(toFormAnswers(out)).toEqual({});
  });

  it('reports missing-profile-field when a required standard field has no value', async () => {
    const profile = { ...PROFILE, contact: { ...PROFILE.contact, phone: null } };
    const ctx = makeCtx(scripted({ 'answer-form-question/v1': [UNANSWERABLE] }), { profile });
    const out = await resolveAnswers(ctx, [
      field({ id: 'p', label: 'Phone', required: true, classification: 'standard' }),
    ]);
    expect(firstBlocker(out)).toMatchObject({
      reason: 'missing-profile-field',
      resolution: { profileField: 'contact.phone' },
    });
  });
});

describe('sponsorship and authorization keep their polarity (review item b)', () => {
  const YN = ['Yes', 'No'];
  const std = (label: string, over: Partial<FieldDescriptor> = {}) =>
    field({
      label,
      classification: 'standard',
      required: true,
      type: 'select',
      options: YN,
      ...over,
    });
  const answer = (
    standard: Partial<typeof PROFILE.standard_answers>,
    label: string,
    over: Partial<FieldDescriptor> = {},
  ) => {
    const profile = { ...PROFILE, standard_answers: { ...PROFILE.standard_answers, ...standard } };
    return resolveStandardFields({ profile }, [std(label, over)])[0];
  };
  const US = 'Authorized to work in the United States';

  it('separates "require sponsorship" from "authorized without sponsorship"', () => {
    expect(standardKeyFor('Will you now or in the future require sponsorship?')).toBe(
      'visa_sponsorship',
    );
    expect(standardKeyFor('Are you authorized to work in the US without sponsorship?')).toBe(
      'authorized_without_sponsorship',
    );
    expect(standardKeyFor('Can you work for us without needing visa sponsorship?')).toBe(
      'authorized_without_sponsorship',
    );
    expect(standardKeyFor('I do not require sponsorship')).toBe('no_sponsorship_needed');
    expect(standardKeyFor('Are you legally authorized to work in the United States?')).toBe(
      'work_authorization',
    );
  });

  it('answers each by meaning for someone authorized who needs no sponsorship', () => {
    const own = { work_authorization: US, visa_sponsorship_required: false };
    expect(answer(own, 'Are you authorized to work in the US without sponsorship?')).toMatchObject({
      value: 'Yes',
    });
    expect(answer(own, 'Will you now or in the future require sponsorship?')).toMatchObject({
      value: 'No',
    });
    expect(
      answer(own, 'I do not require sponsorship', { type: 'checkbox', options: undefined }),
    ).toMatchObject({ value: true });
    expect(answer(own, 'Are you legally authorized to work in the United States?')).toMatchObject({
      value: 'Yes',
    });
  });

  it('answers each by meaning for someone who needs sponsorship', () => {
    const needs = { work_authorization: US, visa_sponsorship_required: true };
    expect(
      answer(needs, 'Are you authorized to work in the US without sponsorship?'),
    ).toMatchObject({ value: 'No' });
    expect(answer(needs, 'Will you now or in the future require sponsorship?')).toMatchObject({
      value: 'Yes',
    });
    expect(
      answer(needs, 'I do not require sponsorship', { type: 'checkbox', options: undefined }),
    ).toMatchObject({ value: false });
  });

  it('does not claim authorization for a place the profile does not cover', () => {
    const eu = {
      work_authorization: 'Authorized to work in the EU',
      visa_sponsorship_required: false,
    };
    expect(answer(eu, 'Are you legally authorized to work in the United States?')).toMatchObject({
      status: 'missing-profile-field',
    });
    expect(answer(eu, 'Are you authorized to work in Germany?')).toMatchObject({ value: 'Yes' });
    const unsure = {
      work_authorization: 'Studying, visa pending',
      visa_sponsorship_required: false,
    };
    expect(
      answer(unsure, 'Are you legally authorized to work in the United States?'),
    ).toMatchObject({
      status: 'missing-profile-field',
    });
  });

  it('maps onto the options the field offers, never free text', () => {
    const own = { work_authorization: US, visa_sponsorship_required: false };
    const worded = ['Yes, I will require sponsorship', 'No, I will not require sponsorship'];
    expect(answer(own, 'Will you require sponsorship?', { options: worded })).toMatchObject({
      value: 'No, I will not require sponsorship',
    });
    expect(
      answer(own, 'Will you require sponsorship?', { options: ['Citizen', 'Visa holder'] }),
    ).toMatchObject({
      status: 'unanswerable',
    });
    expect(answer(own, 'Work authorization', { type: 'text', options: undefined })).toMatchObject({
      value: US,
    });
  });
});

describe('grouped checkboxes resolve to option arrays', () => {
  const group = field({
    label: 'Which of these have you used in production?',
    type: 'checkbox',
    required: true,
    options: ['Kubernetes', 'Terraform', 'Postgres'],
  });
  const grounded = (answer: string) => ({
    answer,
    grounded: true,
    unanswerable: false,
    ungrounded_claims: [],
  });
  const run = (answer: string) =>
    resolveFreeText(makeCtx(scripted({ 'answer-form-question/v1': [grounded(answer)] })), group);

  it('returns the chosen options as strings, not a boolean', async () => {
    expect(await run('Kubernetes\nPostgres')).toMatchObject({
      status: 'filled',
      value: ['Kubernetes', 'Postgres'],
    });
    expect(await run('terraform, postgres')).toMatchObject({ value: ['Terraform', 'Postgres'] });
    expect(await run('["Kubernetes"]')).toMatchObject({ value: ['Kubernetes'] });
  });

  it('rejects a Yes, an unknown option and an empty choice for a group', async () => {
    expect(await run('Yes')).toMatchObject({ status: 'unanswerable' });
    expect(await run('Kubernetes, Docker')).toMatchObject({ status: 'unanswerable' });
  });

  it('a lone checkbox still takes a boolean', async () => {
    const lone = field({ label: 'I agree to the terms', type: 'checkbox', required: true });
    const llm = scripted({ 'answer-form-question/v1': [grounded('Yes')] });
    expect(await resolveFreeText(makeCtx(llm), lone)).toMatchObject({ value: true });
  });
});
