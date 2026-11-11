import { readFileSync } from 'node:fs';
import { resolve as resolve_ } from 'node:path';
import { FakeLlm } from '@wma/llm';
import { describe, expect, it } from 'vitest';
import {
  classifyFields,
  deriveStartDate,
  firstBlocker,
  resolveAnswers,
  resolveFreeText,
  resolveStandardFields,
  standardKeyFor,
  toFieldValues,
  toFormAnswers,
} from '../../src/submission/answers';
import { planFill } from '../../src/submission/fill';
import type { FieldClassification, FieldDescriptor } from '../../src/submission/types';
import { callsTo, makeCtx, PROFILE, scripted } from '../fixtures/submission';
import { declineOption } from '../../src/submission/answers';

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
      ['How did you hear about this job?', 'text', 'standard'],
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
      identity: { ...PROFILE.identity, location: null },
      contact: { ...PROFILE.contact, phone: null },
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

  describe('start date (rule 23b)', () => {
    const start = (over: Partial<FieldDescriptor> = {}) =>
      field({ label: 'When can you start a new role?', classification: 'standard', ...over });
    const withStart = (earliest: string | null, text: string | null, notice: string | null) => ({
      ...PROFILE,
      standard_answers: {
        ...PROFILE.standard_answers,
        earliest_start_date: earliest,
        start_date: text,
        notice_period: notice,
      },
    });
    const MON = new Date('2026-11-09T10:00:00Z');
    const derive = (text: string | null, notice: string | null, today = MON) =>
      deriveStartDate(withStart(null, text, notice), today);

    it('a date question takes the ISO earliest start date, not the text', () => {
      const [r] = resolveStandardFields({ profile: withStart('2027-01-15', 'asap', null) }, [
        start({ type: 'date', required: true }),
      ]);
      expect(r).toMatchObject({ status: 'filled', value: '2027-01-15', source: 'profile' });
    });

    it('a text question keeps the start_date text', () => {
      const [r] = resolveStandardFields(
        { profile: withStart('2027-01-15', 'Within 30 days', null) },
        [start()],
      );
      expect(r).toMatchObject({ status: 'filled', value: 'Within 30 days' });
    });

    it('derives from "within N days/weeks/months" text', () => {
      expect(derive('Within 10 days', null)).toBe('2026-11-19');
      expect(derive('within 2 weeks', '30 days')).toBe('2026-11-23');
      expect(derive('Within a month', null)).toBe('2026-12-09');
    });

    it('immediately, asap and now are today + 14 days', () => {
      for (const t of ['Immediately', 'ASAP', 'available now']) {
        expect(derive(t, null), t).toBe('2026-11-23');
      }
    });

    it('reads "N weeks/months notice" in the text, else the notice period', () => {
      expect(derive('6 weeks notice', null)).toBe('2026-12-21');
      expect(derive('after my notice period', '3 months')).toBe('2027-02-09');
      expect(derive(null, '1 month')).toBe('2026-12-09');
      expect(derive('Flexible', '2 weeks')).toBe('2026-11-23');
    });

    it('falls back to today + 30 days', () => {
      expect(derive(null, null)).toBe('2026-12-09');
      expect(derive('Flexible', 'to be agreed')).toBe('2026-12-09');
    });

    it('rolls a weekend forward to Monday', () => {
      // Fri 13 Nov + 1 day = Sat 14 -> Mon 16; Sat 14 Nov + 1 day = Sun 15 -> Mon 16.
      expect(derive('within 1 day', null, new Date('2026-11-13T09:00:00Z'))).toBe('2026-11-16');
      expect(derive('within 1 day', null, new Date('2026-11-14T09:00:00Z'))).toBe('2026-11-16');
      expect(derive('within 2 days', null, new Date('2026-11-13T09:00:00Z'))).toBe('2026-11-16');
    });

    it('never parks: a required date question with nothing in the profile resolves, using the clock', () => {
      const out = resolveStandardFields(
        {
          profile: withStart(null, null, null),
          clock: { now: () => MON } as never,
        },
        [start({ type: 'date', required: true })],
      );
      expect(out[0]).toMatchObject({ status: 'filled', value: '2026-12-09', source: 'profile' });
      expect(firstBlocker(out)).toBeNull();
    });

    it('records the derived date in form_answers like any answer', () => {
      const f = start({ type: 'date', required: true });
      const out = resolveStandardFields(
        { profile: withStart(null, 'asap', null), clock: { now: () => MON } as never },
        [f],
      );
      expect(toFormAnswers(out)).toEqual({ [f.label]: '2026-11-23' });
    });
  });

  describe('AI policy consent (rule 24b)', () => {
    it('a label asking to confirm the AI guidelines is consent', () => {
      expect(standardKeyFor('Please confirm you have read our AI guidelines', 'checkbox')).toBe(
        'consent',
      );
      expect(standardKeyFor('I understand the AI partnership guidelines', 'checkbox')).toBe(
        'consent',
      );
    });

    it('the description counts: a bare label with a confirming description is consent -> Yes', async () => {
      const f = field({
        label: 'AI Policy for Application',
        type: 'select',
        options: ['Yes', 'No'],
        required: true,
        description:
          'We invite you to review our AI partnership guidelines for candidates and confirm your understanding by selecting "Yes."',
      });
      const [c] = await classifyFields([f]);
      expect(c).toMatchObject({ classification: 'standard', standardKey: 'consent' });
      expect(resolveStandardFields({ profile: PROFILE }, [c!])[0]).toMatchObject({
        status: 'filled',
        value: 'Yes',
      });
    });

    it('does not fire for AI mentions that do not ask for confirmation, or on a textarea', () => {
      expect(standardKeyFor('Why do you want to work on AI?', 'text')).toBeNull();
      expect(
        standardKeyFor('Describe your AI usage', 'textarea', 'Please review our AI policy'),
      ).toBeNull();
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

  it('puts the question description in the <question> JSON only when there is one (rule 22)', async () => {
    const llm = scripted({
      'answer-form-question/v1': [grounded('Yes'), grounded('Yes')],
    });
    await run(llm, field({ label: 'AI Policy', description: 'Confirm by selecting "Yes".' }));
    await run(llm, field({ label: 'Plain' }));
    const [withDesc, without] = callsTo(llm, 'answer-form-question/v1');
    expect(withDesc?.user).toContain('"description":"Confirm by selecting \\"Yes\\"."');
    expect(without?.user).toContain('"max_length_chars":1200}');
  });

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

describe('relocation and consent (live-loop rules 9-12)', () => {
  const YN = ['Yes', 'No'];
  const std = (label: string, over: Partial<FieldDescriptor> = {}) =>
    field({ label, classification: 'standard', required: true, ...over });
  const withSurvey = (willing: boolean | null) => ({
    ...PROFILE,
    survey: { ...PROFILE.survey, willing_to_relocate: willing },
  });
  const resolve = (profile: typeof PROFILE, f: FieldDescriptor) =>
    resolveStandardFields({ profile }, [f])[0];

  it('classifies the three fixture labels (rules 9, 10)', async () => {
    expect(standardKeyFor('Are you open to relocation?')).toBe('relocation');
    expect(standardKeyFor('I acknowledge the privacy policy')).toBe('consent');
    const out = await classifyFields([
      field({ label: 'Are you open to relocation?', type: 'radio', options: YN }),
      field({ label: 'I acknowledge the privacy policy', type: 'checkbox' }),
      field({
        label: 'Which of these have you used in production?',
        type: 'checkbox',
        options: ['Kubernetes', 'Terraform', 'Postgres'],
      }),
    ]);
    expect(out.map((f) => f.classification)).toEqual(['standard', 'standard', 'free-text']);
    expect(out[0]?.standardKey).toBe('relocation');
    expect(out[1]?.standardKey).toBe('consent');
  });

  it('recognises the consent wordings', () => {
    for (const l of [
      'I agree to the Terms and Conditions',
      'I consent to the processing of my personal data',
      'I certify that the information in this application is true and accurate',
      'Please confirm you accept our privacy notice',
    ]) {
      expect(standardKeyFor(l), l).toBe('consent');
    }
    expect(standardKeyFor('Are you authorized to work in the US?')).toBe('work_authorization');
  });

  it('answers relocation from the survey against a radio and a select (rule 9)', () => {
    for (const type of ['radio', 'select'] as const) {
      const f = std('Are you open to relocation?', { type, options: YN });
      expect(resolve(withSurvey(false), f)).toMatchObject({ status: 'filled', value: 'No' });
      expect(resolve(withSurvey(true), f)).toMatchObject({ status: 'filled', value: 'Yes' });
      // Rule 28: an unanswered relocation question is inferred, never parked.
      expect(resolve(withSurvey(null), f)).toMatchObject({
        status: 'filled',
        value: 'No',
        source: 'inferred',
      });
    }
  });

  it('maps relocation onto Yes/No/Depends options by meaning, and infers null (rules 9, 28)', () => {
    const f = std('Would you relocate?', { type: 'radio', options: ['Yes', 'No', 'Depends'] });
    expect(resolve(withSurvey(true), f)).toMatchObject({ value: 'Yes' });
    expect(resolve(withSurvey(null), f)).toMatchObject({ value: 'No', source: 'inferred' });
  });

  it('answers consent affirmatively on a lone checkbox, a Yes/No select and a text box (rule 10)', () => {
    const label = 'I acknowledge the privacy policy';
    expect(resolve(PROFILE, std(label, { type: 'checkbox' }))).toMatchObject({
      status: 'filled',
      value: true,
      source: 'profile',
    });
    expect(resolve(PROFILE, std(label, { type: 'select', options: ['No', 'Yes'] }))).toMatchObject({
      value: 'Yes',
    });
    // A text box is never a consent control: it is not classified as consent at all.
    expect(standardKeyFor(label, 'text')).toBeNull();
    expect(standardKeyFor(label, 'checkbox')).toBe('consent');
  });

  it('narrowed consent: verb plus subject, checkbox/radio/select only (review P2)', async () => {
    expect(standardKeyFor('Please confirm your correct legal name', 'text')).toBe('full_name');
    expect(standardKeyFor('Please confirm your correct legal name')).toBe('full_name');
    expect(standardKeyFor('I confirm the information provided is accurate', 'checkbox')).toBe(
      'consent',
    );
    expect(standardKeyFor('I agree to the privacy policy', 'text')).not.toBe('consent');
    const out = await classifyFields([
      field({ label: 'Please confirm your correct legal name', type: 'text' }),
      field({ label: 'I confirm the information provided is accurate', type: 'checkbox' }),
      field({ label: 'I agree to the privacy policy', type: 'text' }),
    ]);
    expect(out[0]).toMatchObject({ classification: 'standard', standardKey: 'full_name' });
    expect(out[1]).toMatchObject({ classification: 'standard', standardKey: 'consent' });
    expect(out[2]?.standardKey).not.toBe('consent');
  });

  it('narrowed relocation: willingness questions only (review P2)', async () => {
    expect(standardKeyFor('Are you willing to relocate?')).toBe('relocation');
    expect(standardKeyFor('Open to relocation?')).toBe('relocation');
    expect(standardKeyFor('Relocation')).toBe('relocation');
    expect(standardKeyFor('Do you require relocation assistance?')).not.toBe('relocation');
    expect(standardKeyFor('Is a relocation package required?')).not.toBe('relocation');
    const [f] = await classifyFields([
      field({ label: 'Do you require relocation assistance?', type: 'radio', options: YN }),
    ]);
    expect(f?.standardKey).toBeUndefined();
    expect(f?.classification).toBe('free-text');
  });

  it('a generic "prefer not to answer" option does not make a question self-identification', async () => {
    const [felony, community, generic] = await classifyFields([
      field({
        label: 'Have you ever been convicted of a felony?',
        type: 'select',
        options: ['Yes', 'No', 'Prefer not to answer'],
      }),
      field({
        label: 'Identify your community',
        type: 'select',
        options: ['Option A', 'Option B', 'I prefer not to self-identify'],
      }),
      field({ label: 'Gender', type: 'select', options: ['Male', 'Female', 'Prefer not to say'] }),
    ]);
    expect(felony?.classification).toBe('free-text');
    expect(community?.classification).toBe('self-identification');
    expect(generic?.classification).toBe('self-identification');
  });

  it('a self-identification label that says "acknowledge" stays self-identification (rule 10)', async () => {
    const [a, b] = await classifyFields([
      field({
        label: 'I acknowledge the voluntary gender self-identification notice',
        type: 'checkbox',
      }),
      field({
        label: 'I accept the privacy policy',
        type: 'select',
        options: ['I agree', 'I decline to self-identify'],
      }),
    ]);
    expect(a?.classification).toBe('self-identification');
    expect(b?.classification).toBe('self-identification');
  });

  it('shows the model preferences and non-financial survey answers, never pay or family (rule 11)', async () => {
    const llm = scripted({
      'answer-form-question/v1': [
        { answer: 'ok', grounded: true, unanswerable: false, ungrounded_claims: [] },
      ],
    });
    await resolveFreeText(makeCtx(llm), field({ label: 'Where do you want to work?' }));
    const user = llm.calls[0]?.user ?? '';
    const profileBlock = /<profile>([\s\S]*?)<\/profile>/.exec(user)?.[1] ?? '';
    expect(profileBlock).toContain('"preferences"');
    expect(profileBlock).toContain('"target_titles"');
    expect(profileBlock).toContain('"willing_to_relocate"');
    expect(profileBlock).toContain('"career_direction"');
    expect(profileBlock).toContain('"work_life_balance"');
    expect(profileBlock).not.toContain('salary_floor');
    expect(profileBlock).not.toContain('family_constraints');
  });

  it('the prompt carries the checkbox-group rule (rule 12)', () => {
    const text = readFileSync(
      resolve_(__dirname, '../../../../packages/llm/prompts/answer-form-question/v1.md'),
      'utf8',
    );
    expect(text).toMatch(/checkbox group/);
    expect(text).toMatch(/lists every option the profile supports/);
    expect(text).toMatch(/qualifier \(in production, professionally/);
    expect(text).toMatch(/Postgres is PostgreSQL/);
    expect(text).toMatch(/`select` or `radio`, `answer` must be exactly one/);
  });
});

describe('work-authorization wording and prior contact (wave 5 rules 26, 27)', () => {
  const YN = ['Yes', 'No'];
  const std = (label: string, over: Partial<FieldDescriptor> = {}) =>
    field({
      label,
      classification: 'standard',
      required: true,
      type: 'radio',
      options: YN,
      ...over,
    });
  const run = (
    standard: Partial<typeof PROFILE.standard_answers>,
    label: string,
    ctx: { companyName?: string; priorApplications?: string[] } = {},
    profileOver: Partial<typeof PROFILE> = {},
  ) => {
    const profile = {
      ...PROFILE,
      ...profileOver,
      standard_answers: { ...PROFILE.standard_answers, ...standard },
    };
    return resolveStandardFields({ profile, ...ctx }, [std(label)])[0];
  };

  it('classifies the widened work-authorization phrasings', () => {
    for (const l of [
      'Do you have permanent authorization to work for Warp in the U.S. or Canada?',
      'Are you authorized to work in the country where the job is located?',
      'Are you permanently authorized to work in the UK?',
      'Are you eligible to work in the United States?',
      'Are you legally allowed to work in Germany?',
      'Do you have eligibility to work here?',
    ]) {
      expect(standardKeyFor(l), l).toBe('work_authorization');
    }
    expect(standardKeyFor('Are you authorized to work in the US without sponsorship?')).toBe(
      'authorized_without_sponsorship',
    );
  });

  it('a question naming no place with a positive statement resolves Yes; a null statement with no derivable country parks', () => {
    const q = 'Are you authorized to work in the country where the job is located?';
    expect(run({ work_authorization: 'Authorized to work in the United States' }, q)).toMatchObject(
      { status: 'filled', value: 'Yes' },
    );
    expect(
      run(
        { work_authorization: null },
        q,
        {},
        {
          identity: { ...PROFILE.identity, location: null },
          contact: { ...PROFILE.contact, phone: null },
        },
      ),
    ).toMatchObject({
      status: 'missing-profile-field',
      profileField: 'standard_answers.work_authorization',
    });
  });

  it('classifies the prior-contact questions', () => {
    expect(standardKeyFor('Have you ever interviewed at Anthropic before?')).toBe(
      'interviewed_before',
    );
    expect(standardKeyFor('Have you worked at Acme before?')).toBe('worked_before');
    expect(standardKeyFor('Have you previously applied to Acme?')).toBe('applied_before');
    expect(standardKeyFor('Have you worked with Kubernetes?')).toBeNull();
  });

  it('interviewed: null is inferred as none, [] is No, a named company is Yes', () => {
    const q = 'Have you ever interviewed at Anthropic before?';
    expect(run({ previous_interviews: null }, q)).toMatchObject({
      status: 'filled',
      value: 'No',
      source: 'inferred',
    });
    expect(run({ previous_interviews: [] }, q)).toMatchObject({ status: 'filled', value: 'No' });
    expect(run({ previous_interviews: ['Anthropic'] }, q)).toMatchObject({
      status: 'filled',
      value: 'Yes',
    });
    expect(run({ previous_interviews: ['anthropic, pbc'] }, q)).toMatchObject({ value: 'Yes' });
    expect(run({ previous_interviews: ['OpenAI'] }, q)).toMatchObject({ value: 'No' });
  });

  it('uses the posting company when the label names none', () => {
    const q = 'Have you previously interviewed with us?';
    expect(run({ previous_interviews: ['Acme'] }, q, { companyName: 'Acme Inc' })).toMatchObject({
      value: 'Yes',
    });
  });

  it('worked: from work_history employers', () => {
    const employer = PROFILE.work_history[0]!.employer;
    const q = (c: string) => `Have you worked at ${c} before?`;
    expect(run({}, q(employer))).toMatchObject({ status: 'filled', value: 'Yes' });
    expect(run({}, q('Acme'))).toMatchObject({ status: 'filled', value: 'Yes' });
    expect(run({}, q('Initech'))).toMatchObject({ status: 'filled', value: 'No' });
    expect(
      run({}, 'Have you ever worked for this company?', { companyName: employer }),
    ).toMatchObject({ value: 'Yes' });
  });

  it('applied: from priorApplications or previous_interviews; null is inferred No', () => {
    const q = 'Have you applied to Acme before?';
    expect(run({ previous_interviews: null }, q, { priorApplications: ['Acme'] })).toMatchObject({
      status: 'filled',
      value: 'Yes',
    });
    expect(run({ previous_interviews: ['Acme'] }, q)).toMatchObject({ value: 'Yes' });
    expect(run({ previous_interviews: [] }, q, { priorApplications: ['Other'] })).toMatchObject({
      value: 'No',
    });
    expect(run({ previous_interviews: null }, q, { priorApplications: ['Other'] })).toMatchObject({
      value: 'No',
      source: 'inferred',
    });
  });
});

describe('resolveFreeText guess mode (rule 29)', () => {
  const run = (llm: FakeLlm, f: FieldDescriptor) => resolveFreeText(makeCtx(llm), f);
  const guess = (answer: string) => ({
    answer,
    grounded: false,
    guessed: true,
    unanswerable: false,
    ungrounded_claims: ['about five years'],
  });

  it('accepts a guessed answer without the ungrounded retry and marks its source', async () => {
    const llm = scripted({ 'answer-form-question/v1': [guess('About 5 years')] });
    const r = await run(llm, field({ label: 'Years of Kafka experience?', required: true }));
    expect(r).toMatchObject({ status: 'filled', value: 'About 5 years', source: 'guessed' });
    expect(callsTo(llm, 'answer-form-question/v1')).toHaveLength(1);
  });

  it('still enforces the options contract: one retry, then the guess resolves', async () => {
    const llm = scripted({
      'answer-form-question/v1': [guess('about 5'), guess('3-5 years')],
    });
    const r = await run(
      llm,
      field({
        label: 'Years of Kafka experience?',
        type: 'select',
        options: ['0-2 years', '3-5 years', '6+ years'],
        required: true,
      }),
    );
    expect(callsTo(llm, 'answer-form-question/v1')).toHaveLength(2);
    expect(callsTo(llm, 'answer-form-question/v1')[1]?.user).toContain('<rejected>');
    expect(r).toMatchObject({ status: 'filled', value: '3-5 years', source: 'guessed' });
  });

  it('a guess that keeps breaking the options contract parks a required question', async () => {
    const llm = scripted({ 'answer-form-question/v1': [guess('about 5'), guess('around 5')] });
    const r = await run(
      llm,
      field({
        label: 'Years?',
        type: 'select',
        options: ['0-2 years', '3-5 years'],
        required: true,
      }),
    );
    expect(r.status).toBe('unanswerable');
  });

  it('an ungrounded answer that is not a guess still gets the retry', async () => {
    const llm = scripted({
      'answer-form-question/v1': [{ ...guess('x'), guessed: false }, grounded('Fine')],
    });
    const r = await run(llm, field({ label: 'Q' }));
    expect(callsTo(llm, 'answer-form-question/v1')).toHaveLength(2);
    expect(r).toMatchObject({ source: 'generated', value: 'Fine' });
  });

  it('an unanswerable reply still parks a required question and blanks an optional one', async () => {
    const llm = scripted({ 'answer-form-question/v1': [UNANSWERABLE] });
    expect(await run(llm, field({ label: 'Clearance level?', required: true }))).toMatchObject({
      status: 'unanswerable',
    });
    const llm2 = scripted({ 'answer-form-question/v1': [UNANSWERABLE] });
    expect(await run(llm2, field({ label: 'Clearance level?' }))).toMatchObject({
      status: 'blank',
    });
  });
});

describe('inferred defaults for null standard answers (wave 5 rule 28)', () => {
  const YN = ['Yes', 'No'];
  const BLANK = {
    work_authorization: null,
    visa_sponsorship_required: null,
    start_date: null,
    earliest_start_date: null,
    notice_period: null,
    reasons_for_change: null,
    previous_interviews: null,
  };
  const make = (
    over: {
      location?: string | null;
      phone?: string | null;
      remote?: 'remote' | 'hybrid' | 'onsite' | 'any';
      locations?: string[];
      relocate?: boolean | null;
      standard?: Partial<typeof PROFILE.standard_answers>;
    } = {},
  ) => ({
    ...PROFILE,
    identity: {
      ...PROFILE.identity,
      location: over.location === undefined ? null : over.location,
    },
    contact: { ...PROFILE.contact, phone: over.phone === undefined ? null : over.phone },
    preferences: {
      ...PROFILE.preferences,
      remote: over.remote ?? 'any',
      locations: over.locations ?? [],
    },
    survey: { ...PROFILE.survey, willing_to_relocate: over.relocate ?? null },
    standard_answers: { ...BLANK, ...over.standard },
  });
  const ask = (
    profile: ReturnType<typeof make>,
    label: string,
    ctx: { job?: { location: string | null } } = {},
    over: Partial<FieldDescriptor> = {},
  ) =>
    resolveStandardFields({ profile, ...(ctx as object) } as never, [
      field({
        label,
        classification: 'standard',
        required: true,
        type: 'radio',
        options: YN,
        ...over,
      }),
    ])[0];
  const AUTH = 'Are you legally authorized to work in the country where this job is located?';

  it('infers work authorization from a US state, a US city or a +1 phone', () => {
    for (const p of [
      make({ location: 'Austin, TX' }),
      make({ location: 'San Francisco' }),
      make({ phone: '+1 (415) 555-0100' }),
    ]) {
      expect(ask(p, AUTH)).toMatchObject({ status: 'filled', value: 'Yes', source: 'inferred' });
    }
  });

  it('infers from a UK, Canadian or EU location', () => {
    for (const location of ['London, UK', 'Toronto, Canada', 'Berlin, Germany']) {
      expect(ask(make({ location }), AUTH), location).toMatchObject({
        value: 'Yes',
        source: 'inferred',
      });
    }
  });

  it('parks when no country can be derived and the question names none', () => {
    expect(ask(make({ location: null }), AUTH)).toMatchObject({
      status: 'missing-profile-field',
      profileField: 'standard_answers.work_authorization',
    });
    expect(ask(make({ location: 'Somewhere' }), AUTH)).toMatchObject({
      status: 'missing-profile-field',
    });
  });

  it("uses the question's own country when the profile implies none", () => {
    expect(
      ask(make(), 'Do you have permanent authorization to work in the U.S. or Canada?'),
    ).toMatchObject({ value: 'Yes', source: 'inferred' });
  });

  it('parks when the profile country does not cover the question', () => {
    expect(
      ask(make({ location: 'Austin, TX' }), 'Are you authorized to work in Germany?'),
    ).toMatchObject({
      status: 'missing-profile-field',
    });
  });

  it('an explicit profile value always wins over the inference', () => {
    const p = make({
      location: 'Austin, TX',
      standard: {
        work_authorization: 'Authorized to work in the EU',
        visa_sponsorship_required: true,
      },
    });
    expect(ask(p, 'Are you authorized to work in the US?')).toMatchObject({
      status: 'missing-profile-field',
    });
    expect(ask(p, 'Will you require sponsorship?')).toMatchObject({
      status: 'filled',
      value: 'Yes',
      source: 'profile',
    });
    const q = make({
      location: 'Austin, TX',
      standard: {
        start_date: 'In March',
        notice_period: '1 month',
        previous_interviews: ['Acme'],
      },
    });
    expect(
      ask(q, 'What is your notice period?', {}, { type: 'text', options: undefined }),
    ).toMatchObject({ value: '1 month', source: 'profile' });
    expect(ask(q, 'Have you interviewed at Acme before?', {})).toMatchObject({
      value: 'Yes',
      source: 'profile',
    });
  });

  it('infers no sponsorship needed when authorization is inferred', () => {
    const p = make({ location: 'Austin, TX' });
    expect(ask(p, 'Will you now or in the future require visa sponsorship?')).toMatchObject({
      value: 'No',
      source: 'inferred',
    });
    expect(ask(p, 'Are you authorized to work in the US without sponsorship?')).toMatchObject({
      value: 'Yes',
      source: 'inferred',
    });
    expect(ask(make(), 'Will you now or in the future require visa sponsorship?')).toMatchObject({
      status: 'missing-profile-field',
    });
  });

  it('infers previous interviews as none, start date and notice period', () => {
    const p = make();
    expect(ask(p, 'Have you ever interviewed at Anthropic before?')).toMatchObject({
      value: 'No',
      source: 'inferred',
    });
    expect(ask(p, 'When can you start?', {}, { type: 'text', options: undefined })).toMatchObject({
      value: 'Within 30 days',
      source: 'inferred',
    });
    expect(
      ask(p, 'What is your notice period?', {}, { type: 'text', options: undefined }),
    ).toMatchObject({
      value: '2 weeks',
      source: 'inferred',
    });
  });

  it('infers relocation: remote preference is No, a preferred posting location is Yes, else No', () => {
    const q = 'Are you open to relocation?';
    expect(
      ask(make({ remote: 'remote', locations: ['Berlin'] }), q, { job: { location: 'Berlin' } }),
    ).toMatchObject({
      value: 'No',
      source: 'inferred',
    });
    expect(
      ask(make({ locations: ['Berlin', 'Remote'] }), q, { job: { location: 'Berlin, Germany' } }),
    ).toMatchObject({ value: 'Yes', source: 'inferred' });
    expect(ask(make({ locations: ['Berlin'] }), q, { job: { location: 'Paris' } })).toMatchObject({
      value: 'No',
    });
    expect(ask(make(), q)).toMatchObject({ value: 'No', source: 'inferred' });
    expect(ask(make({ relocate: true, remote: 'remote' }), q)).toMatchObject({
      value: 'Yes',
      source: 'profile',
    });
  });

  it('does not infer for an optional field', () => {
    expect(
      ask(make(), 'Have you ever interviewed at Anthropic before?', {}, { required: false }),
    ).toMatchObject({ status: 'blank' });
  });

  it('rule 45: "how did you hear about this role" takes the job-board-like option, else Other', () => {
    const q = 'How did you hear about this role?';
    const sel = (options: string[]) => ({ type: 'select' as const, options });
    expect(ask(make(), q, {}, sel(['LinkedIn', 'Referral', 'Job board', 'Other']))).toMatchObject({
      value: 'Job board',
      source: 'inferred',
    });
    expect(ask(make(), q, {}, sel(['Referral', 'Company website', 'Other']))).toMatchObject({
      value: 'Company website',
    });
    expect(ask(make(), q, {}, sel(['Referral', 'Employee', 'Other']))).toMatchObject({
      value: 'Other',
    });
    expect(ask(make(), q, {}, sel(['Referral', 'Employee']))).toMatchObject({
      status: 'unanswerable',
    });
    expect(ask(make(), q, {}, { type: 'text', options: undefined })).toMatchObject({
      value: 'Job board',
      source: 'inferred',
    });
    expect(
      ask(make(), 'Where did you see this posting?', {}, { type: 'text', options: undefined }),
    ).toMatchObject({ value: 'Job board' });
  });

  it('rule 46: travel up to 25% (or no amount) is Yes; more goes to the model', () => {
    expect(ask(make(), 'Are you willing to travel up to 25% of the time?')).toMatchObject({
      value: 'Yes',
      source: 'inferred',
    });
    expect(ask(make(), 'Are you able to travel occasionally for team offsites?')).toMatchObject({
      value: 'Yes',
      source: 'inferred',
    });
    expect(standardKeyFor('Are you willing to travel up to 50% of the time?')).toBeNull();
    expect(standardKeyFor('Are you comfortable with 30 percent travel?')).toBeNull();
    expect(standardKeyFor('Will you need travel expenses reimbursed?')).toBeNull();
    expect(standardKeyFor('Travel history outside the US')).toBeNull();
  });

  it('planFill and toFormAnswers record inferred answers with their source', () => {
    const f = field({ label: 'Notice period', classification: 'standard', type: 'text' });
    const res = [
      { fieldId: f.id, question: f.label, status: 'filled', value: '2 weeks', source: 'inferred' },
    ] as const;
    expect(planFill([f], [...res]).answers).toEqual({
      'Notice period': { value: '2 weeks', source: 'inferred' },
    });
    expect(toFormAnswers([...res])).toEqual({
      'Notice period': { value: '2 weeks', source: 'inferred' },
    });
  });
});

describe('rules 31 and 32: acknowledgement options and any-of authorization', () => {
  const resolveOne = async (
    f: FieldDescriptor,
    profile: typeof PROFILE = PROFILE,
    ctx: object = {},
  ) => {
    const [c] = await classifyFields([f]);
    return {
      classified: c!,
      res: resolveStandardFields({ profile, ...ctx } as never, [c!])[0],
    };
  };
  const READ = 'I will read the arbitration agreement below.';
  const AGREE =
    'I understand and agree to the terms of the Agreement to Arbitrate set forth above.';
  const ASHBY_ACK =
    'I acknowledge that I have opened, read, and understood the Arbitration Agreement. I understand that by submitting my application, I am agreeing to be bound by the terms of the Arbitration Agreement.';

  it('takes the single option of the two Greenhouse arbitration selects', async () => {
    for (const [label, option] of [
      ['Please read the arbitration agreement below', READ],
      ['Agreement to Arbitrate', AGREE],
    ] as const) {
      const { classified, res } = await resolveOne(
        field({ label, type: 'select', required: true, options: [option] }),
      );
      expect(classified).toMatchObject({ classification: 'standard', standardKey: 'consent' });
      expect(res).toMatchObject({ status: 'filled', value: option, source: 'profile' });
    }
  });

  it('checks every acknowledgement option of the Ashby arbitration checkbox group', async () => {
    const { classified, res } = await resolveOne(
      field({
        label: 'Applicant Arbitration Agreement Acknowledgement',
        type: 'checkbox',
        required: true,
        options: [ASHBY_ACK, 'I confirm I have read the above.'],
      }),
    );
    expect(classified.classification).toBe('standard');
    expect(res).toMatchObject({
      status: 'filled',
      value: [ASHBY_ACK, 'I confirm I have read the above.'],
      source: 'profile',
    });
  });

  it('rule 34: a lone checkbox with one acknowledgement option resolves to true', async () => {
    const { classified, res } = await resolveOne(
      field({
        label: 'Applicant Arbitration Agreement Acknowledgement',
        type: 'checkbox',
        required: true,
        options: [ASHBY_ACK],
      }),
    );
    expect(classified).toMatchObject({ classification: 'standard', standardKey: 'consent' });
    expect(res).toMatchObject({ status: 'filled', value: true, source: 'profile' });
  });

  it("rule 35: only the candidate's own site is a website", async () => {
    const blogPost = "Share your favorite blog post, article, or paper you've read";
    expect(standardKeyFor(blogPost, 'text')).toBeNull();
    const [c] = await classifyFields([field({ label: blogPost, type: 'text' })]);
    expect(c).toMatchObject({ classification: 'free-text' });
    expect((c as { standardKey?: string }).standardKey).toBeUndefined();
    for (const l of ['Website', 'Portfolio URL', 'Personal site', 'Your blog']) {
      expect(standardKeyFor(l, 'text')).toBe('website');
    }
  });

  it('leaves a single-option select that is not an acknowledgement as free text', async () => {
    const { classified } = await resolveOne(
      field({ label: 'Preferred office', type: 'select', required: true, options: ['Remote'] }),
    );
    expect(classified.classification).toBe('free-text');
  });

  it('checks only the acknowledgement in a group that also has a real option', async () => {
    const { res } = await resolveOne(
      field({
        label: 'Before you submit',
        type: 'checkbox',
        required: true,
        options: ['Email me about future roles', 'I confirm I have read the above.'],
      }),
    );
    expect(res).toMatchObject({ status: 'filled', value: ['I confirm I have read the above.'] });
  });

  it('keeps self-identification first, even with acknowledgement-like options', async () => {
    const { classified } = await resolveOne(
      field({
        label: 'Gender',
        type: 'select',
        options: ['I acknowledge and agree to the terms'],
      }),
    );
    expect(classified.classification).toBe('self-identification');
  });

  describe('rule 32: "A or B" authorization', () => {
    const profileWith = (standard: Partial<typeof PROFILE.standard_answers>, location?: string) =>
      ({
        ...PROFILE,
        identity: { ...PROFILE.identity, location: location ?? null },
        contact: { ...PROFILE.contact, phone: null },
        standard_answers: { ...PROFILE.standard_answers, ...standard },
      }) as typeof PROFILE;
    const ask = (profile: typeof PROFILE, label: string) =>
      resolveStandardFields({ profile } as never, [
        field({
          label,
          classification: 'standard',
          required: true,
          type: 'radio',
          options: ['Yes', 'No'],
        }),
      ])[0];
    const OR = 'Do you have permanent authorization to work for Warp in the U.S. or Canada?';
    const AND = 'Are you authorized to work in both the U.S. and Canada?';
    const US = 'Authorized to work in the United States';

    it('explicit US authorization answers Yes to "U.S. or Canada", parks "both"', () => {
      const p = profileWith({ work_authorization: US });
      expect(ask(p, OR)).toMatchObject({ status: 'filled', value: 'Yes', source: 'profile' });
      expect(ask(p, 'Are you authorized to work in either the US or the UK?')).toMatchObject({
        value: 'Yes',
      });
      expect(ask(p, AND)).toMatchObject({ status: 'missing-profile-field' });
      expect(ask(p, 'Are you authorized to work in the U.S. and Canada?')).toMatchObject({
        status: 'missing-profile-field',
      });
    });

    it('authorization for neither place stays unanswered for "or"', () => {
      const p = profileWith({ work_authorization: 'Authorized to work in Germany' });
      expect(ask(p, OR)).toMatchObject({ status: 'missing-profile-field' });
    });

    it('inferred authorization follows the same any-of logic', () => {
      const p = profileWith(
        { work_authorization: null, visa_sponsorship_required: null },
        'Austin, TX',
      );
      expect(ask(p, OR)).toMatchObject({ value: 'Yes', source: 'inferred' });
      expect(ask(p, AND)).toMatchObject({ status: 'missing-profile-field' });
    });
  });
});

describe('rule 39: country from location', () => {
  const ask = (location: string | null, f: Partial<FieldDescriptor> & { label: string }) => {
    const profile = { ...PROFILE, identity: { ...PROFILE.identity, location } };
    return resolveStandardFields({ profile } as never, [
      field({ classification: 'standard', required: true, ...f }),
    ])[0];
  };
  const COUNTRIES = [
    'Canada',
    'France',
    'Germany',
    'India',
    'Japan',
    'Mexico',
    'Spain',
    'United Kingdom',
    'United States of America',
    'Brazil',
    'Australia',
  ];

  it('classifies a Country label and a country-option select as location', () => {
    expect(standardKeyFor('Country')).toBe('location');
    expect(standardKeyFor('Country of residence')).toBe('location');
    const verdict = (label: string) =>
      classifyFields([field({ label, type: 'select', options: COUNTRIES })]).then(
        (r) => r[0]?.standardKey,
      );
    return Promise.all([
      expect(verdict('Where are you based?')).resolves.toBe('location'),
      expect(verdict('Country of citizenship')).resolves.toBe('citizenship'),
    ]);
  });

  it('a Greenhouse large-list Country combobox gets the canonical name', () => {
    expect(ask('South San Francisco, CA', { label: 'Country', hint: 'large-list' })).toMatchObject({
      status: 'filled',
      value: 'United States',
    });
  });

  it('a native select picks the option by alias', () => {
    expect(
      ask('Austin, TX', { label: 'Country', type: 'select', options: COUNTRIES }),
    ).toMatchObject({ status: 'filled', value: 'United States of America' });
  });

  it('a country named in the location resolves to it', () => {
    expect(ask('Berlin, Germany', { label: 'Country' })).toMatchObject({ value: 'Germany' });
    expect(
      ask('London, UK', { label: 'Country', type: 'select', options: COUNTRIES }),
    ).toMatchObject({ value: 'United Kingdom' });
  });

  it('a city/state question keeps the location text', () => {
    expect(ask('South San Francisco, CA', { label: 'Current location' })).toMatchObject({
      status: 'filled',
      value: 'South San Francisco, CA',
    });
  });

  it('no derivable country: missing-profile-field when required, blank when optional', () => {
    expect(ask('Narnia', { label: 'Country' })).toMatchObject({
      status: 'missing-profile-field',
      profileField: 'identity.location',
    });
    expect(ask(null, { label: 'Country', required: false })).toMatchObject({ status: 'blank' });
  });
});

describe('self-identification default: decline', () => {
  const declining = () =>
    makeCtx(scripted({}), {
      profile: {
        ...PROFILE,
        standard_answers: { ...PROFILE.standard_answers, self_identification_default: 'decline' },
      },
    });
  const gender = field({
    id: 'gender',
    label: 'Gender',
    type: 'select',
    options: ['Male', 'Female', 'Decline to self identify'],
    classification: 'self-identification',
  });

  it('finds the decline option, and nothing when the form offers none', () => {
    expect(declineOption(['Male', 'Female', 'Decline to self identify'])).toBe(
      'Decline to self identify',
    );
    expect(declineOption(['Yes', 'No', "I don't wish to answer"])).toBe("I don't wish to answer");
    expect(declineOption(['I prefer not to say'])).toBe('I prefer not to say');
    expect(declineOption(['Yes', 'No'])).toBeNull();
    expect(declineOption(['I am a protected veteran', 'I am not a protected veteran'])).toBeNull();
    expect(declineOption(undefined)).toBeNull();
  });

  it('chooses the decline option the form itself offers', async () => {
    const out = await resolveAnswers(declining(), [gender]);
    expect(out[0]).toMatchObject({
      status: 'filled',
      value: 'Decline to self identify',
      source: 'profile',
    });
    expect(toFieldValues(out, [gender])).toEqual({ gender: 'Decline to self identify' });
    expect(toFormAnswers(out)).toEqual({ Gender: 'Decline to self identify' });
  });

  it('still skips a question that has no decline option, and never guesses', async () => {
    const vet = field({
      id: 'vet',
      label: 'Veteran Status',
      type: 'select',
      options: ['Yes', 'No'],
      classification: 'self-identification',
    });
    const out = await resolveAnswers(declining(), [vet]);
    expect(out[0]).toMatchObject({ status: 'skipped', skipped: 'self-identification' });
    expect(toFieldValues(out, [vet])).toEqual({});
  });

  it('without the setting the question is skipped even when a decline option exists', async () => {
    const out = await resolveAnswers(makeCtx(scripted({})), [gender]);
    expect(out[0]).toMatchObject({ status: 'skipped', skipped: 'self-identification' });
  });

  it('does not touch an attestation that merely offers "Prefer not to answer"', async () => {
    const ctx = makeCtx(scripted({ 'answer-form-question/v1': [UNANSWERABLE] }), {
      profile: {
        ...PROFILE,
        standard_answers: { ...PROFILE.standard_answers, self_identification_default: 'decline' },
      },
    });
    const out = await resolveAnswers(ctx, [
      field({
        id: 'crim',
        label: 'Have you ever been convicted of a crime?',
        type: 'select',
        options: ['Yes', 'No', 'Prefer not to answer'],
        classification: 'free-text',
      }),
    ]);
    expect(out[0]!.status).not.toBe('filled');
    expect(out[0]).not.toMatchObject({ value: 'Prefer not to answer' });
  });

  it('the fill plan enters the decline option and records it', async () => {
    const out = await resolveAnswers(declining(), [gender]);
    const plan = planFill([gender], out);
    expect(plan.values).toEqual({ gender: 'Decline to self identify' });
    expect(plan.answers).toEqual({ Gender: 'Decline to self identify' });
  });

  it('the fill plan still skips a self-identification field the resolver skipped', async () => {
    const out = await resolveAnswers(makeCtx(scripted({})), [gender]);
    const plan = planFill([gender], out);
    expect(plan.values).toEqual({});
    expect(plan.answers).toEqual({ Gender: { skipped: 'self-identification' } });
  });
});

describe('awards in answers', () => {
  it('sends the awards list to the model without sources', async () => {
    const llm = scripted({ 'answer-form-question/v1': [grounded("Dean's List 2018.")] });
    const ctx = makeCtx(llm, {
      profile: {
        ...PROFILE,
        awards: [
          { name: "Dean's List", issuer: 'State University', date: '2018', sources: ['resume'] },
        ],
      },
    });
    await resolveFreeText(
      ctx,
      field({ id: 'h', label: 'Any honors or awards?', type: 'textarea' }),
    );
    const sent = callsTo(llm, 'answer-form-question/v1')[0]!.user;
    expect(sent).toContain('Dean&#39;s List'.replace('&#39;', "'"));
    expect(sent).not.toContain('"sources"');
  });
});

describe('citizenship and payroll state', () => {
  const withAnswers = (over: Record<string, unknown>) => ({
    ...PROFILE,
    standard_answers: { ...PROFILE.standard_answers, ...over },
  });
  const one = (profile: typeof PROFILE, f: FieldDescriptor) =>
    resolveStandardFields({ profile }, [{ ...f, classification: 'standard' }])[0]!;

  it('recognises the labels', () => {
    expect(standardKeyFor('Are you a U.S. person under export control laws?')).toBe('citizenship');
    expect(standardKeyFor('Are you a U.S. citizen?')).toBe('citizenship');
    expect(standardKeyFor('What state will you be on payroll in?')).toBe('payroll_state');
    expect(standardKeyFor('Are you legally authorized to work in the US?')).toBe(
      'work_authorization',
    );
  });

  it('answers a yes/no U.S. person question from the citizenship text', () => {
    const f = field({
      label: 'Are you a U.S. person?',
      type: 'radio',
      options: ['Yes', 'No'],
      required: true,
    });
    expect(one(withAnswers({ citizenship: 'U.S. citizen' }), f)).toMatchObject({
      status: 'filled',
      value: 'Yes',
    });
    expect(one(withAnswers({ citizenship: 'Citizen of India' }), f)).toMatchObject({
      status: 'filled',
      value: 'No',
    });
  });

  it('reports the profile field when citizenship or payroll state is missing', () => {
    const c = field({ label: 'Citizenship', required: true });
    expect(one(withAnswers({ citizenship: null }), c)).toMatchObject({
      status: 'missing-profile-field',
      profileField: 'standard_answers.citizenship',
    });
    const s = field({ label: 'Where will you be on payroll?', required: true });
    expect(one(withAnswers({ payroll_state: 'Texas' }), s)).toMatchObject({
      status: 'filled',
      value: 'Texas',
    });
  });
});
