# Runtime Step 4 guest components

These are inactive integration components, selectively adapted from
`codex/step3-remaining-ops` at `2d72b74eadc6f1e81ccce65512b210bd9fd9fb7b`.
No deployed image, service, installer, provider or credential store is changed.
See [the integration status and acceptance gates](../first-node/RUNTIME-STEP-4-INTEGRATION.md).

The package now includes the reviewed [guest image installer](INSTALLATION.md),
boot-time runtime directories and a private demand-mounted tmpfs. It installs
code and protected unit references into an unconfigured guest and leaves all
office services inactive. Historical component notes below retain their original
scope; current installation and acceptance details are in that contract.

## Desktop wrapper

`qorpera-screen-session <screen_uuid> <ordinal> <display>` retains
TigerVNC, 1920×1200, XFCE and persistent per-screen desktop state. It validates
the ordinal/display pair, refuses path aliases, starts each child in a process
group, waits for both X and the window manager, emits a bounded readiness
record, and stops/reaps the groups when either child dies. Persistent state
is not deleted on close or recovery.

The existing authenticated guest supervisor must supply four existing,
disjoint, physical directories, verified by the Step 2 containment adapter:

- `QORPERA_WORKBENCH_ROOT`: noncanonical company working bytes.
- `QORPERA_DESKTOP_HOME`: desktop application home without provider credentials.
- `QORPERA_SCREEN_STATE_ROOT`: persistent desktop settings, keyed by screen UUID.
- `QORPERA_SCREEN_RUNTIME_ROOT`: ephemeral supervisor-owned runtime directories.

Before invocation, under the existing serialized guest reconcile, call
`prepareCompanyComputerScreenWallpaper({ binding, layout, boundary, templateId,
creature }, signal)` with the current agent metadata from the authorized cloud
registry. The service reads both fields for the bound screen through the
broker-only `qorpera_runtime_office_screen_appearance(p_binding)` when it starts
a desktop; an office that cannot read them still starts, with the figure every
client derives from the agent id. Explicit creature appearance takes precedence
over the reused template/identity derivation. The image's file names are
historical (`pebble`, `folio`, `brain`, `wisp`, `halo`, `ribbon`, `bloom`);
`cloud-company-computer-wallpapers.ts` maps each current avatar to the file
whose traced figure is that avatar, and a test pins the table to the art. The helper copies the image's
`/usr/share/backgrounds/qorpera-screen-<creature>.png` through an explicit
read/write and atomic rename into `<screenStateRoot>/<screen UUID>/wallpaper.png`;
it does not use the cross-filesystem `copyFile` syscall that failed in the old
VirtioFS proof. Repeat preparation when authenticated appearance changes.
When the image also carries the 24 hourly tone-on-tone frames
`qorpera-screen-<creature>-00.png` … `-23.png`, the helper stages them as
`<screen UUID>/backdrops/<HH>.png`; a partial set removes the directory and
keeps the static wallpaper. An optional provider-configured `timeZone` (IANA
name, `linux.desktopTimeZone` in the service configuration) is published as
`<screen UUID>/time-zone`; without it the desktop stays on the image's UTC.
Use the verified desktop-state writer identity/UID mapping: new directories are
`0700` and the wallpaper is `0600`. The supervisor must confirm the desktop can
read them; this helper does not chown NAS data or change credential permissions.

Supply its returned path as **`QORPERA_SCREEN_WALLPAPER`**. Package the included
executable `qorpera-screen-xfce` at `/usr/local/bin/qorpera-screen-xfce` alongside
the wrapper when image integration is separately authorized. The wrapper
refuses an absent helper or a wallpaper outside that screen's state directory.
Inside the clean per-screen D-Bus environment, the helper applies the agent
wallpaper (or the hourly set with xfdesktop's chronological cycle on the
wrapper's `TZ`), scaled image, hidden desktop icons, enabled native desktop
menu and disabled dock shadow **before** starting XFCE. Existing unrelated
desktop settings remain intact.

**One flat dock is the whole desktop chrome.** Before XFCE starts, the wrapper
rewrites the panel configuration in the screen state on every start: a single
opaque dark `xfce4-panel` along the bottom edge (full width, 80 px, 64 px
icons) holding, centred between two expanding gaps, exactly three launchers —
Browser (`/usr/local/bin/qorpera-screen-browser`), Files (`thunar` in the
workbench) and Terminal (`xfce4-terminal` running Bash in the workbench) — the
date at the left and an `HH:MM` clock at the right (equal widths, so the icons
sit on the centre line). There is no top bar and no window list:
the dock shows what is open, and the browser opens maximised. The image must
install `xfce4-terminal`, `thunar` and `tzdata`; no ambient/raw-NAS launch
command is ever written.

- *Icons.* Original Qorpera drawings (`design/dock-icons.js`: a globe, a
  folder, a prompt on coloured tiles; no third-party artwork). The wrapper
  carries them as base64 PNG and writes them to `config/qorpera-dock/`, so they
  need no icon theme and no SVG loader, and they reach existing computers with
  the script. `design/render.sh` renders them and rewrites the block
  between the wrapper's `DOCK-ICONS` markers; a test compares both.
- *Look and click feedback.* `config/gtk-3.0/gtk.css`, every rule scoped to
  `.xfce4-panel`: no button boxes, a soft hover and press highlight, the date
  dimmer than the time (Liberation Sans, regular), and click feedback on the
  icon itself: pushed in (`scale(0.9)`) while the button is held, then one
  420 ms jump (`@keyframes qorpera-dock-jump`, 8 px up, a small second bounce)
  when it is let go. The icon gets the bar's full height to move in (negative
  image margin). It plays once per click and once when the panel starts; nothing
  repeats, so a viewer gets a handful of small updates. This needs no
  compositor. The browser icon also pulses while the service opens the browser:
  the launcher alternates two icon frames for the first three seconds. What CSS
  on xfce4-panel cannot do: a bounce that lasts until the window appears for
  Files and Terminal, magnification under the pointer, labels on hover, or
  moving a neighbour aside; those need a dock application (for example
  `plank`) in a new image.
