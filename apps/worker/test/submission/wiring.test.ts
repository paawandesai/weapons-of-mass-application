import { describe, expect, it, vi } from 'vitest';

const browser = { id: 'the-shared-browser' };
const tailorResume = vi.fn(async () => ({ ok: true }));

vi.mock('../../src/submission/browser', () => ({
  sharedBrowser: async () => browser,
  launchSharedBrowser: async () => ({ newContext: async () => ({}) }),
}));
vi.mock('../../src/submission/tailor', () => ({ tailorResume }));
vi.mock('@wma/llm', () => ({ createLlmClient: () => ({}) }));
vi.mock('@wma/google', () => ({ createGmailSender: () => ({}) }));

describe('production wiring', () => {
  it('renders resume PDFs on the worker-wide shared browser', async () => {
    const { createSubmissionDeps } = await import('../../src/submission/wiring');
    const deps = createSubmissionDeps({} as never);
    const ctx = { application: { id: 'a' } } as never;
    await deps.tailor(ctx);
    expect(tailorResume).toHaveBeenCalledWith(ctx, { browser });
  });
});
