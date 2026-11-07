import {
  activity,
  getUserById,
  insertProfileVersion,
  lockUserForProfileWrite,
  setDailyTarget,
  type TenantHandle,
} from '@wma/db';
import {
  profileDocumentSchema,
  type ProfileDocument,
  type SurveyAnswers,
  type SurveySubmission,
} from '@wma/shared';
import { findLatestProfile } from './review';

/** The version-1 document used when a survey is saved before any profile build. */
export function emptyDocument(
  user: { email: string; displayName: string | null },
  dailyTarget: number,
): ProfileDocument {
  return {
    identity: {
      full_name: user.displayName?.trim() || user.email.split('@')[0] || user.email,
      headline: null,
      location: null,
      summary: null,
    },
    contact: {
      email: user.email,
      phone: null,
      linkedin_url: null,
      github_url: null,
      website_url: null,
    },
    work_history: [],
    projects: [],
    skills: [],
    education: [],
    preferences: { target_titles: [], locations: [], remote: 'any' },
    survey: {
      target_roles: [],
      salary_floor: null,
      work_life_balance: null,
      family_constraints: null,
      willing_to_relocate: null,
      career_direction: null,
      daily_target: dailyTarget,
    },
    standard_answers: {
      work_authorization: null,
      visa_sponsorship_required: null,
      start_date: null,
      notice_period: null,
      reasons_for_change: null,
    },
    flags: [],
  };
}

/** The required fields are target roles and salary floor; without both the survey is not done. */
export function surveyComplete(survey: ProfileDocument['survey']): boolean {
  return survey.target_roles.length > 0 && survey.salary_floor !== null;
}

/** The completed survey answers from the latest profile version, or null. */
export async function getSurveyAnswers(
  handle: TenantHandle,
  userId: string,
): Promise<SurveyAnswers | null> {
  const row = await findLatestProfile(handle, userId);
  if (!row) return null;
  const doc = profileDocumentSchema.parse(row.document);
  if (!surveyComplete(doc.survey)) return null;
  return { ...doc.survey, locations: doc.preferences.locations, remote: doc.preferences.remote };
}

/** Writes the answers into a new profile version (version 1 with an empty document if none). */
export async function saveSurvey(
  handle: TenantHandle,
  userId: string,
  answers: SurveySubmission,
): Promise<number> {
  return handle.transaction(async (h) => {
    await lockUserForProfileWrite(h, userId);
    const user = await getUserById(h, userId);
    const previous = await findLatestProfile(h, userId);
    const base = previous
      ? profileDocumentSchema.parse(previous.document)
      : emptyDocument(user, user.dailyTarget);
    const { locations, remote, ...survey } = answers;
    const document: ProfileDocument = {
      ...base,
      survey,
      preferences: {
        target_titles: survey.target_roles,
        locations: locations ?? base.preferences.locations,
        remote: remote ?? base.preferences.remote,
      },
    };
    const row = await insertProfileVersion(h, {
      userId,
      document,
      builtFrom: previous?.builtFrom ?? [],
    });
    if (user.dailyTarget !== survey.daily_target)
      await setDailyTarget(h, userId, survey.daily_target);
    await activity.logActivity(h, {
      userId,
      actor: 'user',
      action: previous && surveyComplete(base.survey) ? 'survey_revised' : 'survey_saved',
      detail: { version: row.version },
    });
    return row.version;
  });
}
