#!/usr/bin/env bash
set -euo pipefail
cd /home/code/pravite_fund_ai_research_ori
echo "branch=$(git branch --show-current)"
echo "HEAD=$(git rev-parse --short HEAD)"
echo "==== log after 9e7b88c parent ===="
git log --oneline 9e7b88c^..HEAD
echo
for c in 9e7b88c 96c2c71 d1c1ddc 9ecfb62 8170164; do
  echo "######## $c ########"
  git show --stat --format='%h %s%n%n%b' "$c" | head -100
  echo
done
echo "==== key paths touched (union) ===="
git diff --name-only 9e7b88c^..HEAD | sort -u | head -120
