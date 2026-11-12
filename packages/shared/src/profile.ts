import { z } from 'zod';

/**
 * A date as YYYY-MM, or YYYY when the sources only state a year (the month stays unknown rather
 * than invented), or null when unknown / ongoing.
 */
export const monthSchema = z
  .string()
  .regex(/^\d{4}(-(0[1-9]|1[0-2]))?$/, 'expected YYYY-MM or YYYY')
  .nullable();

/** Provenance: ids of the profile sources an entry was taken from. At least one is required. */
const sourcesSchema = z.array(z.string().min(1)).min(1, 'at least one source is required');

export const identitySchema = z.object({
  full_name: z.string().min(1),
  headline: z.string().nullable(),
  location: z.string().nullable(),
  summary: z.string().nullable(),
});

export const contactSchema = z.object({
  email: z.string().email(),
  phone: z.string().nullable(),
  linkedin_url: z.string().url().nullable(),
  github_url: z.string().url().nullable(),
  website_url: z.string().url().nullable(),
});

export const workHistoryEntrySchema = z.object({
  employer: z.string().min(1),
  title: z.string().min(1),
  location: z.string().nullable(),
  start_date: monthSchema,
  end_date: monthSchema,
  summary: z.string().nullable(),
  highlights: z.array(z.string()),
  sources: sourcesSchema,
});

export const projectEntrySchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable(),
  url: z.string().url().nullable(),
  technologies: z.array(z.string()),
  start_date: monthSchema,
  end_date: monthSchema,
  sources: sourcesSchema,
});

export const skillSchema = z.object({
  name: z.string().min(1),
  category: z.string().nullable(),
});

export const educationEntrySchema = z.object({
  institution: z.string().min(1),
  degree: z.string().nullable(),
  field: z.string().nullable(),
  start_date: monthSchema,
  end_date: monthSchema,
  sources: sourcesSchema,
});

/** A certification the user holds, as stated in a source. Optional in the document: older profiles have none. */
export const certificationSchema = z.object({
  name: z.string().min(1),
  issuer: z.string().nullable().optional(),
  sources: sourcesSchema,
});

/**
 * An honor or award the user holds, as stated in a source. Optional in the document: older
 * profiles have none. Form questions about honors and awards are answered from this list only.
 */
export const awardSchema = z.object({
  name: z.string().min(1),
  issuer: z.string().nullable().optional(),
  /** YYYY-MM or YYYY when known. */
  date: monthSchema.optional(),
  sources: sourcesSchema,
});

export const remotePreferenceSchema = z.enum(['remote', 'hybrid', 'onsite', 'any']);

export const preferencesSchema = z.object({
  target_titles: z.array(z.string()),
  locations: z.array(z.string()),
  remote: remotePreferenceSchema,
});

/** Daily application target: 1 to 30, default 12 (survey capability). */
export const dailyTargetSchema = z.number().int().min(1).max(30);

export const surveySchema = z.object({
  target_roles: z.array(z.string()),
  salary_floor: z.number().int().nonnegative().nullable(),
  work_life_balance: z.string().nullable(),
  family_constraints: z.string().nullable(),
  willing_to_relocate: z.boolean().nullable(),
  career_direction: z.string().nullable(),
  daily_target: dailyTargetSchema.default(12),
});

/** ISO `YYYY-MM-DD` that is also a real calendar date (no 2026-02-30). */
const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a date as YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'not a real calendar date');

export const standardAnswersSchema = z.object({
  work_authorization: z.string().nullable(),
  visa_sponsorship_required: z.boolean().nullable(),
  start_date: z.string().nullable(),
  /** ISO `YYYY-MM-DD` when set: typed into date pickers; `start_date` stays the free-text answer. */
  // Default so profile documents stored before the field existed still parse.
  earliest_start_date: isoDateSchema.nullable().default(null),
  notice_period: z.string().nullable(),
  reasons_for_change: z.string().nullable(),
  // Companies the candidate has interviewed at; [] means none, null means not yet answered.
  // Default so profile documents stored before the field existed still parse.
  previous_interviews: z.array(z.string()).nullable().default(null),
  /**
   * What to do with voluntary self-identification questions (gender, race, veteran status,
   * disability). `decline`: choose the form's decline option when it has one; the question is still
   * skipped, never guessed, when it has none. null: skip them all. Default so profile documents
   * stored before the field existed still parse.
   */
  self_identification_default: z.enum(['decline']).nullable().default(null),
  /**
   * Citizenship in the user's own words ("U.S. citizen"). Answers citizenship and "U.S. person"
   * (export control) questions, which work_authorization alone cannot. Default so older documents parse.
   */
  citizenship: z.string().nullable().default(null),
  /** The state or region the user would be on payroll in ("Texas"). Default so older documents parse. */
  payroll_state: z.string().nullable().default(null),
  /**
   * Whether an agreement with a current or former employer (non-compete, non-solicit, NDA) limits
   * where or how the user can work. true = one does. null = not answered: the question is the
   * user's to answer, never guessed. Default so older documents parse.
   */
  employer_agreements_restrict: z.boolean().nullable().default(null),
});

