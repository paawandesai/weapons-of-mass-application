#!/usr/bin/env bash
# Bundle the staged diff plus design briefs into one prompt for a sandbox-less Codex review.
# Usage: scripts/review-bundle.sh --prompt FILE [--briefs 'glob'] [--max-bytes N] > bundle.txt
set -euo pipefail
prompt=""; briefs="docs/design/*.md"; max=$((2*1024*1024))
while [ $# -gt 0 ]; do
  case "$1" in
    --prompt) prompt="$2"; shift 2;;
    --briefs) briefs="$2"; shift 2;;
    --max-bytes) max="$2"; shift 2;;
    -h|--help) sed -n '2,4p' "$0"; exit 0;;
    *) echo "unknown flag $1" >&2; exit 2;;
  esac
done
[ -n "$prompt" ] || { echo "--prompt required" >&2; exit 2; }
cat "$prompt"
printf '\n\n=== git status (staged) ===\n'
git status --short
printf '\n=== design briefs ===\n'
for f in $briefs; do printf '\n--- %s ---\n' "$f"; cat "$f"; done
printf '\n=== staged diff (lockfile, binaries, snapshots and fixtures excluded) ===\n'
git diff --cached --no-color -- . \
  ':(exclude)pnpm-lock.yaml' ':(exclude)**/drizzle/meta/**' ':(exclude)**/fixtures/**' \
  ':(exclude)*.png' ':(exclude)*.pdf' ':(exclude)*.docx' ':(exclude)*.json' | head -c "$max"
printf '\n=== end ===\n'
