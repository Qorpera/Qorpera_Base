# Qorpera Staff Shell Specification

> The agents-only implementation supersedes the universal controller,
> company-owned projection/surface, and self-evolving userland portions of
> this frozen v1 contract. Agent, connector, routine, and artifact decisions
> remain applicable.

**Status:** v1 product contract — frozen decisions
**Date:** 2026-08-15
**Scope:** Qorpera Base desktop shell, provider onboarding, durable staff presentation, agent artifacts, capability requests, activity, authority, and migration
**Architecture references:** `QORPERA-BASE-ARCHITECTURE-MANIFESTO.md`, `QORPERA-BASE-DECISION-RECORD.md`, `packages/coding-agent/docs/company.md`, `packages/coding-agent/docs/authority.md`, `EVOLUTION.md`

## 1. Product thesis

Qorpera Base is the trusted agent interface over a portable company made of files. The company file is the shared operating context; durable AI staff work over it instead of appearing as disposable chat sessions. Base itself is fixed product software, not a company-authored or self-evolving application.

The product hierarchy is:

```text
Profile
  -> one company folder
  -> durable staff roles
       -> tasks and runs
       -> conversations
       -> linked artifacts, surfaces, and dashboards
  -> capabilities and connections
  -> trusted activity and authority record
```

The architecture remains:

```text
Controller -> company files -> selective UI projection
```

The company folder remains primary. Staff identity, company meaning, knowledge, and workflows do not move into a shell-owned company database. The shell owns the stable agent interface and the kernel-owned runtime, security, and provenance state it needs to operate the company safely. Agent-generated pages are artifacts rendered under the owning agent; they never redefine the shell.

## 2. Normative terms

`MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, and `MAY` are normative requirements for v1.

- **Company**: a portable company folder plus the kernel-owned bindings required to operate it.
- **Profile**: the human-facing launcher identity for exactly one company environment: its company folder, staff, local runtime state, connections, schedules, and settings. It is a view over the existing company boundary, not a second business-data store or cloud account.
- **Staff member**: a durable employee identity, charter, appearance, settings, and continuing relationship stored with the company.
- **Runtime**: a temporary local model process executing work for one staff member. It can stop, reconnect, or change model without creating or replacing that staff member.
- **Task**: one bounded unit of work assigned inside a staff member.
- **Run**: one kernel-observed execution attempt for a task.
- **Conversation**: the founder-facing timeline for a staff member, composed from task and run records. It is not one infinitely growing mutable session.
- **Agent artifact**: a projection-backed page, dashboard, report, or working surface linked to one staff member and rendered as a header toggle. There is no standalone Workspace destination.
- **Capability**: kernel-granted access to a resource, destination, secret reference, local tool, or external operation.
- **Trusted chrome**: fixed Base-owned UI that company-authored content cannot replace or impersonate.

## 3. Frozen v1 decisions

The following decisions are closed for v1.

### 3.1 Provider login configures intelligence, not Qorpera identity

Provider login binds model access. It does not create a Qorpera account, establish ownership of a company, or authorize external effects.

- V1 has no required Qorpera cloud account.
- The founder identity used to ratify policy and approve effects remains a separate local cryptographic identity.
- Provider credentials and refresh state remain foundation-owned and machine-local.
- A provider login can be rebound or removed without changing company identity.
- A copied company folder never inherits provider credentials or founder authority.

The v1 provider choices and defaults are fixed:

| Choice | Provider/model binding | Display name |
|---|---|---|
| GPT | `openai-codex/gpt-5.5` | GPT 5.5 |
| Claude | `anthropic/claude-opus-4-8` | Claude Opus 4.8 |
| Grok | `xai/grok-4.5` | Grok 4.5 |

Base MUST NOT silently substitute another model when the selected default is unavailable. It MUST explain the failure and offer retry, another provider, or an explicit advanced model choice.

### 3.2 New profiles bootstrap a selected starting team

Base MUST NOT silently invent a company lead or pre-hire staff. After creating a profile, the founder sees all six original Qorpera starter roles in one multi-select grid and explicitly chooses the starting team:

1. **Operations Lead** — keeps priorities, handoffs, recurring work, and blockers moving across the company.
2. **Research Lead** — turns open questions into sourced findings, tradeoffs, and actionable recommendations.
3. **Inbox Steward** — sorts incoming communication, drafts replies, and keeps commitments from being lost.
4. **Finance Partner** — maintains a clear view of cash, performance, commitments, forecasts, and financial risk.
5. **Product Builder** — turns product intent into scoped, tested changes while keeping tradeoffs visible.
6. **Customer Advocate** — synthesizes customer needs, protects service quality, and closes the loop on feedback.

The founder can select any non-empty combination and confirm the team in one mutation. Base then asks which service categories the company uses, including **Other** with a free-text description. The selected staff identities and first trails MUST be persisted before any proactive orientation begins. Because V1 has one local company writer, introductions run in a visible **Queued** order; they MUST NOT be presented as parallel work.

For a named service without an installed connector, staff first prepare a connector brief and narrow recipe proposal in company files. They MUST NOT request credentials or claim the connector is installed until the founder reviews it and the kernel accepts it. Once staff exist, **Add staff** MAY rank a smaller contextual subset before the complete catalogue. A founder can also select **Describe another role**.

Starter roles are initial briefs, not fixed workflows or kernel ontology. The controller remains free to represent and improve each role using ordinary company files.

### 3.3 Staff are durable; runtimes are replaceable, local, and explicitly placed

V1 does not introduce concurrent company controllers.

- Each staff member has a stable `staffAgentId` and persistent presentation identity.
- A runtime is not a staff member. It is the replaceable local execution process currently carrying that identity and charter.
- V1 runs on the founder's current machine. There is no remote-computer selector, remote screen, or claim that work continues after that machine or Base stops.
- Staff tasks execute through the existing controller security role and serialized writer.
- At most one controller task mutates a company environment at a time.
- Other staff work is shown as **Queued**, not as simultaneously working.
- The shell MUST use the states **Ready**, **Queued**, **Working**, **Waiting for you**, **Paused**, and **Error**.
- The shell MUST NOT use presence language such as online, awake, or always on.
- Routines carry explicit `local`, `cloud`, or `requires-local` placement. Local and `requires-local` work runs while this company is open on this machine; `requires-local` additionally asserts the job must never be enqueued to a hosted runner. `cloud` placement is fail-closed: the local kernel never runs a cloud-placed routine, and it stays parked until a verified hosted routine lane exists.
- Background execution is an explicit per-company setting, off by default. When enabled, closing the company window hides it to the system tray while the local runtime — wake ticker, queued room deliveries, coworker mail — keeps running, and Base starts at login while any company on the machine is opted in. Quitting Base still stops everything; a durable staff identity alone is never evidence of background execution.

The staff metaphor is durable responsibility, continuity, and proactive work. It is not a claim of parallel runtime execution.

### 3.4 Group chats are durable rooms on the single company lane

- A room has a stable `roomId`, an ordered active participant list with retained historical membership, lifecycle status, and a hash-chained append-only transcript.
- Every room message records an explicit founder or `staffAgentId` speaker. Staff output is never merged into an anonymous assistant voice.
- Each participant responds on a room-scoped trail carrying both `roomId` and `staffAgentId`; no process or trail is shared between speakers.
- A founder message broadcasts to all active room participants by default. One or more `@name` mentions narrow delivery to the matching participants while the message remains visible in the room transcript.
- Delivery is durable and per recipient. Participants respond **one at a time** through the company's single autonomous lane; queued deliveries survive restart, retry with backoff, and run when the lane is free. The room feels responsive because delivery is durable, not because processes run in parallel, and the shell MUST NOT present queued participants as simultaneously working.
- **Agent Manager** is an ordinary staff template, not a privileged controller. In a room it may propose bounded delegations through `delegate_to_staff`; the kernel verifies room membership, prevents self-delegation and cycles, caps each manager turn at eight targets, and permits at most three delegation hops. Delegations queue as ordinary targeted room deliveries.

### 3.5 The controller remains invisible infrastructure

New tasks are assigned to staff, not to a visible controller persona. The controller continues to own company semantics and to execute the charter associated with the selected `staffAgentId`.

There is no visible controller row, compatibility chat, or legacy shell. Unassigned historical trails remain on disk for provenance but do not become a conversational destination. Unassigned schedules are disabled during migration; unassigned artifacts remain unpublished until assigned to an active staff UUID. No trail is rewritten to manufacture staff attribution.

### 3.6 Artifacts are projection-backed and staff-owned

`app/projection.json` remains the only department/page publication contract, but it no longer produces a global Workspace page or rail section.

- `ProjectionPageNode.staffAgentId?` is the explicit surface-ownership field.
- Selecting staff renders only pages whose `staffAgentId` exactly equals the selected registry UUID, alongside native Conversation and Activity/details access.
- A category may provide a collection tab for its matching owned child pages; it MUST NOT expose sibling pages owned by another staff member.
- Pages with no `staffAgentId`, or with an unknown or archived staff UUID, are not published in the staff interface and produce an ownership diagnostic until explicitly assigned.
- The staff registry's optional `departmentId` is a presentation link only. It MUST NOT be used to infer ownership for a department or any page.
- Reassignment updates the exact projection page node. It does not rewrite historical trails or grant runtime authority.
- Departments and surfaces remain company-authored; the shell MUST NOT infer structure by scanning folders.
- Header tabs update when a valid projection is atomically published.

### 3.7 Connector plugins are model-neutral capabilities

Base has one connector installation and permission model shared by every supported intelligence provider.

- A connector plugin is a locally installed, source-pinned package composed from skills, MCP servers, and optional trusted native setup UI. Provider-hosted app IDs are not a portable connector package.
- Import adapters MAY normalize public Codex/OpenAI and Claude plugin manifests. Grok-compatible integrations enter through their public MCP/function-calling boundary. The normalized capability is installed once, not duplicated per model.
- Local stdio MCP and loopback HTTP MCP are first-class because the V1 runtime is local. Remote MCP remains optional.
- Every install displays source, publisher, requested hosts, executables, environment/secret references, write capabilities, and update policy before activation.
- Installed plugins never inherit founder authority. Money, identity, irreversible actions, and unattended outward behavior still cross native review.
- Staff request a capability at the moment a concrete outcome is blocked. The Company / Profile sheet owns inventory, updates, revocation, and repair; there is no permanent Connections rail row.
- Qorpera MAY ship bespoke connectors when no suitable public plugin exists. A Nordea connector begins against Nordea's official sandbox with read-only account information; production payment initiation remains separately gated and unavailable without the required regulated-party credentials and roles.

### 3.8 Shell chrome is fixed; company surfaces remain mutable

Base owns and signs the application frame, ultra-minimal rail, selected-staff header, conversations, staff Activity/details, Connections, profile controls, composer, and every authority or credential review.

Company-authored code can publish content only inside a bounded staff surface tab. It cannot replace, overlay, or visually merge with trusted shell chrome. It cannot create a lookalike approval, provider login, capability binding, or founder-signature control.

## 4. Product principles

1. **Staff, not sessions.** Persistent responsibility is the primary mental model; trails remain the durable execution record underneath it.
2. **One obvious next action.** Every empty, blocked, failed, and completed state has one primary action.
3. **Intelligence is ready on entry.** First run selects a provider, verifies its fixed default, and avoids an initial model matrix.
4. **Configuration is contextual and shared.** Staff ask for installed model-neutral capabilities when useful work requires them.
5. **New staff speak first.** Hiring starts a proactive task without waiting for a founder prompt.
6. **Autonomy is stated honestly.** UI states reflect kernel-observed work and current execution limits.
7. **Authority is native.** Mutable company content can request a review but can never render or approve one.
8. **Artifact publication is transactional.** A broken candidate artifact never replaces the last valid publication.
9. **The company stays a folder.** Create, open, import, export, and folder location remain first-class; the shell is never copied into it.
10. **Motion communicates state.** Animation differentiates staff and runtime state without becoming decorative noise.
11. **Conversation shows outcomes, not machinery.** Founder/assistant output stays readable while thinking and tools remain inspectable in the honest trail.
12. **Everything operational has a staff owner.** Artifacts, dashboards, work, and schedules live with staff; unassigned material is not promoted into a second product hierarchy.

## 5. Reference inspiration and Qorpera identity

V1 adopts product patterns visible in the supplied reference screenshots:

- A sparse provider-first welcome screen.
- Persistent staff identities instead of disposable chats.
- A clear first-hire catalogue.
- Large differentiated avatars.
- Familiar conversational message grouping.
- A proactive first staff message.
- Connection requests embedded at the point of need.

V1 MUST NOT copy:

- Grok Bot, xAI, or SpaceX names, logos, slogans, or product copy.
- The reference product's branded avatar geometry, color ordering, or role catalogue.
- Exact role names, role descriptions, or product-specific card copy.
- Apple or iMessage assets or pixel-level styling.

Qorpera's visual system MUST express portable companies, durable responsibility, observable work, and founder authority while following the supplied shell references closely for geometry, density, hierarchy, and message placement. Staff avatars use a small face-only Qorpera character with two eyes. At creation the founder chooses one vibrant color and one of six original face silhouettes; the protected registry persists `appearance.color` and `appearance.shape`. State-bound face tilt, gentle squash, nods, blinks, eye size, and gaze communicate listening, starting, working, finishing, and reconnecting without turning the avatar into a rigid miniature body. Motion must feel cute, trustworthy, and eager; errors rely on explicit text rather than distressed character animation. State always has a text equivalent. Familiar chat grammar is acceptable; copied branding is not.

Typography uses the native Segoe UI Variable optical cuts on Windows: Text for controls and conversation, Display for large headings, and Cascadia Mono for technical detail. Small shell text stays dark, compact, and sharply rendered; soft color never substitutes for an undersized or underweighted label.

## 6. Information architecture

### 6.1 Fixed desktop rail

The desktop rail is always present. There is no manual sidebar toggle and no Home, Needs you, Activity, Workspace, Tasks, Schedules, or Settings destination.

```text
[Search]
[+ Add staff]
<staff rows>
[Company / Profile]
```

**Search** is the first control and opens a transient native overlay across staff, founder/assistant conversation output, linked artifacts, and activity metadata. **+ Add staff** opens hiring immediately below it. Staff rows carry state and attention indicators. The single bottom **Company / Profile** control owns company switching, Connections, environment operations, provider/founder identity, appearance, accessibility, application settings, and the company hard brake. It is one line containing only the company mark and name: no subtitle and no trailing arrow.

Below the supported full-width breakpoint, the shell MAY switch automatically to a compact icon rail. The selected staff identity, state, attention, and company identity must remain available. The layout must not require the user to discover a hidden navigation toggle.

### 6.2 Empty profile and Add

With an empty roster, the main pane opens the multi-select starting-team grid. The next compact step asks which service categories the company uses and offers **Other**. One primary action creates the selected staff as a single protected roster mutation, persists every first trail, and starts the serialized local orientation queue. There is no guided single-hire flow and no separate Home dashboard. Once staff exist, the main pane opens the last selected staff member; Add opens the single-person creator with face, color, shape, name, and role controls.

Needs-attention items do not create another destination. They badge the owning staff row and render as an essential native card in that staff member's conversation or Activity/details. Environment-level failures that have no staff owner badge Company and open a native company-status sheet.

### 6.3 Staff rows and avatars

Each staff row displays:

- A small customizable Qorpera face avatar.
- Name.
- Role title.
- Kernel-derived state.
- Attention count when non-zero.

The roster is ordered by attention priority, then active/queued state, then recent meaningful activity. It is not ordered by raw trail modification time. The Qorpera face uses the registry color and shape plus state-specific motion; color and motion are never the only status signal.

### 6.4 Selected staff header and tabs

Selecting staff opens a single 48-pixel header containing the compact clickable avatar/name, artifact toggles, and one computer/side-panel button. Conversation is the default canvas, not a tab. The header toggles are:

```text
<linked artifacts, surfaces, and dashboards>
```

Direct projection pages whose `staffAgentId` exactly matches the selected staff member become tabs. A category collection tab includes only matching owned child pages. The registry's `departmentId` may provide presentation context but never adds tabs or assigns ownership. Company-authored surfaces remain inside their bounded host beneath the trusted staff header.

The computer button opens a right side panel while the conversation stays visible. That panel contains the agent computer state, routines, runs, failures, and activity details. Clicking the avatar/name opens the same panel in agent-settings mode. Routines never appear as a header text button or standalone shell page.

Scheduling and capability settings open from the trusted staff header. Conversation-level attachments, model/reasoning controls, and worktree creation live behind one ellipsis at the composer's leading edge. They MUST NOT appear as persistent chips or toggles around every message. V1 execution is always local, so the ellipsis MUST NOT offer a fake local/cloud choice.

## 7. Primary journeys

### 7.1 First run

1. Base shows one headline, one explanation, and three provider choices: GPT, Claude, and Grok.
2. The founder selects a provider and completes provider-owned authentication.
3. Base resolves and verifies the fixed default model.
4. Base shows the minimal profile selector. The founder creates a profile by entering its company name and confirming a visible default folder location.
5. Base creates the profile's company folder and a restrictive all-gated `authority.toml`.
6. A native review ratifies the initial policy with the local founder identity.
7. Base opens the multi-select starting-team grid with all six starter roles.
8. The founder selects the initial team, chooses relevant service categories or **Other**, and starts the team.
9. Base persists all selected staff and their first trails, then queues proactive local orientation turns in selection order.
10. No tour, model picker, plugin catalogue, or settings checklist interrupts this path.

**Open existing company folder** is a secondary action on the welcome screen. Existing valid companies skip creation and never rerun conception automatically.

### 7.2 Hire staff

1. The founder selects a starter role or describes another role.
2. A compact confirmation allows a custom display name and one sentence of direction.
3. **Hire** sends the selected template or custom fields through trusted shell chrome.
4. The kernel validates the request, creates the protected registry entry, and issues its stable UUID `staffAgentId`.
5. The kernel creates per-staff local runtime settings using the company's selected provider/default model, the **Fast** execution profile, and `low` reasoning.
6. The kernel creates a new trail bound to that `staffAgentId` and queues or starts the proactive introduction.
7. The controller may create arbitrary working files, memory, routines, or department material for the role; those remain ordinary company files rather than registry fields.
8. The new staff member proactively sends the first message.

The first message MUST:

- State the responsibility it understood.
- Propose one useful initial outcome.
- Ask at most one high-value question or present a short decision set.
- Identify missing access honestly.
- Avoid claiming knowledge, work, or connections it does not have.

**Fast** selects the provider's supported latency-oriented execution tier without changing the frozen provider/model binding; where a provider exposes the priority service tier, Fast uses it. Reasoning defaults to `low`. Provider/model, execution profile, and reasoning remain independently configurable for each staff member through the trusted composer More panel. Changing one staff member never changes another, and no model control remains persistently visible in the composer.

### 7.3 Assign work

- Opening a staff row opens its persistent conversation.
- The composer says **Message <name>…**, matching the persistent relationship rather than a task form.
- Sending creates a new task or adds founder direction to the current waiting task.
- If another task owns the controller, the new task becomes Queued and the shell names the active task.
- The founder can choose **Run when free**; drafts are never discarded.
- Completion messages link to changed files, decisions, evidence, and published surfaces rather than only to the raw trail.

### 7.4 Request a capability

1. A staff task identifies a blocked outcome.
2. The task emits a structured capability request.
3. The native shell renders why it is needed, requested scope, destinations, attendance, and alternatives.
4. The founder selects **Connect**, **Not now**, or **Deny**.
5. Connect opens a native credential/provider flow.
6. The kernel binds opaque references and records the signed decision.
7. The task receives a completion event and resumes or offers **Continue now**.

The staff message may introduce the request, but only the kernel can render the actionable review.

### 7.5 Publish an agent artifact

1. The agent writes candidate artifact, substrate, and projection changes.
2. Base validates the complete candidate publication.
3. Base renders a smoke frame under the production surface policy.
4. Base atomically activates the candidate or rejects it without changing the current publication.
5. The prior valid publication remains available for rollback.
6. The responsible staff member links the founder to the new result.

### 7.6 Switch companies

The bottom Company / Profile control opens the native switcher. It lists recent companies with folder path, open/paused state, attention count, and exact active work. It exposes New, Open folder, Import, Export, Fork, and Open in file manager.

Switching MUST quiesce or checkpoint the current local environment and respect the single-writer lock. Each company retains independent policy, schedules, connector bindings, and local authority state.

## 8. Conversation contract

The conversation is a native projection over immutable tasks and runs.

- Normal conversation renders only founder output, assistant output, and essential native system, connector/authority, queue, and error/retry cards.
- Founder and assistant output use a familiar left/right grouping: founder messages use a vivid system-blue bubble and staff messages use a neutral light bubble. Speaker identity remains programmatically explicit.
- Provider thinking, reasoning summaries, tool calls, tool arguments/results, command output, intermediate narration, and internal execution progress MUST NOT appear in normal conversation, including behind a **What I did** disclosure.
- The header state and subtle Qorpera face motion communicate that work is running without inserting execution noise into chat.
- Complete available thinking and tool execution remain append-only trail data and are inspectable from the selected staff member's Activity/details view with provenance and trust labels.
- Task/run boundaries may use a quiet native divider; they do not introduce synthetic assistant messages.
- Autonomous assistant output names the schedule or causal event that produced it.
- A completed run reports runtime state as **Completed**, not **Succeeded**.
- Company-declared business outcome is shown separately from runtime completion.
- A failed run shows one essential error/retry card with the first useful cause, partial-work summary, known changed files, and recovery guidance. Full technical detail stays in Activity/details.
- Inspecting a historical run is read-only and MUST NOT resume or mutate it.

## 9. Runtime and state contracts

### 9.1 Protected portable staff registry

V1 stores durable staff identity and presentation in the protected `.qorpera/staff.json` registry. It is part of the portable company environment, but only trusted kernel operations may mutate it. It is not an agent-authored projection and does not define the role's complete working state.

```json
{
  "version": 1,
  "agents": {
    "2a946c8e-6959-4a3b-9f36-479135ba853f": {
      "id": "2a946c8e-6959-4a3b-9f36-479135ba853f",
      "displayName": "Research Lead",
      "role": "Evidence and decision support",
      "charter": "Own rigorous investigation, source quality, synthesis, and decision-ready recommendations.",
      "templateId": "research-lead",
      "departmentId": "company:research",
      "appearance": {
        "color": "qorpera-cobalt",
        "shape": "round"
      },
      "employmentStatus": "active",
      "createdAt": "2026-08-15T10:00:00.000Z",
      "updatedAt": "2026-08-15T10:00:00.000Z"
    }
  }
}
```

Rules:

- The root contains exactly `version: 1` and an `agents` object keyed by lowercase UUID v4.
- Each record's `id` exactly matches its UUID key. That UUID is the `staffAgentId` used by the runtime and shell.
- `displayName`, `role`, `charter`, and `appearance.color`/`appearance.shape` are required.
- `templateId` and `departmentId` are optional. `templateId` records starter provenance; `departmentId` is a presentation link, not an organizational ontology.
- `employmentStatus` is `active` or `archived`. V1 archives and restores staff rather than deleting their identity or trails.
- `createdAt` and `updatedAt` are canonical ISO timestamps, and `updatedAt` cannot precede `createdAt`.
- The protected mutation API validates exact fields, bounded text, a physical non-linked registry file, a 4 MiB registry limit, and at most 1,000 agents. Writes replace the file atomically.
- Runtime state, attention, model selection, budgets, capabilities, schedules, conversation state, and authority MUST NOT be asserted by the registry.
- The controller and company-authored surfaces cannot write `.qorpera/staff.json` directly.

The registry is the narrow portable identity/presentation contract required to keep a staff member stable across restarts, export, import, and fork. Arbitrary role work, briefs, goals, memory, evidence, routines, and organizational relationships remain ordinary company files maintained by staff. Base does not discover or interpret those semantics by scanning.

### 9.2 Trail attribution

New staff work extends the existing session header metadata without changing the security actor:

```json
{
  "qorpera": {
    "actor": "controller",
    "staffAgentId": "2a946c8e-6959-4a3b-9f36-479135ba853f",
    "attended": true,
    "autonomous": false,
    "label": "Research Lead — first evidence brief"
  }
}
```

- `actor` remains `controller`; `staffAgentId` is a logical work identity, not a new authority role.
- The current tranche binds staff work by `staffAgentId` plus trail/session identity. It does not implement or promise a separate `taskId`.
- Causal intent, attendance, autonomous labels, groups, parent sessions, and kernel runtime events continue to distinguish why a trail exists.
- Legacy records without `staffAgentId` remain valid and are never rewritten or adopted by a staff member.

### 9.3 Kernel-derived staff state

The native roster merges the protected `.qorpera/staff.json` registry with trusted runtime state. State precedence is:

1. **Working** — the exact live controller session has this `staffAgentId`.
2. **Waiting for you** — an unresolved founder decision, authority review, or capability request blocks its current task.
3. **Queued** — a runnable task exists behind the active writer.
4. **Paused** — the staff member's relevant schedule or work queue is explicitly paused.
5. **Error** — the latest unresolved task ended in a kernel-observed failure.
6. **Ready** — none of the above applies.

Company-authored content may describe business progress but cannot assert these runtime states.

### 9.4 Per-staff intelligence settings

Provider/model, execution profile, and reasoning are kernel-owned settings scoped by company environment identity plus `staffAgentId`. The composer More panel can edit them, but they are not stored in `.qorpera/staff.json`, projected surfaces, or conversation messages.

Every newly hired staff member inherits:

```json
{
  "executionProfile": "fast",
  "reasoning": "low"
}
```

The provider/model is the company's selected frozen default at hire time. The staff header settings show the exact resolved provider, model, service tier, and reasoning level. Changes affect the selected staff member only. Unsupported combinations fail with an explicit alternative; Base does not silently change model or reasoning.

### 9.5 Staff and native shell APIs

The landed protected persistence API is:

```text
readStaffAgents(root)
createStaffAgent(root, input)
updateStaffAgent(root, staffAgentId, update)
archiveStaffAgent(root, staffAgentId)
restoreStaffAgent(root, staffAgentId)
```

Creation accepts `displayName`, `role`, `charter`, optional `templateId`, optional `departmentId`, and `appearance`. The kernel supplies the UUID, active employment status, and timestamps. Update cannot change identity, employment status, or creation time; archive/restore is explicit.

The native shell boundary may use the existing local origin and bridge internally, but it must expose equivalent behavior. Route names below define the product-facing shape:

```text
GET    /api/intelligence/providers
POST   /api/intelligence/login
GET    /api/intelligence/login/:flowId
PUT    /api/companies/:companyId/model-binding