- *The dock is the window list.* All three icons run
  `qorpera-screen-browser` (no argument, `files` or `terminal`; one guest file
  because only existing files reach installed computers). It takes window ids
  from the root window's `_NET_CLIENT_LIST`, which includes minimised windows,
  matches `WM_CLASS` (instance or class) with `xprop -id`, and restores
  (`xdotool windowmap`) and activates the newest one. Only with no window does
  Files or Terminal start. The browser is matched by `qorpera-browser`, the
  class the office service gives it (`--class`), and by every name a Chromium
  build uses for itself: the image's browser is a Chrome for Testing build
  whose class does not start with "Chromium" or "Chrome".
- *Running marks.* Each icon state is an immutable launcher template in
  `config/qorpera-dock/` (`qorpera-<app>.desktop` idle, `qorpera-<app>-running.desktop`,
  and for the browser `-launching`, `-launching-2`, `-failed`); the icon shows
  a white pill under the tile (outlined while opening, amber when it did not
  open). A state is shown by naming its absolute path in the panel's configuration
  (`xfconf-query -c xfce4-panel -p /plugins/plugin-N/items`), which the panel
  follows at once. XFCE imports a managed copy and deletes the previous copy
  when `items` changes; the external template survives repeated transitions.
  The first version replaced the file the panel already
  showed and relied on the panel's file monitor; on a real xfce4-panel
  (capture of 20 September 2026) neither the terminal nor the browser got its
  mark. `qorpera-screen-xfce` starts a small watcher that blocks on
  `xprop -root -spy _NET_CLIENT_LIST`, drains a burst of events into one pass,
  and also looks every three seconds in case an announcement is lost (one
  `xprop` call; nothing more while the list is unchanged). A minimised
  application keeps its mark. Without `xprop` there are simply no marks.
- *Terminal.* Bash with a prompt that shows the folder (a per-screen rc file
  that reads `~/.bashrc` first), DejaVu Sans Mono 11 on a calm dark palette, no
  menu bar or scrollbar, 110x30. Written to `terminalrc` and repeated in the
  `xfce4-terminal` xfconf channel, where newer versions keep their settings.
  New windows open centred; title bars lose the roll-up button.
- *Nothing cosmetic can stop a desktop.* Generated files are written in a
  fresh `mktemp -d` directory (0700) and renamed into place, never at a
  predictable name. A look that cannot be written (CSS, icons, the extra icon
  states) or a window-manager setting that cannot be applied is reported on
  stderr and skipped; only the panel, the three idle launchers, the terminal
  configuration and the backdrop settings are required.
- *Made for VNC.* The helper turns off compositing, shadows, cycle previews and
  desktop zoom, keeps one workspace, and resizes with an outline. Xtigervnc
  runs with `-s 0` (never blanks). Its other defaults are already the
  low-latency set (60 fps frame clock, automatic framebuffer comparison);
  Tight quality and compression are chosen by the viewer client, not here.

**Verify on a real node before rollout** (none of this can be proven with the
doubles the tests use):

1. The panel follows its `items` setting: repeatedly open and close Files and Terminal
   and watch the white mark; click Browser and watch the pulse, the outlined
   mark, then the solid one. `xprop WM_CLASS` on the browser window shows
   `qorpera-browser` once the service revision is active. Repeat a failed browser
   launch and then a successful one; every pulse/state must remain available.
2. The GTK CSS applies: no button boxes, hover and press highlight, the pushed-in
   icon and the jump on release without the tile being cut off at the top, and
   the date and time labels equally wide (icons on the centre line of a 1920 px
   screen), the date dimmer than the time (`#clock-7` / `#clock-3`).
3. `xfsettingsd` (if the image runs it) keeps animations on and does not
   replace `gtk-3.0/settings.ini`; the xfwm4 settings stick after the session
   is up (`xfconf-query -c xfwm4 -p /general/use_compositing` is `false`).
4. Minimise each of the three applications and click its icon: the same window
   comes back, no second one starts. A second Browser click during a cold start
   keeps the hollow dot.
5. `--start-maximized` has no effect on the private sign-in display (no window
   manager there; the window must still fill `--window-size=1920,1200`).
6. Connect as `shared`: the browser is there within a few seconds. Close it,
   reconnect: it stays closed. `watch` never opens it.

`design/mock.html` with `design/mock.png`, `design/mock-browser.png` (the state
of the real capture: browser and terminal open, both marked) and
`design/mock-states.png` (every icon state) is the look check at 1920×1200. Nothing under `design/` is packaged.

**The company browser belongs to the screen.** The Browser launcher raises the
browser window already on the screen. When there is none it touches the empty
file `/run/qorpera/browser-request` (the service-owned `<runtime>/session`
directory bound into the desktop), waits about ten seconds for a Chromium
window and raises it; if none appears it asks once more and waits again. It
never opens a dialog: the icon pulses for three seconds and shows an outlined
mark from the first click while the browser is being opened (a further click
meanwhile shows the same and starts no second wait), and after both waits it
turns grey with an amber mark for six seconds and returns to normal. When the service finds the browser
already open for such a request it restores the window if it was minimised
(CDP window state only; it never chooses a tab).

**A member lands on the browser.** Nothing opens when a desktop starts (six
idle Chromiums would cost far more memory than six idle desktops). When a
viewer who may use the screen connects (`shared` or `control`, never `watch`),
the service asks for the browser exactly as the dock icon would (opener
`desktop`, same SQL decision, same presence record), retrying quietly at
0.3 s, 1.5 s and 4 s in case SQL does not see the viewer yet, then leaving it to
the dock. This happens once per desktop start: a member who closed the browser
on purpose does not get it back by reconnecting. Chromium starts with
`--start-maximized`, so the window manager fits it above the dock. It still
closes once nobody entitled remains.

