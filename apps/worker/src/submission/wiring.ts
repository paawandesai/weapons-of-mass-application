import type { PgBoss } from 'pg-boss';
import { createGmailSender } from '@wma/google';
import { createLlmClient } from '@wma/llm';
import { createBlockedLogger, createOutgoingStore } from '@wma/db';
import { defaultGuards } from '@wma/shared';
import { selectAdapter } from './adapters';
import { launchSharedBrowser, sharedBrowser } from './browser';
import { systemClock, type SubmissionDeps } from './deps';
import { createFollowUpQueue } from './followup';
import { createGmailPort } from './gmail';
import { resolveAnswers } from './answers';
import { tailorResume } from './tailor';

/** The production dependencies: real tailoring, answers, adapters, browser and Gmail. */
export function createSubmissionDeps(boss: PgBoss): SubmissionDeps {
  return {
    // Resume PDFs render on the worker's shared browser, not a Chromium of their own.
    tailor: async (ctx) => tailorResume(ctx, { browser: await sharedBrowser() }),
    resolveAnswers: (ctx, fields) => resolveAnswers(ctx, fields),
    selectAdapter: (url) => {
      const selected = selectAdapter(url);
      return selected.ok ? selected.adapter : null;
    },
    launchBrowser: launchSharedBrowser,
    gmail: createGmailPort,
    clock: systemClock,
    llm: createLlmClient(),
    sendMail: (handle, userId) => ({
      sender: createGmailSender(handle),
      guards: defaultGuards,
      store: createOutgoingStore(handle, userId),
      onBlocked: createBlockedLogger(handle, userId),
    }),
    followUp: createFollowUpQueue(boss),
    webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  };
}
