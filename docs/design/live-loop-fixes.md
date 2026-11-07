# Live-loop fixes (2026-11-07)

Why: the first live run of the demo tenant (fresh database, plain seed, manual trigger) did not stay
on the twelve seeded postings. The `companies` step saw no company memberships, asked the model for
a company list, resolved 49 real boards, fetched 4,148 real postings and started judging all of
them with the real model at concurrency 8. The worker was stopped by hand after four minutes. Two
rules were missing: a demo tenant must never touch live sources, and no run may judge an unbounded
number of postings.

## Rule 1: a demo tenant runs on its seeded postings only

Purpose: the demo is deterministic and free; the simulated recruiter only plays seeded postings.

1. `adaptersFor(handle)` returns exactly `[seeded]` for a tenant whose `demo` flag is true, and
   the default adapters (boards, HN, LinkedIn) otherwise. The seeded adapter is never added to a
   non-demo tenant.
2. `executeDailyRun` never calls `generateCompanyList` for a demo tenant. It writes one activity
   entry `company_list_skipped` with `detail.reason = 'demo_tenant'` instead. (The twelve seeded
   companies are the demo's company list; nothing is generated.)
3. Nothing else about the run changes for a demo tenant: judge, rank, select, hand-off and the
   fixture forms behave as before.

## Rule 2: every run judges at most `JUDGE_CAP_PER_RUN` postings

Purpose: bound the per-run model spend for every tenant. A judge call is one model call per posting.

4. `JUDGE_CAP_PER_RUN` is read by the worker (`apps/worker/src/jobs/daily-run.ts`) and passed to
   `executeDailyRun` as `deps.judgeCap`. Default 120. A value that is not an integer >= 1 falls back
   to the default and is logged once at worker start.
5. The cap applies after `dropAlreadyApplied`, before `judgeAll`. Candidates are ordered: postings
   returned by the adapter with id `seeded` first (`Candidate.source` carries the form vendor, so
   `discover` reports their dedupe keys as `seededKeys`), then newest `postedAt` first, `postedAt` null last, ties in the order the sources
   returned them (stable). The first `judgeCap` are judged.
6. Candidates beyond the cap are not judged and get no `run_candidates` row. They are counted in
   `counts.over_cap` (new key, default 0) and the run writes one activity entry `judge_capped` with
   `{run_id, cap, dropped}` only when `dropped > 0`.
7. Count arithmetic becomes: `deduped - already_applied - over_cap = judged + unjudged`. The
   existing identities for approved, selected, over_target, deadline_passed are unchanged.
8. The run view does not display the counts object (only judged, approved, selected), and over-cap
   postings have no row to label, so nothing changes in the web. `over_cap` is visible in the run
   API payload and the `run_finished` activity entry.

Edge cases: a cap larger than the candidate count changes nothing (`over_cap = 0`, no activity
entry). A demo tenant with 12 seeded postings and the default cap judges all 12.

Failure handling: unchanged; the cap is pure selection before the judge step.

Tests (one per rule line):
- `adaptersFor` demo -> `[seeded]`; non-demo -> defaults without seeded (1).
- demo run: company-list prompt never requested, `company_list_skipped` with reason `demo_tenant`,
  no boards fetched, seeded postings judged (2, 3).
- cap parsing: unset -> 120; `"abc"` and `"0"` -> 120; `"5"` -> 5 (4).
- cap 2 over 5 candidates (one seeded with old date, two dated, two undated): the seeded one and
  the newest dated one are judged; `over_cap = 3`; `judge_capped` written with `dropped: 3` (5, 6).
- counts identity holds with the cap applied (7).
- cap larger than candidates: `over_cap = 0`, no `judge_capped` entry (edge).

Out of scope: a cheap pre-filter (title or keyword match against the profile) so a real tenant
spends its cap on the most relevant postings. That is the right next step for the product and is
recorded here as open; the cap alone only bounds the spend.

## Decision log

- 2026-11-07: demo tenants use the seeded source only (rule 1). Decided by the coordinator after the
  runaway run; consistent with the wave 4 brief (the simulated recruiter plays seeded postings only).
- 2026-11-07: per-run judge cap, default 120, env-configurable (rule 2). A product decision taken
  under the standing $25 spend cap; Andre can raise it per deployment.
- Open: relevance pre-filter before the cap.

## Rule 3: three form question shapes the fixtures use parked every live application

Why: on the second live run all ten hand-offs reached the fill step and parked with
`unanswerable-question`: "Are you open to relocation?" (Lever, Yes/No radio), "I acknowledge the
privacy policy" (lone checkbox) and "Which of these have you used in production?" (Ashby checkbox
group over Kubernetes, Terraform, Postgres). Unit tests passed because the fake model answered;
the real model could not: it is shown identity, work history, projects, skills and education only,
there is no rule for relocation or consent, and the prompt says "exactly one of the options".

