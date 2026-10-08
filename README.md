# Qvantera venue runner

The venue runner sends your trading platform's venue requests from **your own host and your own IP
addresses**, so the exchange sees — and whitelists — addresses you control.

- **Your API secrets never reach it.** The platform signs every request; the runner receives a
  request that is already signed (URL, headers with your API key, body) and sends it, once. It cannot
  forge or change one.
- **It only connects out.** It opens one encrypted connection to your platform
  (`wss://<your platform>/nats`) and connections to the exchanges. Nothing connects in; it needs no
  open port.
- **It has no state.** Restart it, move it, run several: nothing is stored on the host but its
  settings file.

## How it works

Your platform keeps the exchange adapters, the signing, the rate limits and the circuit breakers. When
a strategy places an order with a credential that uses this runner, the platform signs the request
and hands it to the runner over the connection the runner opened; the runner sends it to the
exchange and returns the exchange's answer. Private order streams (fills) are held the same way.

**Lanes.** Each IP address of your host the runner uses is a separate *lane*. Exchanges limit
requests per IP address, so two lanes give a credential twice the per-address budget. The platform
chooses a lane for every request and counts each lane's budget; a credential's private stream stays
on one lane. Limits counted per account (orders per second for your account, for example) are **not**
spread by lanes — only per-address limits are.

## Before you start

1. A Linux host with **Docker** and the **Docker Compose plugin** (`docker compose version` works).
2. Outbound HTTPS from the host to your platform and to the exchanges you trade on.
3. Access to the image `ghcr.io/quadrantcapital/venue-runner` (your platform's operator tells you if
   you need to `docker login ghcr.io` first).
4. This directory's files on the host: `compose.yaml`, `.env.example`, `install.sh`. Every image carries
   them for its own release under `/app/install/`, so they can be copied out of the image you will run:

   ```bash
   mkdir -p /opt/qvantera-runner && cd /opt/qvantera-runner
   for f in compose.yaml .env.example install.sh; do
     docker run --rm --entrypoint cat ghcr.io/quadrantcapital/venue-runner:latest /app/install/$f >$f
   done
   ```

## Install

1. **Register the runner** on the platform: *Organization → Runners → Register runner*, or with the
   CLI:

   ```bash
   qv runners register --name my-host --label region=eu
   ```

   The platform shows a token `qv_rnr_…` **once**. Copy it now; it cannot be shown again (you can
   rotate it later).

2. **Install it on the host** with the token:

   ```bash
   bash install.sh --platform https://qvantera.example.com --token qv_rnr_... --egress auto
   ```

   `bash install.sh` works whether or not the copied file kept its executable bit (a file written by
   `cat` does not).

   `--egress auto` uses every public IP address of the host. To choose, list them:
   `--egress 203.0.113.10,203.0.113.11`. The script writes `.env`, starts the runner and prints its
   lanes:

   ```
   venue runner 0123456789ab (…) — connected, version 1.0.0
     lane 203.0.113.10 -> 203.0.113.10  active
     lane 203.0.113.11 -> 203.0.113.11  active
   Whitelist each active lane's address at the venue.
   ```

3. **Whitelist every active lane's address** in each exchange API key's IP whitelist. The Runners
   page shows the same list.

4. **Point a credential at the runner:** open the credential, choose *Runners*, select this runner
   (and any others for failover), save. Or:

   ```bash
   qv credentials runners set <credential-id> <runner-id> [<runner-id> …]
   ```

   A credential with no runners selected uses the platform's own runners.

## Choosing lanes

- **At install:** `--egress` (or `RUNNER_EGRESS_IPS` in `.env`) is the set of addresses the runner
  binds. Each must be an address of this host — the runner refuses to start otherwise.
- **From the platform:** the Runners page (or `qv runners egress <runner-id> <ip> …`, or `--all`)
  narrows the set to the lanes you want used, and can widen it again — up to what was bound at
  install. The runner applies it within ten seconds, without a restart.
- A host behind NAT: set `RUNNER_EGRESS_IP_URL=https://api.ipify.org` (or your own "what is my IP"
  endpoint) so each lane reports the address the exchange actually sees.
- Two lanes that leave through the same public address are one address to the exchange; the second
  is marked `duplicate` and never used.
- If an exchange refuses a lane's address (not whitelisted), the platform stops using that lane until
  the runner's next report; whitelist it and it is used again.

## Several runners

Register a runner per host and select several for a credential: the platform uses the ones that are
online, keeps each credential's private stream on one of them, and moves it to another within half a
minute if that one goes offline. An order that was in flight on a runner that disappeared is never
re-sent; the platform looks it up at the exchange.

## Update

```bash
docker compose pull && docker compose up -d
```

The Runners page marks a runner **outdated** when it is older than the oldest release the platform
fully supports. `QV_RUNNER_VERSION` in `.env` pins a release; `latest` is the newest.

## Rotate the token, or remove the runner

- **Rotate:** *Runners → Rotate token* (or `qv runners rotate <runner-id>`), then put the new token
  in `.env` and `docker compose up -d`. The old token stops working at once.
- **Remove:** `docker compose down` on the host, then *Runners → Revoke* (or
  `qv runners revoke <runner-id>`). A revoked runner receives nothing more from the platform at once,
  stops itself, and its connection is closed within ten minutes at the latest.

## Troubleshooting

`docker compose logs -f venue-runner` shows what the runner does; `docker compose ps` its health.

| Symptom | Cause |
| --- | --- |
| The runner exits at once: `is not an address of this host` | An address in `RUNNER_EGRESS_IPS` is not on this host. Fix the list, or use `auto`. |
| Log: `Authorization Violation`, reconnecting | The token was rotated or revoked, or mistyped. Register or rotate, update `.env`. |
| Log: `hello not answered` | Connected, but the platform did not answer. Usually a platform restart; it retries. |
| Cannot connect at all | The host cannot reach `https://<your platform>`, or a proxy in between does not pass WebSockets on `/nats`. |
| A lane is `unresolved` | Its IP lookup (`RUNNER_EGRESS_IP_URL`) failed; it is retried every ten minutes, unused meanwhile. |
| A lane is `disabled` | Not among the lanes selected on the platform. |
| Orders refused `no_runner_online` | None of the credential's runners is online, or none has an active lane. |
| Exchange answers "IP not in whitelist" | Whitelist the lane's address shown on the Runners page. |

The runner's own status: `curl -s 127.0.0.1:3005/health` on the host.

## Settings

| Variable | Meaning |
| --- | --- |
| `QV_PLATFORM_URL` | Your platform's address. Required. |
| `QV_RUNNER_TOKEN` | The runner's token. Required. |
| `RUNNER_EGRESS_IPS` | `auto` (default) or a comma-separated list of this host's addresses. |
| `RUNNER_EGRESS_IP_URL` | A plain-text public-IP lookup, asked through each lane. Optional. |
| `RUNNER_NAME` | A name in the runner's logs. Optional. |
| `RUNNER_PORT` | Local port of `/health` and `/metrics`, on 127.0.0.1. Default 3005. |
| `QV_RUNNER_VERSION` | Image tag. Default `latest`. |
| `LOG_LEVEL` | `info` (default), `debug`, `warn`, … |

## Development

Node 22, Yarn 4 (Corepack). `yarn install`, `yarn test` (the NATS tests start a throwaway
nats-server in Docker), `yarn typecheck`, `yarn lint`, `yarn build`. Rules for changing it:
[AGENTS.md](AGENTS.md).
