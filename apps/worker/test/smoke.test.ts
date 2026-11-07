import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '@wma/db';
import { createLlmClient, loadPrompt } from '@wma/llm';
import { profileModelOutputSchema } from '@wma/shared';
import { normalizeModelOutput, PROMPT_ID, renderUserMessage } from '../src/profile/build';
import { postValidate } from '../src/profile/postvalidate';
import type { SourceBundle } from '../src/profile/types';
import { LINKEDIN_TEXT, RESUME_TEXT } from './fixtures/sources';

loadEnv();

// Real API call; run with RUN_LLM_SMOKE=1. Optional SMOKE_OUT=<file> saves the raw model output.
describe.skipIf(!process.env.RUN_LLM_SMOKE)('profile build against the real model', () => {
  it('returns schema-valid output that survives post-validation', async () => {
    const bundle: SourceBundle = {
      accountEmail: 'mara.quill@example.com',
      links: { linkedin_url: 'https://www.linkedin.com/in/mara-quill', github_url: null },
      sources: [
        { id: 'resume', kind: 'resume', text: RESUME_TEXT, partial: false },
        { id: 'linkedin', kind: 'linkedin', text: LINKEDIN_TEXT, partial: false },
      ],
    };
    const llm = createLlmClient();
    const started = Date.now();
    const res = await llm.generateStructured({
      prompt: PROMPT_ID,
      system: loadPrompt('profile-build', 'v1'),
      user: renderUserMessage(bundle),
      schema: profileModelOutputSchema,
    });
    console.log(
      `smoke: model=${llm.model} ms=${Date.now() - started} usage=${JSON.stringify(res.usage)} stop=${res.stopReason}`,
    );
    if (process.env.SMOKE_OUT)
      writeFileSync(process.env.SMOKE_OUT, JSON.stringify(res.output, null, 2));
    const parsed = profileModelOutputSchema.safeParse(normalizeModelOutput(res.output));
    expect(parsed.error?.issues ?? []).toEqual([]);
    const { output, flags } = postValidate(parsed.data!, bundle);
    console.log(
      `smoke: employers=${output.work_history.map((w) => w.employer).join(',')} flags=${JSON.stringify(flags.map((f) => [f.kind, f.value]))}`,
    );
    expect(output.work_history.length).toBeGreaterThan(0);
    expect(output.identity.full_name).toBe('Mara Quill');
  }, 300_000);
});
