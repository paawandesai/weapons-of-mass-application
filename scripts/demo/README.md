# Demo video

Scene list and narration: `docs/demo-script.md`, `scripts/demo/narration/NN.txt`. Output goes to
`data/demo/` (git-ignored). Needs the host `ffmpeg` (libx264, aac), Playwright's Chromium, and
Kokoro for the narration (`kokoro-onnx`, `soundfile`, model files under `~/code/notebooks`).

```bash
scripts/demo/stack.sh up                     # fresh wma_demo, seed, api :3920, worker :4320, web :5190
BASE_URL=http://localhost:5190 OUT_DIR=data/demo pnpm -F @wma/web exec tsx e2e/record-demo.mts
scripts/demo/cut-waits.sh data/demo          # strip the recorded waits (cuts.json)
scripts/demo/narrate.sh                      # NN.txt -> NN.wav
scripts/demo/mux.sh data/demo scripts/demo/narration wma-demo.mp4
scripts/demo/stack.sh down
```

`SCENES=05,07 ... record-demo.mts` re-records only those scenes; the stack must be in the state
that scene expects (a run has happened, a recruiter has answered), so a surgical re-record is for
the scenes after the one that changed state, or after a fresh `stack.sh up` and a full pass.

The recording harness pays for real model calls (judging twelve postings, ten tailored resumes and
form answers, one inbox classification, one prep plan): a few dollars per full pass.