*What a member sees in it.* The image's browser is Playwright's Chromium, a
Chrome for Testing build, which tells everybody that it "is only for automated
testing". `--disable-infobars` hides that bar: it is the switch Playwright
itself passes for this, Chrome for Testing reads it for that purpose and
Chromium, Chrome and Edge ignore it; no managed policy hides the bar, and
`--test-type` is not used because it also silences the warnings about unsafe
flags. `--class=qorpera-browser` gives the window one known class for the dock.
Each launch gives its command-line placeholder a unique
`about:blank#qorpera-startup-<uuid>` address. Immediately after connecting,
`tidyCompanyComputerBrowserTabs` reads and rechecks Chromium's targets, closing
only that exact placeholder when another page exists. The only page stays and
its marker is removed with a guarded `history.replaceState`, without navigation.
Restored blank/new-tab pages, loading targets and all other pages stay. A timed
out read cannot issue later cleanup commands. Cookies and profile data are
never touched. Detach preserves every shared tab, including agent-created blank
tabs: an unchanged URL cannot prove that a member has not used one. A desktop
request for an already-open browser opens no tab. The launch service and browser
child must ship together in a guest-code revision. The request file carries no
data and nothing in it is read. The office
service polls for it while the desktop is ready, removes it without following
links, and opens the screen agent's granted profile through the same contained
launch as before (bwrap, managed policy, egress relay, profile custody). Whether
that may happen is decided by the broker-only SQL function
`qorpera_office_screen_browser_grant(p_binding, p_opener)`: the screen agent's
current grant, and either an agent holding the screen lease or a live
shared/control viewer whose member still has input permission (then only a
company-owned profile; the dock (`desktop`) only ever opens a company-owned
profile, lease or not). Each open is recorded in
`qorpera_runtime_office_browser_opens` with the run and, as
`present_member_id`, the members who were live with input permission at that
moment. That is presence, not a proven click: a shared desktop cannot attribute
a press. At most one row per screen, present member and opener per 60 s.
An agent run joins the screen's browser instead of starting its own,
still proves its own grant under its lease before every action
(`qorpera_native_office_browser_grant`), and lets go of it at run end instead
of closing it. The window does not outlive the people entitled to it: the egress
relay repeats the SQL check every second, so it stays open while an agent holds
the lease or a member with input permission is live on the screen, and closes
within about a second once neither is. To keep a viewer's network blip from
closing a member's browser, SQL tolerates a check (never an open) for at most
60 s after the last recorded presence, in SQL time, and only while nothing was
fenced since: same office generation, privacy version, screen generation,
shared-viewer epoch and drain challenge, no takeover, same grant, a
company-owned profile, and a present member who still has input permission
under the same membership. The browser also closes with the screen: drain,
privacy fence, lost grant, service stop. A failed or cancelled action of a run
that drove the browser closes it too (only a physical close proves its
automation stopped); a run that never joined it closes nothing. Signing in to
third-party sites stays a takeover (`control`) activity under the contract;
nothing here records member keystrokes beyond the existing per-input commitment
ledger. `qorpera-screen-browser` is guest code: an existing computer gets the
new launcher through a guest-code revision, while the service side needs only
the service file and the SQL migration. The same holds for the dock:
`qorpera-screen-session` (panel, look, icons), `qorpera-screen-xfce` (VNC
settings, terminal look, running marks) and `qorpera-screen-browser` reach existing computers
through one guest-code revision and take effect at the next start of each
desktop; the browser's command line (`--start-maximized`, `--disable-infobars`,
`--class`) lives in `qorpera-company-computer-service.mjs`.
The owned startup placeholder also changes `office-browser-child.mjs`; include
that entry together with the service and three desktop scripts in the guest-code
revision. The dock matches the browser window with or without the new class.

**Each computer's own network (2026-09-28).** A computer (an agent's screen)
has a long-running shell and a desktop Terminal with a real network of their
own; the machine (this VM) hosts the computers. The office service still
creates one network namespace for each computer's shell and one for its
desktop, and asks the root plumber (`qorpera-computer-plumb`, one request per
connection on `qorpera-computer-plumb.socket`, which only the office account
can reach) to add a veth `qcmp<ordinal><s|d>` into it while its program still
waits at the start gate. The plumber takes no process on the office account's
word: it plumbs only a namespace under `/usr/bin/bwrap` (never the browser's
own copy) whose Tini's only child is still at the gate, and refuses when the
machine's firewall is not loaded. Requests, `--up` and `--down` run one at a
time under a lock on the plumber's own file, installed root-only (0500) so
that no computer can hold it.
`qorpera-computer-network.service` runs `qorpera-computer-plumb --up` at boot:
it loads `qorpera-computer-network.nft`, then turns forwarding on. The
computers reach the public internet on any port and protocol, and never a
private, shared, link-local, loopback or special range (the NAS, nodes,
Tailscale, cloud metadata, the LXD bridges), the machine itself or each other;
nothing comes in, and the machine forwards nothing else. Each computer also
gets the same ranges as a filter inside its own namespace, which it cannot
change, so losing the machine's table (a flush) still leaves nothing private
in reach. Each computer may hold 16,384 connections at once and all together
196,608 (the table holds 262,144), far above real work, so that computers
cannot fill the machine's connection table. Redirects are off everywhere.
Stopping the service (`--down`) removes every computer's link before the
firewall. Name servers are public. The browser keeps its own device-less
namespace and relay, so profiles, sign-ins and credentials stay out of the
shell. This needs a new image (the units, the firewall, the plumber, and the
`iproute2`, `nftables` and `iputils-ping` packages); the installer takes the
five network files together or not at all. The shell's init is a mode
(`--shell-host`) of `office-browser-child.mjs`. Without the plumber a computer
starts with loopback only, never with an unfiltered network.

The wrapper is not an authorization or sandbox implementation. Directory-name
validation cannot detect bind mounts, NAS aliases, unsafe inherited image
configuration, network routes or leaked credentials. The supervisor must
validate these before launch, sanitize the wrapper environment, and verify
readiness against its authenticated registry generation. Its `stop()` must
reap the entire service/cgroup, including daemonized descendants; the wrapper's
process-group cleanup is not sufficient proof by itself.

RFB uses a private Unix socket, `viewer.sock`, beneath the screen runtime
directory; TCP RFB and TCP X11 are disabled. Clipboard exchange, dynamic resize
and client overrides are disabled in TigerVNC as well as the gateway. RFB `None`
and X11 must be reachable only through the controlled guest channels.
`CompanyComputerLinuxDesktopLauncher` mounts those paths into its private
Bubblewrap namespace, checks both wrapper and RFB readiness, and keeps the
desktop alive after viewer disconnects. It uses root-owned `/usr/bin/Xtigervnc`
directly; the minimal sandbox does not mount ambient `/etc/alternatives`.

