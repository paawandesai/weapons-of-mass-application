# Success score

Purpose: one number, 0-100, for "is the product working", computed from the database by
`pnpm score`, for Andre and anyone reading the status doc. It is a trend number for this product,
not a benchmark against anyone else's.

Inputs (one tenant, one user, optional `--since` date; all from Postgres through the tenant handle):
applications (status, pending_reason, closed_reason, attempt_count, applied_at, form_answers),
interviews (confirmed_at, calendar_event_id, reply_sent_at), outgoing_messages (kind, body_text,
blocked), activity_log (`digest_flag` with kind `no_free_slot`), run_candidates (judgment,
selected), email_threads (count), llm_usage (cost_usd).

Units: counts and ratios in [0, 1]; the score is a percentage rounded to an integer; dollars from
`llm_usage.cost_usd` summed, null when the ledger is empty.

Rules:
1. Gate. The score is 0 when any invariant is violated, whatever the components say:
   a. money sent: an outgoing message that was not blocked and fails `moneyGuard.check`;
   b. self-identification filled: a `form_answers` entry whose label starts with gender, race,
      veteran status, ethnicity or disability and whose value is not null, "" or a `{skipped}`
      marker;
   c. booked without confirmation: an interview with `calendar_event_id` and no `confirmed_at`.
   Each violation is listed with its count. (Following an injected instruction has no generic
   detector; the golden set covers it with planted phrases.)
2. Components, each a ratio with a weight; the weights do not change:
   | component | numerator | denominator | weight |
   |---|---|---|---|
   | submission | applications with status applied, interviewing or offer, or `applied_at` set | applications with `attempt_count` >= 1, or `applied_at` set, or status other than pending (`attempt_count` counts failures; a clean first try has 0) | 30 |
   | discovery | would-apply labels (unmeasured) | candidates with a judgment | 20 |
   | answers | 1 - changed labels (unmeasured) | `form_answers` values with source inferred or guessed | 20 |
   | inbox | correct labels (unmeasured) | email threads | 15 |
   | scheduling | interviews with confirmed_at, calendar_event_id and reply_sent_at | interviews + `no_free_slot` digest flags | 15 |
3. A component with denominator 0 is "no data" and leaves the score. A component whose numerator
   needs a human label (discovery, answers, inbox) is "unmeasured" and leaves the score; the
   report prints the denominator as the number of items waiting for a label.
4. Score = weighted mean of the measured components with their weights renormalised to sum to 1,
   times the gate (1 or 0). Coverage = sum of measured weights / 100, printed beside the score so
   a 100 built from one component cannot pass for a 100 built from five.
5. Failure buckets. Beside the submission rate: counts of `pending_reason` and `closed_reason`
   values among the attempted applications, sorted descending. These are the backlog.
6. Cost. Confirmed applications per dollar = submission numerator / sum(cost_usd) when the sum is
   positive; otherwise "no ledger".
7. Golden set is separate: `scripts/gauntlet.sh --golden` prints employers passed of eight; the
   status line is "golden N/8, score S (coverage C)". Never averaged together (rule: the gate
   tells you the code regressed, the score tells you the product works).

Edge cases: a tenant with no applications yet scores "no data" with coverage 0 (not 0 points);
applications still pending with attempt_count 0 (never handed to the submitter, or no failure yet) are not attempts; a blocked outgoing message is not
a leak (nothing left); demo tenants are scored like any other (the CLI default is the demo user so
the command works on a fresh checkout; pass `--tenant` and `--user` for a real account).

Time: `--since YYYY-MM-DD` filters applications by created_at, interviews by created_at, outgoing
and activity by created_at/at, candidates by their run's started_at, usage by at; UTC.

Failure handling: a missing table or column fails the whole command (it is a report; a partial
report is worse than none). Read-only.

Outputs: a text report (gate line with violations, one line per component with ratio and
numerator/denominator or "unmeasured (N waiting)", failure buckets, cost line, score and coverage).
Exit code 0 always (it is a report, not a gate); `--json` prints the computed object.

Tests: gate each of a, b, c zeroes the score; blocked message is not a leak; skipped self-ID is not
filled; submission ratio and buckets; scheduling with no_free_slot in the denominator; unmeasured
components leave the score and renormalise weights (one measured component at 1.0 gives 100 with
coverage 0.30); no-data coverage 0 and score null; cost line with and without ledger; rounding.

Out of scope: the three human labels (a later labelling page), per-ATS breakdowns, the golden set.
