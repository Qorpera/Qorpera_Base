# Node 1's door of members' live pictures (20260930745000)

In the large view a member who may act on an agent's desktop gets its changed areas as they change, over one held-open
WebSocket, instead of a picture every 450 ms through the member bridge. That stream does not pass the bridge (a
Supabase Edge Function cannot hold it): it comes in through node 1's own Cloudflare tunnel, `screens.qorpera.com`, to
the executor's live-picture listener on node 1's loopback (`memberStreams`, `127.0.0.1:8793`; see
`deploy/coding-worker/README.md`). This folder is that door and nothing else:

- `qorpera-screens-tunnel.service`: the tunnel's connector (cloudflared 2026.10.5, `/usr/local/bin/cloudflared`), a
  `DynamicUser` with no capabilities, reaching only the loopback and Cloudflare's tunnel edge (region1 and region2 as
  Cloudflare publishes them; the source is beside the addresses in the unit). Its token is a systemd credential
  (`LoadCredentialEncrypted`), sealed with the host's own key, and with its TPM too when it has one: it is never an
  argument, never in the environment, never on disk in the clear (the decrypted copy exists only in the unit's own
  credentials while it runs, readable by it alone). It does not start while no token is sealed. Installed off.
- **What "sealed" is worth.** With the host key alone (`/var/lib/systemd/credential.secret`, on the same unencrypted
  disk), the seal keeps the token from being read in passing, from a backup or copy of that one file, and from other
  hosts; it does not keep it from whoever holds the whole disk or root on the host. With the TPM as well, a copy of the
  whole disk opens nothing, but root on the running host still can. `status` says which it is: `token sealed (host
  key)` or `token sealed (host key + tpm)`.
- `qorpera-screens-door`: the one place the token passes, and the switch. `token` reads it once (a hidden prompt, or
  one line of stdin; the whole install command Cloudflare shows may be pasted) and seals it to
  `/etc/credstore.encrypted/qorpera-screens-tunnel`; `on` enables and starts the connector and says `on` once it
  reached Cloudflare (within 30 s, else why not); `off` stops, disables and
  masks it (the kill switch); `status` says the connector's state, whether it reached Cloudflare and whether a token is
  sealed and with which key, never the token. Each verb answers with its own word or line only: systemd's own messages
  (systemd-creds' note that the host key is not on encrypted media, systemctl's "Created symlink") are not shown unless
  the step failed.
- `qorpera-screens-door.sudoers`: the operator may run exactly those four verbs as root.
- `install-screens-door.sh`: verifies every file against its pins, and the connector against the sha-256 of the
  cloudflared our own database stack already runs (service `tunnel` in `/opt/dbhome` on db-primary, image
  `cloudflare/cloudflared:2026.10.5` at digest `sha256:1b1d34d0…`; its `/usr/local/bin/cloudflared`, 40,187,067 bytes,
  sha-256 `5bec754a…`). Nothing is downloaded: the binary for node 1 is taken from that image. Cloudflare's standalone
  release asset of the same version is a different build and the installer refuses it. It installs, and leaves the
  unit off.

## What the door lets in

Only what the listener serves: `GET /v1/member-machine-streams/<ticket>`, a WebSocket upgrade with the subprotocol
`qorpera.machine-stream.v1` and the Origin the ticket was bought for. A ticket is bought on the pointer route through
the member bridge, as the member, on a live pointer pass (32 random bytes, single use, 30 s). Anything else is a 404
with no body. The stream only shows: a browser's data message ends it (1008), and nothing on its path can send a key,
a click or a move to a desktop (the relay in the machine passes only the three messages of a viewer, see
`packages/runner-orchestrator/src/company-machine-stream.ts`).

Cloudflare ends TLS for `screens.qorpera.com`, so it sees the pictures as they pass, as it would for any site it
serves; it never sees a member's bearer token (the ticket is all the stream carries, and it is used up on admission).

## At the release (Jonas's steps, after the door is on node 1)

1. In Cloudflare Zero Trust, Networks, Tunnels: create a tunnel `qorpera-node01-screens` (cloudflared), with one public
   hostname `screens.qorpera.com` to `http://127.0.0.1:8793`. Copy the install command it shows; do not run it.
2. On node 1: `sudo -n qorpera-screens-door token`, paste the command (nothing shows), Enter. It says `written`.
3. `sudo -n qorpera-screens-door on`. It says `on`. `sudo -n qorpera-screens-door status` then says `connector ready`
   and which key sealed the token.
4. The web's `machineStreamUrl` is `wss://screens.qorpera.com`.

## Turning it off, and back

`sudo -n qorpera-screens-door off`: within seconds the hostname answers only Cloudflare's own error, every open
stream ends, and every window falls back to its pictures through the member bridge. `on` again brings it back with the
sealed token. A new token (Cloudflare's "refresh token"): `token` again; a running connector takes it at once. If the
host's credential key is ever replaced, the sealed token no longer opens: `token` again.

## Checks

`node --test deploy/screens-door/qorpera-screens-door.test.mjs` (in the deploy-node step) holds the files to the real
proof on a throwaway machine (POINTER-PROGRESS.md): a fake token sealed and then found in no log, journal, process list
or file but the sealed one.
