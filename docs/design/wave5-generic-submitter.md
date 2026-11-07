# Wave 5: the generic form submitter, the per-company cap and the title pre-filter

Why: the first real run (2026-11-07, docs/design/live-loop-fixes.md) judged well and then parked
both applications with `browser-error`: the three vendor adapters wait for selectors copied from
old saved pages, and today's Greenhouse (job-boards.greenhouse.io, React) and Ashby (single-page
app) forms no longer have them. Lever still matches, but ends in an hCaptcha iframe. Patching
three selector lists would break again on the next redesign. The submitter reads the page the way
a person does instead. The same run showed two ranking gaps: the judge cap took the newest 120 of
4,401 postings with no regard to relevance, and four of five approved postings were at one company.

Ground truth captured on 2026-11-07 (apps/worker/test/fixtures/forms/real/): the rendered HTML
with scripts, styles, iframes and SVG removed, plus Playwright aria snapshots, of
`greenhouse-jobboards` (Anthropic, Staff+ Software Engineer STEM), `ashby` (OpenAI, Founding Full
Stack Engineer, /application tab) and `lever` (Palantir, Administrative Business Partner, /apply).
The old fixtures under forms/{greenhouse,ashby,lever} stay: the demo tenant's forms server serves
them and the generic path must still complete them.

## Part A: the generic submitter (apps/worker/src/submission/adapters)

Purpose: one page layer that finds, reads and fills application questions on any hosted ATS form
from the accessibility semantics of the page; vendor files shrink to hints (hosts, apply URL,
confirmation, account pages). Everything above the page layer (classification, answers, never-
invent, self-identification skip, form_answers, CAPTCHA chain, Gmail confirmation) is unchanged.

Inputs: a Playwright page on the apply URL; the vendor hints; the resolved `FieldValues` by
question id. Output: `FieldDescriptor[]` from `fields(page)`, the filled page, a submit outcome.

Rules:
1. Form root. The root is the nearest common ancestor of the resume file input (or, without one,
   the first visible text input) and the submit button (rule 12); if either is missing, the first
   `form` element containing a visible control; otherwise `body`. Controls outside the root
   (site search, cookie banners, headers) are never questions.
2. Controls. A question's control is any visible element inside the root that is: `input` (not
   hidden, submit, button, reset, image), `select`, `textarea`, `[role=combobox]`,
   `[role=listbox]`, `[role=radio]`, `[role=checkbox]`, `[role=switch]`, or a `button` carrying
   `aria-pressed` or `data-option` (Ashby Yes/No). File inputs count even when visually hidden.
   `[contenteditable]` is a `textarea`. Controls inside a CAPTCHA widget, an account form, a
   header, or `aria-hidden="true"` are skipped.
3. Question box. Each control belongs to the nearest ancestor that contains its label (rule 4)
   and no other question's label; radio inputs, checkbox inputs, `[role=radio]`,
   `[role=checkbox]` and pressed-buttons that share a `name`, or share a box with one label, form
   ONE question whose options are the controls' own labels (rule 5). Everything else is one
   question per control. Question id: `name` for groups; else `id`; else `name`; else a stable
   path (`q<index>` by document order) that `fill` resolves the same way.
4. Label text, first that yields non-empty text: `label[for=id]`; `aria-labelledby` targets;
   `aria-label`; the `legend` or heading (`h1`-`h6`, `[role=heading]`) that is the box's first
   text; a `label` wrapping the control; `placeholder`. The text is normalised (whitespace
   collapsed) with a trailing `*`, `✱`, `(required)` or `(optional)` removed; option labels are
   never used as the question label.
5. Option labels: the control's own `label[for]`, wrapping `label`, `aria-label`, or text content
   (buttons). Native `select` options come from `option` elements with a non-empty value.
   Combobox options (rule 7) are read by opening the control.
6. Required: `required`, `aria-required="true"`, a trailing `*`/`✱` in the label text (before
   normalisation), a class containing `required` on the label or box, or a hidden `input[required]`
   twin inside the box (react-select). Groups are required when any member or the box is.
