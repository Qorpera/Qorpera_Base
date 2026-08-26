# Step 3 screens: transport and audit-trail decision

**Status: RATIFIED, 2026-08-26 (founder).** The founder confirmed the Grok
bot-computer model: one shared Company Computer, an individual screen per
staff agent — transport option A (per-screen TigerVNC/XFCE desktops with
noVNC-style embedding over the existing capability-gated paths). The audit
trail follows the recommended option 2 (transcript events plus periodic
content-addressed keyframes; no continuous video). The screens slice builds
in the "What a decision unblocks" order below.

## What is being decided

Charter principle 7: each staff agent attaches to its own screen (desktop
session) on the shared machine; several agents work in parallel; one
computer-use task occupies one screen at a time. Two sub-decisions gate the
implementation:

1. **Transport** — how a screen is realized in the guest and how members (and
   the shell) watch and drive it.
2. **Audit trail** — how screen sessions are recorded into the canonical
   transcript contracts.

Fixed constraints from the ratified architecture, not up for re-decision:

- No public VNC/SPICE/RDP endpoint, ever. Viewer traffic rides Tailscale or
  the private management network, gated by short-lived Qorpera capabilities
  (the Grok audit's rule 7, already adopted for Step 2 ingress).
- A screen session never grants runner, provider, or control-plane authority
  by implication; attach/detach is control-plane state.
- Screens are parallel work surfaces, not security boundaries; the trust
  domain stays the company environment.
- No local GPU; software rendering only.
- The Company Computer image is built, signed, and activated through the
  Step 2 provenance cycle, so the desktop stack must be installable from
  pinned Ubuntu packages.

## Transport options

**A. Per-screen X11: Xvfb/Xvnc (TigerVNC) + XFCE, one display per screen,
noVNC/websockify for viewers — RECOMMENDED.**
One TigerVNC server per screen yields N genuinely parallel desktops on one
guest. This is exactly the stack the Grok bot-computer runs (XFCE, Chrome,
TigerVNC, noVNC, D-Bus, software rendering), which the audit called
conventional, replaceable, and "a strong Step 3 reference". Agent computer-use
tooling (screenshot + input injection) is most mature on X11. The shell embeds
a web VNC client over the existing authenticated broker path; no new client
runtime. Weaknesses: X11 is legacy technology, and VNC carries no built-in
recording — recording is a separate concern below.

**B. Per-screen headless Wayland compositor (wlroots) + wayvnc.**
The modern stack; clean headless compositor per screen and PipeWire-quality
capture for recording. Weaknesses: computer-use input/screenshot tooling and
multi-session operational practice are younger; more moving parts to pin in
the image; no audit-endorsed reference deployment. Reasonable second choice
if X11 tooling becomes a blocker; the screens contract below is transport-
neutral so a later migration stays an image change, not a contract change.

**C. xrdp (RDP multi-session).**
Native multi-session support and sound RDP tooling, but embedding RDP in the
shell needs a protocol gateway (e.g. Guacamole) — a new trusted service in
the data path — and agent tooling still targets the X session behind xrdp.
More infrastructure for no contract-level gain.

**D. LXD VGA/SPICE console.**
Rejected. The LXD console is one machine console; it cannot provide N
parallel per-staff screens, which is the charter's defining requirement.
Stays available to operators as a break-glass maintenance surface.

## Audit-trail options

The audit decision constrains only what is durably RECORDED into company
history. It never limits the live surface: members always have the direct,
real-time, interactive path into every screen — seeing exactly what the
agent sees and taking over input at will — through the ratified transport
above.

**1. Control-plane events only.** Attach/detach/task-occupancy in the
existing event contracts. Cheapest; no visual record of what happened on the
screen. Insufficient alone for the charter's audit posture.

**2. Events + periodic content-addressed keyframes — RECOMMENDED.**
Attach/detach/occupancy as transcript events; the screen agent captures
periodic (and on-task-boundary) screenshots published as content-addressed
artifacts bound to the run, exactly like other run artifacts. Bounded cost,
replayable "what was on this screen while task X ran", and it reuses the
object catalog, reachability, and cleanup contracts unchanged. Computer-use
tasks already screenshot as part of their loop; those frames double as the
audit record for agent-driven work.

**3. Full session video/protocol recording.** Continuous recording (VNC
stream capture or Guacamole-style replay) gives complete fidelity but adds a
recording proxy to the trusted path, large mutable artifacts against the
256 MiB file contract, and retention policy questions. Defer; option 2's
contract leaves room to add a `screen_recording` artifact kind later without
breaking anything.

## What a decision unblocks (the screens slice, in order)

1. `qorpera_company_computer_screens` registry: screen rows per Company
   Computer, attach/detach RPCs, and the one-task-per-screen scheduling rule
   (`max_concurrency` stays 1 per screen; the computer's concurrency becomes
   the number of screens).
2. Guest screen agent in the image: session lifecycle per screen, viewer
   socket bound loopback-only, brokered capability check on attach.
3. Shell surface: watch/drive UX over the broker path, per charter's
   member-visible shared machine.
4. Keyframe artifact publication on the run transcript (audit option 2).

## Recommendation summary

Option A + option 2: per-screen TigerVNC/XFCE desktops with noVNC embedding
over the existing capability-gated paths, and audit recording as transcript
events plus periodic content-addressed keyframes. This follows the Step 2
decision grain (proven Ubuntu-packaged components over newer stacks), matches
the audit's endorsement of the Grok desktop stack as reference, and keeps
every new byte inside contracts that already exist.

## Decision record

- **2026-08-26 (founder):** the Grok bot-computer model — shared computer,
  individual screen per staff agent. Transport option A (per-screen
  TigerVNC/XFCE + noVNC embedding, capability-gated, never public) and audit
  option 2 (transcript events + periodic content-addressed keyframes) are
  ratified. Mirrored in STEP-3-COMPANY-COMPUTERS.md "Ratified decisions".
