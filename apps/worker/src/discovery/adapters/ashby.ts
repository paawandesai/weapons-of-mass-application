import { Candidate } from '@wma/shared';
import { boardApiUrl, boardPublicUrl } from '@wma/discovery';
import { htmlToText, toIso } from '../text';
import type { SourceAdapter } from '../types';
import { sweepBoards } from './board';

interface AshbyJob {
  id: string;
  title?: string;
  location?: string;
  isRemote?: boolean;
  isListed?: boolean;
  jobUrl?: string;
  publishedAt?: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
  compensation?: { compensationTierSummary?: string; scrapeableCompensationSalarySummary?: string };
}

export const ashbyAdapter: SourceAdapter = {
  id: 'ashby',
  fetch: (ctx) =>
    sweepBoards('ashby', ctx, async (board) => {
      const body = await ctx.http.json<{ jobs?: AshbyJob[] }>(
        boardApiUrl('ashby', board.boardSlug, { full: true, region: board.region }),
      );
      const out: Candidate[] = [];
      for (const j of body.jobs ?? []) {
        if (!j.id || !j.title || j.isListed === false) continue;
        out.push(
          Candidate.parse({
            source: 'ashby',
            title: j.title,
            companyName: board.companyName,
            companyId: board.companyId,
            url: j.jobUrl ?? `${boardPublicUrl('ashby', board.boardSlug)}/${j.id}`,
            ats: 'ashby',
            atsJobId: j.id.toLowerCase(),
            description:
              j.descriptionPlain ?? (j.descriptionHtml ? htmlToText(j.descriptionHtml) : null),
            location: j.location ?? null,
            postedAt: toIso(j.publishedAt),
            raw: {
              pay:
                j.compensation?.scrapeableCompensationSalarySummary ??
                j.compensation?.compensationTierSummary ??
                null,
              isRemote: j.isRemote ?? null,
            },
          }),
        );
      }
      return out;
    }),
};
