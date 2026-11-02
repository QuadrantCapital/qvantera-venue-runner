#!/usr/bin/env bash
# supply-chain.sh against shims of syft, grype, cosign and docker: what it writes, what it refuses,
# and that an image gets its tags last. The real tools, and the signing round trip against GHCR, run in
# CI on a push to dev (docs/engineering/supply-chain.md).
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
mkdir -p "${work}/bin" "${work}/gh"

# The script finds the public key next to itself: a copy of it, with a stand-in key, is what runs.
cp "${here}/supply-chain.sh" "${work}/gh/supply-chain.sh"
echo "stand-in public key" >"${work}/gh/cosign.pub"

# What each shim does is set by FAKE_* variables. `signed`, `attested` and `tagged` are files a shim
# creates, so a test can tell whether a signature or a tag was written.
cat >"${work}/bin/syft" <<'SHIM'
#!/usr/bin/env bash
for a in "$@"; do case "$a" in cyclonedx-json=*) echo '{"bomFormat":"CycloneDX"}' >"${a#cyclonedx-json=}" ;; esac; done
SHIM
cat >"${work}/bin/grype" <<'SHIM'
#!/usr/bin/env bash
[ "${FAKE_CRITICAL:-0}" = 1 ] && { echo "CVE-0000-0001 Critical" >&2; exit 2; }
exit 0
SHIM
cat >"${work}/bin/docker" <<'SHIM'
#!/usr/bin/env bash
case "$*" in
  *"imagetools create"*) touch "${FAKE_DIR}/tagged"; echo "$*" >>"${FAKE_DIR}/created" ;;
  *.Manifest*) echo "{\"digest\":\"${FAKE_MOVED_DIGEST:-sha256:$(printf '0%.0s' {1..64})}\"}" ;;
  *.Provenance*) if [ "${FAKE_PROVENANCE:-1}" = 1 ]; then echo '{"SLSA":{"buildDefinition":{"buildType":"x"}}}'; else echo '{}'; fi ;;
esac
SHIM
# `attest` and `sign` are refused unless they sign with the key from the environment and are given the
# signing config `signing-config create` wrote — the config is what keeps them away from Rekor.
cat >"${work}/bin/cosign" <<'SHIM'
#!/usr/bin/env bash
case "$1" in
  signing-config)
    [ "$2" = create ] && [ "$3" = --out ] || exit 1
    echo '{"mediaType":"stand-in"}' >"$4" ;;
  attest | sign)
    printf '%s\n' "$*" >>"${FAKE_DIR}/sign-calls"
    [[ " $* " == *" --key env://COSIGN_PRIVATE_KEY "* ]] && [ -n "${COSIGN_PRIVATE_KEY:-}" ] || exit 1
    cfg="$(sed -n 's/.* --signing-config \([^ ]*\) .*/\1/p' <<<" $* ")"
    [ -n "${cfg}" ] && [ -s "${cfg}" ] || exit 1
    if [ "$1" = attest ]; then touch "${FAKE_DIR}/attested"; else touch "${FAKE_DIR}/signed"; fi ;;
  verify)
    printf '%s\n' "$*" >>"${FAKE_DIR}/verify-calls"
    [ "${FAKE_SIGNED:-1}" = 1 ] || exit 1 ;;
  verify-attestation)
    printf '%s\n' "$*" >>"${FAKE_DIR}/verify-calls"
    [ "${FAKE_ATTESTED:-1}" = 1 ] || exit 1 ;;
esac
SHIM
chmod +x "${work}/bin/"*

export PATH="${work}/bin:${PATH}" FAKE_DIR="${work}" RUNNER_TEMP="${work}"
export COSIGN_PRIVATE_KEY="stand-in private key" COSIGN_PASSWORD="stand-in password"
zeros="$(printf '0%.0s' {1..64})"
ref="ghcr.io/quadrantcapital/control-api@sha256:${zeros}"

