# Shared computer viewing and server-owned idle policy

The web computer view opens in shared mode for members with input permission.
Mouse and keyboard input are available as soon as the viewer connects, while
the agent keeps its independent native screen lease. Closing the viewer ends
that viewer only. Read-only members retain watch access; private sign-in retains
its exclusive control and acknowledged privacy fences.

The provider service defaults to a five-minute idle window. Its protected
configuration may set `idleMs` between 60000 and 86400000 milliseconds. Login,
status polling and durable open desktop rows do not keep a computer running.
Live viewer sessions, authorized runnable machine-capable turns, native leases,
resources awaiting physical cleanup, privacy/takeover work and pending
machine-start continuations count as demand. A turn can discover its machine
tools before it takes a lease, so it retains the VM during that interval.

Idle admission runs on the server under the same office lock as new work. It
uses the existing governed service-stop and VM power-off workers. It neither
deletes the allocation nor treats a timeout as physical stop evidence. Opening
the web computer view or admitting native machine work records a durable wake
request. The provider resumes only after retaining the exact physical stop
history and completion, and activates the successor through the existing boot,
configuration and readiness checks. An open view waits through cold startup.
An accepted wake remains durable when the requesting client leaves; subsequent
machine effects still require current authority. Read-only members can watch
an active computer, while idle wake requires company write access.

Shared viewer grants use a stable screen fence that survives ordinary agent
lease acquisition, renewal and release. Actual drain, privacy, takeover and
screen-generation changes still revoke them. The viewer gateway releases only
the held keys and mouse buttons sent through that connection when it closes.

Member input is authorized and audited per window, not per packet. A round
trip per key and pointer event (about 130 ms each, strictly serialized) made
the desktop unusable. `qorpera_admit_runtime_office_viewer_input_window` runs
the same authority check as `qorpera_check_runtime_office_viewer` (grant state,
input mode and role, screen and shared-viewer epoch, privacy version, takeover
and driver, expiry, membership) and returns a validity of at most one second.
While a window is valid the gateway forwards input at once. While input flows
it renews in the background at half the validity, and for three seconds after
the last input; an idle viewer makes no window calls. Consequences:

- Revocation: a fence in the registry stops member input within one second,
  the same bound as the browser egress relay's re-check. Authority only comes
  from a timely answer, measured from before the request. Fences pushed to the
  gateway (drain, privacy) still close the connection immediately. An explicit
  refusal ends the connection and releases held input.
- Availability: a slow, lost or failed renewal (a long agent-side transaction
  on the office rows, a 5xx, a deadlock) is not a refusal. It grants nothing:
  the window lapses, input that arrives without a window is dropped (never
  held for replay; a packet waits at most 400 ms for a window that is just
  opening), keys and buttons this viewer holds are released, and the stream
  stays. With nothing to report, the next input packet opens a fresh window.
  With dispatched input still unreported, the gateway resends the same report
  every 250 ms; the registry treats an exact replay of the viewer's last row
  as already recorded. Three seconds without a valid answer end the connection.
- Audit: the ledger holds one row per window instead of one per packet: first
  sequence, `packet_count` and a commitment. The commitment is an HMAC, under
  the per-connection key, over the previous window's commitment and the keyed
  per-packet commitments of the range. No raw keys, positions or unkeyed
  digests are stored. Ranges are contiguous; any other replay, overlap or gap
  is refused. A refused call still records the window that had already been
  dispatched and marks the row `recorded_after_refusal`; the row is audit,
  not evidence of authority. At close the viewer is released first (a member
  takeover returns to the agent without waiting), then the last windows are
  reported within two seconds, so every ordinary last row carries that mark.
  Ten seconds after a viewer ended or expired its ledger accepts nothing. If
  the registry is unreachable at close, up to one second of input has no row.
  Operator activity (`admittedControlInputs`) sums `packet_count`.
- Pointer moves that are pending together collapse to the latest one, also
  across the WebSocket frames of one read. Presses, releases and key events
  are never dropped or reordered. A viewer forwards at most 500 input packets
  per second: excess moves are dropped, excess key or button events end it.
- Other client traffic (update requests) is re-validated at most once per
  second instead of on every chunk. Guest output is forwarded one write per
  guest chunk, with Nagle disabled on both legs.

