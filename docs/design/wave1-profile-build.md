# Design brief: profile build and the never-invent rule

Purpose: turn the user's connected sources into one profile document that later changes trust, without inventing employers, titles, dates, degrees or skills. Read by the review page, the decision prompt and resume tailoring.

Inputs: resume text (pdf-parse or mammoth output, UTF-8); LinkedIn public page text (may be partial or empty); GitHub REST: public repos with name, description, primary language, pushed_at; Drive: exported text of files in selected folders (max 2 MB each, max 20 files); survey answers (jsonb). Each source is tagged with a `source_id` string like `resume`, `linkedin`, `github`, `drive:<fileId>`.

Units: dates as ISO `YYYY-MM` strings, or `YYYY` when a source states only the year (day and, if unstated, month stay unknown; the model never invents them); `null` for unknown end date means current.

Rules:
1. The model call MUST use structured output against the profile zod schema; a response that fails schema validation MUST be retried once, then the build fails with `profile_build_invalid_output`.
2. Every `work_history`, `projects` and `education` entry MUST carry `sources: string[]` with at least one source_id.
3. Post-validation MUST reject any `work_history` entry whose `employer` (case-insensitive, whitespace-collapsed) does not appear as a substring in the concatenated text of its cited sources; rejected entries are dropped and a `flags[]` item `{type: "unsupported_entry", section, value}` is added.
4. Same rule as 3 for `education.institution` and `projects.name` (projects may cite github, where the repo name counts as source text).
5. Skills MUST be a subset of tokens that appear in at least one source text; unsupported skills are dropped silently (no flag), because skills lists are noisy.
6. A date conflict (same employer, overlapping ranges with different titles from different sources) MUST produce one `flags[]` item `{type: "date_conflict", ...}` and keep both entries.
7. A source that returned no text MUST produce `{type: "partial_source", source_id}` and the build continues; a build with no resume text at all MUST fail with `profile_build_no_resume`.
8. Every successful build MUST insert a new `profiles` row with `version = max(version)+1` for the user and `built_from = [source_id...]`; it MUST NOT touch `approved_profile_version`.
9. The review approve action MUST refuse while any flag of type `unsupported_entry` or `date_conflict` is unresolved (resolved = removed from `flags[]` by the user editing); `partial_source` flags do not block.
10. The build MUST write one activity log entry `profile_built` with `{version, sources, flag_count}`.

Edge cases: employer written as "Google" in resume and "Google LLC" on LinkedIn: rule 3 passes if either cited source contains the stored string, so the model should store the shorter form; a flag is acceptable if not. A gap in employment is not a flag. A resume with no dates yields entries with null dates and no flag.

Time: dates compared as `YYYY-MM`, a `YYYY` date taken as the whole year (January as a start, December as an end); overlap means start1 <= end2 and start2 <= end1 with null end = 9999-12.

Failure handling: per source (rule 7); whole-build failure only on rules 1 and 7's no-resume case. Failures write `profile_build_failed` with the reason code.

Consistency: source texts are gathered once into an in-memory bundle before the model call; the same bundle is used for post-validation.

Outputs: new `profiles` row; activity log entry; job result `{version, flags}`.

Tests: rules 1 to 10 each; the Google vs Google LLC case; null end date overlap; model fixture that invents an employer (dropped and flagged); fixture with partial LinkedIn; no-resume failure; approve refused with an unresolved flag, allowed after edit.

Out of scope: learning from outcomes, scoring, tailoring, LinkedIn login.