7. Kinds and how each is filled:
   - `text`, `number`, `email`, `tel`, `url`: `fill`. A `tel` inside an international phone
     widget (ancestor class contains `iti`, or a country `button` precedes it) receives the
     national digits after the widget's country is set to the profile's country when derivable,
     else the number as given.
   - `textarea` (and contenteditable): `fill`.
   - `select` (native): `selectOption` by label, then by value.
   - `combobox` (`[role=combobox]`, or `input[aria-autocomplete=list]`, `aria-haspopup=listbox`):
     click, wait up to 2 s for `[role=option]` (or `[id^="react-select-<id>-option"]`), read
     the options once at scan time (bounded: a list of more than 60 options is recorded with
     `options` omitted and `hint` `large-list`), choose the option whose normalised text equals
     the value (then one that starts with it), press Escape when nothing matched. An autocomplete
     with no preloaded options (Ashby location) is typed into, then the first option whose text
     contains the typed value is chosen; none within 3 s leaves the typed text.
   - `yesno` (two pressed-buttons with `data-option` yes/no, or texts Yes/No): click the one
     whose option matches the boolean or Yes/No value; options reported as `['Yes','No']` so the
     existing yes/no mapping applies.
   - `radio`, `checkbox-group`: check by option label (exact, case-insensitive), as today.
   - `checkbox` (single): set to the boolean.
   - `date` (`type=date`, or a text input whose class or placeholder contains `date`): type the
     value in the widget's placeholder format when it shows one (`MM/DD/YYYY` default), press
     Escape to close any picker.
   - `file`: never filled here; the resume goes through `attachResume` (rule 11).
   An unrecognised control kind is reported as `text` with `hint` `unknown-control`; if its
   question is required and the fill does not stick (rule 9), it is an `unmapped-field`.
8. Classification is unchanged (`classifyField`): the `hint` carries the section heading text,
   section/box class names and the control name/id, so the EEOC blocks of all three vendors
   (`eeoc__question__wrapper`, the Ashby "U.S. EQUAL EMPLOYMENT OPPORTUNITY INFORMATION" section
   header, Lever `eeo[...]` names) classify as self-identification and are never filled.
9. Fill verification. After filling, the page is rescanned and each filled question's current
   value is compared with the intended one (text equality, option selected, button pressed,
   checkbox state). A required question whose value did not stick is an `unmapped-field` with
   the screenshot, before submit, never after.
10. Submit button: inside the root, `button[type=submit]` or `input[type=submit]`, else a `button`
    whose text matches `/^(submit( application)?|apply( now)?|send application)$/i`. Clicking a
    submit that is `disabled` or `aria-disabled="true"` after fill is an `unmapped-field` outcome
    naming `submit`, with screenshot.
11. Resume input: a file input whose label, name, id or `accept` suggests a resume
    (`resume|cv|curriculum`), else the first file input in the root. Setting files on a visually
    hidden input is fine; a drop-zone with no input is `unmapped-field: resume`.
12. Confirmation, first within 10 s after submit: the vendor hint (selector or URL), else the
    root disappears or is replaced by text matching
    `/thank you for (applying|your application)|application (has been |was )?(submitted|received)|we('ve| have) received your application/i`,
    else a visible validation error (`[aria-invalid=true]`, `[role=alert]`, a class containing
    `error` with text) → outcome `form-rejected` with the error texts (pending reason, screenshot,
    no retry on this attempt), else a CAPTCHA (rule 13), else `unconfirmed` and the existing Gmail
    confirmation wait.
13. CAPTCHA detection adds iframe challenges: an `iframe[src*=hcaptcha]`, `iframe[src*=recaptcha]`
    whose frame is visible with size > 0 (a challenge, not the badge), or `[data-sitekey]` with a
    visible box. These have no image to solve, so the chain skips the two agent stages and goes
    straight to the human stage with a full-page screenshot (the existing human email); the
    text-and-image widget path is unchanged. An invisible reCAPTCHA badge alone is not a CAPTCHA.
14. Vendor hints (`VendorHints`): `ats`, `hosts`, `applyUrl`, `confirmation` (selector/url),
    `account` (Greenhouse account pages, unchanged), and `resumeInput` as an optional override.
    No scan selectors remain in vendor files. `selectAdapter` keeps routing by host and the demo
    forms origin; an unknown host is still `unsupported-ats` (changing `AtsId` is out of scope).
15. Ashby application limits: a visible callout containing `/may not apply more than (\d+) times
    in any (\d+) day/i` is recorded in the activity entry `form-notice` with the numbers; it does
    not stop the submission (the per-company cap in Part B is the control).

Edge cases: a form with no resume field (proceeds, `no-resume-field`); a combobox whose menu
renders in a portal outside the root (options are read document-wide by the `react-select-<id>`
prefix or `[role=listbox]` that appeared after the click); a label with an asterisk inside a
`span[aria-hidden]` (still required); two questions sharing one label element (second gets its
own `aria-label`/placeholder or `q<index>`); a Greenhouse "Country" combobox with 240 options
(`large-list`, standard `location`: filled only when the profile country is derivable, else blank
when optional, `unmapped-field` when required).