GET    /api/staff-agents
POST   /api/staff-agents
PATCH  /api/staff-agents/:staffAgentId
POST   /api/staff-agents/:staffAgentId/archive
POST   /api/staff-agents/:staffAgentId/restore
GET    /api/staff-agents/:staffAgentId/timeline?cursor=<cursor>
POST   /api/staff-agents/:staffAgentId/messages
GET    /api/staff-agents/:staffAgentId/settings
PUT    /api/staff-agents/:staffAgentId/settings
GET    /api/staff-agents/:staffAgentId/activity?cursor=<cursor>
GET    /api/staff-agents/:staffAgentId/schedules
POST   /api/staff-agents/:staffAgentId/schedules
PATCH  /api/staff-agents/:staffAgentId/schedules/:scheduleId
POST   /api/staff-agents/:staffAgentId/schedules/:scheduleId/run
DELETE /api/staff-agents/:staffAgentId/schedules/:scheduleId
POST   /api/trails/:trailFile/retry
POST   /api/trails/:trailFile/pause

GET    /api/capabilities
GET    /api/capability-requests
POST   /api/capability-requests/:requestId/review

GET    /api/runtime/events

GET    /api/companies
POST   /api/companies/open
POST   /api/companies/switch
```

`POST /api/staff-agents` accepts the validated creation fields, for example:

```json
{
  "displayName": "Research Lead",
  "role": "Evidence and decision support",
  "charter": "Own rigorous investigation, source quality, synthesis, and decision-ready recommendations.",
  "templateId": "research-lead",
  "appearance": {
    "color": "qorpera-cobalt",
    "shape": "round"
  }
}
```

The kernel authenticates and records the founder action, writes the protected registry, and returns the complete record with its issued `staffAgentId`. The registry is a portable identity and presentation record, not a kernel-owned company workflow or memory store.

`POST /api/staff-agents/:staffAgentId/messages` accepts founder content and optional attachments through the existing signed, expiring, single-use input intent. It binds the resulting controller session to the exact registry identity. It MUST NOT accept an arbitrary role prompt from company-authored content.

`GET /api/runtime/events` uses the existing kernel event transport and emits at least:

```text
staff.created
staff.updated
staff.archived
staff.restored
session.queued
session.started
session.waiting
session.completed
session.failed
capability.requested
capability.resolved
artifact.published
artifact.rejected
```

Every staff-session event includes company environment identity, `staffAgentId`, causal intent, kernel timestamp, and trail/session reference where applicable. Clients MUST NOT expect a `taskId` in this tranche.

### 9.6 Capability request contract

```json
{
  "schema": "qorpera.capability-request/v1",
  "id": "capreq:01K...",
  "staffAgentId": "2a946c8e-6959-4a3b-9f36-479135ba853f",
  "trailFile": "2026-08-15T10-00-00-000Z_9f58c4ad.jsonl",
  "label": "Public web research",
  "reason": "Find ten matching companies and retain source links.",
  "kind": "mcp",
  "scopes": ["search", "read-public-pages"],
  "destinations": ["configured-search-provider"],
  "attendance": "attended",
  "behaviorHash": null,
  "alternative": "Prepare the research criteria for manual sourcing."
}
```

Allowed `kind` values are `mcp`, `http`, `secret-reference`, and `local-tool`. Provider-specific fields remain capability-owned extensions and do not become company ontology.

The kernel canonicalizes the request before native review. Unattended codified outward behavior additionally requires the existing content-hash signature. Capability binding is necessary but never bypasses money, identity, irreversible, or authority policy.

### 9.7 Connector plugin package contract

The normalized local package is deliberately smaller than any provider catalogue:

```json
{
  "schema": "qorpera.connector-plugin/v1",
  "id": "github",
  "version": "1.2.0",
  "source": { "kind": "https", "url": "https://example.invalid/plugin.tgz", "sha256": "…" },
  "skills": ["skills/review-prs"],
  "mcpServers": [
    { "id": "github", "transport": "http", "url": "https://api.example.invalid/mcp" }
  ],
  "permissions": {
    "hosts": ["api.example.invalid"],
    "secretReferences": ["github.oauth"],
    "executables": [],
    "writesExternalData": true
  }
}
```

- Codex/OpenAI plugin packages and Claude plugin packages are import formats, not separate runtime silos. Their public skills and MCP definitions normalize into this contract.
- Provider-hosted account/app identifiers and proprietary catalogue metadata are ignored during import. They do not identify a locally runnable connector.
- A package is installed once in the kernel-owned machine store and may be used by GPT, Claude, or Grok when that model can call the normalized tool surface.
- Package files are immutable by content hash. Updates are a new reviewed version, not ambient mutation.
- Local process launch, network destinations, secret references, and external writes are denied unless declared and approved. A plugin cannot render its own credential or authority approval.
- Removing a plugin revokes its runtime capabilities without deleting company artifacts or trail history.
- The first implementation targets local-folder install and pinned HTTPS archives. A public Qorpera catalogue is discovery metadata over the same package contract, not a second connector implementation.

### 9.8 Surface and schedule ownership

- A linked surface is owned only by the exact `ProjectionPageNode.staffAgentId` on its page node. Ownership is page-specific, not inferred from department membership, names, paths, or registry `departmentId`.
- `departmentId` remains optional staff presentation metadata and has no ownership or authority effect.
- A schedule is owned through a protected `staffAgentId` on its kernel-managed definition. New schedules MUST have one active owner and are created only inside that staff member's Activity/details.
- A future scheduled wake stamps the owner's `staffAgentId` into its new trail. Reassignment never changes earlier trails.
- Newly assigned founder work starts a trail with the selected `staffAgentId`; v1 does not create new unassigned conversational work.
- Archiving staff pauses its schedules before the archive transition completes. Pages whose `staffAgentId` names the archived record retain that explicit value but remain unpublished with a diagnostic until the staff member is restored or each page is reassigned.
- Ownership changes are founder-authenticated kernel operations. Company surfaces may propose them but cannot perform or render them.

## 10. Staff surface publication contract

The active linked-surface publication is an atomic set containing:

- `app/projection.json`.
- Every referenced company surface.
- Every declared substrate or asset needed for first render.

The protected staff registry is outside this activation set. A staff record's optional `departmentId` may link into the active projection for presentation, but it never assigns pages. Page ownership comes only from each exact `ProjectionPageNode.staffAgentId`; unresolved staff or department references produce diagnostics rather than inferred ownership.

Publication MUST:

1. Stage a candidate without changing the active set.
2. Validate schema, unique immutable IDs, references, and surface paths.
3. Validate declared substrate fields used by the surface.
4. Load every changed surface in the production renderer sandbox.
5. Reject remote subresources, unauthorized network access, external WebSockets, beacons, arbitrary `file://` reads, and attempts to cover trusted chrome.
6. Atomically activate the complete set.
7. Retain the last valid set and an explicit rollback action.
8. Record controller assertion, kernel validation, activation, and rollback as distinct trail facts.

