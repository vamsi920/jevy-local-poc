#!/bin/zsh
# Sequential live battery runs (one model at a time so Ollama never swaps models mid-run).
cd "$(dirname "$0")/.."
for spec in "$@"; do
  model=${spec%%@*}; split=${spec##*@}; tag=${model//[:\/]/_}
  echo "=== $model $split $(date)"
  OLLAMA_MODEL=$model BATTERY_SPLIT=$split BATTERY_OUTPUT=test-results/v2/$split-$tag.json npx tsx tests/battery.ts > test-results/v2/$split-$tag.log 2>&1
  tail -1 test-results/v2/$split-$tag.log
done