Purpose: the agent fills questions the profile can answer truthfully; it still parks what it cannot.

9. New standard key `relocation` (`/\brelocat/` on the normalized label), resolved from
   `survey.willing_to_relocate` as a Yes/No fact by meaning (same mapping as sponsorship). Null
   parks a required field as `missing-profile-field` naming `survey.willing_to_relocate`.
10. New standard key `consent`: a label that acknowledges, agrees to, accepts, consents to,
    certifies or confirms a privacy policy, privacy notice, terms, conditions, data processing, or
    the accuracy or truth of the application. It resolves to the affirmative: `true` for a lone
    checkbox, the Yes-like option when options exist, "Yes" for a text box. Never when the label is
    a self-identification label (rule order unchanged: self-identification first). Decision: the
    user authorised the agent to submit applications on their behalf, and the never-invent check
    makes the accuracy certification true; the answer is recorded in `form_answers` like any other.
11. The model's `<profile>` for form questions also carries `preferences` (target_titles,
    locations, remote) and `survey.willing_to_relocate`, `survey.career_direction`,
    `survey.work_life_balance`. Never `salary_floor` or `family_constraints`.
12. Prompt `answer-form-question` (edited in place at v1; nothing has shipped): for a checkbox
    group (`field_type` checkbox with options) the answer lists every option the profile supports,
    one per line, and is unanswerable only when none applies; a skill, tool or technology listed in
    the profile's skills or work history counts as used by the candidate (a profile lists what the
    person has worked with); option names are matched by meaning (Postgres = PostgreSQL), but the
    answer uses the option's exact spelling. The "exactly one option" rule now applies to select
    and radio fields only.

Edge cases: a consent label with a decline option stays self-identification (existing rule). A
relocation question with options that are not Yes/No ("Yes", "No", "Depends") maps Yes/No by
meaning; `willing_to_relocate = null` with such options parks. A checkbox group where the model
returns a single option is still valid (existing `checkGroup`).

Tests: classification of the three fixture labels (9, 10); `relocation` true/false/null against a
radio and a select (9); consent on a lone checkbox, a Yes/No select and a text box (10); a
self-identification label that also says "acknowledge" stays self-identification (10); the
`<profile>` block contains preferences and willing_to_relocate but never salary_floor or
family_constraints (11); the prompt file contains the checkbox-group sentence and the
`classify-form-field` 30-label test still passes (12).

Decision log addition: 2026-11-07, consent and accuracy acknowledgements are answered Yes by rule
(rule 10); relocation comes from the survey (rule 9); the form-question model sees preferences and
the non-financial survey answers (rule 11).

## Rule 4: the attempt claim must not conflict with foreign-key share locks

13. `lockForAttempt` claims the application row with `FOR NO KEY UPDATE ... SKIP LOCKED`. Why: the
    worker test "runs one attempt when the same application is enqueued twice at once" failed on
    three suite runs today with both callers reporting `duplicate`. The loser of the advisory lock
    writes a `duplicate_enqueue` activity entry attached to the application; the foreign-key check
    takes a `KEY SHARE` lock on the row, `FOR UPDATE` conflicts with it, and `SKIP LOCKED` made the
    winner skip its own row and return `duplicate: locked`. `FOR NO KEY UPDATE` still excludes every
    other claim and every `FOR UPDATE` elsewhere, and the attempt never changes a key column.
    The existing test is the test; the change is in `packages/db/src/repos/applications.ts`.

