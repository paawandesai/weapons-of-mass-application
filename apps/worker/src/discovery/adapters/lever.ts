import { Candidate } from '@wma/shared';
import { boardApiUrl, boardPublicUrl } from '@wma/discovery';
import { htmlToText, toIso } from '../text';
import type { SourceAdapter } from '../types';
import { sweepBoards } from './board';

interface LeverPosting {
  id: string;
  text?: string;
  hostedUrl?: string;
  createdAt?: number;
  categories?: { location?: string; commitment?: string; team?: string; allLocations?: string[] };
  workplaceType?: string;
  descriptionPlain?: string;
  description?: string;
  additionalPlain?: string;
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string };
}

export const leverAdapter: SourceAdapter = {
  id: 'lever',
  fetch: (ctx) =>
    sweepBoards('lever', ctx, async (board) => {
      const body = await ctx.http.json<LeverPosting[]>(
        boardApiUrl('lever', board.boardSlug, { region: board.region }),
      );
      if (!Array.isArray(body)) throw new Error('unexpected lever response');
      const out: Candidate[] = [];
      for (const p of body) {
        if (!p.id || !p.text) continue;
        const description =
          [
            p.descriptionPlain ?? (p.description ? htmlToText(p.description) : ''),
            p.additionalPlain ?? '',
          ]
            .filter(Boolean)
            .join('\n\n') || null;
        out.push(
          Candidate.parse({
            source: 'lever',
            title: p.text,
            companyName: board.companyName,
            companyId: board.companyId,
            url: p.hostedUrl ?? `${boardPublicUrl('lever', board.boardSlug, board.region)}/${p.id}`,
            ats: 'lever',
            atsJobId: p.id.toLowerCase(),
            description,
            location: p.categories?.location ?? null,
            postedAt: toIso(p.createdAt),
            raw: { pay: p.salaryRange ?? null, workplaceType: p.workplaceType ?? null },
          }),
        );
      }
      return out;
    }),
};