A structurally valid publication that renders required sections empty is invalid. The validator must test rendered coverage, not only file existence.

## 11. Staff activity, attention, and authority

### 11.1 Attention without a destination

Attention is a native prioritized state over:

- Founder questions.
- Capability requests.
- Authority gates.
- Policy ratification.
- Environment failures.
- Resource ceilings and hard-brake events.
- Linked-surface publication failures requiring founder direction.

There is no Needs you page. Staff-owned items badge the staff row and render as essential native cards in that staff member's Conversation or Activity. Unassigned environment items badge Company and open a native company-status sheet. Attention MUST support priority, deduplication, supersession, and stale-request resolution. An interrupted controller run cannot change a signed approved request back to pending. Kernel reconciliation, not company file state, decides the effective transition.

### 11.2 Staff-scoped Activity/details

Activity is opened from the selected staff header and displays only that staff member's operating record:

- Runs, queued work, and schedules.
- Runtime state.
- Separate business outcome when the company published one.
- Start time, duration, selected model, usage, and cost where available.
- Useful failure cause inline.
- Partial work and changed artifacts.
- Provider-exposed thinking/reasoning and tool calls/results retained in the trail, with provenance and trust labels.
- Authority and capability effects.
- Retry, pause, inspect, and open-result actions.
- Schedule create, edit, pause/resume, run-now, and delete controls.

