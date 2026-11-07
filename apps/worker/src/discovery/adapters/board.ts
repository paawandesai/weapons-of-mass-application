import type { AtsId, Candidate } from '@wma/shared';
import type { BoardRef, SourceContext, SourceId, SourceResult } from '../types';

/**
 * Shared board sweep for the three ATS adapters: every board of that ATS on the user's list is
 * fetched; a failing board is skipped and named, all failing means the source is unavailable.
 */
export async function sweepBoards(
  id: SourceId & AtsId,
  ctx: SourceContext,
  fetchBoard: (board: BoardRef) => Promise<Candidate[]>,
): Promise<SourceResult> {
  const boards = ctx.boards.filter((b) => b.ats === id);
  if (boards.length === 0) return { status: 'ok', candidates: [] };
  const failed: string[] = [];
  const results = await Promise.all(
    boards.map(async (b) => {
      try {
        return await fetchBoard(b);
      } catch {
        failed.push(b.boardSlug);
        return [] as Candidate[];
      }
    }),
  );
  const candidates = results.flat();
  if (failed.length === 0) return { status: 'ok', candidates };
  const allFailed = failed.length === boards.length;
  return {
    status: allFailed ? 'unavailable' : 'partial',
    candidates,
    detail: `${failed.length} of ${boards.length} boards failed`,
    failedBoards: failed.sort(),
  };
}
