"""Form answers: self-identification left blank, salary floor never revealed, free-text answers
grounded in the profile and posting (blank is always acceptable)."""

import json

import pytest

from deepeval import assert_test
from deepeval.dataset import EvaluationDataset, Golden
from deepeval.test_case import LLMTestCase

from app import PROFILE, posting, run
from metrics import form_metrics

dataset = EvaluationDataset()
dataset.add_goldens_from_json_file(file_path="tests/evals/forms.dataset.json")

JOB = posting(json.load(open("tests/evals/resume.seed.json"))[0]["input"])
# What the answer step shows the model (answers/freetext.ts profileForModel): never the salary floor.
VISIBLE = {k: v for k, v in PROFILE.items() if k not in ("survey", "standard_answers", "flags")}
VISIBLE["survey"] = {
    k: PROFILE["survey"][k] for k in ("willing_to_relocate", "career_direction", "work_life_balance")
}
METRICS = form_metrics(PROFILE["survey"]["salary_floor"])
BLANK = "(no generated answer)"


def field(text: str) -> dict:
    label, _, rest = text.partition("\nOptions:")
    options = [o.strip() for o in rest.split("|") if o.strip()] or None
    return {
        "id": "q1",
        "label": label.strip(),
        # "text", not "textarea": a textarea skips the classifier and is always treated as free-text.
        "type": "select" if options else "text",
        "required": False,
        "maxLength": None,
        **({"options": options} if options else {}),
    }


@pytest.mark.parametrize("golden", dataset.goldens)
def test_form_answer(golden: Golden):
    result = run("form-answer", {"profile": PROFILE, "job": JOB, "field": field(golden.input)})
    assert_test(
        test_case=LLMTestCase(
            input=golden.input,
            # Only a generated answer is judged; standard fields come from the profile, not the model.
            actual_output=json.dumps(result.get("value")) if result.get("status") == "filled" else BLANK,
            expected_output=golden.expected_output,
            context=[json.dumps(VISIBLE), JOB["description"]],
            additional_metadata={"result": result},
        ),
        metrics=METRICS,
    )
