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
});
