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
screen-generation changes still revoke them. Each input packet retains the
existing authorization and audit admission. The viewer gateway releases only
the held keys and mouse buttons sent through that connection when it closes.
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