Only the exact live trail is labeled Working. An incomplete historical trail is **Incomplete**, never inferred as live. Opening details is deterministic read-only inspection. Unassigned historical runs remain trail data rather than becoming a second visible staff identity.

### 11.3 Authority

- Founder approval is a native signed transition.
- File edits alone never approve an effect.
- Reviews identify company, staff, trail/session, exact action, scope, attendance, behavior hash where applicable, and whether approval is single-use or standing.
- The global pause and hard brake remain accessible from the bottom Company / Profile control, plus a native emergency shortcut, when the controller or a company surface fails.
- Kernel escalation does not depend on staff speech or controller cooperation.

## 12. Breaking local migration

There are no production users or remote environments to preserve. V1 therefore performs one explicit breaking migration to the fixed shell. It preserves company files, staff, trails, artifacts, inbox, connector bindings, schedules, authority records, and Git history, but removes every obsolete company-owned shell copy and saved shell version.

### 12.1 Existing companies

- Existing companies do not receive auto-hired staff.
- If the company has no `.qorpera/staff.json`, the protected registry is treated as version 1 with an empty `agents` object and the company opens with the six starter roles.
- Existing untagged controller trails remain byte-identical on disk for provenance but are not presented as staff conversations.
- Existing product-worker attribution remains intact and is not reclassified as staff work.
- Existing schedules without `staffAgentId` are disabled. Migration does not guess an owner; the founder may explicitly assign and re-enable one later.
- Every active schedule with `staffAgentId` appears only inside that staff member's Activity/details. No standalone schedule or job page survives migration.
- An existing runnable model binding skips provider onboarding. A broken binding opens a focused repair flow using the three fixed defaults.
- Existing capability and secret references remain machine-local and are not recopied.