The per-packet function remains for gateways that predate this change; both
share one sequence and ledger (`packet_count` is null for per-packet rows).
The RFB negotiation excludes QEMU keyboard and extended mouse formats: noVNC
uses the core input packets admitted by that authority. Advertising those
extensions made ordinary physical keyboard shortcuts disconnect the viewer.

## Desktop startup regression

The deployed UI avatar IDs changed to `planet`, `acorn`, `flame`, `rocket`,
`crown`, `heart` and `ghost`, while the VM image retained wallpapers named
`pebble`, `folio`, `brain`, `wisp`, `halo`, `ribbon` and `bloom`. Deriving asset
filenames from avatar IDs made desktop preparation fail before starting XFCE.
The new explicit mapping keeps guest asset identities independent of UI names.
Packaging checks the complete static and hourly wallpaper inventory, and the
desktop regression prepares every current avatar against the checked-in PNGs.

That first table followed the old template-to-name list, not the figures inside
the files, so every desktop showed another agent's avatar (the file named
`folio` draws the acorn, `brain` the planet, and so on). The table now follows
the traced figure in each template and a regression test compares it with the
baked avatar paths. The guest service also reads the agent's saved avatar for
the bound screen, so the agent-id hash is only a fallback. No artwork changed:
an installed office needs only the new service file and the new SQL function.

## The dock browser on a shared screen

A member sharing an agent's desktop clicks the browser icon in the dock and
gets the company browser on that screen, for member and agent alike. The
browser is owned by the screen, not by a run: the dock launcher leaves an empty
request file, the office service opens the screen agent's granted profile
through the unchanged contained launch, a later agent run joins the same
window, and run end lets go of it instead of closing it. Authority is the
broker-only `qorpera_office_screen_browser_grant` (migration
`20260920041000_runtime_office_screen_browser.sql`): the agent's current grant
plus an agent lease or a live shared/control viewer with input permission; the
dock and a member alone only ever open a company-owned profile. The relay
repeats that check every second, so the browser closes about a second after
the last entitled party is gone; SQL tolerates a check for at most 60 s after
the last unfenced presence so a viewer's network blip does not close it. Opens
are recorded with the members who were present (presence, not a proven click).
Unchanged: the run's own grant check before every agent action, per-connection
egress checks, one Chromium per profile, the privacy fence and drain closing
it at once, and a failed or cancelled action of a run that drove the browser
physically closing it. Third-party sign-in remains a takeover (`control`)
activity.
Details: `deploy/lxd-company-computer-guest/README.md`.

## Rollout order for the backdrop, dock browser and refusal journal

1. **SQL first.** Apply `20260920040000_runtime_office_screen_appearance.sql`
   and `20260920041000_runtime_office_screen_browser.sql` before any office
   runs the new service. Both only add objects; the old service never calls
   them. The other order is not safe: a new service on old SQL fails every
   agent browser action with `BROWSER_GRANT_UNCONFIRMED`, because the screen's
   browser authority does not exist yet. The avatar read degrades safely in
   that state (the desktop starts with the figure derived from the agent id).
2. **Service-only software revision** (the single file
   `/opt/qorpera-office/qorpera-company-computer-service.mjs`). It carries the
   corrected avatar-to-backdrop table and the avatar read, the screen-owned
   browser, and the `qorpera.office-viewer-refusal/v1` journal lines. No
   artwork ships: the installed PNGs already draw the current avatars.
3. **Guest-code revision** for `/usr/local/bin/qorpera-screen-browser`. Until
   an office has it, its old launcher still raises a browser an agent opened
   but cannot ask for one, and still shows the stale private sign-in text.
4. The bundle activation follows the repository's guarded rollout like any
   other; none of the steps above depends on it being active first.

## Release and acceptance

This is a source candidate, not evidence of an installed production release.
It requires the shared-viewer and idle-policy SQL migrations, the matching
office runtime and provider packages, and the web client. The new v33 bundle
activation must follow the repository's existing guarded rollout process;
do not rewrite the already shipped v31/v32 activations or activate a bundle whose
matching services have not passed their rollout gates.

On a disposable Linux/LXD office, verify repeated idle stop/wake cycles through
the production provider service, including after a completed operator recovery.
Then verify browser input while an agent is using the same screen, viewer close
without agent interruption, cold viewer startup, native/routine wake without a
member client, private sign-in fences, and no machine demand from login alone.
Local SQL and fixture tests do not replace this physical acceptance.
