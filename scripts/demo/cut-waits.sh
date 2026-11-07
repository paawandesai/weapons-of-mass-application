#!/usr/bin/env bash
# Removes the waits recorded by apps/web/e2e/record-demo.mts from the scene WebMs, using the
# intervals in <dir>/cuts.json ({"05-board": [[from,to],...]}, seconds from the scene's recording
# start). Each scene is rewritten in place; the original is kept as raw/<scene>.full.webm, so the
# script is safe to run twice.
#   scripts/demo/cut-waits.sh data/demo
set -euo pipefail
DIR="${1:?scene dir}"
FFMPEG="${FFMPEG:-ffmpeg}"
cd "$DIR"
mkdir -p raw
python3 - <<'PY' | while IFS=$'\t' read -r scene expr; do
import json
for scene, ivs in json.load(open("cuts.json")).items():
    if not ivs: continue
    print(scene + "\t" + "+".join(f"between(t,{a},{b})" for a, b in ivs))
PY
  [[ -f "$scene.webm" ]] || { echo "no $scene.webm"; continue; }
  [[ -f "raw/$scene.full.webm" ]] || cp "$scene.webm" "raw/$scene.full.webm"
  "$FFMPEG" -nostdin -y -loglevel error -i "raw/$scene.full.webm" \
    -vf "select='not($expr)',setpts=N/FRAME_RATE/TB" -r 25 -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -b:v 4M -an "$scene.webm" < /dev/null
  echo "$scene: cut $expr -> $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$scene.webm")s"
done
