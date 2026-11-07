/**
 * Eval bridge: runs one real worker step on one input and prints the result as JSON, so the
 * Python DeepEval suites in /evals test the production code path (prompt, schema, retry and guard
 * loops), not a copy of the prompt.
 *
 *   echo '{"task":"inbox-classify","input":{...}}' | pnpm -F @wma/worker exec tsx src/evals/bridge.ts
 *
 * Uses ANTHROPIC_API_KEY. EVAL_FAKE_LLM=<file.json> replays a JSON array of model replies instead
 * (used to check the bridge without a key).
 */
import { readFileSync } from 'node:fs';
import { createLlmClient, FakeLlm, type StructuredLlm } from '@wma/llm';
import type { ProfileDocument } from '@wma/shared';
import { classifyMessage } from '../inbox/classify';
import { classifyFields } from '../submission/answers/classify';
import { resolveFreeText } from '../submission/answers/freetext';
import { tailorResume } from '../submission/tailor';
import { resumeToText } from '../submission/tailor/format';
import type { FieldDescriptor, SubmissionContext } from '../submission/types';

interface Job {
  title: string;
  location: string | null;
  description: string;
  url?: string;
}

type Request =
  | {
      task: 'inbox-classify';
      input: {
        from: string;
        subject: string;
        text: string;
        receivedAt: string;
        company: string;
        jobTitle: string;
      };
    }
  | { task: 'tailor-resume'; input: { profile: ProfileDocument; job: Job } }
  | {
      task: 'form-answer';
      input: { profile: ProfileDocument; job: Job; field: Omit<FieldDescriptor, 'classification'> };
    };

function llm(): StructuredLlm {
  const fake = process.env.EVAL_FAKE_LLM;
  if (fake) return new FakeLlm(JSON.parse(readFileSync(fake, 'utf8')) as unknown[]);
  return createLlmClient(process.env.EVAL_MODEL ? { model: process.env.EVAL_MODEL } : {});
}

async function run(req: Request, model: StructuredLlm): Promise<unknown> {
  switch (req.task) {
    case 'inbox-classify': {
      const { company, jobTitle, receivedAt, ...msg } = req.input;
      return classifyMessage(
        model,
        { ...msg, receivedAt: new Date(receivedAt) } as Parameters<typeof classifyMessage>[1],
        { companyName: company, jobTitle },
      );
    }
    case 'tailor-resume': {
      // Only the fields the tailor step reads; the PDF is skipped and the document captured.
      let text: string | null = null;
      const ctx = {
        llm: model,
        profile: req.input.profile,
        job: { url: '', ...req.input.job },
        judgment: null,
        handle: { tenantId: 'eval' },
        application: { id: 'eval' },
        files: { put: async () => {} },
      } as unknown as SubmissionContext;
      const result = await tailorResume(ctx, {
        render: async (doc) => {
          text = resumeToText(doc);
          return { bytes: Buffer.alloc(0), pageCount: 1, fontStep: 0 };
        },
      });
      return { ...result, resume_text: text };
    }
    case 'form-answer': {
      const [field] = await classifyFields(
        [{ ...req.input.field, classification: 'free-text' }],
        model,
      );
      if (!field) throw new Error('form-answer: no field');
      if (field.classification !== 'free-text') return { classification: field.classification };
      const ctx = {
        llm: model,
        profile: req.input.profile,
        job: req.input.job,
      } as unknown as SubmissionContext;
      return { classification: field.classification, ...(await resolveFreeText(ctx, field)) };
    }
  }
}

const req = JSON.parse(readFileSync(0, 'utf8')) as Request;
run(req, llm()).then(
  (out) => process.stdout.write(`${JSON.stringify(out)}\n`),
  (e: unknown) => {
    process.stdout.write(
      `${JSON.stringify({ error: e instanceof Error ? e.message : String(e) })}\n`,
    );
    process.exitCode = 1;
  },
);