Both desktop and command namespaces require root-owned Bubblewrap, Tini and
Bash. A trusted execution gate under Tini confirms namespace parent-death
cleanup before monitor termination is safe. Immediate cancellation closes the
permission pipe and waits for actual exit; it cannot run the requested program.
After gate readiness, terminating namespace PID 1 also kills detached children.
The packaged service unit now specifies whole-cgroup shutdown for unexpected
broker failure; actual systemd crash/restart acceptance remains required.
A model must not reach another display, read the control broker's
environment or filesystem, or reach raw browser-profile storage through shell.
This restricts control/credential channels, not agents' shared company work.

Keep the gateway's RFB output filter on every guest connection. It requires the
wrapper's 1920×1200, 32-bit/24-depth true-color format and removes clipboard
messages in watch and control mode. Unsupported framing closes the connection;
the real image/decoder pairing still needs cloud acceptance before activation.

## Existing state adoption

The old guest used `<QORPERA_SCREEN_STATE_ROOT>/screen-<ordinal>` for desktop
state and `<QORPERA_CHROME_PROFILES>/screen-<ordinal>` for Chrome. The new
components use `<screenStateRoot>/<screen UUID>` and
`<browserProfilesRoot>/<explicitly granted profile UUID>`. Sharing the parent
directory does **not** adopt the old state, and symlink aliases are not allowed.

`planCompanyComputerStateAdoption` produces a pure path mapping from the
verified old registry identities and explicit profile dispositions. It rejects
cross-company/agent substitutions, duplicate mappings and missing profile
dispositions. It performs **no reads, copying, migration or authorization**.
The handoff's **Existing-state adoption procedure** defines inventory,
quarantine, fresh authorization, stopped-service proof, reviewed staging,
hash verification, journal completion and rollback. The existing boundary
adapter must deny startup while expected adoption is unresolved; a fresh
computer needs an explicitly empty inventory. Never use automatic UUID
directory creation to silently bypass existing state.

The provider's reviewed copy plan places the four guest roots below
`/var/lib/qorpera-office/.qorpera-adopted-<adoptionId>/`. NAS and adoption
ancestors may be owned by the office service only when private (`0700`). The
Linux state-directory opener walks from `/` through pinned directory
descriptors with no symlink following, verifies ownership/mode and canonical
paths again before returning the readable directory, and leaves mount identity
checking to the existing boundary. Foreign owners and group/world-writable
ancestors are refused. Root-owned executable, image, configuration and receipt
checks remain separate and unchanged. The service unit requires the physical
mounts and runtime directories; protected configuration plus preflight verifies
the exact adopted roots before either listener starts. The provider still must
install a verified boot-bound receipt and establish cloud activation first.

## Read-only preparation before activation

The separate `qorpera-company-computer-preparation.mjs` process reads only the
root-protected `/etc/qorpera-office/preparation.json`. The shared
`qorpera.office-guest-preparation/v1` request binds the allocation, generation,
image/bootstrap, actual guest boot and reviewed copy to a portable manifest of
paths, private permissions, lengths and hashes. Host inode numbers do not survive
virtiofs unchanged; the guest independently measures and compares its own inode
metadata across two complete passes. It requires the exact persistent mount,
unprivileged user/group identity, zero capabilities and finite kernel limits.
Links, special files, nested mounts, foreign owners, unexpected/missing entries
and changed content are refused. The request is reread after verification.

The packaged preparation unit has no automatic installation target. It uses a
private network, read-only NAS paths and no office service credentials. It starts
no browser, desktop or listener. Bootstrap must install the protected request and
create root-owned private `/run/qorpera-office-preparation`; systemd opens its
`result.json` before dropping the service uid. The report exposes only scope,
binding hashes, physical observation hash and counts, never copied content.

The provider must retain the infrastructure writer handoff and current SQL
authority while correlating a freshly completed systemd invocation, exact
request digest and current boot. A report file alone grants no authority and is
not an adoption receipt. Provider orchestration, protected receipt/configuration
installation and matching cloud activation still must be implemented before the
ordinary office service may start. Its active-state preflight is unchanged.

### Protected configuration installation

The unit selects six immutable credential files beneath
`/etc/qorpera-office/boots/%b/credentials`, where systemd expands `%b` to the
kernel boot ID as 32 lowercase hexadecimal digits. Initial configuration also
preserves the original `/etc/qorpera-office/credentials` files. Both sets must
match the original completion before configuration acknowledgement, startup
or restart; an acknowledged missing file or directory is refused without repair.
The boot directories are root-owned 0755 and their credential directories 0700;
individual credentials remain root-owned 0400. There is no current/latest link.
The image installer creates only the empty boot root and refuses existing boot
state. These files do not authorize a new boot: protected new-boot adoption,
configuration and SQL admission remain required after VM resume.

