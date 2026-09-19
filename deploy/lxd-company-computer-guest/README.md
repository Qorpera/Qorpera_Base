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
desktop settings remain intact. Before that, the wrapper rewrites the panel
configuration in the screen state on every start: a top bar with the window
list and clock, and a dock with exactly three launchers — Terminal
(`xfce4-terminal` running Bash in the workbench), Files (`thunar` in the
workbench) and Browser (`/usr/local/bin/qorpera-screen-browser`). The image
must install `xfce4-terminal`, `thunar` and `tzdata`; no ambient/raw-NAS launch
command is ever written.

**The company browser belongs to the screen.** The Browser launcher raises the
browser window already on the screen. When there is none it touches the empty
file `/run/qorpera/browser-request` (the service-owned `<runtime>/session`
directory bound into the desktop), waits about ten seconds for a Chromium
window and raises it; if none appears it says only that the browser could not
be opened. The file carries no data and nothing in it is read. The office
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
(`qorpera_native_office_browser_grant`), and lets go of it at run end; the
window stays. The browser closes with the screen: drain, privacy fence, lost
grant, service stop, and, as before, when an agent action fails or is cancelled
mid-flight (only a physical close proves its automation stopped). Signing in to
third-party sites stays a takeover (`control`) activity under the contract;
nothing here records member keystrokes beyond the existing per-input commitment
ledger. `qorpera-screen-browser` is guest code: an existing computer gets the
new launcher through a guest-code revision, while the service side needs only
the service file and the SQL migration.

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

## Browser and shell

`PersistentCompanyComputerBrowser` uses the installed Chrome and existing
`playwright-core`; profile UUIDs and explicit grants come from cloud authority.
Its launch adapter is mandatory; it has no ambient Playwright launch fallback.
The profile root is broker-owned and separate from desktop home and workbench.
Do not restore the older `qorpera-chrome` ambient per-display profile launcher.
Member browser startup and sign-in need the same profile broker and typed
privacy handoff. Revocation must close control channels and suspend affected
viewers before secret input; masking password fields alone is insufficient.

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

`startCompanyComputerLinuxOfficeService` connects this guest to the existing TLS/WSS service, shared gate and supervisors. Unexpected idle process failure cancels the listeners and awaits cleanup; failed cleanup stays unconfirmed. The service constructs the adopted identity/mount boundary and a per-run immutable screenshot publisher. The packaged entrypoint loads protected provider/adoption and capture-object gateway configuration. Governed Company File projection, provider lifecycle and generation replacement remain unfinished. Capture publication and completed-result read authorization are tested against local SQL; the native image patch has Darwin loopback acceptance, while Linux artifact acceptance and the combined physical guest/SQL/object-gateway run remain pending. No production startup is enabled by this composition.

## Office process package

`node scripts/package-company-computer.mjs --out /absolute/new-directory` writes a new local package and refuses to overwrite an existing directory. Its manifest hashes every file, including Playwright 1.62.1 and its resources, contained browser helper, managed policy, wrappers and existing creature artwork. It supplies service code/assets, not a complete OS/browser image, image signature or deployment.

The eventual image installer must place the service bundle and its `node_modules` together under root-owned `/opt/qorpera-office`, the unit under `/etc/systemd/system`, `office-browser-child.mjs` at `/usr/local/lib/qorpera/office-browser-child.mjs`, the screen wrappers under `/usr/local/bin`, `qorpera-browser-policy.json` at `/usr/local/share/qorpera/browser-policy.json`, and the wallpaper files under `/usr/share/backgrounds`. Image ancestors must be root-owned and unwritable by the broker. The provider must separately pin/provision Node, Bubblewrap, Tini, XFCE/TigerVNC, Chromium and the remaining OS dependencies. Packaging performs none of those installations.

`qorpera-company-computer.service` uses the dedicated unprivileged `qorpera-office` identity. The provider must prepare the exact `/var/lib/qorpera-office` mount and private adopted tree described above, with persistent children `workbench`, `desktop`, `screens`, `profiles`. The mount and adoption ancestors may be private service-owned state. `/run/qorpera-office` has protected root-owned ancestors, private runtime children `display`, `browser`, `captures`, and a separate empty `private` tmpfs. Persistent state is not created, chowned or removed by startup. Protected configuration must name the same mounts/paths and limits; the unit defaults to 4 GiB, 512 tasks and 200% CPU. The boundary verifies the actual kernel limits and mounts.

Configuration is the closed `qorpera.company-computer-service/v1` document defined by `CompanyComputerServiceConfig`: exact company/environment/office/logical-computer scope, generation, HTTPS registry/object-gateway origins, numeric listener IP addresses with distinct ports, explicit HTTPS viewer origins, layout, limits, mount identities, runtime roots and provider/adoption attestation. Secrets and executable/environment overrides are not accepted in that document. The native and viewer listeners use the same protected TLS certificate/key pair; its SANs and the image trust store must cover the configured endpoints.

