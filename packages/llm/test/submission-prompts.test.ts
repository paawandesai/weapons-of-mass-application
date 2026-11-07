import { describe, expect, it } from 'vitest';
import { loadPrompt } from '../src';

describe('submission prompts', () => {
  it.each(['tailor-resume', 'extract-resume-facts', 'answer-form-question', 'classify-form-field'])(
    '%s/v1 loads and is non-trivial',
    (name) => {
      expect(loadPrompt(name, 'v1').length).toBeGreaterThan(300);
    },
  );

  it('the tailoring prompt forbids invention and the answer prompt forbids compensation and EEO answers', () => {
    expect(loadPrompt('tailor-resume', 'v1')).toMatch(/Never add degrees or certifications/);
    expect(loadPrompt('answer-form-question', 'v1')).toMatch(/compensation, salary or pay/);
    expect(loadPrompt('answer-form-question', 'v1')).toMatch(/race, ethnicity, gender/);
    expect(loadPrompt('answer-form-question', 'v1')).toMatch(
      /lists every option the profile supports/,
    );
    expect(loadPrompt('answer-form-question', 'v1')).toMatch(
      /"have you used", "are you familiar with"/,
    );
    expect(loadPrompt('answer-form-question', 'v1')).toMatch(
      /qualifier \(in production, professionally, N\+ years/,
    );
    expect(loadPrompt('answer-form-question', 'v1')).toMatch(
      /leave the option out\. When no option is supported, the question is unanswerable/,
    );
  });

  it('the answer prompt carries guess mode and the never-guess list (rule 29)', () => {
    const p = loadPrompt('answer-form-question', 'v1');
    expect(p).toMatch(/Guess mode/);
    expect(p).toMatch(/set `guessed` to true and `grounded` to false/);
    expect(p).toMatch(
      /Never guess about: credentials, licenses, certifications, security clearances/,
    );
    expect(p).toMatch(/compensation/);
    expect(p).toMatch(/criminal history/);
    expect(p).toMatch(/legal attestations beyond work authorization/);
    expect(p).toMatch(/hard requirement with a number that the profile contradicts/);
    expect(p).toMatch(/no guess is defensible stays unanswerable/);
  });
});
