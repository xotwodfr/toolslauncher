#!/usr/bin/env bash
# Runs a command, streams its output as usual, and if it FAILS also publishes the last lines of that output as a
# GitHub error annotation. Annotations are readable through the public API without signing in, so a failed CI run
# explains itself instead of needing someone to open the log.
#   usage: bash scripts/ci-step.sh "<label>" <command> [args...]
label="$1"; shift
log="$(mktemp)"

"$@" 2>&1 | tee "$log"
code=${PIPESTATUS[0]}

if [ "$code" -ne 0 ]; then
  # strip colour codes and CRs, then escape for a workflow command: % -> %25, newline -> %0A
  msg="$(tail -n 60 "$log" | tr -d '\r' | sed 's/\x1b\[[0-9;]*[A-Za-z]//g' | awk 'BEGIN{ORS="%0A"} {gsub(/%/,"%25"); print}')"
  echo "::error title=${label} failed (exit ${code})::${msg}"
fi
rm -f "$log"
exit "$code"
