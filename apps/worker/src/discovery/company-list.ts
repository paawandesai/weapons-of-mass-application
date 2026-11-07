import {
  activity,
  getUnresolvedCompanyByName,
  listResolvedCompaniesByName,
  listUserCompanies,
  ProfileNotApprovedError,
  requireApprovedProfile,
  upsertCompany,
  upsertUserCompany,
  type CompanyRow,
  type TenantHandle,
} from '@wma/db';
import type { StructuredLlm } from '@wma/llm';
import { z } from 'zod';
import { mapLimit, nameWords, resolveBoard, type Http, type ResolveResult } from '@wma/discovery';
import { loadVersionedPrompt } from './prompts';
import { loadProfileDocument, profileForPrompt } from './profile-view';

export const MIN_COMPANIES = 20;
/** An unresolved name is not looked up again for this long. */
export const UNRESOLVED_RETRY_MS = 30 * 24 * 60 * 60 * 1000;
const RESOLVE_CONCURRENCY = 4;

export const CompanyListOutput = z.object({
  companies: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        reason: z.string().trim().min(1),
        slug_hints: z.array(z.string()),
      }),
    )
    .min(MIN_COMPANIES),
});
export type CompanyListOutput = z.infer<typeof CompanyListOutput>;

export interface CompanyListDeps {
  llm: StructuredLlm;
  http?: Http;
  now?: () => Date;
  /** Board lookup; defaults to resolveBoard over `http`. */
  resolve?: (name: string, hints: string[]) => Promise<ResolveResult>;
}

export type CompanyListResult =
  | { generated: false; reason: 'profile_not_approved' | 'llm_failed' }
  | {
      generated: true;
      suggested: number;
      added: number;
      resolved: number;
      unresolved: number;
      unavailable: number;
      cached: number;
      /** Suggestions dropped because the user removed that company. */
      removed: number;
    };

/**
 * Builds or extends the user's company list from the approved profile. Names already resolved in
 * the global cache cost no lookup; unresolved names within their retry window are not looked up
 * again; a timeout leaves the name out entirely so the next generation tries it again. Rows the
 * user removed stay removed (upsertUserCompany never resurrects them).
 */
export async function generateCompanyList(
  handle: TenantHandle,
  userId: string,
  deps: CompanyListDeps,
): Promise<CompanyListResult> {
  const now = deps.now ?? (() => new Date());
  let version: number;
  try {
    version = await requireApprovedProfile(handle, userId);
  } catch (e) {
    if (!(e instanceof ProfileNotApprovedError)) throw e;
    await activity.logActivity(handle, {
      userId,
      actor: 'agent',
      action: 'company_list_skipped',
      detail: { reason: 'profile_not_approved' },
    });
    return { generated: false, reason: 'profile_not_approved' };
  }
  const profile = await loadProfileDocument(handle, userId, version);
  const existing = await listUserCompanies(handle, userId, { includeRemoved: true });
  const prompt = loadVersionedPrompt('company-list', 'v1');

  let output: CompanyListOutput | null = null;
  for (let attempt = 0; attempt < 2 && !output; attempt++) {
    try {
      const res = await deps.llm.generateStructured({
        prompt: 'company-list/v1',
        system: prompt.body,
        user: [
          'Suggest companies for this person.',
          existing.length
            ? `Already on their list (do not repeat): ${existing.map((e) => e.company.name).join(', ')}`
            : '',
          `<profile>\n${JSON.stringify(profileForPrompt(profile), null, 1)}\n</profile>`,
        ]
          .filter(Boolean)
          .join('\n\n'),
        schema: CompanyListOutput,
        maxTokens: 8000,
      });
      const parsed = CompanyListOutput.safeParse(res.output);
      if (parsed.success) output = parsed.data;
    } catch {
      // retried once below, then reported
    }
  }
  if (!output) {
    await activity.logActivity(handle, {
      userId,
      actor: 'agent',
      action: 'company_list_failed',
      detail: { reason: 'invalid_model_output', prompt: prompt.id },
    });
    return { generated: false, reason: 'llm_failed' };
  }

  const resolve = deps.resolve ?? ((name, hints) => resolveBoard(name, hints, { http: deps.http }));
  // Removal is a hard override: a removed company is filtered out before any lookup, by name and
  // (after resolution) by board, so it cannot come back as a new company row with a new id.
  const removedRows = existing.filter((e) => e.membership.removedAt);
  const removedNames = new Set(removedRows.map((e) => nameWords(e.company.name).join(' ')));
  const removedBoards = new Set(
    removedRows.flatMap((e) =>
      e.company.ats && e.company.boardSlug
        ? [`${e.company.ats}:${e.company.boardSlug}:${e.company.boardRegion}`]
        : [],
    ),
  );
  const seen = new Set<string>();
  let removedCount = 0;
  const suggestions = output.companies.filter((c) => {
    const k = c.name.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    if (removedNames.has(nameWords(c.name).join(' '))) {
      removedCount++;
      return false;
    }
    return true;
  });

  const tally = { added: 0, resolved: 0, unresolved: 0, unavailable: 0, cached: 0 };
  await mapLimit(suggestions, RESOLVE_CONCURRENCY, async (s) => {
    const link = async (company: CompanyRow) => {
      const { created } = await upsertUserCompany(handle, {
        userId,
        companyId: company.id,
        source: 'llm',
        reason: s.reason,
      });
      if (created) tally.added++;
    };
    const cached = await listResolvedCompaniesByName(handle, s.name);
    if (cached.length) {
      tally.cached++;
      tally.resolved++;
      for (const c of cached) {
        if (!removedBoards.has(`${c.ats}:${c.boardSlug}:${c.boardRegion}`)) await link(c);
      }
      return;
    }
    const stale = await getUnresolvedCompanyByName(handle, s.name);
    if (stale?.unresolvedUntil && stale.unresolvedUntil > now()) {
      tally.unresolved++;
      await link(stale);
      return;
    }
    const r = await resolve(s.name, s.slug_hints);
    if (r.status === 'resolved') {
      tally.resolved++;
      for (const b of r.boards) {
        if (removedBoards.has(`${b.ats}:${b.boardSlug}:${b.region}`)) continue;
        const company = await upsertCompany(handle, {
          name: s.name,
          ats: b.ats,
          boardSlug: b.boardSlug,
          boardRegion: b.region,
          boardUrl: b.boardUrl,
          resolvedAt: now(),
          createdBy: 'llm',
        });
        await link(company);
      }
    } else if (r.status === 'unresolved') {
      tally.unresolved++;
      const company = await upsertCompany(handle, {
        name: s.name,
        unresolvedUntil: new Date(now().getTime() + UNRESOLVED_RETRY_MS),
        createdBy: 'llm',
      });
      await link(company);
    } else {
      // ATS unreachable: leave it out entirely so the next generation or run retries it.
      tally.unavailable++;
    }
  });

  await activity.logActivity(handle, {
    userId,
    actor: 'agent',
    action: 'company_list_generated',
    detail: { prompt: prompt.id, suggested: suggestions.length, removed: removedCount, ...tally },
  });
  return { generated: true, suggested: suggestions.length, removed: removedCount, ...tally };
}
