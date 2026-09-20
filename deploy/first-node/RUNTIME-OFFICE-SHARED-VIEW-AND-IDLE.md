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
  the same bound as the browser egress relay's re-check. Fences pushed to the
  gateway (drain, privacy) still close the connection immediately. A refused,
  failed or late renewal ends the connection and releases held input. Packets
  that arrive without a valid window are dropped, never held for replay.
- Audit: the ledger holds one row per window instead of one per packet: first
  sequence, `packet_count` and a commitment. The commitment is an HMAC, under
  the per-connection key, over the previous window's commitment and the keyed
  per-packet commitments of the range. No raw keys, positions or unkeyed
  digests are stored. Ranges are contiguous; a replay, overlap or gap is
  refused. A renewal that is refused still records the window that had already
  been dispatched, and the gateway reports the last window before release. If
  the registry is unreachable at that moment, up to one second of input has no
  ledger row.
- Pointer moves that are pending together collapse to the latest one. Presses,
  releases and key events are never dropped or reordered.
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
