#!/usr/bin/env bash
# Voices scripts/demo/narration/NN.txt into NN.wav with Kokoro (local text-to-speech, ONNX).
#   scripts/demo/narrate.sh [--voice am_michael] [--speed 1.0] [NN ...]
# No scene ids: every narration/*.txt. Existing .wav files are overwritten.
# KOKORO_MODEL and KOKORO_VOICES point at the model files (defaults: ~/code/notebooks).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)/narration"
VOICE="am_michael"; SPEED="1.0"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --voice) VOICE="$2"; shift 2 ;;
    --speed) SPEED="$2"; shift 2 ;;
    *) break ;;
  esac
done
ids=("$@")
if [[ ${#ids[@]} -eq 0 ]]; then for f in "$DIR"/*.txt; do ids+=("$(basename "$f" .txt)"); done; fi
export KOKORO_MODEL="${KOKORO_MODEL:-$HOME/code/notebooks/kokoro-v1.0.onnx}"
export KOKORO_VOICES="${KOKORO_VOICES:-$HOME/code/notebooks/voices-v1.0.bin}"
python3 -I - "$DIR" "$VOICE" "$SPEED" "${ids[@]}" <<'PY'
import os, re, sys
import numpy as np, soundfile as sf
from kokoro_onnx import Kokoro
d, voice, speed, *ids = sys.argv[1:]
k = Kokoro(os.environ["KOKORO_MODEL"], os.environ["KOKORO_VOICES"])
for n in ids:
    text = open(os.path.join(d, n + ".txt"), encoding="utf-8").read().strip()
    # One sentence per generation keeps the prosody steady; 350 ms between sentences.
    sentences = [s for s in re.split(r"(?<=[.!?])\s+", text) if s]
    out, sr = [], 24000
    for s in sentences:
        a, sr = k.create(s, voice=voice, speed=float(speed), lang="en-us")
        out.append(a); out.append(np.zeros(int(sr * 0.35), dtype=a.dtype))
    audio = np.concatenate(out)
    audio = audio / max(1e-6, np.abs(audio).max()) * 0.9
    sf.write(os.path.join(d, n + ".wav"), audio, sr)
    print(f"voiced {n}: {len(audio)/sr:.1f}s")
PY
