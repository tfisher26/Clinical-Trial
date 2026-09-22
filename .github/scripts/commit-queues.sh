#!/usr/bin/env bash
# Commit and push whatever the pipeline wrote into the pending-* queue
# files. Shared by every job that produces queue entries.
#
# Retries with a rebase because these jobs run daily and can collide
# with a human editing the same queue files by hand.
set -euo pipefail

MESSAGE="${1:-Queue new items for manual review}"

git config user.name  "clinical-trial-pipeline-bot"
git config user.email "actions@users.noreply.github.com"

git add pipeline/pending-* 2>/dev/null || true

if git diff --staged --quiet; then
  echo "commit-queues: nothing new to commit."
  exit 0
fi

git commit -m "$MESSAGE"

for attempt in 1 2 3; do
  if git push; then
    echo "commit-queues: pushed on attempt $attempt."
    exit 0
  fi
  echo "commit-queues: push rejected (attempt $attempt), rebasing on origin and retrying..."
  git pull --rebase --autostash origin "${GITHUB_REF_NAME:-main}"
done

echo "commit-queues: could not push after 3 attempts." >&2
exit 1
