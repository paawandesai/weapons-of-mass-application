import { getProfileVersion, type TenantHandle } from '@wma/db';
import { profileDocumentSchema, type ProfileDocument } from '@wma/shared';

/** The parts of the profile a prompt needs: no contact details, no review flags. */
export function profileForPrompt(profile: ProfileDocument) {
  const {
    identity,
    work_history,
    projects,
    skills,
    education,
    preferences,
    survey,
    standard_answers,
  } = profile;
  return {
    identity,
    work_history,
    projects,
    skills,
    education,
    preferences,
    survey,
    standard_answers,
  };
}

/** The approved version's document, validated. */
export async function loadProfileDocument(
  handle: TenantHandle,
  userId: string,
  version: number,
): Promise<ProfileDocument> {
  return profileDocumentSchema.parse((await getProfileVersion(handle, userId, version)).document);
}
