import { Candidate, parseAtsJobUrl } from '@wma/shared';
import { boardApiUrl } from '@wma/discovery';
import { escapedHtmlToText, toIso } from '../text';
import type { SourceAdapter } from '../types';
import { sweepBoards } from './board';

interface GreenhouseJob {
  id: number | string;
  title?: string;
  absolute_url?: string;
  location?: { name?: string } | null;
  updated_at?: string;
  first_published?: string;
  content?: string;
  departments?: Array<{ name?: string }>;
}

export const greenhouseAdapter: SourceAdapter = {
  id: 'greenhouse',
  fetch: (ctx) =>
    sweepBoards('greenhouse', ctx, async (board) => {
      const body = await ctx.http.json<{ jobs?: GreenhouseJob[] }>(
        boardApiUrl('greenhouse', board.boardSlug, { full: true, region: board.region }),
      );
      const out: Candidate[] = [];
      for (const j of body.jobs ?? []) {
        if (!j.title || j.id == null) continue;
        const id = String(j.id);
        // A company-hosted careers page is not the hosted form; use the board URL for those.
        const url =
          j.absolute_url && parseAtsJobUrl(j.absolute_url)
            ? j.absolute_url
            : `${board.region === 'eu' ? 'https://job-boards.eu.greenhouse.io' : 'https://job-boards.greenhouse.io'}/${board.boardSlug}/jobs/${id}`;
        out.push(
          Candidate.parse({
            source: 'greenhouse',
            title: j.title,
            companyName: board.companyName,
            companyId: board.companyId,
            url,
            ats: 'greenhouse',
            atsJobId: id,
            description: j.content ? escapedHtmlToText(j.content) : null,
            location: j.location?.name ?? null,
            postedAt: toIso(j.first_published ?? j.updated_at),
            raw: { departments: (j.departments ?? []).map((d) => d.name).filter(Boolean) },
          }),
        );
      }
      return out;
    }),
};