### 12.2 Existing projections and obsolete shells

- A valid existing `app/projection.json` remains the surface publication contract.
- Each projected page with an exact active `staffAgentId` becomes a header tab for that staff member, regardless of the containing department's `departmentId` relationship.
- Projected pages with no `staffAgentId`, or an unknown/archived value, stay on disk but are not published in the staff interface until explicitly assigned. Migration does not guess from department links, labels, paths, authorship, or recent use.
- Assigning a legacy page writes the selected UUID to that exact `ProjectionPageNode.staffAgentId`; it does not move surface files, change staff `departmentId`, or alter history.
- A staff member may own pages across projection departments. Each page has at most one explicit owner. Invalid ownership references fail visibly and never fall back to inferred department ownership.
- The former platform-owned Main, Inbox, Activity, and Chats entries do not remain rail destinations. Staff conversation, the computer panel, company-status cards, and owned artifact toggles replace them.
- Existing company-authored surfaces continue inside the bounded staff surface host.
- On first open, the kernel resolves the exact direct `<company>/userland` child, rejects linked or redirected entries, removes the complete physical tree including `.versions`, and records the deletion in that company's Git history when applicable.
- Migration never serves, embeds, exports, or offers rollback to deleted shell code. The fixed shell is loaded only from the installed Base package and is never copied into a company.
- The migration is idempotent. A company without `userland/` opens directly in the fixed shell.