The unit supplies six `LoadCredential` files: `qorpera-office-config`, `qorpera-office-registry`, `qorpera-office-native`, `qorpera-office-objects`, `qorpera-office-tls-cert`, and `qorpera-office-tls-key`. Registry, native and object credentials must differ; native/object tokens are 43-character base64url values. Credential reads require read-only regular files, one link, safe ownership and immutable root-owned ancestors, and reject symlinks/FIFOs, overlong or changed reads. There is no ambient token fallback. The registry key remains host-only; it never enters browser/command namespaces. Provider subscription credentials are absent from this service.

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

The historical office image is never rebuilt for a service-only update. Instead the provider stages two standalone, independently pinned root tools into the root-only `/run/qorpera-office-preparation` inbox and runs them under the existing preparation flock:

| Tool | Entry point | Staged path | Purpose |
|---|---|---|---|
| install | `office-service-software-control.ts` | `software-control.mjs` | Verifies the signed statement/plan, stopped predecessor custody and the capability-gated SQL install challenge, then atomically installs the target service bytes and writes `/var/lib/qorpera-office-service-software/<updateId>/installed.json` (the root-only journal root is created on the first revision; the historical image ships without it). No start, no SQL acknowledgement. |
| measure | `office-service-software-measurement-control.ts` | `software-measurement-control.mjs` | Reads a staged canonical invocation challenge, claims its nonce once, measures the actual running service (bytes, invocation, PID, cgroup, configuration) and publishes a closed receipt `software-measurement-<challengeId>.json`. No SQL, no capability, no start or activation. |

`scripts/package-office-service-software-control.mjs --out <new-directory>` builds both bundles and a `qorpera.office-software-control-package/v2` manifest with one digest per tool. Both launch through `office-software-control-launcher.ts`: the parent pins its own bytes and location, opens the preparation lock and re-executes itself under `flock --exclusive --nonblock --no-fork` with an empty environment; only the locked child works. Execution caps (60 s install, 5 s measure) never extend a SQL challenge.

Provider side (`packages/runner-orchestrator/src/lxd-office-software-transport.ts`): staging of tools/trust/manifests/service/capability, per-attempt durable journal records (`software-install-…` / `software-measurement-…` dispatch, accepted, evidence) under the provider journal root, LXD exec of a pinned tool, root read-back of the receipt or measurement, and an independent host-side digest of the installed target. The optional service configuration key `softwareLanePath` names a `qorpera.lxd-office-software-lane/v1` document (expected revision and service artifact, both tool digests, optional signed plan, and the path of the 64-hex provider capability credential). With a lane present, same-boot and new-boot activations require a fresh capability-bound measurement before activation; without it, unenrolled behaviour is unchanged.

Operator tooling for one revision (no generalized update framework): `scripts/prepare-office-service-software-revision.mjs` derives the next inventory from the installed image's package manifest with **only** the service entry replaced (`--next-service`), or — a **guest-code** revision — with the service and/or named closed guest code entries replaced (repeatable `--next-file <entry>=<path>`; the closed list is `COMPANY_COMPUTER_SERVICE_SOFTWARE_FILES` in `@qorpera/contracts`: the control bundles and the image installer under `/opt/qorpera-office`, the browser child under `/usr/local/lib/qorpera`, the three `/usr/local/bin/qorpera-screen-*` scripts and the browser policy; units, tmpfiles fragments, the AppArmor profile, wallpapers and the browser runtime are never revised this way). The statement then lists the revised entries with their destination path and mode in both `previous.files` and `next.files`, `acceptance.change` is `guest-code`, and the install tool stages each changed entry as `software-file-<sha256>`, installs it atomically at its destination with the contract mode under the same per-attempt journal (`previous-<entry>`, `next-<entry>`, `install-intent-<entry>.json`) and lists the installed entries in the receipt (`files`); the provider measures every installed entry host-side (`measuredFiles` in the evidence) before acknowledging. The update document names the revision directory as `filesDir` for a guest-code revision. On the database side, migration `20260915220000_runtime_office_guest_code_revision.sql` patches the reviewed `qorpera_begin_office_software` / `qorpera_ack_office_software_install` / `qorpera_enroll_office_software` functions in place: `next` and the specification may carry a validated closed `files` list, `acceptance.change` must be `guest-code` exactly when both inventories list the same entries, a revision whose service is unchanged is accepted only when a listed entry changed, receipts must carry exactly the installed entries, and stored revision specifications keep the service specification without the list (the package manifest digest binds the inventory). The preparer signs the statement with the operator's ed25519 key (read from a PEM, never printed) and writes `envelope.json`, `plan.json` (fresh `updateId`/`successorActivationId`, `stopAcknowledgementSha256` = canonical digest of the retained SQL stop acknowledgement), `trust.json`, both manifests, the service bytes and a digest manifest, verifying the set with `verifyLxdOfficeServiceSoftware` before returning. On the node, `qorpera-office-software-update.cjs` (packaged with the provider) runs exactly one step per invocation — `enroll --evidence-sha256 …` (revision 0 baseline only), `begin`, `stage`, `install`, `status` — from a protected `qorpera.lxd-office-software-update/v1` document, as the provider user under the lifecycle's own journal `adoption.lock` flock while the ordinary provider service is stopped; it composes `LxdOfficeSoftwareControl`, the staging/transport functions and the retained `service-stop-request-…`/`service-stop-completed-…` journal records, never loops or retries, and prints closed JSON without either credential.
