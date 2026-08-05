#!/usr/bin/env bash
#
# release.sh — one-command Eldercube release.
#
# Bumps the version string in every place it must change, auto-increments the
# service-worker cache name, verifies they all agree, then commits. Pushing is
# opt-in via --push so nothing goes live without you asking.
#
# Usage:
#   ./release.sh <version> "<description>"           # bump + commit (no push)
#   ./release.sh <version> "<description>" --push     # bump + commit + push to main
#
# Example:
#   ./release.sh 1.12.24 "fix mobile joystick drift" --push
#
# For --push, credentials come from the GH_TOKEN environment variable if set
# (never stored in the repo); otherwise your normal git credentials are used:
#   GH_TOKEN="$(cat /path/to/token)" ./release.sh 1.12.24 "msg" --push
#
set -euo pipefail

# ---- locate repo root (script must live in it) ----
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# ---- args ----
NEW="${1:-}"
DESC="${2:-}"
PUSH="no"
[ "${3:-}" = "--push" ] && PUSH="yes"

die(){ echo "✖ $*" >&2; exit 1; }

[ -n "$NEW" ]  || die "Usage: ./release.sh <version> \"<description>\" [--push]"
[ -n "$DESC" ] || die "Usage: ./release.sh <version> \"<description>\" [--push]"
echo "$NEW" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
  || die "Version must look like X.Y.Z (got: $NEW)"
[ -f version.json ] && [ -d .git ] \
  || die "Run this from the repo root (version.json + .git not found)."

# ---- current version + cache number ----
CURRENT="$(perl -ne 'print $1 if /"version"\s*:\s*"([^"]+)"/' version.json)"
[ -n "$CURRENT" ] || die "Could not read current version from version.json"
CACHE_NUM="$(perl -ne 'print $1 if /minicraft-v(\d+)/' sw.js)"
[ -n "$CACHE_NUM" ] || die "Could not read cache number from sw.js"
NEW_CACHE_NUM=$((CACHE_NUM + 1))

if [ "$CURRENT" = "$NEW" ]; then
  die "version.json is already at $NEW — pick a higher version."
fi

echo "→ Bumping $CURRENT → $NEW   (sw cache v$CACHE_NUM → v$NEW_CACHE_NUM)"

# ---- the 5 edits (perl -i is portable across macOS/BSD and GNU sed) ----
perl -i -pe "s/\"version\"\s*:\s*\"\Q$CURRENT\E\"/\"version\":\"$NEW\"/"        version.json
perl -i -pe "s/v=\Q$CURRENT\E/v=$NEW/g"                                          index.html
perl -i -pe "s/APP_VERSION\s*=\s*'\Q$CURRENT\E'/APP_VERSION = '$NEW'/"           js/main.js
perl -i -pe "s/minicraft-v$CACHE_NUM/minicraft-v$NEW_CACHE_NUM/"                 sw.js

# ---- verify every touchpoint now agrees ----
fail=0
check(){ grep -q -- "$2" "$1" || { echo "  ✖ $1 missing: $2"; fail=1; }; }
check version.json "\"version\":\"$NEW\""
check index.html   "css/style.css?v=$NEW"
check index.html   "js/main.js?v=$NEW"
check js/main.js   "APP_VERSION = '$NEW'"
check sw.js        "minicraft-v$NEW_CACHE_NUM"
[ "$fail" -eq 0 ] || die "Version bump incomplete — see above. Nothing committed."

# any lingering references to the old version in the shipped files?
if grep -REn "v=$CURRENT|APP_VERSION = '$CURRENT'|\"version\":\"$CURRENT\"" \
     version.json index.html js/main.js sw.js >/dev/null 2>&1; then
  echo "  ! warning: an old-version reference still remains (check above files)"
fi

echo "✓ All 5 touchpoints updated to $NEW"

# ---- commit ----
git add -A
git commit -q -m "v$NEW — $DESC

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
echo "✓ Committed: v$NEW — $DESC"

# ---- push (opt-in) ----
if [ "$PUSH" = "yes" ]; then
  echo "→ Pushing to origin main…"
  if [ -n "${GH_TOKEN:-}" ]; then
    git -c credential.helper='!f() { echo username=abendanjulius; echo "password=$GH_TOKEN"; }; f' \
        push origin main
  else
    git push origin main
  fi
  echo "✓ Pushed — GitHub Pages will deploy v$NEW to minicraft.me shortly."
else
  echo "ℹ Not pushed. Review, then run:  git push origin main"
  echo "  (or re-run with --push next time)"
fi
