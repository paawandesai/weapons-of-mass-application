import {
  activity,
  finishProfileBuild,
  getLatestProfile,
  getUserById,
  insertProfileVersion,
  lockRunningBuild,
  lockUserForProfileWrite,
  NotFoundError,
  type TenantHandle,
} from '@wma/db';
import {
  profileModelOutputSchema,
  type ProfileDocument,
  type ProfileFlag,
  type ProfileModelOutput,
} from '@wma/shared';
import { loadPrompt, type StructuredLlm } from '@wma/llm';
import { gatherBundle, type DrivePort } from './bundle';
import { postValidate } from './postvalidate';
import { BuildError, BuildSupersededError, type SourceBundle } from './types';

export const PROMPT_ID = 'profile-build/v1';

export interface BuildDeps {
  llm: StructuredLlm;
  drive?: DrivePort;
}

export interface BuildResult {
  version: number;
  flags: ProfileFlag[];
  sources: string[];
}

const esc = (s: string) => s.replace(/<\/source>/gi, '<\\/source>');

export function renderUserMessage(bundle: SourceBundle): string {
  const blocks = bundle.sources
    .filter((s) => s.text.trim() !== '')
    .map((s) => `<source id="${s.id}" kind="${s.kind}">\n${esc(s.text)}\n</source>`);
  return `Account email: ${bundle.accountEmail}\n\n${blocks.join('\n\n')}`;
}

const URL_FIELDS = ['linkedin_url', 'github_url', 'website_url'] as const;

/**
 * Light cleanup of known model habits before validation: empty strings in contact fields mean
 * "absent", a link written without a scheme gets https://, and an end date written as "Present"
 * means current (null). Nothing is added that the model did not say.
 */
export function normalizeModelOutput(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const out = { ...(raw as Record<string, unknown>) };
  const contact = out.contact;
  if (contact && typeof contact === 'object') {
    const c = { ...(contact as Record<string, unknown>) };
    for (const k of ['phone', ...URL_FIELDS]) {
      if (typeof c[k] === 'string' && (c[k] as string).trim() === '') c[k] = null;
    }
    for (const k of URL_FIELDS) {
      const v = c[k];
      if (typeof v === 'string' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(v))
        c[k] = `https://${v.trim()}`;
    }
    out.contact = c;
  }
  for (const section of ['work_history', 'projects', 'education'] as const) {
    const entries = out[section];
    if (!Array.isArray(entries)) continue;
    out[section] = entries.map((e) => {
      if (!e || typeof e !== 'object') return e;
      const entry = { ...(e as Record<string, unknown>) };
      for (const k of ['start_date', 'end_date']) {
        const v = entry[k];
        if (typeof v === 'string' && /^\s*(|present|current|now|ongoing|today)\s*$/i.test(v))
          entry[k] = null;
      }
      return entry;
    });
  }
  return out;
}

/** Rule 1: structured output, validated against the schema; one retry, then fail. */
async function callModel(llm: StructuredLlm, bundle: SourceBundle): Promise<ProfileModelOutput> {
  const system = loadPrompt('profile-build', 'v1');
  const user = renderUserMessage(bundle);
  let lastIssue = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    let response;
    try {
      response = await llm.generateStructured({
        prompt: PROMPT_ID,
        system,
        user:
          attempt === 0
            ? user
            : `${user}\n\nYour previous reply was rejected: ${lastIssue}. Reply again with a valid object.`,
        schema: profileModelOutputSchema,
      });
    } catch (e) {
      throw new BuildError('profile_build_llm_error', (e as Error).message);
    }
    const parsed = profileModelOutputSchema.safeParse(normalizeModelOutput(response.output));
    if (parsed.success) return parsed.data;
    lastIssue = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
  }
  throw new BuildError('profile_build_invalid_output', lastIssue);
}

/** Carries the user-authored sections over from the latest version, or starts from defaults. */
async function carriedSections(
  handle: TenantHandle,
  userId: string,
): Promise<Pick<ProfileDocument, 'preferences' | 'survey' | 'standard_answers'>> {
  try {
    const latest = await getLatestProfile(handle, userId);
    const d = latest.document as ProfileDocument;
    return { preferences: d.preferences, survey: d.survey, standard_answers: d.standard_answers };
  } catch (e) {
    if (!(e instanceof NotFoundError)) throw e;
    const user = await getUserById(handle, userId);
    return {
      preferences: { target_titles: [], locations: [], remote: 'any' },
      survey: {
        target_roles: [],
        salary_floor: null,
        work_life_balance: null,
        family_constraints: null,
        willing_to_relocate: null,
        career_direction: null,
        daily_target: user.dailyTarget,
      },
      standard_answers: {
        work_authorization: null,
        visa_sponsorship_required: null,
        start_date: null,
        earliest_start_date: null,
        notice_period: null,
        reasons_for_change: null,
      },
    };
  }
}

export interface RunOptions {
  /**
   * The profile_builds row this run belongs to. When given, publishing is fenced on that row still
   * being `running`, and the build's terminal status and `profile_built` activity entry are
   * committed in the same transaction as the profile version.
   */
  buildId?: string;
}

/**
 * Builds a new, unapproved profile version. Never touches the approved version. Throws
 * BuildError with a reason code for the whole-build failures (no resume, invalid output) and
 * BuildSupersededError when the build row is no longer the user's running build.
 *
 * Everything slow (sources, model, post-validation) happens before one short transaction that
 * locks the user, re-reads the user-authored sections, inserts the version and records the outcome,
 * so a survey save or edit cannot slip in between and be overwritten.
 */
export async function runProfileBuild(
  handle: TenantHandle,
  userId: string,
  deps: BuildDeps,
  opts: RunOptions = {},
): Promise<BuildResult> {
  const bundle = await gatherBundle(handle, userId, { drive: deps.drive });
  const resume = bundle.sources.find((s) => s.kind === 'resume');
  if (!resume || resume.text.trim() === '') throw new BuildError('profile_build_no_resume');

  const model = await callModel(deps.llm, bundle);
  const { output, flags } = postValidate(model, bundle);
  const sources = bundle.sources.filter((s) => s.text.trim() !== '').map((s) => s.id);

  return handle.transaction(async (h) => {
    await lockUserForProfileWrite(h, userId);
    if (opts.buildId && !(await lockRunningBuild(h, opts.buildId)))
      throw new BuildSupersededError(opts.buildId);
    const carried = await carriedSections(h, userId);
    const document: ProfileDocument = { ...output, ...carried, flags };
    const row = await insertProfileVersion(h, { userId, document, builtFrom: sources });
    if (opts.buildId) {
      const finished = await finishProfileBuild(h, opts.buildId, {
        state: 'done',
        version: row.version,
      });
      if (!finished) throw new BuildSupersededError(opts.buildId);
      await activity.logActivity(h, {
        userId,
        actor: 'agent',
        action: 'profile_built',
        detail: { version: row.version, sources, flag_count: flags.length },
      });
    }
    return { version: row.version, flags, sources };
  });
}