Failure handling: unchanged outcomes (`unmapped-field`, `unanswerable-question`,
`missing-profile-field`, `browser-error`, `captcha-*`, `unconfirmed`) plus `form-rejected`.
Every park stores a full-page screenshot as today.

Tests:
- Scan the three real static fixtures and assert the exact question list (label, kind, required,
  options for native/group controls, classification): Greenhouse 33 controls → 24 questions incl.
  3 self-identification; Ashby 25 controls → 11 questions incl. 3 yes/no, 2 self-identification
  radio groups, 1 consent checkbox group; Lever → the language checkbox group as ONE question,
  the consent radio, 2 native selects. (Numbers are to be confirmed by the agent against the
  fixture and recorded in the test names.)
- Interactive synthetic fixtures (small HTML+JS under forms/_shared or forms/generic): a
  react-select-like combobox with a portal menu; an Ashby-like yes/no button pair; an
  autocomplete that filters on typing; a date input with a picker; an intl phone widget;
  hidden file input with a drop-zone. One Playwright test per kind fills and verifies (rule 9).
- The old demo fixtures (forms/greenhouse, ashby, lever) still complete end to end through the
  generic path (existing adapters.test.ts and e2e.test.ts stay green).
- Required detection: asterisk in aria-hidden span; class `_required_`; hidden required twin.
- Submit disabled after fill → unmapped-field `submit`; validation error after submit →
  `form-rejected`; iframe hCaptcha → human stage with screenshot, no agent attempts.
- Confirmation by text; confirmation by vendor URL.

Out of scope: a model-driven action planner for unknown controls (the `unknown-control` hint and
the screenshot are the hand-off for a later wave); new `AtsId` values; Ashby autofill-from-
resume; candidate accounts beyond Greenhouse's existing pages.

## Part B: ranking (apps/worker/src/discovery)

16. Per-company cap. `selectTopN` becomes `selectWithCompanyCap(ranked, target, cap)` with
    `MAX_PER_COMPANY_PER_RUN` (env, default 1, integer >= 1, invalid → default with one warning):
    walking the ranked list, a candidate whose company (by `companyId`, else normalised
    `companyName`) already has `cap` selections is skipped with `exclusionReason` `company_cap`
    (new value; the run view label is "Another role at this company was chosen") and the walk
    continues until `target` are selected or the list ends. `counts.over_target` counts the rest
    as before; `counts.company_cap` is added. The identity `approved - deadline_passed =
    selected + over_target + company_cap` holds.
17. Title pre-filter before the judge cap (replaces rule 5 ordering of live-loop-fixes.md): each
    candidate gets a local relevance score, no model: +3 for each target title or target role
    (preferences.target_titles ∪ survey.target_roles) whose significant words (length ≥ 3,
    minus stop words `engineer, senior, staff, lead, principal, software, the, and, of`) all appear
    in the posting title; +1 for each such word that appears in the title; +1 for each profile
    skill name appearing in the title or the first 2,000 characters of the description (max +5).
    Order: seeded first, then score desc, then `postedAt` desc (null last), then source order.
    The first `judgeCap` are judged. A candidate with score 0 is still eligible when the cap
    allows.
18. `counts.prefilter_zero` records how many candidates under the cap had score 0 (visibility
    only). docs/daily-run.md documents 16-18.

Tests: cap 1 with four roles at one company and one elsewhere, target 2 → one of each,
`company_cap` 3; cap 2; invalid env; score ordering with a target title "Staff Software Engineer"
vs an unrelated "Account Manager" posted later; skills match in description; counts identity.

## Decision log

