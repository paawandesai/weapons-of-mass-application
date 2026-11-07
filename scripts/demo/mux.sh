#!/usr/bin/env bash
# Builds the final narrated MP4 from the scenes in <dir> (NN-*.webm clips and NN-*.png title cards
# from record-demo.mts, already cut by cut-waits.sh) and the narration in <narr> (NN.wav).
# Every scene is re-encoded to one uniform intermediate (1440x900, 30 fps, yuv420p, H.264, AAC)
# and the pieces are concatenated, so the concat demuxer never sees mismatched streams.
#   scripts/demo/mux.sh data/demo scripts/demo/narration [out.mp4]
# A still is held for its narration plus TAIL_AIR, or its .seconds without one. Footage longer
# than its narration plus SLACK is time-compressed to that length; footage shorter is slowed at
# most MAX_SLOW x and then held on its last frame, so the voice never trails off into silence.
set -euo pipefail
DIR="${1:?scene dir}"
NARR="$(cd "${2:?narration dir}" && pwd)"
OUT="${3:-wma-demo.mp4}"
FFMPEG="${FFMPEG:-ffmpeg}"
FFPROBE="${FFPROBE:-ffprobe}"
TAIL_AIR="${TAIL_AIR:-0.6}"
SLACK="${SLACK:-6.0}"
MAX_SLOW="${MAX_SLOW:-1.25}"
VF="scale=1440:900:flags=lanczos,format=yuv420p"
ENC=(-c:v libx264 -preset medium -crf 20 -c:a aac -b:a 160k -ar 48000)
dur() { "$FFPROBE" -v error -show_entries format=duration -of csv=p=0 "$1"; }
calc() { python3 -c "print($1)"; }
cd "$DIR"
: > concat.txt
for f in $(ls [0-9][0-9]-*.webm [0-9][0-9]-*.png 2>/dev/null | LC_ALL=C sort); do
  n="${f%%-*}"
  clip="$NARR/$n.wav"
  if [[ "${f##*.}" == "png" ]]; then
    if [[ -f "$clip" ]]; then
      need=$(calc "$(dur "$clip") + $TAIL_AIR")
      "$FFMPEG" -nostdin -y -loglevel error -loop 1 -framerate 30 -i "$f" -i "$clip" \
        -filter_complex "[0:v]$VF[v];[1:a]aresample=48000,apad[a]" -map "[v]" -map "[a]" -t "$need" "${ENC[@]}" "seg-$n.mp4"
    else
      need=$(cat "${f%.png}.seconds" 2>/dev/null || echo 3)
      "$FFMPEG" -nostdin -y -loglevel error -loop 1 -framerate 30 -i "$f" -f lavfi -i anullsrc=r=48000:cl=stereo \
        -filter_complex "[0:v]$VF[v]" -map "[v]" -map 1:a -t "$need" "${ENC[@]}" "seg-$n.mp4"
    fi
    echo "scene $n still -> ${need}s"
  else
    vdur=$(dur "$f")
    if [[ -f "$clip" ]]; then
      adur=$(dur "$clip")
      target=$(calc "$adur + $SLACK")
      if python3 -c "import sys; sys.exit(0 if $vdur > $target else 1)"; then
        factor=$(calc "$target / $vdur"); need="$target"
        "$FFMPEG" -nostdin -y -loglevel error -i "$f" -i "$clip" \
          -filter_complex "[0:v]$VF,setpts=PTS*${factor},fps=30[v];[1:a]aresample=48000,apad[a]" \
          -map "[v]" -map "[a]" -t "$need" "${ENC[@]}" "seg-$n.mp4"
        echo "scene $n video ${vdur}s narration ${adur}s -> ${need}s (compressed x$(calc "round(1/$factor,2)"))"
      else
        need=$(calc "max($vdur, $adur + $TAIL_AIR)")
        slow=$(calc "min($MAX_SLOW, $need / $vdur)")
        pad=$(calc "max(0.0, $need - $vdur * $slow)")
        "$FFMPEG" -nostdin -y -loglevel error -i "$f" -i "$clip" \
          -filter_complex "[0:v]$VF,setpts=PTS*${slow},fps=30,tpad=stop_mode=clone:stop_duration=${pad}[v];[1:a]aresample=48000,apad[a]" \
          -map "[v]" -map "[a]" -t "$need" "${ENC[@]}" "seg-$n.mp4"
        echo "scene $n video ${vdur}s narration ${adur}s -> ${need}s (slowed x${slow}, held ${pad}s)"
      fi
    else
      "$FFMPEG" -nostdin -y -loglevel error -i "$f" -f lavfi -i anullsrc=r=48000:cl=stereo \
        -filter_complex "[0:v]$VF,fps=30[v]" -map "[v]" -map 1:a -t "$vdur" "${ENC[@]}" "seg-$n.mp4"
      echo "scene $n video ${vdur}s (no narration)"
    fi
  fi
  echo "file 'seg-$n.mp4'" >> concat.txt
done
"$FFMPEG" -nostdin -y -loglevel error -f concat -safe 0 -i concat.txt -c copy "$OUT"
rm -f seg-*.mp4 concat.txt
# Title frame and thumbnail for publishing.
"$FFMPEG" -nostdin -y -loglevel error -ss 0.5 -i "$OUT" -frames:v 1 title-frame.png
cp -f 01-title.png thumbnail.png 2>/dev/null || true
printf 'total %.1fs  %s\n' "$(dur "$OUT")" "$(ls -la "$OUT" | awk '{print $5" bytes"}')"
