# Evals

DeepEval suites for the three LLM steps whose mistakes go out under the candidate's name. Each test runs the
real worker code (prompt, schema validation, retry and guard loops) through
`apps/worker/src/evals/bridge.ts`, then scores the result.

| Suite | Step under test | Metrics | Bar |
|---|---|---|---|
| `test_inbox.py` | `classifyMessage` (`inbox-classify`) | Compensation flag (recall), Classification, Booking link and times | binary, every case |
| `test_resume.py` | `tailorResume` (`tailor-resume` + `extract-resume-facts` check) | Resume produced, No fabrication (judge) | binary, every case |
| `test_form_answers.py` | `classifyFields` + `resolveFreeText` (`classify-form-field`, `answer-form-question`) | Self-identification left blank, Salary floor kept private, Grounded answer (judge) | binary, every case |

Every fourth inbox and resume case also runs with an injected instruction appended (`app.py`, `INJECTION`);
the expected result does not change.

## Run

```bash
pip install -r tests/evals/requirements.txt
pnpm install
export ANTHROPIC_API_KEY=...        # the app under test (Opus) and the judge (Sonnet)
deepeval test run tests/evals/test_inbox.py --num-processes 5
deepeval test run tests/evals/test_resume.py --num-processes 5
deepeval test run tests/evals/test_form_answers.py --num-processes 5
```

Run from the repo root, one suite at a time: concurrent `deepeval test run`s in the same directory share
`.deepeval/` and corrupt each other's results. A full run of all three suites costs a few dollars, mostly the
resume step on Opus.

## Datasets

`*.dataset.json` are the goldens. Each one grows from a `*.seed.json` built from the repo's own fixtures
(`apps/worker/test/fixtures/inbox`, the board fixtures, the demo catalog and labels from the submission
tests), via `python tests/evals/generate.py [inbox|resume|forms]`, which:

1. generates new cases with DeepEval's synthesizer (Claude Sonnet, evolutions off so inputs keep their format);
2. labels them with an independent spec, not the app's own prompt, so the eval is not graded against itself.

Labels are model-made. The committed datasets were reviewed by hand: 12 inbox cases were removed (candidate-sent
mail, duplicates, off-topic mail and one ambiguous daylight-saving label). If you regenerate, review again
before committing. Everything is fictional; the candidate is the fixture profile (Ada Example).

## Not covered yet

The apply decision, profile build, email-to-application matching, company list, pay-data extraction and prep
plan, and an end-to-end run of the daily loop. CAPTCHA solving is deliberately out of scope.
