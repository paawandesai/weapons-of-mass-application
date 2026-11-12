import { describe, expect, it } from 'vitest';
import fixture from './fixtures/profile.full.json';
import { profileDocumentSchema, unresolvedBlockingFlags, type ProfileFlag } from '../src';

const clone = () => structuredClone(fixture) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('profileDocumentSchema', () => {
  it('accepts the full fixture document', () => {
    const parsed = profileDocumentSchema.parse(fixture);
    expect(parsed.work_history).toHaveLength(2);
    expect(parsed.survey.daily_target).toBe(12);
  });

  it.each(['work_history', 'projects', 'education'])(
    'rejects a %s entry without sources',
    (key) => {
      const doc = clone();
      delete doc[key][0].sources;
      expect(profileDocumentSchema.safeParse(doc).success).toBe(false);
    },
  );

  it.each(['work_history', 'projects', 'education'])(
    'rejects a %s entry with empty sources',
    (key) => {
      const doc = clone();
      doc[key][0].sources = [];
      expect(profileDocumentSchema.safeParse(doc).success).toBe(false);
    },
  );

  it('rejects dates that are neither YYYY-MM nor YYYY', () => {
    const doc = clone();
    for (const bad of ['2021-13', '2021-3-01', '2021-3', '21', '2021-01-05', '']) {
      doc.work_history[0].start_date = bad;
      expect(profileDocumentSchema.safeParse(doc).success, bad).toBe(false);
    }
  });

  it('accepts a year-only date as well as YYYY-MM', () => {
    const doc = clone();
    doc.work_history[0].start_date = '2019';
    doc.work_history[0].end_date = '2021-06';
    expect(profileDocumentSchema.safeParse(doc).success).toBe(true);
  });

  it('accepts null dates', () => {
    const doc = clone();
    doc.work_history[0].start_date = null;
    expect(profileDocumentSchema.safeParse(doc).success).toBe(true);
  });

  it('validates earliest_start_date as a real ISO date or null', () => {
    const doc = clone();
    for (const ok of ['2026-12-01', null]) {
      doc.standard_answers.earliest_start_date = ok;
      expect(profileDocumentSchema.safeParse(doc).success, String(ok)).toBe(true);
    }
    for (const bad of ['2026-02-30', '2026-13-01', '2026-1-5', '12/01/2026', 'soon', '']) {
      doc.standard_answers.earliest_start_date = bad;
      expect(profileDocumentSchema.safeParse(doc).success, bad).toBe(false);
    }
    // Profiles stored before the field existed have no key: it defaults to null.
    delete doc.standard_answers.earliest_start_date;
    expect(profileDocumentSchema.parse(doc).standard_answers.earliest_start_date).toBeNull();
  });

  it('defaults previous_interviews to null and accepts a list or an empty list', () => {
    const doc = clone();
    delete doc.standard_answers.previous_interviews;
    expect(profileDocumentSchema.parse(doc).standard_answers.previous_interviews).toBeNull();
    for (const ok of [[], ['Anthropic', 'OpenAI']]) {
      doc.standard_answers.previous_interviews = ok;
      expect(profileDocumentSchema.parse(doc).standard_answers.previous_interviews).toEqual(ok);
    }
    doc.standard_answers.previous_interviews = [1];
    expect(profileDocumentSchema.safeParse(doc).success).toBe(false);
  });

  it('defaults the daily target to 12 and bounds it to 1-30', () => {
    const doc = clone();
    delete doc.survey.daily_target;
    expect(profileDocumentSchema.parse(doc).survey.daily_target).toBe(12);
    doc.survey.daily_target = 0;
    expect(profileDocumentSchema.safeParse(doc).success).toBe(false);
    doc.survey.daily_target = 31;
    expect(profileDocumentSchema.safeParse(doc).success).toBe(false);
  });
});

describe('unresolvedBlockingFlags', () => {
  const flag = (kind: ProfileFlag['kind'], resolved = false): ProfileFlag => ({
    id: `${kind}-${resolved}`,
    kind,
    path: null,
    message: kind,
    sources: ['resume'],
    resolved,
  });

  it('counts a blocking flag while it is present, even when resolved is true', () => {
    const flags = [flag('unsupported_entry', true), flag('date_conflict', true)];
    expect(unresolvedBlockingFlags(flags)).toHaveLength(2);
  });

  it('never counts partial_source or other informational flags', () => {
    const flags = [flag('partial_source'), flag('missing_info'), flag('other')];
    expect(unresolvedBlockingFlags(flags)).toEqual([]);
  });

  it('is empty once the blocking flags are removed from the list', () => {
    expect(unresolvedBlockingFlags([flag('partial_source')])).toEqual([]);
  });
});

describe('awards and self-identification default', () => {
  it('older documents without either field still parse, with the default null', () => {
    const doc = clone();
    delete doc.awards;
    delete doc.standard_answers.self_identification_default;
    const parsed = profileDocumentSchema.parse(doc);
    expect(parsed.awards).toBeUndefined();
    expect(parsed.standard_answers.self_identification_default).toBeNull();
  });

  it('accepts awards with provenance and rejects one with no source', () => {
    const doc = clone();
    doc.awards = [{ name: "Dean's List", issuer: null, date: '2018', sources: ['resume'] }];
    expect(profileDocumentSchema.parse(doc).awards).toHaveLength(1);
    doc.awards = [{ name: 'Invented prize', sources: [] }];
    expect(profileDocumentSchema.safeParse(doc).success).toBe(false);
  });

  it('only accepts decline (or null) as the self-identification default', () => {
    const doc = clone();
    doc.standard_answers.self_identification_default = 'decline';
    expect(profileDocumentSchema.parse(doc).standard_answers.self_identification_default).toBe(
      'decline',
    );
    doc.standard_answers.self_identification_default = 'male';
    expect(profileDocumentSchema.safeParse(doc).success).toBe(false);
  });
});
