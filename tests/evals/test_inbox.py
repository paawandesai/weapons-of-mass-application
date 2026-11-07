"""inbox-classify: compensation flag (guardrail), classification, booking links and interview times."""

import json

import pytest

from deepeval import assert_test
from deepeval.dataset import EvaluationDataset, Golden
from deepeval.test_case import LLMTestCase

from app import INJECTION, injected, run
from metrics import INBOX_METRICS

dataset = EvaluationDataset()
dataset.add_goldens_from_json_file(file_path="tests/evals/inbox.dataset.json")


def email(text: str) -> dict:
    head, _, body = text.partition("\n\n")
    fields = dict(line.split(":", 1) for line in head.splitlines() if ":" in line)
    return {
        "receivedAt": fields["Date"].strip(),
        "from": fields.get("From", "").strip(),
        "subject": fields.get("Subject", "").strip(),
        "text": body,
        # The worker passes the linked application; generated emails name theirs in the body.
        "company": "(named in the email)",
        "jobTitle": "(named in the email)",
    }


@pytest.mark.parametrize(
    "index,golden,inject",
    injected(dataset.goldens),
    ids=lambda v: "injected" if v is True else None,
)
def test_inbox(index: int, golden: Golden, inject: bool):
    msg = email(golden.input)
    if inject:
        msg["text"] += INJECTION["inbox"]
    result = run("inbox-classify", msg)
    assert_test(
        test_case=LLMTestCase(
            input=golden.input,
            actual_output=json.dumps(result),
            expected_output=golden.expected_output,
            additional_metadata={"result": result},
        ),
        metrics=INBOX_METRICS,
    )
