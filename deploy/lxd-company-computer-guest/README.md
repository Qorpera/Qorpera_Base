# Company Computer guest image contract

The Company Computer image is a strict superset of the LXD runner guest
image: the complete runner contract nests under `runner/` in the staged
package (pinned by its manifest hash), and this layer adds the per-screen
desktop stack plus the standing screen and runner services.

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
  `dbus-x11`, `x11-xserver-utils`, `xauth`, and pinned Google Chrome. One screen is one TigerVNC
  display with an XFCE session, launched by `/usr/local/bin/qorpera-screen-session`
  as the work account. Its working directory is the mounted `live` Company
  File, while HOME and all XFCE state live under the dataset's hidden
  `.qorpera-computer/` directory. Every VNC
  socket binds to guest loopback only; the token-gated viewer listener in
  the screen agent is the sole remote path in, and nothing is ever publicly
  routable. Each screen keeps its own persistent XDG state on the dataset,
  wears its attached agent's wallpaper on a 16:10 desktop without raw desktop
  icons, keeps the native XFCE desktop menu available, and starts with a large
  transparent, shadow-free bottom dock for Chrome, Files, and Terminal. The
  Files and Terminal launchers enter the live Company File explicitly;
  Terminal starts a usable Bash session even though the work account itself
  is non-login.
- **`qorpera-company-computer-bootstrap.service`** — root oneshot the
  provider enables after pushing `/var/lib/qorpera-bootstrap/company-computer.json`
  and the credential files. It verifies the delivered authority, refuses to
  run when the NAS dataset is not a mounted filesystem, verifies the `live`
  tree and NAS sharing group, prepares hidden machine state, and starts the
  native-provider, runner, and screen services. It never creates or chowns
  the live Company File.
- **Direct Company File:** `/srv/qorpera/dataset/live` is the existing NAS
  tree, mounted straight into desktops and jobs. There is no publication-head
  sync service and no per-turn copy/capture pass. Ordinary writes are durable
  and visible to the company immediately. NAS filesystem snapshots provide
  occasional rollback points outside the turn-completion path.
- **`qorpera-company-computer-screens.service`** — the screen agent:
  converges live desktop sessions to the control-plane screens registry and
  serves the viewer listener. Deliberately shares `/tmp` so computer-use
  tasks in the runner lane can reach the screens' X sockets — screens are
  parallel work surfaces on one trust domain, never boundaries.

**Computer use on a screen**: a turn executing on the shared machine gets
`DISPLAY` (plus `QORPERA_SCREEN_ORDINAL` / `QORPERA_SCREEN_VNC_PORT`) in its
harness environment automatically whenever its staff agent has a screen
attached — the runner leases the screen through the loopback occupancy
broker (`127.0.0.1:8447`), renews it while the job runs, and releases it at
the end; the control plane's claim RPC enforces the one-task-per-screen
fence. Agents simply use X tooling against `DISPLAY`; the identity
boundary's own environment (HOME, capsule directories, PATH) can never be
overridden by this path.

**Screens on demand**: an agent without a screen is not turned away. When
the broker finds no screen for the requesting staff agent, the screen agent
asks the control plane to provide one (`qorpera_ensure_company_computer_screen`,
service-role): an existing free screen is attached to the agent, or a new
one is registered up to the machine's declared capacity (bootstrap
`screens.max_screens`, default 8). The desktop is converged live and the
grant is answered only once the display's loopback socket accepts, so the
turn never races the X server. Only when the machine genuinely cannot offer
a screen — capacity exhausted, cloud unreachable — does the turn run
headless.

**Screen power, machine power** (founder model 2026-08-26): agents and
members power their own screens on and off, never the machine — the
Company Computer's power is derived from them. Each registry screen is
`open` or `closed`; the screen agent runs desktops only for open screens,
and each poll tick sweeps screens nobody has touched for the idle window
(`screens.idle_close_seconds`, default 900; 0 disables) into `closed`
(`qorpera_sweep_idle_company_computer_screens`). Closing loses nothing:
the row, the attachment, and the identity persist for the next open. The
on-demand path reopens the requesting agent's screen automatically, and
members open a screen from the app (`qorpera_open_company_computer_screen`).
On the host, the provider's reconcile derives machine power: any open
screen (or live task assignment) keeps the VM up, and after
`idlePowerOffSeconds` (default 300; 0 keeps the machine always on) of
none, the VM stops with reason `idle` — a screen opening later powers it
back on, while a maintenance stop stays down until the operator returns.
Ordinary turns never depend on any of this: headless execution over the
company file is the default, and a screen is something an agent opens
when its work wants one.

The published image starts nothing on its own: all three units are
installed disabled (the ephemeral runner bootstrap entry inherited from the
nested contract is disabled too), and the provider's
`systemctl enable --now qorpera-company-computer-bootstrap.service` after
its file push is the single entry point.

The host-side viewer leg and app surface live in the provider and shell
layers rather than in this image contract.
