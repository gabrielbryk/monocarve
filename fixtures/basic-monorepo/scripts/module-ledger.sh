#!/bin/sh
# Regenerate the module ledger: how many TypeScript modules each application
# owns. Nothing edits it by hand, and moving a file out of an application
# invalidates it — which is what makes it this fixture's stand-in for a real
# codegen'd registry keyed on a directory listing.
#
# Writes to $1, defaulting to the committed ledger, so the checker can generate
# a comparison copy without disturbing the tree it is checking.
set -eu

output="${1:-generated/module-ledger.json}"

count() {
  find "$1" -name '*.ts' -type f | wc -l | tr -d ' \n'
}

mkdir -p "$(dirname "$output")"
printf '{\n  "apps/web/src": %s,\n  "apps/api/src": %s\n}\n' "$(count apps/web/src)" "$(count apps/api/src)" >"$output"