### 12.3 Identity and portability

- Open/import/fork never carries provider credentials, founder private keys, local gate capabilities, schedules, or standing signatures across environment identity boundaries.
- Forked companies receive a fresh environment identity and an empty machine-local authority binding.
- Moving a company through a first-class environment operation should preserve or explicitly rebind machine-local identity. Direct filesystem moves continue to require native review because current state is path-keyed.

### 12.4 Failure and recovery

- A linked, redirected, or otherwise non-physical legacy shell fails before deletion and names the exact unsafe path.
- The installed fixed shell is independent of company migration, so a failed cleanup never requires loading old company code.
- Registry and projection writes retain their normal last-known-good documents.
- No migration rewrites append-only trails or released Git history. Deletion of a tracked legacy shell is a new kernel-authored Git commit.

## 13. Security requirements

1. Provider login tokens never enter model context, company files, sandbox environment, company-authored surfaces, or ordinary trail payloads.
2. Staff share the controller security actor in v1; `staffAgentId` never widens authority.
3. Company-authored content cannot assert Working, Queued, authority status, provider login success, or capability binding.
4. Company surfaces run under the existing exact-origin renderer boundary and cannot reach trusted shell APIs directly.
5. Credential, authority, policy, company-operation, and external-link reviews are native and canonicalized.
6. Every founder input is bound to a signed, expiring, single-use causal intent.
7. Every task and outward effect remains attributable to company, security actor, staff role, task, behavior hash where applicable, and causal intent.
8. Runtime serialization is kernel-owned. UI queue state cannot start a competing writer.
9. Invalid staff registry mutations are rejected atomically; invalid linked-surface publications fail closed to the last valid publication.
10. The shell states residual isolation limits honestly on every supported platform.

## 14. Accessibility requirements

- All shell functions are keyboard accessible, including company switching, staff selection, task creation, capability review, and the hard brake.
- Focus order follows the visual hierarchy and returns to the initiating control after modal review.
- Staff state is expressed by text and iconography, never color or animation alone.
- Avatar color variants meet contrast requirements in both light and dark themes.
- Reduced-motion mode replaces all loops and celebratory transitions with static equivalents.
- Runtime updates use restrained accessible live regions and do not repeatedly announce token-level streaming.
- Conversation bubbles preserve speaker names for screen readers and do not rely on left/right position alone.
- Native versus company-authored content has a programmatically exposed trust label.
- Action controls meet a 44 by 44 CSS-pixel target where layout permits and never fall below platform accessibility guidance.
- Zoom to 200 percent remains usable without hiding the active company, staff identity, composer, or current essential action.
- Error messages state the cause, retained work, and recovery action in plain language.

## 15. Phased delivery and acceptance criteria

### Phase 0 — Contract and original visual system

- Ratify this document and the protected `.qorpera/staff.json` version-1 registry contract.
- Produce original Qorpera avatar, motion, conversation, and trusted-review designs.
- Complete naming and visual review against the supplied reference to prevent copied branding.
- Prototype welcome, empty roster, customizable Qorpera face avatars, staff conversation, capability request, and linked-artifact boundary.
- Usability participants can distinguish company, staff, task, run, conversation, linked surface, and trusted system card without implementation terminology.

### Phase 1 — Fixed shell and migration boundary

- The rail contains only Search, + Add staff, staff rows, and the bottom single-line Company / Profile control, in that order.
- No company-authored content can replace or overlap fixed chrome.
- Desktop navigation has no manual sidebar toggle.
- Selecting staff exposes linked artifacts as header toggles; conversation is implicit and computer/routines/settings open in the contextual right panel.
- Tasks and schedules have no standalone page and remain inside their owning staff member.
- Existing owned projections render in bounded staff tabs; invalid or unassigned pages stay unpublished with diagnostics.
- The exact physical legacy `userland/` tree and all saved versions are deleted; staff, trails, schedules, artifacts, inbox, authority, and connector bindings remain.
- Existing trails and prior company Git history remain unchanged; tracked legacy-shell deletion is added as a new kernel commit.
- The installed fixed shell remains usable after interrupted company migration, and linked artifacts retain their last-known-good publication.

### Phase 2 — Provider-first onboarding and profile selector