- 2026-11-07: generic submitter over per-vendor selectors (Andre: "the submitter should be able
  to dynamically handle these form differences"). Vendor files keep only hints.
- 2026-11-07: one application per company per run by default; the Ashby notice (5 per 180 days)
  is recorded, not enforced, this wave.
- 2026-11-07: relevance pre-filter is local and deterministic; a model pre-filter is a later
  option if the local score proves too blunt.
- 2026-11-07 (Part B interpretation, accepted): a target title made only of stop words ("Staff
  Software Engineer") falls back to all its words of three or more letters, otherwise rule 17
  could never match the most common titles. Word matching is whole-token. Targets present in
  both lists should score once (fix pass).

## Found by the live scan (2026-11-07, read-only scan of the three real forms)

The generic submitter found 25, 16 and 22 questions on the live Anthropic (Greenhouse), OpenAI
(Ashby) and Palantir (Lever) forms with correct labels, kinds, required flags, self-identification
groups and the Ashby limit notice. One defect:

19. Page settled before any scan. A React page (Greenhouse job-boards) is visible before it is
    interactive: scanning or clicking before hydration does nothing and the next render replaces
    the stamped elements (every Greenhouse combobox read as `text` with no options, two seconds
    each). After `load` finds the root, the adapter waits for `networkidle` (bounded, 8 s) and
    then for DOM stability: a scan's stamped elements must all still be attached 500 ms later,
    rescanning until they are (bounded, 10 s). Every later `scanPage` call that finds a stamped
    element missing rescans once before acting. With the wait in place the live Greenhouse
    comboboxes open on click and report their options (244 countries → `large-list`; Yes/No pairs;
    one-option agreements).
20. Native selects obey the same 60-option bound as comboboxes (Lever's 3,300-university select
    must not reach the answer prompt). A `large-list` question with a profile-derived or
    model-generated text value is filled by typing into the control (combobox) or by choosing the
    option whose normalised text contains the value (native select); a required one with no match
    is `unmapped-field`.
21. `PendingReason` in packages/shared gains `form-rejected`; `located` joins the standard location
    pattern ("Where are you currently located?").

## Codex review of wave 5 (read-only, 2026-11-07)

21 findings, all accepted; none dropped. The fix pass implements each as stated, plus rules 19-21 above.

- [P1] Require confirmation evidence tied to the submitted form — apps/worker/src/submission/adapters/scan-script.ts:661-666
  The thank-you regex searches the entire body, while `controlsLeft` only checks visible native controls in the stamped root. A page containing boilerplate such as “after your application has been received” becomes confirmed when the form temporarily hides during submission, even if the server subsequently rejects it. Role-only controls are also excluded. `confirmed()` consequently permits a false `applied` outcome without actual submission confirmation.

- [P1] Preserve anonymous question identities across rescans — apps/worker/src/submission/adapters/scan-script.ts:599-605
  If uploading the resume or answering a question inserts an anonymous control before existing anonymous controls, their `q<index>` IDs shift. Previously resolved `FieldValues` then address different questions during `fillPage` or its retry. Because verification also resolves by ID first, this can type a truthful answer into the wrong control instead of reporting an unmapped field.
- [P1] Associate each combobox value with its own control — apps/worker/src/submission/adapters/scan-script.ts:392-394
  When an external label makes `box` a common ancestor of multiple questions, this returns the first combobox's selected value rather than this question's value. An empty required combobox can therefore pass verification when another combobox has the intended text, or a correctly filled combobox can fail because its neighbor differs. The selected-value lookup needs control-specific ownership.
- [P1] Distinguish combobox search text from a committed selection — apps/worker/src/submission/adapters/scan-script.ts:395-396
  For a select-style combobox whose options fail to load, `fillCombobox` takes the autocomplete fallback and leaves the intended text in the search input. This fallback reports that text as the current value, so `stuck()` accepts it even though no option was selected and the hidden required backing input remains empty. Preserve the distinction between a free-text autocomplete and a required option selection when verifying.
- [P1] Retain section IDs in the classification context — apps/worker/src/submission/adapters/scan-script.ts:406-409
  The previous scanner included the section ID, but this replacement collects only classes and heading text. A section identified by `id="eeoc_fields"` loses its self-identification signal when its heading does not match `SELF_ID_SECTION`. Questions without an independently recognized demographic label, such as pronouns, can then be classified as ordinary questions and filled, violating the existing self-identification skip behavior.
- [P2] Audit required questions from the final scan — apps/worker/src/submission/adapters/generic.ts:711-716
  Verification only checks the original fill plan and filters failures using each question's original `required` flag. If an answer reveals another required field, or changes an optional question to required, the final scan can contain an empty required question without producing an unmapped-field failure. Audit the current required questions before allowing submission, excluding the intentionally skipped categories.
- [P2] Reject unmatched checkbox-group answers during verification — apps/worker/src/submission/adapters/generic.ts:554-561
  The expected selection is computed by discarding intended values that do not match current members. If every intended option is missing or renamed, filling unchecks everything and verification compares two empty sets successfully. A required checkbox group is then submitted empty rather than reported as unmapped. Verify that the intended options were actually resolved before comparing checked state.
- [P2] Reject truncated values during fill verification — apps/worker/src/submission/adapters/generic.ts:578-586
  These comparisons accept incorrect partial values: a current combobox value of “United States” verifies an intended “United States Minor Outlying Islands”, and a one-digit phone value verifies any intended number ending in that digit. A widget that truncates or rejects most of an answer can therefore pass verification and submit incorrect data. Compare the actual chosen option and the complete expected phone digits after only the known dial-code transformation.
- [P2] Recognize completed CAPTCHAs whose widgets remain visible — apps/worker/src/submission/adapters/scan-script.ts:694-702
  A solved checkbox reCAPTCHA or hCaptcha normally retains its visible iframe and site-key container. Presence alone therefore continues to report an active challenge after successful completion, and the frame handle's `cleared()` never succeeds. Check completion evidence, such as the response token or subsequent confirmation, rather than requiring the provider to remove its widget.
- [P2] Wait for options when expansion state is on the wrapper — apps/worker/src/submission/adapters/generic.ts:206-209
  For a wrapper with `role="combobox"` and `aria-expanded`, `q.typeRef` points to its inner input, which need not carry `aria-expanded`. The collector consequently reports `expanded: false` and stops after roughly 400 ms instead of allowing the configured two seconds. A portal menu appearing after 600 ms is missed, causing incorrect descriptors or failed required selections.
- [P2] Wait for matching results after filtering a combobox — apps/worker/src/submission/adapters/generic.ts:382-387
  When typing triggers asynchronous filtering, the previous options commonly remain mounted until the response arrives. `collectOptions` immediately returns those stale nonempty rows, so this branch fails to find the requested option and clears the search before the filtered result can arrive. Wait for a matching or refreshed result within the timeout instead of treating any existing rows as the completed response.
- [P2] Scope portal options to the active combobox — apps/worker/src/submission/adapters/scan-script.ts:742-746
  This collects every newly visible option in the document, regardless of which control owns it. If a previous autocomplete's delayed results arrive while the next combobox opens, its options are included and `pickOption` can click a result belonging to the previous question. Resolve the active menu through control ownership or its associated listbox instead of using document-wide option appearance as ownership.
- [P2] Derive the React Select option prefix from its input ID — apps/worker/src/submission/adapters/generic.ts:195-197
  A normal React Select input ID is `react-select-2-input`, while its options use `react-select-2-option-*`. Using the whole question ID here produces `react-select-react-select-2-input-option`, which cannot match those options. The promised ID-based fallback therefore fails for menus without explicit `role="option"` elements.
- [P2] Verify native selects against their selected value too — apps/worker/src/submission/adapters/generic.ts:568-574
  `nativeSelect` explicitly supports selecting by value, but the scanner records only the selected option's label and this verifier compares that label with the intended value. Selecting value `us` with label “United States” succeeds and then incorrectly becomes an unmapped-field failure for a required select. Retain and compare the selected value as well as its label.
- [P2] Read pressed-button checkbox state from ARIA — apps/worker/src/submission/adapters/scan-script.ts:375-376
  A standalone `button[aria-pressed]` becomes a checkbox question, but buttons have a truthy `type` property. This therefore reads their nonexistent `checked` property and always reports false, even after a successful click. Required true answers cannot pass verification; the custom-control fallback also needs to recognize `aria-pressed` when deciding whether to toggle.
- [P2] Detect hidden required twins without requiring ARIA attributes — apps/worker/src/submission/adapters/scan-script.ts:545-549
  A required backing input hidden by `type="hidden"`, the `hidden` attribute, or CSS is ignored unless it also has `aria-hidden="true"` or `tabindex="-1"`. A custom select relying on such a twin is consequently reported optional, allowing it to remain unanswered. Include actual hidden-state detection rather than limiting this rule to two accessibility attributes.
- [P2] Report validation errors that persist through submission — apps/worker/src/submission/adapters/common.ts:374-379
  Validation errors can appear during filling or blur and remain unchanged when submission is rejected. Removing every error already present before the click suppresses that rejection, so the job waits for Gmail and records `unconfirmed` instead of promptly parking as `form-rejected`. A still-visible validation error should not be excluded merely because it appeared before the submit click.
- [P2] Detect error classes with camel-case prefixes — apps/worker/src/submission/adapters/scan-script.ts:684-689
  Although the selector finds any class containing `error`, this additional regex rejects classes such as `fieldError` or `validationError`. A visible validation message using those classes and no alert role or `aria-invalid` is therefore missed, producing an unconfirmed submission rather than `form-rejected`. Match the specified class substring consistently.
- [P2] Preserve non-Latin company names in cap keys — apps/worker/src/discovery/rank.ts:59-62
  For candidates without `companyId`, distinct company names composed of non-Latin characters all normalize to `name:`. Selecting one then excludes unrelated companies under the default cap, potentially leaving the daily target unfilled. Normalize punctuation and whitespace without discarding Unicode letters and numbers.
- [P2] Normalize target titles before deduplicating their scores — apps/worker/src/discovery/rank.ts:128-132
  Matching lowercases target words, but target deduplication only trims the original strings. If preferences contain “Backend Engineer” and the survey contains “backend engineer”, the same semantic target awards both bonuses twice. This distorts the relevance ordering before the judge cap; deduplicate using the same case normalization used for matching.
- [P2] Make the frame-CAPTCHA test model the real no-op entry — apps/worker/test/submission/generic-job.test.ts:95-97
  Adding `challenge: 'frame'` to `FakeCaptcha` leaves its answer-solving `enter()` behavior intact, whereas the real frame handle's `enter()` does nothing. The test therefore reaches `applied` through a capability the production implementation does not have. Use frame-accurate entry and clearing behavior, and test external clearance separately from a human text answer.
codex exit 0

## Found by the first real submissions (2026-11-07, evening)

Six submissions (three vendors) loaded, scanned and tailored, then all parked at the answer step,
before any value was typed. Causes and rules:

22. Question descriptions. The scanner records each question's description: the text of
    `aria-describedby` targets, a sibling element whose class contains `description`, `help` or
    `hint`, or the box's text between the label and the control (bounded, 1,000 chars).
    `FieldDescriptor.description` carries it, `form_answers` keeps keying by the label, and the
    answer prompt receives it in `<question>` as `description`. (Anthropic's "AI Policy for
    Application" was sent to the model as the bare label.)
23. Earliest start date. `standard_answers.earliest_start_date` (ISO date, nullable) joins the
    profile, editable on the review page next to the start-date text. A `start_date` question
    whose kind is `date` resolves from it (typed in the picker's placeholder format, default
    `MM/DD/YYYY`, then Escape); a text start question keeps the text. Null on a required date
    question parks as `missing-profile-field` naming `standard_answers.earliest_start_date`.
24. Decision for Andre, not a rule: a question that asks the candidate to confirm an employer's
    policy on AI use in the application (Anthropic's AI partnership guidelines) is answered by the
    human, never by the agent; the park (`unanswerable-question`) stays. Recorded as open.

Andre's decisions (2026-11-07, evening), replacing 23 and 24 above:
23b. Earliest start date is derived, never parked: `earliest_start_date` when set; else parsed
    from `standard_answers.start_date` text ("within N days/weeks" → today + N; "immediately",
    "asap", "now" → today + 14 days; "N weeks/months notice" or `notice_period` → today + that);
    else today + 30 days. Weekends roll forward to Monday. The derived value is recorded in
    `form_answers` like any answer.
24b. The agent confirms an employer's AI-use policy question. Rule 10 (consent) widens: a label or
    description that asks to review, read, understand or confirm an AI policy, AI guidelines or
    AI partnership guidelines (Anthropic's "AI Policy for Application": "confirm your
    understanding by selecting Yes") resolves to the affirmative like any acknowledgement; the
    description is part of the match now that rule 22 captures it.
25. Take-home exercises (a required URL/file for an exercise, assignment, case study or work
    sample) stay parked as `unanswerable-question`; out of scope for now.

## Found by the third real submission round (2026-11-07, evening)

AI policy and start date passed. Parks: four Anthropic forms on "Have you ever interviewed at
Anthropic before?", two OpenAI forms on "Are you authorized to work in the country where the job
is located?" (the profile's `work_authorization` is null: Andre fills it on the review page), one
Warp form on "Do you have permanent authorization to work for Warp in the U.S. or Canada?"
(phrasing not matched by the work-authorization rule).

26. The work-authorization rule also matches "authori[sz]ation to work", "permanent(ly)
    authori[sz]ed", "permanent authori[sz]ation", "eligib(le|ility) to work" and "legally
    (able|allowed|entitled) to work". A null `work_authorization` keeps parking as
    `missing-profile-field` (the answer is the user's to give, never guessed).
27. Prior-contact questions resolve from facts the system holds:
    - "Have you (ever) worked (at|for) <company>" → Yes/No from `work_history` employers
      (normalised name match against the posting's company).
    - "Have you (ever|previously) interviewed (at|with) <company>" → Yes/No from a new standard
      answer `previous_interviews: string[] | null` (company names; `[]` means none; null = not
      yet answered → `missing-profile-field` naming it). Editable on the review page as a
      comma-separated list.
    - "Have you (ever|previously) applied (to|at|for) <company>" → Yes when the application
      records hold an earlier applied row for that company or `previous_interviews` names it;
      otherwise No when `previous_interviews` is set; null parks.
    The company in the question is the posting's company unless the label names another.

## Andre's policy change (2026-11-07, evening): educated guesses from the profile

"You are allowed to make educated guesses for these questions based on profile. We'll never
finish if you stop at every mildly ambiguous question." The never-invent rule still governs
facts that would be credentials (employers, titles, dates, degrees, certifications, licences,
clearances), compensation and self-identification. For everything else the agent answers with
the most likely value the profile supports, records that it guessed, and tells the user.

28. Null standard answers get an inferred default at resolve time instead of parking, recorded
    with source `inferred`:
    - `work_authorization`: from `identity.location` (a US state or city, or a US phone country
      code → "Authorized to work in the United States"; likewise UK, Canada, EU countries from
      the address); unknown country → the question's own country when it names one, else park.
    - `visa_sponsorship_required`: false when authorization was inferred for the question's
      country, else park.
    - `previous_interviews`: `[]` (none).
    - `start_date`: "Within 30 days"; `notice_period`: "2 weeks"; `earliest_start_date` derives
      from those (rule 23b).
    - `relocation` (willing_to_relocate null): No when `preferences.remote` is `remote`, else
      Yes when the posting's location is in `preferences.locations`, else No.
29. Guess mode for free-text questions. The answer prompt may answer a question about the
    candidate that the profile does not state outright when the profile makes one answer clearly
    more likely (years of experience with a listed skill, familiarity with a tool in the same
    family, team size from a highlight, "open to hybrid" from preferences). It sets
    `guessed: true` and `grounded: false` for such an answer; the retry-on-ungrounded rule does
    not fire for a guess. Guesses are never made for: credentials, licences, certifications,
    clearances, criminal history, compensation, demographics, legal attestations beyond work
    authorization, or anything the posting treats as a hard requirement with a number the
    profile contradicts. A required question with no defensible guess still parks.
30. Visibility. Every inferred or guessed answer is stored in `form_answers` as
    `{value, source: 'inferred' | 'guessed'}`, shown on the application page with the label
    "Answered by inference, correct it in your profile if wrong", and listed in the daily digest
    under "Answers we guessed today". A profile edit that fills the field stops the inference.

Decision log: 2026-11-07, educated guesses allowed (Andre); credentials, compensation and
self-identification stay hard parks.

## Found by the fourth real submission round (2026-11-07, evening)

Inferred defaults, start date and AI policy all passed. Parks: Anthropic (4) on the two
arbitration questions ("Please read the arbitration agreement below" → one option "I will read
the arbitration agreement below."; "Agreement to Arbitrate" → one option "I understand and agree
to the terms of the Agreement to Arbitrate set forth above."), OpenAI (2) on "Applicant
Arbitration Agreement Acknowledgement" (a checkbox group whose options are the acknowledgement
sentences), Warp on "permanent authorization to work for Warp in the U.S. or Canada" (the
profile implies the US; the rule required every named place), Perplexity (2) on the take-home.

31. Acknowledgement by option text. The consent rule also matches when the question's options
    (a select or radio with one option, or a checkbox group) are themselves acknowledgement
    statements: an option text with an acknowledgement verb (acknowledge, agree, accept,
    consent, certify, confirm, understand, have read, will read) and a subject (agreement, terms,
    policy, notice, conditions, arbitration, the above, the information provided). Resolution:
    a single-option select or radio takes that option; a checkbox group checks every option
    that is an acknowledgement statement; a Yes/No set takes Yes. Decision (Andre, rule 10 and
    24b rationale): the user authorised the agent to apply, and these acknowledgements are a
    condition of applying; arbitration agreements included. Recorded in form_answers with
    source `profile` like other consents.
32. Authorization for "A or B". When a work-authorization question names several places joined
    by "or" / "either" / "any of", the answer is Yes when the profile's authorization covers at
    least one of them; "and" / "both" keeps the every-place rule. Inferred authorization (rule
    28) follows the same logic.
33. A company whose postings park on a take-home exercise is reported in the digest with a
    "remove from your list" link; no automatic removal.

## Found by the dry answer-planning pass (2026-11-07, evening)

A read-only pass that loads every pending form and resolves every answer without filling: the
four Anthropic forms resolve completely. Two gaps:

34. A lone checkbox keeps its own statement. The scanner reports a single checkbox with
    `options: [<the checkbox's own label text>]` whenever that text differs from the question
    label (Ashby: question "Applicant Arbitration Agreement Acknowledgement", checkbox "I
    acknowledge that I have opened, read, and understood the Arbitration Agreement…"). Rule 31
    then applies: a lone checkbox whose single option is an acknowledgement statement resolves
    to `true`. `form_answers` records the question label as before.
35. The website rule matches only the candidate's own site: "website", "portfolio", "personal
    (site|page|url|blog)", "your blog"; never a label containing "post", "article", "paper",
    "favorite", "favourite", "read" or "recommend" (Warp: "Share your favorite blog post,
    article, or paper you've read" is free text, answered in guess mode or parked).

## Found by the first real submit clicks (2026-11-07, 19:46)

Hex (Ashby, 14 fields) and OpenAI (Ashby, 16 fields) were filled correctly end to end (resume
attached, location, date, Yes/No, arbitration boxes, EEO left blank; screenshots on file) and the
submit button was clicked. Both pages stayed on the form; no confirmation on the page and no
Gmail confirmation within 600 s → `unconfirmed`. A probe that clicks Submit on an empty Ashby
form in the worker's browser shows no validation message and no submit request, only a reCAPTCHA
Enterprise reload: the handler runs, gets a reCAPTCHA verdict and stops. The worker runs
Playwright's bundled headless shell, which reCAPTCHA Enterprise scores as a bot.

36. Submit trace. From the click until the submit window ends, the adapter records every POST
    request (host and path only, no query, headers or bodies) with its status, console errors
    (first 200 chars, sanitised), and a viewport screenshot taken 3 s after the click stored as
    `submit-<attempt>.png`. The job writes them as one `submit-trace` activity entry. Evidence,
    not a decision: `unconfirmed` stays the outcome when nothing else is detected.
37. Real browser. The worker launches Google Chrome (`channel: 'chrome'`, new headless) with a
    user agent that does not say Headless, the user's timezone and `en-US` locale, a 1280x900
    viewport and `--disable-blink-features=AutomationControlled`; the bundled Chromium remains
    the fallback when Chrome is not installed (tests, CI) and for PDF rendering. The console
    `--no-sandbox` flag is used only when the process is not root-capable; on this machine
    Chrome runs without it.
38. No blind second click. The job's "submit again when not confirmed" fallback runs only when
    the submit trace shows no POST to the vendor after the first click; otherwise a second click
    could duplicate an application that went through without a visible confirmation.

Evidence for rule 37 (probe, 2026-11-07 20:05): clicking Submit on an EMPTY OpenAI Ashby form.
Bundled headless shell: one reCAPTCHA `reload` POST, no submit request, no validation text, body
unchanged. Google Chrome (channel 'chrome', new headless, user agent without "Headless",
`--disable-blink-features=AutomationControlled`, en-US, America/Los_Angeles, 1280x900): reCAPTCHA
`reload` → `userverify` → `clr`, then `POST /api/non-user-graphql?op=ApiSubmitMultipleFormsAction`
(200) and the page's own error container "Your form needs corrections: Missing entry for required
field: Legal Name…" (class `_errorsContainer_…`, matched by the form-rejected detector). Nothing
was submitted (empty form).

39. Country from location. When a `location` question is a country list (a combobox or select
    whose options are countries, or a label that is just "Country"/"Country of residence"), the
    answer is the country derived from `identity.location` (US state abbreviations and city
    names → "United States"; the same place table as rule 28 for UK, Canada, EU countries),
    chosen among the options by normalised name ("United States" also matches "United States of
    America", "USA", "US"); a city/state question keeps the location text. No derivable country
    → blank when optional, `missing-profile-field` when required.

## Found right after the first real submit requests (2026-11-07, 20:10)

Andre sees "security code" emails from Greenhouse: the new job-boards flow verifies the
applicant's email with a one-time code after the submit click, so the two Anthropic submissions
got past reCAPTCHA and are sitting on a code prompt that the post-submit wait does not recognise.

40. Post-submit email verification. During the submit window and the confirmation wait, a page
    that shows a code prompt (visible text or label matching /security code|verification code|
    one[- ]time code|code (we|that was) sent|enter the (\d-digit )?code|check your (email|inbox)/i
    together with a short text/number input) triggers the existing account-verification path:
    poll Gmail (`waitForVerification`: sender domains of the vendor and the company, messages
    received after the click, 15 s interval, 5 min cap), extract the code or follow the link,
    enter it (`enterVerificationCode`), press the prompt's continue/verify button, then resume
    the confirmation wait. Timeout → `verification-timeout` (existing reason) with screenshot.
    Activity: `email-verification` with {source: 'code' | 'link'}. The code is never stored.
