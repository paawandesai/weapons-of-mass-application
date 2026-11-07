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