- A fresh user reaches the profile selector through one provider authentication. Each profile card opens exactly one isolated company environment and exposes no physical path in the card.
- GPT resolves to `openai-codex/gpt-5.5`, Claude to `anthropic/claude-opus-4-8`, and Grok to `xai/grok-4.5`.
- No silent model fallback occurs.
- Authentication cancellation, offline state, missing entitlement, and provider failure have local retry or provider-switch actions.
- Provider login cannot approve authority or replace local founder identity.
- Open existing company is available from welcome.
- Profile controls support New, Open, Import, Export, and Fork and name exact active work before switching.
- Profile switching and global settings live only in the bottom Profile control.

### Phase 3 — Durable staff and conversations

- New profiles show exactly the six frozen starter roles in a multi-select grid, followed by the service-category and **Other** question.
- Starting a team persists every selected registry entry and first trail before the local orientation queue begins; only one introduction is Working at a time.
- Unsupported **Other** services produce a connector brief and recipe proposal before any credential request.
- Hiring produces a valid protected registry record, stable UUID `staffAgentId`, and proactive first message.
- New staff launch on the selected frozen provider/model with Fast execution and `low` reasoning.
- Provider/model, speed, and reasoning settings are independently editable per staff member from the trusted composer More panel and never appear as persistent composer chrome.
- Staff display identity and history survive restart.
- New tasks group under staff while each run remains independently inspectable.
- Only one staff member can show Working; runnable contenders show Queued in deterministic order.
- Sending while busy preserves the draft, names active work, and offers Run when free.
- Untagged historical trails remain on disk for provenance but do not create a compatibility conversation.
- Qorpera face avatars use the founder-selected registry color and shape plus state-specific accessible animation.
- Normal conversation contains only founder/assistant output and essential native system, connector/authority, queue, and error/retry cards.
- Thinking, reasoning, tool execution, and command output remain absent from chat and complete in staff Activity/details.
- Motion, keyboard, screen-reader, contrast, zoom, and reduced-motion requirements pass.

### Phase 4 — Contextual capabilities, attention, and authority

- A blocked task can produce a canonical capability request with reason, scope, destination, attendance, and alternative.
- Native Connect, Not now, and Deny transitions are attributable and recoverable.
- Successful connection resumes or explicitly continues the blocked task without repeating founder context.
- Raw credentials never enter company-controlled execution or storage.
- A local reviewed connector package can normalize public Codex/OpenAI or Claude skills and MCP definitions into one model-neutral installed capability.
- The same installed connector can be used by GPT, Claude, and Grok without three provider-specific copies.
- Install, update, revoke, and removal show source, content hash, executable/network/secret permissions, and affected staff before mutation.
- Provider-hosted app IDs are never mistaken for portable local connector implementations.
- Staff/company attention badges and essential cards deduplicate and supersede obsolete requests without a separate page.
- Approved requests never reopen because of controller file edits or interrupted runs.
- Staff Activity/details separates runtime completion from business success, exposes complete trail detail, and shows actionable failure causes.
- Hard brake and pause remain available during controller and company-surface failure.

### Phase 5 — Transactional staff surfaces and ownership migration

- Valid department and page publication updates the owning staff member's header tabs without app restart.
- Candidate substrate and surface changes activate as one atomic set.
- Validation detects missing rendered fields and empty required sections, not only missing files.
- A broken candidate never replaces the prior valid linked surfaces.
- Every activation has provenance and a one-action rollback.
- Fixed-shell failures name the useful cause, preserve drafts, and offer reconnect or retry without loading company-authored chrome.
- Unassigned projected pages remain unpublished until explicit assignment; invalid staff references fail visibly and never infer ownership from `departmentId`.
- Unassigned schedules are disabled until explicit assignment; only future wakes gain the new `staffAgentId`.
- Artifact revision remains free; outward actions still cross native authority.

### V1 release gate

V1 is complete only when Phases 1 through 5 pass together on a migrated existing company and a newly created company. A polished empty roster without safe ownership migration, authority, and transactional linked-surface publication is not a complete release.

## 16. Known deferred work

The following work is explicitly outside v1:

- Headless kernel/service execution while Base itself is closed. Background execution keeps the Base process alive under the tray; quitting Base still stops everything.
- Any **always on** product claim.
- Parallel company-controller writers or parallel staff execution. Rooms serialize participant turns through the single autonomous lane.
- Staff-specific kernel authority roles; all staff use the controller role in v1.
- Unbounded delegation graphs, recursive manager trees beyond three hops, and automatic merge arbitration beyond the room's explicit speaker transcript.
- A hosted public Qorpera connector catalogue, ratings, or automated third-party publishing pipeline. Local reviewed package installation is V1.
- Production Nordea payments or other regulated financial actions without the required external licensing, roles, and credentials.
- Inbound webhook/listening support except as an optional kernel module.
- MCP server exposure of company capabilities except as an optional kernel module.
- A Qorpera cloud account, cloud sync identity, or multi-user organization service.
- Remote agent computers or remote desktop streaming. Staff execute on the founder's current local machine in V1.
- Concurrent per-participant room execution. Rooms exist as durable entities with per-message speaker identity and mention routing; their participants respond serially on the single company lane.
- Cross-company business-data aggregation.
- Automatic reassignment of legacy schedules, surfaces, or conversations to new staff.
- Voice input and voice conversations.
- Mobile shell navigation.
- OS-keychain hardening where the current platform still uses protected mode-0600 credential files.
- General Base contract migration across arbitrary future environment versions beyond version stamping and explicit migration tooling.

Deferred work must not be implied by v1 copy or animation. In particular, a durable staff identity is not evidence of background execution or parallelism.

## 17. Product success measures

- Time from launch to verified intelligence and the empty company view.
- Provider authentication completion and repair rate.
- First-staff hire rate.
- Time from hire to the proactive first proposal.
- Time from first assignment to a linked useful outcome.
- Capability requests completed from the essential connector card without opening Connections.
- Percentage of users who correctly identify staff versus task versus company.
- Queued tasks that retain founder drafts and later start successfully.
- Failed runs with an actionable cause and recovery path.
- Duplicate, stale, or incorrectly reopened attention requests.
- Linked-surface candidate rejection and rollback rate.
- Historical run inspections that perform zero file or trail mutation.
- Accessibility completion for provider login, hiring, assigning work, reviewing authority, and activating the hard brake.

These measures evaluate comprehension, useful outcomes, and trust. Message volume, avatar engagement, and raw session count are not primary success metrics.
