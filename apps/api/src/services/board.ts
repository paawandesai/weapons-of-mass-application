import {
  listApplications,
  listCompaniesByIds,
  listJobsByIds,
  searchApplicationsByCompany,
  type ApplicationRow,
  type ApplicationStatus,
  type JobRow,
  type TenantHandle,
} from '@wma/db';

export const BOARD_COLUMNS = ['applied', 'interviewing', 'offer', 'closed'] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

/** Design rule 1: a pure mapping from status to column; pending is a badge inside Applied. */
export function columnOf(status: ApplicationStatus): BoardColumn {
  return status === 'pending' ? 'applied' : status;
}

export const SEARCH_MIN_CHARS = 2;
export const SEARCH_MAX_RESULTS = 20;

export interface BoardCard {
  id: string;
  status: ApplicationStatus;
  badge: 'pending' | null;
  company: string | null;
  title: string | null;
  location_mode: string | null;
  pay_min: number | null;
  pay_max: number | null;
  currency: string | null;
  applied_at: string | null;
  last_activity_at: string;
}

export type BoardResponse = { columns: Record<BoardColumn, BoardCard[]> };

interface Joined {
  row: ApplicationRow;
  job: JobRow | undefined;
  company: string | null;
}

/** The user's applications with their job and company name, tenant-scoped through the repos. */
async function loadJoined(handle: TenantHandle, userId: string): Promise<Joined[]> {
  const rows = await listApplications(handle, userId);
  const jobs = new Map(
    (await listJobsByIds(handle, [...new Set(rows.map((r) => r.jobId))])).map((j) => [j.id, j]),
  );
  const companyIds = [
    ...new Set([...jobs.values()].map((j) => j.companyId).filter((id): id is string => !!id)),
  ];
  const names = new Map((await listCompaniesByIds(handle, companyIds)).map((c) => [c.id, c.name]));
  return rows.map((row) => {
    const job = jobs.get(row.jobId);
    return { row, job, company: job?.companyId ? (names.get(job.companyId) ?? null) : null };
  });
}

function toCard({ row, job, company }: Joined): BoardCard {
  return {
    id: row.id,
    status: row.status,
    badge: row.status === 'pending' ? 'pending' : null,
    company,
    title: job?.title ?? null,
    location_mode: job?.locationMode ?? null,
    pay_min: job?.payMin ?? null,
    pay_max: job?.payMax ?? null,
    currency: job?.currency ?? null,
    applied_at: row.appliedAt ? row.appliedAt.toISOString() : null,
    last_activity_at: row.lastActivityAt.toISOString(),
  };
}

export async function buildBoard(handle: TenantHandle, userId: string): Promise<BoardResponse> {
  const columns: BoardResponse['columns'] = {
    applied: [],
    interviewing: [],
    offer: [],
    closed: [],
  };
  const joined = await loadJoined(handle, userId);
  joined.sort(
    (a, b) =>
      b.row.lastActivityAt.getTime() - a.row.lastActivityAt.getTime() ||
      a.row.id.localeCompare(b.row.id),
  );
  for (const j of joined) columns[columnOf(j.row.status)].push(toCard(j));
  return { columns };
}

export interface SearchResult {
  application_id: string;
  company: string;
  title: string | null;
  status: ApplicationStatus;
  column: BoardColumn;
  badge: 'pending' | null;
}

/** Case-insensitive substring match over company names of the user's own applications (max 20). */
export async function searchCompanies(
  handle: TenantHandle,
  userId: string,
  q: string,
): Promise<SearchResult[]> {
  const rows = await searchApplicationsByCompany(handle, userId, q, SEARCH_MAX_RESULTS);
  return rows.map((j): SearchResult => ({
    application_id: j.application.id,
    company: j.company,
    title: j.job.title ?? null,
    status: j.application.status,
    column: columnOf(j.application.status),
    badge: j.application.status === 'pending' ? 'pending' : null,
  }));
}
