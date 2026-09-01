# Runtime Step 4 guest components

These are inactive integration components, selectively adapted from
`codex/step3-remaining-ops` at `2d72b74eadc6f1e81ccce65512b210bd9fd9fb7b`.
No image, service, installer, provider, credential store or deployment is changed.
See [the integration handoff](../first-node/RUNTIME-STEP-4-COMPUTERS-SCREENS.md).

## Desktop wrapper

`qorpera-screen-session <screen_uuid> <ordinal> <display> <vnc_port>` retains
TigerVNC, 1920×1200, XFCE and persistent per-screen desktop state. It validates
the display/port pair, refuses path aliases, starts each child in a process
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
registry. Explicit creature appearance takes precedence over the reused
template/identity derivation. The helper copies the image's
`/usr/share/backgrounds/qorpera-screen-<creature>.png` through an explicit
read/write and atomic rename into `<screenStateRoot>/<screen UUID>/wallpaper.png`;
it does not use the cross-filesystem `copyFile` syscall that failed in the old
VirtioFS proof. Repeat preparation when authenticated appearance changes.
Use the verified desktop-state writer identity/UID mapping: new directories are
`0700` and the wallpaper is `0600`. The supervisor must confirm the desktop can
read them; this helper does not chown NAS data or change credential permissions.

Supply its returned path as **`QORPERA_SCREEN_WALLPAPER`**. Package the included
executable `qorpera-screen-xfce` at `/usr/local/bin/qorpera-screen-xfce` alongside
the wrapper when image integration is separately authorized. The wrapper
refuses an absent helper or a wallpaper outside that screen's state directory.
Inside the clean per-screen D-Bus environment, the helper applies the former
agent wallpaper, scaled image, hidden desktop icons, enabled native desktop
menu and disabled dock shadow **before** starting XFCE. Existing unrelated
desktop settings remain intact. The image-owned dock still needs the current
authorized browser and governed Files/Terminal launchers; do not reuse the
old ambient/raw-NAS launch commands.

The wrapper is not an authorization or sandbox implementation. Directory-name
validation cannot detect bind mounts, NAS aliases, unsafe inherited image
configuration, network routes or leaked credentials. The supervisor must
validate these before launch, sanitize the wrapper environment, and verify
readiness against its authenticated registry generation. Its `stop()` must
reap the entire service/cgroup, including daemonized descendants; the wrapper's
process-group cleanup is not sufficient proof by itself.

Loopback RFB `None` and X11 must be reachable only through the controlled guest
channels. A model must not reach another display, read the control broker's
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

## Browser and shell

`PersistentCompanyComputerBrowser` uses the installed Chrome and existing
`playwright-core`; profile UUIDs and explicit grants come from cloud authority.
The profile root is broker-owned and separate from desktop home and workbench.
Do not restore the older `qorpera-chrome` ambient per-display profile launcher.
Member browser startup and sign-in need the same profile broker and typed
privacy handoff. Revocation must close control channels and suspend affected
viewers before secret input; masking password fields alone is insufficient.

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
`scrot`. Arbitrary shell and screenshot execution require the existing contained
command runner through `CompanyComputerGuestCommands`; there is no new runner
or local fallback. Agent commands receive only an assigned display and the
noncanonical workbench. Canonical Company File reads/writes must use the
governed projection/gateway, never the historical direct NAS `dataset/live`
route. Screenshot publishing uses the existing immutable asset boundary.

Both scripts were syntax-checked locally. The XFCE helper also ran against fake
X11/XFCE commands; adoption tests copied synthetic local fixture bytes and used
fake Chrome. Linux desktop startup/rendering, actual session-cookie adoption,
guest isolation and agent control still require the live acceptance gates in
the handoff. Tab recovery tests use fake Playwright pages, not real Chrome.
Do not activate these files based on component tests.