failures=0
code=0
# run <VAR=value…> -- <args…>: supply-chain.sh's exit in $code, its output in $work/out; the markers are cleared first.
run() {
  rm -f "${work}/signed" "${work}/attested" "${work}/tagged" "${work}/created" "${work}/sign-calls" "${work}/verify-calls"
  local envs=()
  while [ "$1" != -- ]; do envs+=("$1"); shift; done
  shift
  code=0
  env ${envs[@]+"${envs[@]}"} "${work}/gh/supply-chain.sh" "$@" >"${work}/out" 2>&1 || code=$?
}
check() { # check <name> <command…>
  local name="$1"
  shift
  if "$@"; then
    echo "ok   ${name}"
  else
    echo "FAIL ${name}"
    sed 's/^/     | /' "${work}/out"
    failures=$((failures + 1))
  fi
}
succeeded() { [ "${code}" = 0 ]; }
failed() { [ "${code}" != 0 ]; }
wrote_signature() { [ -e "${work}/signed" ] && [ -e "${work}/attested" ]; }
wrote_nothing() { [ ! -e "${work}/signed" ] && [ ! -e "${work}/attested" ] && [ ! -e "${work}/tagged" ]; }
tagged() { [ -e "${work}/tagged" ]; }
not_tagged() { [ ! -e "${work}/tagged" ]; }
tagged_with() { grep -q -- "--tag ghcr.io/quadrantcapital/control-api:$1 ${ref}" "${work}/created"; }

run -- release "${ref}" tree-abc sha-def dev
check "a clean scan signs, attests and tags" succeeded
check "  writes the signature and the SBOM" wrote_signature
check "  gives the digest each tag" tagged_with tree-abc
check "  and the next" tagged_with sha-def
check "  and the last" tagged_with dev

# Nothing may reach a public log. The shim refuses a signing call without the empty signing config; this
# says there were two such calls (the attestation and the signature) and that none asks for a certificate,
# a token or a log.
signing_calls_are_offline() {
  [ "$(grep -c "" "${work}/sign-calls")" = 2 ] &&
    ! grep -qE -- '--(identity-token|fulcio-url|rekor-url|oidc|tlog-upload|insecure-skip-verify)' "${work}/sign-calls"
}
check "the attestation and the signature are made with the key and the empty signing config, and nothing else" signing_calls_are_offline

# What release checked after signing, and what `promote` checks: the committed public key, no log.
verified_by_the_committed_key() {
  [ "$(grep -c "" "${work}/verify-calls")" = 2 ] &&
    ! grep -qvE -- "--key ${work}/gh/cosign\.pub .*--insecure-ignore-tlog=true" "${work}/verify-calls" &&
    ! grep -qE -- '--certificate' "${work}/verify-calls"
}
check "release verifies what it wrote against the committed public key, with no log" verified_by_the_committed_key

run COSIGN_PRIVATE_KEY= -- release "${ref}" tree-abc
check "release without the private key fails" failed
check "  and writes no signature and no tag" wrote_nothing

run COSIGN_PASSWORD= -- release "${ref}" tree-abc
check "release without the key's password fails" failed
check "  and writes no signature and no tag" wrote_nothing

run FAKE_CRITICAL=1 -- release "${ref}" tree-abc
check "a Critical with a fix fails the job" failed
check "  and writes no signature and no tag" wrote_nothing

run FAKE_CRITICAL=1 -- scan "${ref}"
check "scan alone fails on a Critical" failed

run FAKE_PROVENANCE=0 -- release "${ref}" tree-abc
check "an image built without provenance is refused" failed
check "  and gets no tag" not_tagged

run FAKE_SIGNED=0 -- release "${ref}" tree-abc
check "a signature that does not verify against the public key fails the job" failed
check "  and the image gets no tag" not_tagged

run FAKE_ATTESTED=0 -- release "${ref}" tree-abc
check "an attestation that does not verify fails the job" failed
check "  and the image gets no tag" not_tagged

run FAKE_MOVED_DIGEST="sha256:${zeros//0/1}" -- release "${ref}" tree-abc
check "a tag that lands on another digest fails the job" failed

run -- release "${ref}"
check "release without a tag is refused" failed

run -- verify "${ref}"
check "a signed tree verifies" succeeded
check "  by the committed public key, with no log" verified_by_the_committed_key

run FAKE_SIGNED=0 -- verify "${ref}"
check "an unsigned tree is refused" failed

