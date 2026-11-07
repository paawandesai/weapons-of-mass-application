import { applicationFileKey } from '@wma/db';
import type { ProfileDocument } from '@wma/shared';
import { callStructured, esc } from '../structured';
import { renderResumePdf, ResumeTooLongError, type RenderOptions, type RenderedPdf } from '../pdf';
import type { SubmissionContext, TailorResult } from '../types';
import { compareFacts, compareSkills, dedupe, factsFromContent } from './facts';
import { resumeToText } from './format';
import {
  resumeFactsSchema,
  tailoredResumeSchema,
  type ResumeDocument,
  type TailoredResume,
} from './schema';

export { compareFacts, compareSkills, normalizeName } from './facts';
export type { ResumeDocument, TailoredResume } from './schema';

export const TAILOR_PROMPT = 'tailor-resume';
export const EXTRACT_PROMPT = 'extract-resume-facts';

export interface TailorOptions extends RenderOptions {
  /** Replaces the Playwright renderer (tests). */
  render?: (doc: ResumeDocument) => Promise<RenderedPdf>;
}

/** The profile as the model sees it: facts only, no survey, preferences, standard answers or flags. */
function profileForModel(p: ProfileDocument) {
  return {
    identity: p.identity,
    contact: p.contact,
    work_history: p.work_history.map(({ sources: _s, ...w }) => ({
      ...w,
      end_date: w.end_date ?? 'present',
    })),
    projects: p.projects.map(({ sources: _s, ...x }) => x),
    skills: p.skills,
    education: p.education.map(({ sources: _s, ...x }) => x),
    certifications: (p.certifications ?? []).map(({ sources: _s, ...x }) => x),
  };
}

export function tailorUserMessage(ctx: SubmissionContext, rejected: string[]): string {
  const { job, judgment } = ctx;
  const posting = {
    title: job.title,
    location: job.location,
    description: job.description,
    url: job.url,
  };
  const decision = judgment
    ? { seniority: judgment.seniority, location_mode: judgment.location_mode }
    : {};
  const parts = [
    `<profile>\n${esc(JSON.stringify(profileForModel(ctx.profile), null, 1))}\n</profile>`,
    `<posting>\n${esc(JSON.stringify(posting, null, 1))}\n</posting>`,
    `<decision>\n${JSON.stringify(decision)}\n</decision>`,
  ];
  if (rejected.length) {
    parts.push(
      `<rejected>\nYour previous resume was discarded because it stated facts that are not in the profile:\n${rejected.map((f) => `- ${esc(f)}`).join('\n')}\n</rejected>`,
    );
  }
  return parts.join('\n\n');
}

/** Name and contact lines come from the profile so the first text line is always the user's name. */
export function documentFor(profile: ProfileDocument, content: TailoredResume): ResumeDocument {
  const { identity, contact } = profile;
  return {
    name: identity.full_name,
    contact: [
      contact.email,
      contact.phone,
      identity.location,
      contact.linkedin_url,
      contact.github_url,
      contact.website_url,
    ]
      .filter((x): x is string => !!x)
      .map((x) => x.replace(/^https?:\/\/(www\.)?/, '')),
    content,
  };
}

async function check(ctx: SubmissionContext, doc: ResumeDocument): Promise<string[]> {
  const extracted = await callStructured(
    ctx.llm,
    EXTRACT_PROMPT,
    `<resume>\n${esc(resumeToText(doc))}\n</resume>`,
    resumeFactsSchema,
  );
  return dedupe([
    ...compareFacts(ctx.profile, extracted),
    ...compareFacts(ctx.profile, factsFromContent(doc.content)),
    ...compareSkills(ctx.profile, doc.content),
  ]);
}

/**
 * Tailor step (rules 6 and 17): generate with `tailor-resume@1`, extract facts with
 * `extract-resume-facts@1`, compare with the profile, regenerate once with the failures quoted,
 * then render, check the page count and store `resume.pdf`.
 *
 * Returns `{ok: false, reason: 'tailoring-check-failed', detail: 'invalid_facts'}` after a
 * second failed check and `detail: 'too_long'` when the PDF stays over two pages after the font
 * shrink. Throws RenderError when rendering itself fails (the caller maps it to render-failed).
 */
export async function tailorResume(
  ctx: SubmissionContext,
  opts: TailorOptions = {},
): Promise<TailorResult> {
  let rejected: string[] = [];
  let doc: ResumeDocument | null = null;
  let regenerated = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const content = await callStructured(
      ctx.llm,
      TAILOR_PROMPT,
      tailorUserMessage(ctx, rejected),
      tailoredResumeSchema,
    );
    const candidate = documentFor(ctx.profile, content);
    const failures = await check(ctx, candidate);
    if (failures.length === 0) {
      doc = candidate;
      regenerated = attempt > 0;
      break;
    }
    rejected = failures;
  }
  if (!doc) {
    return {
      ok: false,
      reason: 'tailoring-check-failed',
      detail: 'invalid_facts',
      failures: rejected,
    };
  }

  let pdf: RenderedPdf;
  try {
    pdf = await (opts.render ?? ((d) => renderResumePdf(d, opts)))(doc);
  } catch (e) {
    if (e instanceof ResumeTooLongError) {
      return {
        ok: false,
        reason: 'tailoring-check-failed',
        detail: 'too_long',
        failures: [`The resume renders to ${e.pageCount} pages; the limit is 2.`],
      };
    }
    throw e;
  }
  const pdfKey = applicationFileKey(ctx.handle.tenantId, ctx.application.id, 'resume.pdf');
  await ctx.files.put(pdfKey, pdf.bytes);
  return {
    ok: true,
    pdfKey,
    pageCount: pdf.pageCount,
    unmetRequirements: doc.content.unmet_requirements,
    regenerated,
  };
}
