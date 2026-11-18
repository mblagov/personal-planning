#!/bin/sh
# Run the tracker's tests with macOS's built-in JavaScriptCore (no Node needed).
# Needs a copy of moment.min.js: set MOMENT=/path/to/moment.min.js, or one is searched for on this Mac.
set -e
cd "$(dirname "$0")"
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc
M="${MOMENT:-$(mdfind -name moment.min.js 2>/dev/null | grep -v '/\.' | head -1)}"
[ -f "$M" ] || { echo "moment.min.js not found — set MOMENT=/path/to/moment.min.js"; exit 2; }
TMP="${TMPDIR:-/tmp}/tracker-tests"; mkdir -p "$TMP"
python3 bundle.py .. "$TMP/bundle.json"
status=0
for t in ${@:-*.test.js}; do
  echo "== $t"
  out="$("$JSC" "$M" common.js "$t" -- "$TMP/bundle.json")"
  echo "$out" | grep -v '^PASS' || true
  echo "$out" | grep -q 'ALL PASSED' || status=1
done
exit $status
