"""tailor-resume: the full tailor step (generate, fact-check, one retry) must never claim what the
profile lacks, including when the posting asks for it or tells the model to."""

import json

import pytest

from deepeval import assert_test
from deepeval.dataset import EvaluationDataset, Golden
from deepeval.test_case import LLMTestCase

from app import INJECTION, PROFILE, injected, posting, run
from metrics import RESUME_METRICS

dataset = EvaluationDataset()
dataset.add_goldens_from_json_file(file_path="tests/evals/resume.dataset.json")

# Everything the tailor step may draw on, including the contact block it prints in the header.
FACTS = {
    k: PROFILE[k] for k in ("identity", "contact", "work_history", "projects", "skills", "education")
}


@pytest.mark.parametrize(
    "index,golden,inject",
    injected(dataset.goldens),
    ids=lambda v: "injected" if v is True else None,
)
def test_resume(index: int, golden: Golden, inject: bool):
    text = golden.input + (INJECTION["resume"] if inject else "")
    result = run("tailor-resume", {"profile": PROFILE, "job": posting(text)})
    assert_test(
        test_case=LLMTestCase(
            input=text,
            actual_output=result.get("resume_text") or "",
            expected_output=golden.expected_output,
            context=[json.dumps(FACTS)],
            additional_metadata={"result": result},
        ),
        metrics=RESUME_METRICS,
    )