## Rules 5 and 6: found by the first booked interview

14. The web dev server proxies `/confirm` and `/captcha` to the API, like `/api` and `/auth`. The
    slot-offer and CAPTCHA emails link to `${WEB_ORIGIN}/confirm/<token>` and
    `${WEB_ORIGIN}/captcha/<token>`; without the proxy the browser got the SPA shell and no form.
    Any production reverse proxy must route the same four prefixes to the API (noted in
    docs/setup/local-dev.md).
15. `outputFormatFor` strips `maxItems` from the wire schema (the API answered
    `output_config.format.schema: For 'array' type, property 'maxItems' is not supported`, so the
    prep plan failed twice after the first booking). The zod schema still enforces the bound
    locally, like every other stripped keyword. Test: a schema with `.array().max(15)` produces a
    wire schema without `maxItems`.

## Codex review of the live-loop fixes (read-only, 2026-11-07)

Four findings, all accepted; none dropped.

- P2 consent too loose: "Please confirm your correct legal name" matched verb + "correct". Rule 10
  is narrowed: consent applies only to checkbox, radio and select fields (never a text box), and the
  verb must concern the subject in the same label: a privacy policy or notice, terms, conditions,
  data processing, or the accuracy or truth of *the information, answers, statements or application*
  (an accuracy word alone is not a subject).
- P2 checkbox-group prompt over-claims: a listed skill supported "used in production". Rule 12 is
  narrowed: a listed skill supports "have you used", "are you familiar with" and "which of these do
  you know"; a qualifier in the question (in production, professionally, N+ years, expert or
  advanced, at scale, led or owned) must be supported by the work history or projects explicitly,
  or that option is left out; when no option is supported the question is unanswerable.
- P2 relocation too loose: "Do you require relocation assistance?" was answered from willingness.
  Rule 9 is narrowed to willingness questions: the label must pair a relocation word with willing,
  open, able, prepared, ready, consider or a bare "Relocation?"-style label, and must not mention
  assistance, package, support, reimbursement, bonus, costs or expenses. Other relocation questions
  go to grounded free-text resolution (the model now sees willing_to_relocate under rule 11).
- P3 run-cap demo test accepts any status: assert `finished` or `short_day` and the hand-off count.

## Rule 7: the first profile build starts on its own (found by the first real sign-in)

Why: Andre signed in with Google, connected resume, LinkedIn and GitHub, saved the survey and
landed on a review page of blank fields. The survey save writes profile version 1 (survey only)
and nothing starts the build from the sources; the only trigger was the "Rebuild from sources"
button at the bottom.

16. `PUT /api/survey` saves the survey, then starts a profile build when all of: the user has a
    resume, the latest profile version was never built from sources (`built_from` empty), and no
    build is running (`requestProfileBuild` already returns the running one). The response gains
    `build_started: boolean`. The activity entry is `profile_build_requested` with
    `detail.trigger = 'survey'` (the button's entry has no trigger; leave it).
17. The review page checks the build status on load. While a build is running it shows one line,
    "Building your profile from your connected sources…", polls with the existing loop, and loads
    the result when done; a failed build shows the existing failure banner. It never shows the
    unbuilt version's blank fields while a build runs.
18. The button reads "Build from sources" when the shown version was never built from sources and
    "Rebuild from sources" otherwise. `GET /api/profile` exposes `built_from` so the page can tell.

Tests: survey save with resume and unbuilt profile starts a build (fake queue) and logs the
trigger (16); a second save while that build runs starts none (16); no resume starts none (16); a
save on a profile already built from sources starts none (16); the review page shows the building
line and then the loaded profile when status goes running → done (17); the button label for each
case (18).