The path encoding follows upstream systemd's
[boot specifier implementation](https://github.com/systemd/systemd/blob/v257/src/shared/specifier.c)
and [credential source expansion](https://github.com/systemd/systemd/blob/v257/src/core/load-fragment.c).
The disposable systemd probe independently verifies current-boot selection and
refusal when only another boot and the original credential directory remain.

The packaged `qorpera-company-computer-configuration-control.mjs` accepts a command
UUID, staged configuration SHA-256 and boot UUID. It uses the same existing
process-owned preparation flock. The pinned image must also provision
`/etc/qorpera-office/credentials` as root:root 0700; the tmpfiles fragment now
includes that directory. The helper accepts only the protected 0400
`/run/qorpera-office-preparation/configuration-incoming-<sha256>.json`, bounded to
192 KiB. Its closed v1 request contains the original preparation command,
serialized service configuration and the five credential values for the six
fixed `LoadCredential` files. Credentials never appear in command arguments,
completion reports or diagnostics.

The configuration must match the prepared scope/generation, adopted layout,
mount, kernel limits, allocation/image/bootstrap/boot and exact receipt. Private
runtime paths remain fixed to the image contract. Token syntax/separation and
TLS certificate/key parsing are checked before installation. The current
successful preparation invocation and exact protected evidence are repeatedly
read while the ordinary service remains inactive. Atomic no-overwrite writes
install root:root 0400 files and retain a root-only command claim and hash-only
completion. Interrupted installation resumes the same bytes; missing or changed
acknowledged files cannot be repaired by replay. Neither helper starts the
ordinary service or changes cloud state.

Provider staging, credential custody, durable dispatch/readback and matching
SQL activation still need integration. Protected installation proves file
custody and preparation binding; it does not authenticate an endpoint, create
provider authority or establish service readiness. The Linux probe uses actual
files, kernel flock, TLS parsing and a SIGKILL/restart window with synthetic
credentials and a synthetic system manager. Actual systemd lifecycle remains
an acceptance gate.

Preparation now requires systemd's `INVOCATION_ID` and includes it in the report.
The oneshot unit uses `RemainAfterExit=yes` so its completed invocation can be
correlated explicitly. The provider must establish that it ran a fresh invocation
and verify the actual unit's successful exited state, not infer success from an
environment value or report file. The shared report parser checks the exact
request/content hashes and all binding fields; it does not query systemd.
The [upstream systemd documentation](https://raw.githubusercontent.com/systemd/systemd/main/man/systemd.exec.xml)
defines a new invocation identity for each unit runtime cycle. Linux fixtures
supply synthetic invocation IDs and do not claim actual systemd execution.

The packaged `qorpera-company-computer-preparation-control.mjs` root helper
accepts exactly a command UUID, staged request SHA and guest boot UUID. The pinned
image must pre-provision `/etc/qorpera-office` as protected root-owned local
configuration, `/run/qorpera-office-preparation` as root:root 0700, and its empty
root:root 0600 `control.lock`. The package supplies `qorpera-office-preparation.conf`
for installation at `/usr/lib/tmpfiles.d/qorpera-office-preparation.conf` in the
pinned image. Boot-time tmpfiles setup creates these paths without truncating an
existing lock. The provider must confirm this setup before dispatching the helper;
the helper does not run tmpfiles or repair a missing lock. The wrapper opens that existing file with no-follow
checks, then uses `flock --no-fork` through an inherited descriptor; it never
creates a missing lock. The child requires its own PID to hold the actual kernel
flock and validates all root uid/gid slots and the current kernel boot.

Control checks staged 0400 bytes and installs an identical 0444 request using
fsynced no-overwrite publication. The ordinary service must be inactive with no
pending job. It retains a root-only command claim before starting the one fixed
preparation unit. Existing claims only inspect completion; they never repeat
start. Both installed service units must match their protected packaged copies,
be loaded from their fixed paths, have no drop-ins and require no daemon reload.
Completion requires a fresh retained invocation, active/exited oneshot state,
zero main/control PIDs, no queued job, successful process exit and exact protected
report/request bytes. A final repeated check precedes the root-only
`completion.json`. This is preparation evidence, not an adoption receipt.

The systemctl clients have bounded lifetimes and sanitized output. The outer
helper bounds its child group to 350 seconds. A failed/lost startup reply keeps
the command claim; it cannot authorize a second start. The provider still needs
to reconcile uncertain LXD operations, retain this evidence and install the
matching receipt/configuration before fenced activation. Linux control fixtures
exercise real root file custody, atomic installation and kernel flock with a
synthetic systemd manager. Actual systemd execution remains an acceptance gate.

### Recorded exec output

LXD 6.9 runs a VM exec only with `record-output` and keeps the recorded stdout
and stderr on the host. Every pinned control the provider runs in an office has
one output contract (the provider's public procfs reads, `cat` of the boot id and
uptime, are separate: their stdout is their result):

- The eleven `/opt/qorpera-office/qorpera-company-computer-*-control.mjs` helpers
  and the two temporary software tools start through `runCompanyComputerControlEntry`
  (`packages/runtime/src/cloud-company-computer-control-entry.ts`). Success writes
  nothing. Any refusal or unexpected error (bad arguments, wrong boot, held lock,
  changed request, protected-file errors, an uncaught exception or an unhandled
  rejection) writes exactly the helper's fixed failure line to stderr, once, and
  exits 1. `--help` writes one fixed line to stdout. Every stdout/stderr stream
  write (console, `write`, `end(chunk)`) is dropped and Node's warning printer is
  removed.
- The code package loader (`OFFICE_CODE_PACKAGE_LOADER`) writes nothing on success
  and exactly `OFFICE_CODE_PACKAGE_LOADER_UNCONFIRMED` on any failure. Its
  `bootstrap.cjs` and `measure.cjs` tools print nothing; the provider reads their
  probe, receipt and measurement back from the root-owned files they publish.
- In all three lanes, only the locked flock child reads protected requests,
  credentials or evidence, and it runs with ignored stdio.

`packages/runtime/test/cloud-company-computer-control-entry.test.ts` runs the
packaged helpers with injected faults. `cloud-company-computer-control-output-linux.test.ts`
runs them and the loader as root on Linux, with a locked child that writes to
every stream and descriptor.

## Browser and shell

`PersistentCompanyComputerBrowser` uses the installed Chrome and existing
`playwright-core`; profile UUIDs and explicit grants come from cloud authority.
Its launch adapter is mandatory; it has no ambient Playwright launch fallback.
The profile root is broker-owned and separate from desktop home and workbench.
Do not restore the older `qorpera-chrome` ambient per-display profile launcher.
Member browser startup and sign-in need the same profile broker and typed
privacy handoff. Revocation must close control channels and suspend affected
viewers before secret input; masking password fields alone is insufficient.
An agent's browser snapshot is Playwright's aria snapshot, which copies every
input's value. While a private box (`COMPANY_COMPUTER_PRIVATE_FIELD_SELECTOR`:
password, one-time code, card, or a text box named for one) holds a value, the guest
shows every typed value as `[hidden]` and hides the private values wherever the
page repeats them; browser screenshots mask the same boxes in every frame. A
desktop screenshot cannot mask, so it is refused while a shown tab of the
screen's browser window holds such a value in any frame, or cannot answer
(checked before and after the capture). Shell commands still reach the screen's
X socket; that is closed separately.

`createCompanyComputerLinuxBrowserLaunch` runs Chromium in a separate checked
Bubblewrap namespace. Package Chromium at `/usr/lib/qorpera-chromium/chrome`,
the bundled `cloud-company-computer-browser-child.ts` entry at
`/usr/local/lib/qorpera/office-browser-child.mjs`, and the exact managed policy at
`/usr/local/share/qorpera/browser-policy.json`, all root-owned and immutable to
the broker. The launcher checks the policy against its source pin before launch.
Only the selected profile, workbench, X socket and private Unix egress relay are
mounted. HOME is ephemeral. DevTools uses inherited descriptors, never a port.
Chromium's renderer sandbox remains enabled; only its namespace permits nested
user namespaces. The shell and desktop still prohibit them.

The relay accepts bounded CONNECT requests to public IPv4 HTTPS destinations,
checks live grants and resolves once before connecting to the checked address.
It does not intercept TLS or log request bodies, URLs, cookies or pipe frames.
Managed policy blocks file selection dialogs, downloads, password saving,
extensions, local files, developer UI and JavaScript typed in the address bar.
The developer-availability policy must permit the trusted CDP connection; the
separate `devtools://*` block disables the UI. This distinction is checked by
real keyboard probes and [Chromium's UI admission code](https://raw.githubusercontent.com/chromium/chromium/151.0.7922.34/chrome/browser/devtools/devtools_window.cc).
File upload/download integration requires a later governed transfer path.

Shutdown closes the relay before requesting a bounded browser flush, then waits
for physical namespace exit. CDP disconnection alone must not kill a graceful
flush or confirm drain. A failed drain keeps the profile reserved. The manager
also owns pending launches and closes all profiles on service cancellation.

The v2 computer tools expose browser `list_tabs` and `select_tab`. Listing
returns up to 10 bounded title/URL previews and a `nextAfterTabId` cursor; pass
that cursor as `afterTabId` to continue. IDs identify only pages in the granted
context and current automation/lease/epoch/run. They are not authority, cannot
select another profile or display, and do not survive a changed admission or
guest restart. Renewal and tab reordering preserve them. Listing does not
create, select or close pages; selection focuses the explicitly identified page
through Playwright and the existing effect checks.

Pre-input ambiguity, unavailable IDs and already-closed targets preserve the
browser only after reauthorization. A closed selected page needs explicit tab
selection to resume page actions; it never silently switches to another page.
Failures during dispatched automation and cancellation close the control
channel; a replacement requires fresh authority and a proven drain, never
silent replay. The shared screen gate keeps cancellation armed through final
authorization and waits for browser shutdown before acknowledging takeover.

`CompanyComputerGuestAutomation` adapts Playwright and the image's `xdotool` and
`scrot`. Arbitrary shell and screenshot execution use
`CompanyComputerLinuxCommands` through `CompanyComputerGuestCommands`, composed
with the desktop and physical supervisor lifetimes. Agent commands receive only an assigned display and the
noncanonical workbench. Canonical Company File reads/writes must use the
governed projection/gateway, never the historical direct NAS `dataset/live`
route. Screenshot publishing uses the existing immutable asset boundary.
Page captures preserve their actual viewport dimensions within 1920×1200;
desktop captures must match the full fixed display. Receipts identify the
surface, width and height so page pixels are not treated as desktop coordinates.

Both scripts were syntax-checked locally. The Linux desktop probe additionally
runs the actual wrappers, XFCE and TigerVNC with two displays, independent pointer
control, private RFB handshakes, screenshots, persistent settings and normal,
failed and immediately cancelled startup cleanup. The fixture uses synthetic
authority/mount provisioning and a raw Pebble image, not final desktop styling.
The browser probe runs actual Chromium page tools and capture, verifies kernel
renderer sandbox state, private profile isolation, UI restrictions, private-IP
denial, cookie persistence across manager shutdown/restart, revocation and
ephemeral cleanup. Its authority, mount provisioning, HTTP content and asset
publisher are synthetic. Adoption tests copy synthetic local bytes.

The `--private` Linux probe exercises `startCompanyComputerLinuxPrivateSurface`:
a fresh Xvnc-only display with no XFCE/autostart or persistent desktop mounts,
the selected Chromium profile, and a dedicated empty tmpfs workbench. Provision
that tmpfs separately from all shared roots and both broker runtime roots, owned
by the broker with mode 0700 and root-owned ancestors. The containing service
must fence ordinary channels and prove all desktop/command/browser drains
before calling it. Its returned transport accepts only the exact private owner,
challenge, profile and screen; normal gateway ticket/input checks still apply.
No agent automation, capture or X handle is returned. The host-only
`CloudCompanyComputerPrivateSurfaceControl` calls
`qorpera_check_runtime_office_private_surface` on launch and renewal; status
metadata does not authorize a browser. Revocation closes the private browser
and X server and removes temporary state, while retaining the intended profile.
Exit acknowledgement remains possible after membership loss.

The private proof types synthetic content through real RFB, inspects a rendered
frame, verifies the old desktop's autostart process remains stopped, and tests
revocation and fresh-display reopening. Its authority and drain coordination
are fixture inputs, not whole-service handoff acceptance. Whole-guest privacy
composition with real authority, real website login, cloud provisioning and deployed acceptance
remain required before activation.

## Whole Linux guest and service

`CompanyComputerLinuxGuest` owns the adapters above as one physical office. Native session creation only binds authority; admitted effects prepare the desktop and wait for readiness. Shared desktops persist after native sessions and viewers close. The service-only shared-surface RPC renews idle authority. Privacy fencing cancels pending starts as well as active sessions, and private preparation waits for every shared resource drain. Recovered private viewers are checked before launch; ready private browsers survive viewer disconnect. Exit physically closes private resources before shared work resumes.

`startCompanyComputerLinuxOfficeService` connects this guest to the existing TLS/WSS service, shared gate and supervisors. Unexpected idle process failure cancels the listeners and awaits cleanup; failed cleanup stays unconfirmed. The service constructs the adopted identity/mount boundary and a per-run screenshot publisher that stores nothing: company objects are gone, so a capture is checked against its asset and handed over once. The packaged entrypoint loads protected provider/adoption configuration; it ignores the configuration's capture object gateway URL until the orchestrator drops it. Governed Company File projection, provider lifecycle and generation replacement remain unfinished. Capture publication and completed-result read authorization are tested against local SQL; the native image patch has Darwin loopback acceptance, while Linux artifact acceptance and the combined physical guest/SQL/object-gateway run remain pending. No production startup is enabled by this composition.

## Office process package

`node scripts/package-company-computer.mjs --out /absolute/new-directory` writes a new local package and refuses to overwrite an existing directory. Its manifest hashes every file, including Playwright 1.62.1 and its resources, contained browser helper, managed policy, wrappers and existing creature artwork. It supplies service code/assets, not a complete OS/browser image, image signature or deployment.

The eventual image installer must place the service bundle and its `node_modules` together under root-owned `/opt/qorpera-office`, the unit under `/etc/systemd/system`, `office-browser-child.mjs` at `/usr/local/lib/qorpera/office-browser-child.mjs`, the screen wrappers under `/usr/local/bin`, `qorpera-browser-policy.json` at `/usr/local/share/qorpera/browser-policy.json`, and the wallpaper files under `/usr/share/backgrounds`. Image ancestors must be root-owned and unwritable by the broker. The provider must separately pin/provision Node, Bubblewrap, Tini, XFCE/TigerVNC, Chromium and the remaining OS dependencies. Packaging performs none of those installations.

`qorpera-company-computer.service` uses the dedicated unprivileged `qorpera-office` identity. The provider must prepare the exact `/var/lib/qorpera-office` mount and private adopted tree described above, with persistent children `workbench`, `desktop`, `screens`, `profiles`. The mount and adoption ancestors may be private service-owned state. `/run/qorpera-office` has protected root-owned ancestors, private runtime children `display`, `browser`, `captures`, and a separate empty `private` tmpfs. Persistent state is not created, chowned or removed by startup. Protected configuration must name the same mounts/paths and limits; the unit defaults to 4 GiB, 512 tasks and 200% CPU. The boundary verifies the actual kernel limits and mounts.

Configuration is the closed `qorpera.company-computer-service/v1` document defined by `CompanyComputerServiceConfig`: exact company/environment/office/logical-computer scope, generation, HTTPS registry/object-gateway origins, numeric listener IP addresses with distinct ports, explicit HTTPS viewer origins, layout, limits, mount identities, runtime roots and provider/adoption attestation. Secrets and executable/environment overrides are not accepted in that document. The native and viewer listeners use the same protected TLS certificate/key pair; its SANs and the image trust store must cover the configured endpoints.

The unit supplies six `LoadCredential` files: `qorpera-office-config`, `qorpera-office-registry`, `qorpera-office-native`, `qorpera-office-objects`, `qorpera-office-tls-cert`, and `qorpera-office-tls-key`. Registry and native credentials must differ; the native token is a 43-character base64url value. The service no longer reads `qorpera-office-objects`: the unit still supplies it, and the configuration still names the object gateway origin, until the orchestrator drops both. Credential reads require read-only regular files, one link, safe ownership and immutable root-owned ancestors, and reject symlinks/FIFOs, overlong or changed reads. There is no ambient token fallback. The registry key remains host-only; it never enters browser/command namespaces. Provider subscription credentials are absent from this service.

The process registers SIGINT/SIGTERM before credential loading and awaits its service lifetime and cleanup. `KillMode=mixed` gives the broker its graceful drain interval, then kills all remaining cgroup members on main-process exit or the 70-second deadline, as specified by [systemd's kill contract](https://raw.githubusercontent.com/systemd/systemd/main/man/systemd.kill.xml). Credential layout follows [systemd's credential contract](https://raw.githubusercontent.com/systemd/systemd/main/man/systemd.exec.xml). A systemd `active` process state is not cloud office readiness. Current active-office authority and physical preflight are still required; provider preparation/activation must be integrated before rollout.

Local verification covers closed configuration, cancellation during startup, cleanup failure propagation, real Linux credential metadata/descriptor checks and package startup outside the workspace. `scripts/test-company-computer-service-linux.mjs` uses a prepared local image and disabled networking. It verifies neither live systemd supervision nor combined provider/SQL/TLS/physical readiness. Those remain release gates.

The disposable `--guest` probe runs two real desktops, shared shell work and browser capture through the endpoint, and private entry/recovery/exit through the supervisors. It preserves files and desktop lifetime across client/session closure, then checks whole cleanup. SQL/native authority, readiness and asset publication are fixtures. TLS tests separately verify service shutdown with simulated physical failures; a real database, TLS listeners and physical guest have not yet been proved in one combined run.

## Protected adoption projection and physical readiness

`startCompanyComputerLinuxOfficeService` now constructs `CompanyComputerLinuxBoundary`; it accepts an `attestation` configuration rather than an arbitrary readiness callback. Before listeners start, and again through guest effects/idle renewals, the boundary requires:

- Current office generation, pinned image/bootstrap identity, active logical computer and Company File, and an unreleased matching LXD machine allocation. Founder stop and maintenance deny readiness.
- The provider-attested current Linux boot ID, zero capabilities, no-new-privileges and finite cgroup ceilings.
- All shared roots on the exact configured nonvolatile workbench mount, separate private tmpfs, safe ownership, disjoint paths and no nested mount aliases.
- A root-owned adoption receipt outside the guest roots, with the exact configured digest. Its closed `qorpera.office-state-adoption/v1` record contains `state: complete`, scope, generation, allocation/instance/image/bootstrap/boot identity, layout, workbench mount, inventory/review digests and `verified_empty` or `migration_completed` disposition.

This receipt is a read-only projection of the existing provider/adoption journal. The provider verifies inventory, review, physical stop/copy/publication and NAS backing before invoking the protected preparation helper. After the exact manifest passes guest preparation and the root helper verifies its completed systemd invocation, the helper atomically publishes `/etc/qorpera-office/adoption.json` as root:root `0444`. This copied-state path uses `migration_completed`, even for an initialized empty destination; it never claims the historical source was empty. `inventorySha256` identifies the retained copy's output inventory. The v2 preparation completion binds the receipt digest, and the provider independently derives and rereads its exact bytes before retaining evidence. Conflicting existing receipts are never overwritten, and a missing acknowledged receipt is not recreated.

A successful receipt reader does not perform the earlier operations, measure an LXD image from inside the VM, activate an office or grant a browser profile. Reboot/replacement requires a freshly attested boot identity; existing working bytes are retained and are not reinterpreted as a new empty inventory. Protected configuration/credential delivery, cloud activation, supervisor integration and actual systemd lifecycle acceptance remain required.

The `--boundary` probe uses a unique persistent Docker volume, a synthetic root attester and synthetic cloud responses. The broker runs without capabilities and checks actual filesystem/kernel metadata, denies receipt mutation/aliases/wrong owners, rejects changed boot and mount identities, and preserves working files. The volume is removed after the disposable probe. This is not live NAS adoption or an end-to-end provider acceptance record.

## Governed service-only software revisions (temporary provider-pinned tools)

**Before updating an office's code (from bundle v98): make sure its image cannot update itself.** The office service and preparation refuse to run unless the image masks the five apt self-update units (`RUNNER_IMAGE_SELF_UPDATE_ENABLED:<UNIT>`, see [INSTALLATION.md](INSTALLATION.md)). An office on an older, unmasked image gets the masks in one of two ways: a re-image with the v98 installer, or a service-only or guest-code revision installed by the install tool at or after the version that masks (below), which masks before the new service lands. A code-only package revision (`office-code-package-control.ts`) does not mask, so such an office must be re-imaged before it. Installed into an unmasked office any other way, the new service refuses on every start (three failed starts, then systemd gives up) and preparation refuses too, so the office stays down; the signed statement and the install receipt do not record the masks.

The historical office image is never rebuilt for a service-only update. Instead the provider stages two standalone, independently pinned root tools into the root-only `/run/qorpera-office-preparation` inbox and runs them under the existing preparation flock:

| Tool | Entry point | Staged path | Purpose |
|---|---|---|---|
| install | `office-service-software-control.ts` | `software-control.mjs` | Masks the image's apt self-update units (see below). Verifies the signed statement/plan, stopped predecessor custody and the capability-gated SQL install challenge, then atomically installs the target service bytes and writes `/var/lib/qorpera-office-service-software/<updateId>/installed.json` (the root-only journal root is created on the first revision; the historical image ships without it). No start, no SQL acknowledgement. |
| measure | `office-service-software-measurement-control.ts` | `software-measurement-control.mjs` | Reads a staged canonical invocation challenge, claims its nonce once, measures the actual running service (bytes, invocation, PID, cgroup, configuration) and publishes a closed receipt `software-measurement-<challengeId>.json`. No SQL, no capability, no start or activation. |

The install tool also masks the office image's apt self-update units (`apt-daily{,-upgrade}.{timer,service}`, `unattended-upgrades.service`) after its local checks and before its own challenge check (`office-self-update-mask.ts`). It runs inside the provider's 5 s install challenge, so units already masked skip the mask call and its systemd reload, and each check is one `systemctl` call. It refuses while an apt job is still running and never stops one mid-upgrade; on an office just woken, wait until `apt-daily.service` and `apt-daily-upgrade.service` are inactive or failed before the install step (a refusal shows only as `UNCONFIRMED` and uses one challenge and one attempt). The mask is idempotent, so a retried install is safe and fast. The signed receipt does not record the masks; a v98+ office service refuses to start without all five, so the successor's measured start proves them.

`scripts/package-office-service-software-control.mjs --out <new-directory>` builds both bundles and a `qorpera.office-software-control-package/v2` manifest with one digest per tool. Both launch through `office-software-control-launcher.ts`: the parent pins its own bytes and location, opens the preparation lock and re-executes itself under `flock --exclusive --nonblock --no-fork` with an empty environment; only the locked child works. Execution caps (60 s install, 5 s measure) never extend a SQL challenge.

Provider side (`packages/runner-orchestrator/src/lxd-office-software-transport.ts`): staging of tools/trust/manifests/service/capability, per-attempt durable journal records (`software-install-…` / `software-measurement-…` dispatch, accepted, evidence) under the provider journal root, LXD exec of a pinned tool, root read-back of the receipt or measurement, and an independent host-side digest of the installed target. The optional service configuration key `softwareLanePath` names a `qorpera.lxd-office-software-lane/v1` document (expected revision and service artifact, both tool digests, optional signed plan, and the path of the 64-hex provider capability credential). With a lane present, same-boot and new-boot activations require a fresh capability-bound measurement before activation; without it, unenrolled behaviour is unchanged.

Operator tooling for one revision (no generalized update framework): `scripts/prepare-office-service-software-revision.mjs` derives the next inventory from the installed image's package manifest with **only** the service entry replaced (`--next-service`), or — a **guest-code** revision — with the service and/or named closed guest code entries replaced (repeatable `--next-file <entry>=<path>`; the closed list is `COMPANY_COMPUTER_SERVICE_SOFTWARE_FILES` in `@qorpera/contracts`: the control bundles and the image installer under `/opt/qorpera-office`, the browser child under `/usr/local/lib/qorpera`, the three `/usr/local/bin/qorpera-screen-*` scripts and the browser policy; units, tmpfiles fragments, the AppArmor profile, wallpapers and the browser runtime are never revised this way). The statement then lists the revised entries with their destination path and mode in both `previous.files` and `next.files`, `acceptance.change` is `guest-code`, and the install tool stages each changed entry as `software-file-<sha256>`, installs it atomically at its destination with the contract mode under the same per-attempt journal (`previous-<entry>`, `next-<entry>`, `install-intent-<entry>.json`) and lists the installed entries in the receipt (`files`); the provider measures every installed entry host-side (`measuredFiles` in the evidence) before acknowledging. The update document names the revision directory as `filesDir` for a guest-code revision. On the database side, migration `20260915220000_runtime_office_guest_code_revision.sql` patches the reviewed `qorpera_begin_office_software` / `qorpera_ack_office_software_install` / `qorpera_enroll_office_software` functions in place: `next` and the specification may carry a validated closed `files` list, `acceptance.change` must be `guest-code` exactly when both inventories list the same entries, a revision whose service is unchanged is accepted only when a listed entry changed, receipts must carry exactly the installed entries, and stored revision specifications keep the service specification without the list (the package manifest digest binds the inventory). The preparer signs the statement with the operator's ed25519 key (read from a PEM, never printed) and writes `envelope.json`, `plan.json` (fresh `updateId`/`successorActivationId`, `stopAcknowledgementSha256` = canonical digest of the retained SQL stop acknowledgement), `trust.json`, both manifests, the service bytes and a digest manifest, verifying the set with `verifyLxdOfficeServiceSoftware` before returning. On the node, `qorpera-office-software-update.cjs` (packaged with the provider) runs exactly one step per invocation — `enroll --evidence-sha256 …` (revision 0 baseline only), `begin`, `stage`, `install`, `status` — from a protected `qorpera.lxd-office-software-update/v1` document, as the provider user under the lifecycle's own journal `adoption.lock` flock while the ordinary provider service is stopped; it composes `LxdOfficeSoftwareControl`, the staging/transport functions and the retained `service-stop-request-…`/`service-stop-completed-…` journal records, never loops or retries, and prints closed JSON without either credential.