run FAKE_ATTESTED=0 -- verify "${ref}"
check "a tree without its SBOM attestation is refused" failed

run FAKE_PROVENANCE=0 -- verify "${ref}"
check "a tree without provenance is refused" failed

run -- verify ghcr.io/quadrantcapital/control-api:tree-abc
check "a tag is refused: only a digest names what was signed" failed

# The public key is part of the tree. Without it nothing can be verified, so nothing is promoted.
mv "${work}/gh/cosign.pub" "${work}/gh/cosign.pub.away"
run -- verify "${ref}"
check "a tree is refused when the repository carries no public key" failed
run -- release "${ref}" tree-abc
check "  and nothing is tagged when the key to check against is missing" not_tagged
mv "${work}/gh/cosign.pub.away" "${work}/gh/cosign.pub"

# no-oidc: no workflow can get an OIDC token or run a keyless signing action.
mkdir -p "${work}/wf-good" "${work}/wf-oidc" "${work}/wf-attest" "${work}/wf-gha"
cat >"${work}/wf-good/ci.yml" <<'EOF'
permissions:
  contents: read
  packages: write
jobs:
  sign:
    environment: signing
    steps:
      - uses: sigstore/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6
EOF
cp "${work}/wf-good/ci.yml" "${work}/wf-oidc/ci.yml"
printf '    permissions:\n      id-token: write\n' >>"${work}/wf-oidc/ci.yml"
cp "${work}/wf-good/ci.yml" "${work}/wf-attest/ci.yml"
printf '      - uses: actions/attest-build-provenance@v2\n' >>"${work}/wf-attest/ci.yml"
cp "${work}/wf-good/ci.yml" "${work}/wf-gha/ci.yml"
printf '      - uses: sigstore/gh-action-sigstore-python@v3\n' >>"${work}/wf-gha/ci.yml"
run -- no-oidc "${work}/wf-good"
check "workflows that ask for no OIDC token pass" succeeded
run -- no-oidc "${work}/wf-oidc"
check "a workflow that asks for an OIDC token is refused" failed
run -- no-oidc "${work}/wf-attest"
check "a workflow that runs actions/attest is refused" failed
run -- no-oidc "${work}/wf-gha"
check "a workflow that runs a keyless signing action is refused" failed
run -- no-oidc
check "no-oidc with no directory is refused" failed

# pins: a Dockerfile's bases and a Compose file's third-party images are named by digest.
pinned="sha256:${zeros//0/a}"
cat >"${work}/Dockerfile.good" <<EOF
# syntax=docker/dockerfile:1@${pinned}
FROM node:24-bookworm@${pinned} AS builder
RUN true
FROM --platform=linux/amd64 node:24-slim@${pinned}
COPY --from=builder /app /app
FROM builder AS test
FROM scratch
EOF
cat >"${work}/compose.good.yaml" <<EOF
services:
  db:
    image: postgres:18-alpine@${pinned} # 18-alpine
  control:
    image: ghcr.io/quadrantcapital/control-api:\${QV_IMAGE_TAG:-latest}
  local:
    image: qvantera-e2e:ci
  # image: commented:out
EOF
cat >"${work}/Dockerfile.floating-base" <<EOF
FROM node:24-bookworm AS builder
FROM node:24-slim@${pinned}
EOF
cat >"${work}/Dockerfile.floating-last-stage" <<EOF
FROM node:24-bookworm@${pinned} AS builder
FROM node:24-slim
EOF
cat >"${work}/compose.floating.yaml" <<EOF
services:
  db:
    image: postgres:18-alpine
EOF
run -- pins "${work}/Dockerfile.good" "${work}/compose.good.yaml"
check "a Dockerfile and a Compose file with every image by digest pass" succeeded
run -- pins "${work}/Dockerfile.floating-base"
check "a base named by tag is refused" failed
run -- pins "${work}/Dockerfile.floating-last-stage"
check "the last stage's base is held to it too" failed
run -- pins "${work}/compose.floating.yaml"
check "a third-party Compose image named by tag is refused" failed
run -- pins
check "pins with no file is refused" failed

[ "${failures}" = 0 ] || { echo "${failures} failed"; exit 1; }
echo "supply-chain.test.sh: all passed"
