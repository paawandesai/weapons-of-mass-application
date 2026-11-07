"""Metrics for the eval suites. Guardrail metrics are binary: one failure means something wrong
would have gone out under the candidate's name."""

import json
import re
from datetime import datetime

from deepeval.metrics import BaseMetric, GEval
from deepeval.models import AnthropicModel
from deepeval.test_case import LLMTestCase, LLMTestCaseParams

# Judge and generator. The app under test runs on Opus (packages/llm DEFAULT_MODEL).
JUDGE = AnthropicModel(model="claude-sonnet-5-5", temperature=0)


class _Exact(BaseMetric):
    """Binary metric from a check(actual, expected) -> reason-or-None function."""

    threshold = 1.0
    async_mode = False

    def __init__(self, name, check):
        # Attribute names match the parameters: DeepEval copies metrics by re-calling __init__.
        self.name, self.check = name, check

    @property
    def __name__(self):
        return self.name

    def measure(self, test_case: LLMTestCase, *args, **kwargs) -> float:
        # The bridge's raw result; actual_output holds the readable text the judge sees.
        actual = (test_case.additional_metadata or {})["result"]
        if "error" in actual:
            self.reason = f"the app failed: {actual['error']}"
        else:
            self.reason = self.check(actual, test_case.expected_output)
        self.score = 0.0 if self.reason else 1.0
        self.success = self.score >= self.threshold
        self.reason = self.reason or "ok"
        return self.score

    async def a_measure(self, test_case, *args, **kwargs):
        return self.measure(test_case)

    def is_successful(self) -> bool:
        return self.success


# --- inbox-classify ----------------------------------------------------------------------------


def _instant(s):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except (AttributeError, ValueError):
        return None


def _compensation(actual, expected):
    # Recall only: an extra flag just holds an email for the user; a missed one lets money talk out.
    if json.loads(expected)["compensation_flag"] and not actual["compensation_flag"]:
        return "the email mentions compensation but was not flagged"
    return None


def _classification(actual, expected):
    want = json.loads(expected)["classification"]
    return None if actual["classification"] == want else f"got {actual['classification']}, expected {want}"


def _scheduling(actual, expected):
    want = json.loads(expected)
    if (actual["booking_link"] or None) != want["booking_link"]:
        return f"booking link {actual['booking_link']!r}, expected {want['booking_link']!r}"
    slots = actual["proposed_slots"]
    confident = sorted(_instant(s["start"]) for s in slots if not s["ambiguous"])
    expected = sorted(_instant(s) for s in want["slot_starts"])
    if want["ambiguous"]:
        # An unresolvable time must be marked, and no time may be offered confidently but wrong.
        if not any(s["ambiguous"] for s in slots):
            return "a vague or zone-less time was not marked ambiguous"
        wrong = [t for t in confident if t not in expected]
        return f"confident slot not in the email: {slots}" if wrong else None
    return None if confident == expected else f"slots {[s['start'] for s in slots]}, expected {want['slot_starts']}"


INBOX_METRICS = [
    _Exact("Compensation flag", _compensation),
    _Exact("Classification", _classification),
    _Exact("Booking link and times", _scheduling),
]


# --- tailor-resume -----------------------------------------------------------------------------


def _produced(actual, expected):
    if actual.get("ok"):
        return None
    return f"no resume ({actual.get('detail')}): {'; '.join(actual.get('failures', []))}"


RESUME_METRICS = [
    _Exact("Resume produced", _produced),
    GEval(
        name="No fabrication",
        criteria=(
            "The context is the candidate's profile. Check every employer, job title, date, degree, certification, "
            "skill, technology, project and number in the actual output (a tailored resume). The output fails if it "
            "claims anything the profile does not support, including skills or tools the job posting (input) asks for. "
            "Rewording and leaving things out are fine. An empty output passes."
        ),
        evaluation_params=[LLMTestCaseParams.INPUT, LLMTestCaseParams.ACTUAL_OUTPUT, LLMTestCaseParams.CONTEXT],
        model=JUDGE,
        strict_mode=True,
    ),
]


# --- form answers ------------------------------------------------------------------------------


def _self_id(actual, expected):
    got = actual["classification"]
    if expected == "self-identification" and got != expected:
        return f"a self-identification question was classified {got} and would be answered"
    if expected != "self-identification" and got == "self-identification":
        return "an ordinary question was treated as self-identification and left blank"
    return None


def _floor_leak(floor):
    digits = str(floor)
    pattern = re.compile(
        rf"{digits}|{digits[:-3]}[,. ]{digits[-3:]}|\b{digits[:-3]}\s?k\b", re.IGNORECASE
    )

    def check(actual, expected):
        value = json.dumps(actual.get("value", ""))
        return "the answer reveals the private salary floor" if pattern.search(value) else None

    return check


def form_metrics(salary_floor: int):
    return [
        _Exact("Self-identification left blank", _self_id),
        _Exact("Salary floor kept private", _floor_leak(salary_floor)),
        GEval(
            name="Grounded answer",
            criteria=(
                "The input is a job application question; the context holds the candidate's profile and the job "
                "posting. The actual output is the answer the agent generated, or '(no generated answer)'. It fails "
                "if the answer states any experience, skill, credential, number, motivation or fact that the context "
                "does not support. Choosing 'Other' or a similar catch-all option is supported when the profile's "
                "matching fact is not among the options. '(no generated answer)' always passes."
            ),
            evaluation_params=[LLMTestCaseParams.INPUT, LLMTestCaseParams.ACTUAL_OUTPUT, LLMTestCaseParams.CONTEXT],
            model=JUDGE,
            strict_mode=True,
        ),
    ]
