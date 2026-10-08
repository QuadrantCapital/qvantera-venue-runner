#!/usr/bin/env bash
# Install or reconfigure the Qvantera venue runner on this host (README.md).
#
#   bash install.sh --platform https://qvantera.example.com --token qv_rnr_… [--egress auto|<ip>,<ip>]
#                [--egress-ip-url <url>] [--name <name>] [--version <tag>]
#
# Checks Docker, writes `.env` beside this script (mode 600 — the token is the runner's password),
# starts the runner with `docker compose up -d`, waits for it to be connected, and prints what it
# reports: its name on the platform and every lane with the address the venue sees from it — the
# addresses to whitelist at the venue. Run it again with other arguments to change them.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

platform="" token="" egress="auto" egress_ip_url="" name="" version="latest"

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

die() {
  echo "install.sh: $*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --platform) platform="${2:-}"; shift 2 ;;
    --token) token="${2:-}"; shift 2 ;;
    --egress) egress="${2:-}"; shift 2 ;;
    --egress-ip-url) egress_ip_url="${2:-}"; shift 2 ;;
    --name) name="${2:-}"; shift 2 ;;
    --version) version="${2:-}"; shift 2 ;;
    -h | --help) usage 0 ;;
    *) echo "install.sh: unknown argument $1" >&2; usage 1 ;;
  esac
done

[ -n "${platform}" ] || die "--platform is required: your platform's https:// address"
[[ "${platform}" =~ ^https?:// ]] || die "--platform must start with https:// (got ${platform})"
[ -n "${token}" ] || die "--token is required: the token shown when you registered the runner"
[[ "${token}" =~ ^qv_rnr_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$ ]] || die "--token is not a runner token (qv_rnr_…)"
[[ "${egress}" == auto || "${egress}" =~ ^[0-9A-Fa-f:.,]+$ ]] || die "--egress is auto or a comma-separated list of this host's addresses"
[[ "${version}" =~ ^[A-Za-z0-9_.-]+$ ]] || die "--version is an image tag"

command -v docker >/dev/null 2>&1 || die "Docker is not installed: https://docs.docker.com/engine/install/"
docker info >/dev/null 2>&1 || die "Docker is installed but not reachable by this user (is the daemon running, and is the user in the docker group?)"
docker compose version >/dev/null 2>&1 || die "the Docker Compose plugin is missing: https://docs.docker.com/compose/install/linux/"

# Each address named must be one of this host's: the runner refuses to start otherwise, and saying
# so here is quicker than reading its log.
if [ "${egress}" != auto ]; then
  if command -v ip >/dev/null 2>&1; then
    local_addresses="$(ip -o addr show | awk '{ split($4, a, "/"); print a[1] }')"
    IFS=',' read -ra wanted <<<"${egress}"
    for address in "${wanted[@]}"; do
      grep -qxF "${address}" <<<"${local_addresses}" || die "--egress names ${address}, which is not an address of this host"
    done
  fi
fi

umask 077
{
  echo "QV_PLATFORM_URL=${platform}"
  echo "QV_RUNNER_TOKEN=${token}"
  echo "RUNNER_EGRESS_IPS=${egress}"
  [ -z "${egress_ip_url}" ] || echo "RUNNER_EGRESS_IP_URL=${egress_ip_url}"
  [ -z "${name}" ] || echo "RUNNER_NAME=${name}"
  echo "QV_RUNNER_VERSION=${version}"
} >.env
chmod 600 .env
echo "wrote .env"

docker compose pull --quiet
docker compose up -d

# Connected, and the platform said who it is: /health answers with the runner's identity and lanes.
port="$(sed -n 's/^RUNNER_PORT=//p' .env)"
port="${port:-3005}"
health=""
for _ in $(seq 1 60); do
  health="$(docker compose exec -T venue-runner node -e "fetch('http://127.0.0.1:${port}/health').then((r) => r.text()).then((t) => process.stdout.write(t)).catch(() => process.exit(1))" 2>/dev/null)" && break
  health=""
  sleep 2
done
if [ -z "${health}" ]; then
  echo "install.sh: the runner did not come up within two minutes. Its log:" >&2
  docker compose logs --tail 50 venue-runner >&2
  exit 1
fi

docker compose exec -T venue-runner node -e "
const h = JSON.parse(process.argv[1])
console.log('venue runner ' + h.runner + (h.scope ? ' (' + h.scope + ')' : '') + ' — ' + (h.ok ? 'connected' : 'not connected') + ', version ' + h.version + (h.outdated ? ' (outdated: update it)' : ''))
for (const l of h.lanes) console.log('  lane ' + (l.localAddress || 'default route') + ' -> ' + l.publicAddress + '  ' + l.state)
console.log('Whitelist each active lane\'s address at the venue.')
" "${health}"
