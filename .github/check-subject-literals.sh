#!/usr/bin/env bash
# Every NATS subject comes from the table generated from
# qvantera-contracts/catalog/subjects.yaml and shipped in @quadrantcapital/proto.
#
# The rule is "no `qvantera.` subject written by hand", not "no *new* subject written by hand".
# A handler can carry a subject name inside a regex — `^qvantera\.broker\.market\.([^.]+)\.` —
# which typecheck cannot see and which breaks a request path at runtime once the subject is renamed.
# So: any subject-shaped `qvantera.` literal, old or new, escaped or not.
#
# Tests are exempt on purpose. A test that asserts the literal name is how a rename is noticed
# at all — it is the pin, not a second declaration. Comment lines are exempt for the same reason
# the Python sibling exempts `#`: a subject named in prose documents the contract, it does not
# construct one, and a stale name in a comment is a documentation defect, not a runtime one.
set -euo pipefail
cd "$(dirname "$0")/.."

# Only the roots this repository actually has. This is load-bearing, not tidiness: GNU grep
# exits 2 on a missing directory operand, and `if hits=$(...)` reads that as "no hits", so
# naming a root that does not exist turned the whole check into a silent pass on CI while BSD
# grep still failed it locally.
roots=()
for d in src apps packages; do
  [[ -d $d ]] && roots+=("$d")
done
if [[ ${#roots[@]} -eq 0 ]]; then
  echo "no source roots to check" >&2
  exit 1
fi

# `qvantera` followed by two dot-separated segments, where each dot may be backslash-escaped
# because the offender that prompted this was a regex literal. Two segments is what separates a
# subject (at least `qvantera.v1.<domain>.<action>`) from `qvantera.sandbox_runner`, which is a
# Python module path the runtime spawns.
if hits=$(grep -rnE "['\"\`][^'\"\`]*qvantera\\\\*\.[a-z0-9_-]+\\\\*\.[a-z]" --include='*.ts' \
            --exclude-dir=node_modules --exclude-dir=dist \
            "${roots[@]}" \
            | grep -v '\.test\.ts:' \
            | grep -vE ':[0-9]+:[[:space:]]*(//|\*|/\*)' ); then
  echo "Subject literals outside a test:" >&2
  echo "$hits" >&2
  echo >&2
  echo "Build the subject with @quadrantcapital/proto's generated table, and read a token" >&2
  echo "back out of one with subjectTokens() — do not re-describe its shape by hand." >&2
  exit 1
fi
echo "no hand-written subject literals"
