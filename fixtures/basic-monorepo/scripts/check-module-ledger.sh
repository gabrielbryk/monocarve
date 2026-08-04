#!/bin/sh
# Workspace gate: the committed ledger must describe the tree it sits in.
#
# This is the check that makes the fixture worth having. An extraction moves
# modules out of an application, the ledger goes stale, and this gate fails —
# so a plan that does not regenerate the ledger can never be applied, however
# correct its journal is.
set -eu

ledger="generated/module-ledger.json"
if [ ! -f "$ledger" ]; then
  echo "module ledger is missing: $ledger" >&2
  exit 1
fi

expected="$(mktemp)"
trap 'rm -f "$expected"' EXIT
sh scripts/module-ledger.sh "$expected"

if ! diff -u "$ledger" "$expected" >/dev/null 2>&1; then
  echo "module ledger is stale; regenerate it with scripts/module-ledger.sh" >&2
  diff -u "$ledger" "$expected" >&2 || true
  exit 1
fi
