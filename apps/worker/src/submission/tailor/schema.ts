import { z } from 'zod';

/** Dates in resume content: `YYYY-MM`, `YYYY`, `present`, or null when none is shown. */
const dateText = z.string().nullable();

/** What the tailoring prompt returns. Name and contact lines come from the profile, not the model. */
export const tailoredResumeSchema = z.object({
  headline: z.string().nullable(),
  summary: z.string().nullable(),
  experience: z.array(
    z.object({
      employer: z.string().min(1),
      title: z.string().min(1),
      location: z.string().nullable(),
      start_date: dateText,
      end_date: dateText,
      bullets: z.array(z.string().min(1)),
    }),
  ),
  projects: z.array(
    z.object({
      name: z.string().min(1),
      description: z.string().nullable(),
      technologies: z.array(z.string()),
    }),
  ),
  education: z.array(
    z.object({
      institution: z.string().min(1),
      degree: z.string().nullable(),
      field: z.string().nullable(),
      start_date: dateText,
      end_date: dateText,
    }),
  ),
  skills: z.array(z.string().min(1)),
  unmet_requirements: z.array(z.string().min(1)),
});
export type TailoredResume = z.infer<typeof tailoredResumeSchema>;

/** What the facts-extraction prompt returns, read from the rendered resume text. */
export const resumeFactsSchema = z.object({
  employers: z.array(z.string()),
  roles: z.array(
    z.object({
      employer: z.string(),
      title: z.string(),
      start_date: z.string().nullable(),
      end_date: z.string().nullable(),
    }),
  ),
  education: z.array(
    z.object({
      institution: z.string(),
      degree: z.string().nullable(),
      /** Additive: omitted by an older extractor means "none stated". */
      field: z.string().nullable().optional(),
    }),
  ),
  certifications: z.array(z.string()),
});
export type ResumeFacts = z.infer<typeof resumeFactsSchema>;

/** Everything the PDF template prints. */
export interface ResumeDocument {
  name: string;
  /** Contact line items in print order (email, phone, location, links). */
  contact: string[];
  content: TailoredResume;
}
