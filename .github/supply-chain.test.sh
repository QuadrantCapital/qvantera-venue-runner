#!/usr/bin/env bash
# supply-chain.sh against shims of syft, grype, cosign and docker: what it writes, what it refuses,
# and that an image gets its tags last. The real tools, and the keyless round trip, run in CI on a
# push to dev (docs/engineering/supply-chain.md).
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
mkdir -p "${work}/bin"

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
cat >"${work}/bin/cosign" <<'SHIM'
#!/usr/bin/env bash
case "$1" in
  attest) touch "${FAKE_DIR}/attested" ;;
  sign) touch "${FAKE_DIR}/signed" ;;
  verify)
    printf '%s\n' "$*" >"${FAKE_DIR}/verify-args"
    [ "${FAKE_SIGNED:-1}" = 1 ] || exit 1 ;;
  verify-attestation) [ "${FAKE_ATTESTED:-1}" = 1 ] || exit 1 ;;
esac
SHIM
chmod +x "${work}/bin/"*

export PATH="${work}/bin:${PATH}" FAKE_DIR="${work}" RUNNER_TEMP="${work}"
export GITHUB_REPOSITORY=QuadrantCapital/qvantera-control
export GITHUB_WORKFLOW_REF=QuadrantCapital/qvantera-control/.github/workflows/ci.yml@refs/heads/dev
zeros="$(printf '0%.0s' {1..64})"
ref="ghcr.io/quadrantcapital/control-api@sha256:${zeros}"

failures=0
code=0
# run <VAR=value…> -- <args…>: supply-chain.sh's exit in $code, its output in $work/out; the markers are cleared first.
run() {
  rm -f "${work}/signed" "${work}/attested" "${work}/tagged" "${work}/created" "${work}/verify-args"
  local envs=()
  while [ "$1" != -- ]; do envs+=("$1"); shift; done
  shift
  code=0
  env ${envs[@]+"${envs[@]}"} "${here}/supply-chain.sh" "$@" >"${work}/out" 2>&1 || code=$?
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

run FAKE_CRITICAL=1 -- release "${ref}" tree-abc
check "a Critical with a fix fails the job" failed
check "  and writes no signature and no tag" wrote_nothing

run FAKE_CRITICAL=1 -- scan "${ref}"
check "scan alone fails on a Critical" failed

run FAKE_PROVENANCE=0 -- release "${ref}" tree-abc
check "an image built without provenance is refused" failed
check "  and gets no tag" not_tagged

run FAKE_SIGNED=0 -- release "${ref}" tree-abc
check "a signature that does not verify fails the job" failed
check "  and the image gets no tag" not_tagged

run FAKE_MOVED_DIGEST="sha256:${zeros//0/1}" -- release "${ref}" tree-abc
check "a tag that lands on another digest fails the job" failed

run -- release "${ref}"
check "release without a tag is refused" failed

run -- verify "${ref}"
check "a signed tree verifies" succeeded

run FAKE_SIGNED=0 -- verify "${ref}"
check "an unsigned tree is refused" failed

run FAKE_ATTESTED=0 -- verify "${ref}"
check "a tree without its SBOM attestation is refused" failed

run FAKE_PROVENANCE=0 -- verify "${ref}"
check "a tree without provenance is refused" failed

run -- verify ghcr.io/quadrantcapital/control-api:tree-abc
check "a tag is refused: only a digest names what was signed" failed

# The identity `verify` accepts: this repository's ci.yml, on dev or a hotfix branch — not a pull
# request's merge ref, a feature branch, another workflow, or another repository.
run -- verify "${ref}"
pattern="$(sed -n 's/.*--certificate-identity-regexp \([^ ]*\).*/\1/p' "${work}/verify-args")"
accepts() { printf '%s\n' "https://github.com/$1" | grep -Eq "${pattern}"; }
refuses() { ! accepts "$1"; }
check "dev's workflow is accepted" accepts QuadrantCapital/qvantera-control/.github/workflows/ci.yml@refs/heads/dev
check "a hotfix branch's workflow is accepted" accepts QuadrantCapital/qvantera-control/.github/workflows/ci.yml@refs/heads/hotfix/cut-the-lease
check "a feature branch's is refused" refuses QuadrantCapital/qvantera-control/.github/workflows/ci.yml@refs/heads/feature/x
check "a pull request's merge ref is refused" refuses QuadrantCapital/qvantera-control/.github/workflows/ci.yml@refs/pull/7/merge
check "another workflow is refused" refuses QuadrantCapital/qvantera-control/.github/workflows/other.yml@refs/heads/dev
check "another repository's is refused" refuses QuadrantCapital/qvantera-trading/.github/workflows/ci.yml@refs/heads/dev

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
