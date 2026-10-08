# qvantera-venue-runner — local agent instructions

Workspace-wide rules: `../AGENTS.md`. Reference: `../docs/engineering/`. This file covers only
what is specific to this repository.

## What this repo owns

The venue runner (M-366, M-367, § D-36): the venue egress of Qvantera, a product of its own that
customers install on their own hosts, and that the platform installs the same way for its hosted
runners. It relays the venue REST requests spot-gateway has signed, once each, and holds the venue
WebSocket sockets spot-gateway opens through it. Image `ghcr.io/quadrantcapital/venue-runner`.

| Path | Owns |
| --- | --- |
| `src/` | the runner |
| `compose.yaml`, `.env.example`, `install.sh` | the customer install |
| `README.md` | written for a customer, not for this team |

## The boundary — the most important rule here

The runner is outside the platform's trust boundary: a customer runs it on a host the platform
does not control. So:

- **It never holds a venue secret.** What reaches it is a URL, headers carrying the API key, a body
  spot-gateway signed, and a socket's frames. Signing, adapters, rate limits and the breaker stay in
  spot-gateway. Invariant 3 (`../AGENTS.md`) and § D-18 are why.
- **It depends on the contract bindings only** — `@quadrantcapital/proto` and the frame codec
  `@quadrantcapital/wire`. Never on `db`, `messaging`, `observability` or anything from
  qvantera-trading: it is installed by people who are not this team, and the runner/v1 contract is
  the whole of what it shares with the platform.
- **It never decides where a request goes.** spot-gateway chooses the runner and the lane of every
  request and socket, and counts the venue's limits (M-315); the runner binds the lane it is told.
- **It never retries a request.** One that went out and was not answered is spot-gateway's to call
  ambiguous (§ D-9).
- It reaches the platform outbound only, as a NATS client over the platform's WebSocket listener.

## Commands

`yarn build` · `yarn test` · `yarn typecheck` · `yarn lint` · `yarn audit:deps` · `yarn dev`

## Releases

`dev` builds the image once per tree (`:tree-*`, `:sha-*`, `:dev`); `main` promotes that build to
`:latest` and builds nothing, as in every qvantera repository (M-351). The version customers see is
`package.json`'s, reported in the runner's hello and heartbeat; raising the oldest version the
platform serves is a contract change (`runner_min_version` in qvantera-contracts).
