# Company Computer guest image contract

The Company Computer image is a strict superset of the LXD runner guest
image: the complete runner contract nests under `runner/` in the staged
package (pinned by its manifest hash), and this layer adds the per-screen
desktop stack plus the two standing agents the shared machine runs.

Build the staged package with:

```bash
node scripts/package-lxd-company-computer-guest.mjs --signed-runner-image <directory>
```

(`--contract-only` builds the contract without the signed runner OCI archive,
for tests.) Then stage it on the node and run
`deploy/first-node/build-lxd-company-computer-image-candidate.sh`, which is
pinned to the exact package manifest checksum in lockstep with
`scripts/package-lxd-company-computer-guest.test.mjs`.

What this layer adds on top of the runner contract:

- **Desktop stack:** `xfce4`, `xfce4-terminal`, `tigervnc-standalone-server`,
  `dbus-x11`, `x11-xserver-utils`, `xauth`. One screen is one TigerVNC
  display with an XFCE session, launched by `/usr/local/bin/qorpera-screen-session`
  as the work account with the shared dataset workbench as HOME. Every VNC
  socket binds to guest loopback only; the token-gated viewer listener in
  the screen agent is the sole remote path in, and nothing is ever publicly
  routable.
- **`qorpera-company-computer-bootstrap.service`** — root oneshot the
  provider enables after pushing `/var/lib/qorpera-bootstrap/company-computer.json`
  and the credential files. It verifies the delivered authority, refuses to
  run when the NAS dataset is not a mounted filesystem, hands the dataset's
  working directories to the work account, and starts the two agents.
- **`qorpera-company-computer-sync.service`** — the delta-sync agent keeping
  the standing Company File checkout tracking the verified head. Runs as the
  unprivileged work account; every input arrives through systemd
  `LoadCredential=`. Object storage selection is explicit
  (`QORPERA_OBJECT_STORAGE_PRIMARY`, shipped as `supabase` for the
  acceptance profile); NAS-primary deployments override it through a
  drop-in naming the object gateway URL and token, and anything else fails
  closed.
- **`qorpera-company-computer-screens.service`** — the screen agent:
  converges live desktop sessions to the control-plane screens registry and
  serves the viewer listener. Deliberately shares `/tmp` so computer-use
  tasks in the runner lane can reach the screens' X sockets — screens are
  parallel work surfaces on one trust domain, never boundaries.

The published image starts nothing on its own: all three units are
installed disabled (the ephemeral runner bootstrap entry inherited from the
nested contract is disabled too), and the provider's
`systemctl enable --now qorpera-company-computer-bootstrap.service` after
its file push is the single entry point.

Not yet part of this contract: the company-flavor runner-lane bootstrap
(the ephemeral runner bootstrap expects `bootstrap.json` and the ephemeral
service schema, so turn execution on the shared machine still needs its own
bootstrap step), the host-side viewer leg brokering member capabilities,
and a browser in the desktop stack.