export const flagKindSchema = z.enum([
  'partial_source',
  'date_conflict',
  'unsupported_entry',
  'unverified_employer',
  'missing_info',
  'other',
]);

export const flagSchema = z.object({
  id: z.string().min(1),
  kind: flagKindSchema,
  /** Dotted path into the document the flag refers to, e.g. `work_history.0.start_date`. */
  path: z.string().nullable(),
  /** All entries a `date_conflict` flag refers to (both conflicting entry paths). */
  paths: z.array(z.string()).optional(),
  message: z.string().min(1),
  sources: z.array(z.string()),
  resolved: z.boolean(),
  /** Document section an `unsupported_entry` flag refers to, e.g. `work_history`. */
  section: z.string().nullable().optional(),
  /** The offending value (employer, institution or project name) that was dropped. */
  value: z.string().nullable().optional(),
});

export const profileDocumentSchema = z.object({
  identity: identitySchema,
  contact: contactSchema,
  work_history: z.array(workHistoryEntrySchema),
  projects: z.array(projectEntrySchema),
  skills: z.array(skillSchema),
  education: z.array(educationEntrySchema),
  /** Certifications the profile positively states; a resume may claim only these. */
  certifications: z.array(certificationSchema).optional(),
  /** Honors and awards the profile positively states; an answer may claim only these. */
  awards: z.array(awardSchema).optional(),
  preferences: preferencesSchema,
  survey: surveySchema,
  standard_answers: standardAnswersSchema,
  flags: z.array(flagSchema),
});

/**
 * What the model is asked to produce: the sections that come from source text. Survey,
 * preferences and standard answers come from the user; flags come from post-validation.
 */
export const profileModelOutputSchema = profileDocumentSchema.pick({
  identity: true,
  contact: true,
  work_history: true,
  projects: true,
  skills: true,
  education: true,
});

/**
 * Survey submission: target roles and salary floor are required; the daily target defaults to 12
 * and is bounded 1 to 30. Locations and remote preference land in the preferences section.
 */
export const surveySubmissionSchema = surveySchema.extend({
  target_roles: z.array(z.string().trim().min(1)).min(1, 'at least one target role is required'),
  salary_floor: z.number().int().nonnegative(),
  locations: z.array(z.string()).optional(),
  remote: remotePreferenceSchema.optional(),
});

/** Flag kinds that stop approval while unresolved (partial_source never blocks). */
export const BLOCKING_FLAG_KINDS = ['unsupported_entry', 'date_conflict'] as const;

/**
 * Blocking flags that still stand. A flag is resolved by removing it from `flags[]`, so a blocking
 * flag counts as long as it is present, whatever its `resolved` boolean says.
 */
export function unresolvedBlockingFlags(flags: ProfileFlag[]): ProfileFlag[] {
  return flags.filter((f) => (BLOCKING_FLAG_KINDS as readonly string[]).includes(f.kind));
}

export type ProfileModelOutput = z.infer<typeof profileModelOutputSchema>;
export type SurveySubmission = z.infer<typeof surveySubmissionSchema>;
export type ProfileDocument = z.infer<typeof profileDocumentSchema>;
export type WorkHistoryEntry = z.infer<typeof workHistoryEntrySchema>;
export type ProjectEntry = z.infer<typeof projectEntrySchema>;
export type Certification = z.infer<typeof certificationSchema>;
export type Award = z.infer<typeof awardSchema>;
export type EducationEntry = z.infer<typeof educationEntrySchema>;
export type ProfileFlag = z.infer<typeof flagSchema>;
export type Survey = z.infer<typeof surveySchema>;
