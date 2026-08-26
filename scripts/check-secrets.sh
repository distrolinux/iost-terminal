#!/bin/bash
# High-confidence scan of tracked source. This complements GitHub's own secret
# scanning and intentionally avoids printing matched secret material.
set -Eeuo pipefail

command -v git >/dev/null || { echo 'ERROR: git is required' >&2; exit 1; }

patterns=(
  '-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----'
  'AKIA[0-9A-Z]{16}'
  'github_pat_[A-Za-z0-9_]{20,}'
  'gh[pousr]_[A-Za-z0-9]{30,}'
  'xox[baprs]-[A-Za-z0-9-]{20,}'
  'https://hooks\.slack\.com/services/[A-Za-z0-9/_-]{20,}'
  'sk-(proj-)?[A-Za-z0-9_-]{32,}'
)

failed=0
for pattern in "${patterns[@]}"; do
  if git grep -IlE -- "$pattern" -- . >/dev/null 2>&1; then
    failed=1
  fi
done

if [ "$failed" -ne 0 ]; then
  echo 'ERROR: a tracked file matches a high-confidence credential pattern' >&2
  echo 'Inspect locally without posting the match; rotate any real credential before history cleanup.' >&2
  exit 1
fi

echo 'PASS  no tracked file matches high-confidence credential patterns'
