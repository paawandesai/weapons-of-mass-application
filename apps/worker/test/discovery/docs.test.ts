import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { schema } from '@wma/db';
import { slugVariants } from '@wma/discovery';
import { QUEUED_STEP, RUN_STEPS } from '../../src/discovery/run';

const read = (p: string) => readFileSync(new URL(`../../../../${p}`, import.meta.url), 'utf8');
const listBetween = (doc: string, tag: string) => {
  const m = doc.match(new RegExp(`<!-- ${tag} -->\\n([\\s\\S]*?)<!-- /${tag} -->`));
  return [...(m?.[1] ?? '').matchAll(/^- `([a-z_]+)`/gm)].map((x) => x[1]!);
};

describe('docs/daily-run.md matches the code', () => {
  const doc = read('docs/daily-run.md');
  it('lists exactly the run statuses of the enum', () => {
    expect(listBetween(doc, 'statuses')).toEqual([...schema.runStatus.enumValues]);
  });
  it('lists exactly the run steps', () => {
    expect(listBetween(doc, 'steps')).toEqual([QUEUED_STEP, ...RUN_STEPS]);
  });
});

describe('docs/discovery.md matches the slug rules', () => {
  const doc = read('docs/discovery.md');
  it('documents the variants the tests use', () => {
    expect(doc).toContain('`Northwind Labs` gives `northwind-labs`');
    expect(doc).toContain('`northwindlabs`');
    expect(slugVariants('Northwind Labs')).toEqual(['northwind-labs', 'northwindlabs']);
    for (const suffix of ['inc', 'llc', 'ltd', 'corp', 'gmbh'])
      expect(doc).toContain(`\`${suffix}\``);
    expect(slugVariants('Acme Inc')).toEqual(['acme']);
    expect(doc).toContain('at most six');
  });
});
