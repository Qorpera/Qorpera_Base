# Qorpera Calls Specification

**Status:** Draft product and architecture contract

**Date:** 2026-08-24

**Scope:** Founder-to-staff and staff-to-founder live voice calls in Qorpera Base, including native shell UI, agent call requests, interruption policy, durable thread records, authority, and staged telephone delivery

**Related contracts:** `QORPERA-STAFF-SHELL-SPEC.md`, `packages/coding-agent/docs/company.md`, `packages/coding-agent/docs/authority.md`

## 1. Decision

Calls are a standalone Qorpera feature. They are not presentations, teaching artifacts, walkthroughs, podcasts, videos, or another artifact format.

A call is a live attended interaction with a durable staff member. The founder may start it from the staff thread, or a staff member may request one when synchronous conversation materially reduces delay, ambiguity, or interaction cost. The same call session may be reached through an in-app voice window first and a telephone transport later.

The product distinction is:

- A **presentation** explains work through a prepared artifact.
- A **thread message** communicates asynchronously.
- A **notification** asks for attention without opening a conversation.
- A **call** opens a live, interrupting conversation because speaking now is more useful than continuing asynchronously.

Importance alone does not justify a call. A serious event that staff can safely investigate, test, contain, and resolve should remain autonomous. A non-emergency issue may justify a call when it contains several dependent questions or a nuanced approval that would be inefficient in text.

## 2. Product goals

Calls MUST:

1. Let the founder speak with the selected staff member without leaving the staff thread.
2. Keep the rest of Qorpera Base usable during the call.
3. Give staff a structured way to request a live conversation without giving a model direct control of an interruption or telephone dialer.
4. Let the founder predict and control when staff may ring them.
5. Support deadline-based escalation from an existing task, notification, or approval request.
6. Make multi-question, approval, verification, sensitive, and live-coordination conversations faster than repeated messages.
7. Preserve call outcome, provenance, and follow-up work in the owning staff thread.
8. Keep approvals and outward effects inside the existing native authority boundary.
9. Work through provider-native harnesses without depending on a provider-specific system prompt.
10. Extend later to ordinary telephone calls without changing the staff identity, call policy, or thread record.

## 3. Non-goals

The first Calls tranche does not include:

- Presentation, teaching, podcast, or video generation.
- A new Calls destination, tab, artifact, or staff surface.
- A full-screen voice mode that replaces the selected staff thread.
- Direct model access to telephony credentials or provider APIs.
- Automatic calls based only on a model-generated urgency label.
- Spoken authorization for high-impact actions without the required native review.
- Emergency-services calling.
- Automatic recording of call audio.
- A dedicated telephone number for every staff member.
- Group calls or calls between staff members.
- Inbound calls from unknown external people.

## 4. Normative terms

`MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, and `MAY` are normative requirements.

- **Call request:** A structured proposal to hold a live conversation. It is not permission to ring or dial.
- **Call policy:** Host-owned rules that select whether and how a call request may interrupt the founder.
- **Call session:** One live voice conversation bound to a company, staff member, founder, and causal request.
- **Call attempt:** One in-app or telephone attempt to connect a call session.
- **Call brief:** The bounded context assembled for the live voice runtime.
- **Call record:** The durable native event rendered in the owning staff thread.
- **Conversation request:** The broader agent proposal from which the host may choose a task, notification, scheduled call, in-app ring, or telephone call.
- **Synchronous benefit:** The expected reduction in turns, ambiguity, or dangerous delay from speaking live instead of continuing asynchronously.
- **Interruption cost:** The expected cost of taking over the founder's attention at the current time and through the selected transport.

## 5. Interaction classes

Calls are classified by why a live conversation helps, not by a single severity scale.

### 5.1 Founder-started working call

The founder selects the call button in a staff header. The selected staff member joins with current thread context. This path does not require an agent call request or interruption-policy decision.

### 5.2 Deadline escalation

An existing task, notification, approval, or follow-up carries a visible response deadline and a configured `callAfter` time. If it remains unresolved, the host may ring once according to founder policy.

The asynchronous item MUST state the planned escalation before it occurs, for example:

```text
Needs your answer by 3:00 PM
If unanswered, Brain will call once at 2:50 PM
```

### 5.3 Branching questions

A call may be useful when answers are dependent and each answer changes the next question. A long list of independent questions SHOULD use a form or thread message instead.

### 5.4 Contextual approval

A call may explain alternatives, consequences, timing, and a recommendation before a purchase or other authority request. The call MAY prepare a native approval, but MUST NOT impersonate or replace it.

### 5.5 Failed asynchronous convergence

A call may be proposed after repeated clarification loops, contradictory answers, or evidence that staff and founder are talking past one another.

### 5.6 Live external coordination

A call may be useful when a customer, supplier, candidate, partner, delivery, or time-limited external event is waiting for a founder decision.

### 5.7 Instruction conflict

A call may resolve a conflict between founder instructions, policies, priorities, or multiple authorized company members when the agent cannot infer which principle should win.

### 5.8 Sensitive conversation

A call may be offered for delicate customer, employee, reputational, or relationship matters where voice communicates uncertainty or nuance better than a cold notification. Sensitivity alone does not permit an unannounced telephone interruption.

### 5.9 Pre-authorized opportunity

A call may report a short-lived opportunity only when it matches a founder-created standing preference, such as a price, candidate, domain, or availability threshold.

### 5.10 Verification

A call may act as an out-of-band conversation when an instruction is unusual or conflicts with established behavior. Answering a phone does not by itself prove identity or authorize an effect.

### 5.11 Bundled voice briefing

The founder may choose voice as a working channel and allow staff to bundle several non-urgent decisions into one call. The bundle MUST name the number of topics and expected duration before the founder answers.

## 6. Channel selection

The host selects the least interrupting channel that can still achieve the outcome.

| Human input | Synchronous benefit | Default channel |
|---|---|---|
| Not required | Low | Staff acts; thread outcome when useful |
| Not required | High | Staff acts; optional founder-started voice explanation |
| Required | Low | Task, notification, form, or native approval |
| Required | High | Offer, schedule, or place a call according to policy |

Urgency determines **when** interaction is needed. Synchronous benefit determines **whether a call is the right interaction**. Transport policy determines **how the founder is reached**.

Before requesting a call, staff MUST complete every safe, useful step that does not require founder input. Staff MUST NOT call merely to transfer investigation, testing, comparison, or routine judgment back to the founder.

## 7. Initial native-harness behavior contract

The first implementation cannot assume that Qorpera controls every provider system prompt. Call behavior MUST therefore be supplied through the host-managed instruction file used by the native harness. For Codex-compatible harnesses this is an `AGENTS.md` instruction block; other harnesses receive the equivalent native instruction file.

This instruction is behavioral guidance only. It does not grant a capability, authorize an interruption, or bypass host policy.

The initial block SHOULD be semantically equivalent to:

```md
## Live calls

You may request a live conversation with the founder, but you cannot ring or
dial them directly. The host decides whether a request becomes a message,
scheduled call, in-app ring, or phone call.

Request a call only when live conversation would materially reduce delay,
ambiguity, repeated clarification, or the cost of several dependent questions.
Importance alone is not a reason to call.

Before requesting a call:

- Complete every safe investigation, test, comparison, and containment step
  that does not require founder input.
- Explain what you already completed.
- State the decision or information you need.
- Prefer a task, message, form, or approval when live discussion adds little.
- State the deadline, expected duration, and fallback if the founder does not
  answer.
- Never repeatedly call, manufacture urgency, or use guilt to obtain attention.

Use the host call-request tool. Never invoke a telephony provider directly.
```

The host SHOULD generate or mount this block rather than asking company-authored content to edit a founder-owned root instruction file. The effective block MUST be inspectable and versioned by Qorpera. Provider-specific wording MAY vary, but the behavioral requirements MUST remain equivalent.

## 8. Agent call-request contract

Staff request a conversation through a brokered host tool. The initial product-facing shape is:

```text
request_founder_call({
  purpose,
  reason,
  agenda,
  questions,
  workCompleted,
  expectedMinutes,
  deadlineAt?,
  callAfter?,
  fallbackIfMissed,
  evidenceRefs?
})
```

The tool MUST create a call request and return the host decision. It MUST NOT synchronously invoke a phone provider.

An example request is:

```json
{
  "schema": "qorpera.call-request/v1",
  "id": "callreq:01K...",
  "companyId": "company:01K...",
  "staffAgentId": "2a946c8e-6959-4a3b-9f36-479135ba853f",
  "trailFile": "2026-08-24T12-30-00-000Z_9f58c4ad.jsonl",
  "purpose": "approval",
  "reason": "The annual plan saves EUR 600, but exceeds my purchase authority.",
  "agenda": ["Compare annual and monthly terms", "Confirm purchase"],
  "questions": ["May I purchase the annual plan for EUR 4,200?"],
  "workCompleted": [
    "Compared three suppliers",
    "Checked the approved budget",
    "Confirmed the quote expires at 15:00"
  ],
  "expectedMinutes": 4,
  "deadlineAt": "2026-08-24T15:00:00+02:00",
  "callAfter": "2026-08-24T14:50:00+02:00",
  "fallbackIfMissed": "Do not purchase; retain the comparison in the thread.",
  "evidenceRefs": ["agents/<id>/artifacts/supplier-comparison.md"],
  "createdAt": "2026-08-24T12:30:00+02:00"
}
```

Allowed `purpose` values are initially:

- `working-session`
- `deadline-escalation`
- `approval`
- `clarification`
- `live-coordination`
- `sensitive`
- `verification`
- `briefing`

The schema MUST NOT contain a model-controlled `dialNow`, `bypassQuietHours`, or equivalent field.

## 9. Host interruption policy

The call broker is trusted host infrastructure. It canonicalizes the request, evaluates policy, persists its decision, and selects one of:

- `continue_async`
- `post_call_offer`
- `schedule_call`
- `ring_in_app`
- `call_phone`
- `deny`

The policy MUST consider:

- Founder opt-in for agent-initiated calls.
- Allowed staff members and call purposes.
- Quiet hours, time zone, working hours, and temporary focus state.
- Whether a visible response deadline and escalation promise already exist.
- Number and dependency of questions.
- Expected duration.
- Safe work already completed.
- Whether waiting worsens the outcome.
- Whether staff can continue productively without an answer.
- Request confidence and trusted evidence.
- Duplicate, superseded, resolved, dismissed, and expired requests.
- Recent call frequency, declined calls, cooldowns, and daily limits.
- In-app presence and available transports.
- Global pause, company hard brake, and per-staff pause.

External text, connector output, email, web content, or another agent's message MUST NOT directly trigger a ring. Such material may be evidence for a call request, but the request remains subject to host policy.

The first implementation SHOULD prefer explicit rules and founder configuration over a learned interruption score. A model MAY summarize why a call would help, but MUST NOT be the sole decision-maker.

## 10. Founder controls

The Company settings surface owns global call policy. Staff settings MAY narrow it for one staff member.

The founder can configure:

- Whether staff may request calls.
- Whether staff may ring in-app without a prior manual answer.
- Whether deadline escalations may call automatically.
- Whether telephone calls are allowed.
- Which staff members and purposes may call.
- Quiet hours and time zone.
- Maximum automatic calls per day.
- Retry behavior after a missed or declined call.
- Whether voicemail may be left.
- Caption and transcript retention.
- Audio recording, off by default.
- The default transport order.

The founder MUST be able to pause all agent-initiated calls immediately without disabling founder-started calls or deleting call history.

## 11. Selected-staff header

The selected-staff header remains one fixed shell row.

```text
[avatar] Brain  Research Lead          [Call] [Company Computer] [...]
```

Requirements:

- The **Call** button is a handset icon immediately to the left of **Company Computer**.
- It is part of trusted shell chrome, not an artifact toggle.
- It is available while the conversation canvas is selected.
- It MUST NOT create a **Calls** or **Voice** tab.
- It MUST NOT move the conversation under an artifact such as **Findings**.
- The idle tooltip is **Call <name>**.
- During a live call, selecting it focuses or restores the call window.
- When voice is unavailable, the disabled control explains the exact cause.
- The control exposes an accessible name and a platform-sized pointer target.

Artifact toggles, when present, retain their existing meaning. Calls never appear among them.

## 12. Active in-app call window

The call opens as a compact movable window inside the main Qorpera window. It does not navigate away from the thread.

### 12.1 Default geometry

- Initial size: approximately 360 by 410 CSS pixels.
- Initial placement: lower-right of the main pane, clear of the composer and trusted reviews.
- The title area is draggable.
- The window remains constrained to the usable main-pane bounds.
- Position persists for the current app session and MAY persist per profile.
- The window may be minimized and restored from the header call button.
- A later tranche MAY add resizing; the first implementation may use one fixed expanded size plus a minimized state.

### 12.2 Content

The expanded window contains:

- Staff name and elapsed time.
- The exact staff avatar and appearance.
- A restrained voice activity indicator.
- One or two live caption lines.
- Mute.
- Captions on/off.
- Minimize.
- End call.

The window SHOULD favor the staff identity and current spoken point over a long transcript. Full transcript review belongs after the call or in an explicit disclosure.

The expanded window MUST NOT show connector logos, a **Read from** footer, artifact tabs, or a dial pad.

### 12.3 Interaction with the shell

- The founder can scroll, navigate, open files, inspect the staff computer, and write messages during a call.
- The call window MUST NOT make the rest of the app inert.
- The window remains above ordinary thread content but below native authority, credential, and security reviews.
- A native review may temporarily take focus without ending the call.
- Closing the selected thread does not end the call; the minimized call indicator remains available in trusted chrome.

## 13. Incoming in-app call

An incoming call first appears as a compact native ring surface. It includes:

- Staff avatar and name.
- Purpose in plain language.
- One-sentence reason.
- Expected duration.
- Deadline, when relevant.
- **Answer**, **Decline**, and **Reply in thread**.

Example:

```text
Brain is calling for an approval
The supplier quote expires at 3:00 PM
About 4 minutes

[Answer] [Decline] [Reply in thread]
```

Declining MUST NOT produce guilt-oriented copy. The agent receives a structured decline event and follows the declared fallback. The founder MAY add **Call me in 10 minutes** or another explicit callback time.

## 14. Thread call records

Calls are persisted as native conversation events in the owning staff thread. They are not assistant-authored Markdown and cannot be rendered by company-authored content.

### 14.1 Completed call

The selected design is a flat native call record using alignment and whitespace instead of a large card:

```text
[call/wave]  Call with Brain       <waveform>       10:25 AM
             Purchase approval · 4 min
```

Requirements:

- The record sits in the staff side of the conversation with the staff avatar in the normal gutter.
- It is visually denser than a normal message and lighter than an authority card.
- It uses staff color for the call/wave mark without relying on color alone.
- Hover or keyboard focus reveals one compact action capsule containing **Summary** and **Call back**.
- **Summary** opens a native summary surface anchored to the record or in the existing contextual panel.
- **Call back** starts a new founder-initiated call linked to the prior session.
- The actions do not remain permanently visible when the record is idle.

### 14.2 Missed call

The missed state is a calm, narrow record:

```text
[missed handset]  Missed call from Brain      10:42 AM
```

Requirements:

- It is not styled as an application error.
- It may use muted red with an explicit missed-handset icon and text.
- Hover or focus reveals **See why**.
- **See why** exposes the original reason, requested agenda, deadline, work completed, and fallback.
- If the request is still relevant, the surface MAY include **Call back** or **Reply in thread**.
- A declined call uses **Declined call**, not **Missed call**.

### 14.3 Record lifecycle

One call session owns one thread record. The record updates in place as state changes rather than emitting duplicate records for requested, ringing, answered, and ended.

A record may reach:

- `offered`
- `scheduled`
- `ringing`
- `active`
- `completed`
- `missed`
- `declined`
- `cancelled`
- `failed`
- `expired`

## 15. Call summary and continuation

Ending a call produces a bounded continuation envelope containing:

- Plain-language summary.
- Decisions made.
- Open questions.
- Explicit approvals or denials discussed.
- Follow-up work staff committed to.
- Evidence references mentioned.
- Transcript reference when retained.
- Call duration and transport.

The summary MUST distinguish discussion from authorization. For example, **The founder was comfortable with the annual plan** is not an executable approval. A native signed approval remains separate.

The continuation is delivered to the owning staff runtime on its next turn and retained with the call record. The staff member SHOULD acknowledge the agreed next step in normal low-LIX thread prose and continue work without asking the founder to repeat the call.

If summary generation fails, the call record and transcript metadata remain valid and display **Summary unavailable** with retry. The call MUST NOT disappear.

## 16. Live voice runtime

A call runtime represents the same durable staff member but need not be the same model process as the text harness.

The host assembles a bounded call brief from:

- Company and staff identity.
- Staff charter and appearance.
- Staff memory relevant to the request.
- The call request and agenda.
- A compact digest of the current thread.
- Exact pending native reviews.
- Referenced evidence that the founder may ask about.
- Tools allowed during an attended voice session.

The call brief MUST NOT indiscriminately copy the complete Company File, complete trail history, raw connector payloads, or secrets into the voice session.

The voice runtime MAY use a provider Realtime/WebRTC session, a provider-native voice mode, or another approved speech transport. Product semantics cannot depend on one provider. The call broker owns transport adaptation, interruption policy, event normalization, and durable records.

Provider or voice-model substitution MUST be visible in Activity/details when it differs from the staff member's normal model. It MUST NOT create a second visible employee.

## 17. Tools and authority during a call

The call runtime may read bounded context and use allowed attended tools. It remains subject to the same company role, capability, and authority boundaries as the selected staff member.

Rules:

- The voice runtime cannot approve its own request.
- The voice runtime cannot directly dial, purchase, transfer money, sign, publish, send, or perform another outward effect merely because the founder is speaking.
- An approval discussion may create or focus the exact native review.
- High-impact approval requires the normal native signed transition.
- When voice approval is later allowed for a bounded low-risk class, it requires explicit founder opt-in, exact read-back, an authenticated call session, a durable transcript event, and a class-specific limit. It remains outside the first tranche.
- Ambiguous assent such as **yeah** or **sounds good** MUST NOT be converted into an executable authority decision.
- Company-authored content cannot render a lookalike call, call record, incoming ring, or voice approval.

## 18. Persistence contract

The host owns durable call state. Proposed read models are:

```text
call_requests
call_sessions
call_attempts
call_events
```

A call session minimally records:

```json
{
  "schema": "qorpera.call-session/v1",
  "id": "call:01K...",
  "companyId": "company:01K...",
  "staffAgentId": "2a946c8e-6959-4a3b-9f36-479135ba853f",
  "founderIdentityId": "founder:01K...",
  "requestId": "callreq:01K...",
  "trailFile": "2026-08-24T12-30-00-000Z_9f58c4ad.jsonl",
  "state": "completed",
  "transport": "in-app-webrtc",
  "startedAt": "2026-08-24T12:50:00+02:00",
  "answeredAt": "2026-08-24T12:50:05+02:00",
  "endedAt": "2026-08-24T12:54:11+02:00",
  "durationSeconds": 246,
  "summaryRef": "call-summary:01K...",
  "transcriptRef": "call-transcript:01K...",
  "recordingRef": null
}
```

Every transition records company, staff, founder, causal request, transport, policy revision, kernel timestamp, and provider attempt identifier where applicable. Provider webhooks and model assertions are inputs; the host journal is the durable state authority.

## 19. State machine

```text
requested
  -> continued_async
  -> offered -> accepted -> connecting -> active -> completed
  -> scheduled -> ringing -> accepted -> connecting -> active -> completed
  -> ringing -> missed
  -> ringing -> declined
  -> cancelled
  -> expired
  -> failed
```

Rules:

- A resolved or superseded request cannot ring.
- A declined request does not retry unless the founder explicitly configured a retry or callback.
- A missed call defaults to no automatic retry.
- A critical configured deadline escalation may retry once after a founder-selected interval.
- Ending the media connection is idempotent.
- Recovery reconciles provider state with the host journal before changing the thread record.
- A call that connected but lost its final provider webhook can still complete from locally observed media and end events.

## 20. Proposed native shell API

The exact bridge may remain internal, but equivalent behavior is required:

```text
POST   /api/staff-agents/:staffAgentId/calls
POST   /api/call-requests
GET    /api/call-requests/:requestId
POST   /api/call-requests/:requestId/review
GET    /api/calls/:callId
POST   /api/calls/:callId/answer
POST   /api/calls/:callId/decline
POST   /api/calls/:callId/end
POST   /api/calls/:callId/mute
POST   /api/calls/:callId/captions
GET    /api/calls/:callId/summary
GET    /api/calls/:callId/transcript
```

Founder-started `POST /api/staff-agents/:staffAgentId/calls` creates an attended in-app session. Agent-originated `POST /api/call-requests` creates only a request for host policy evaluation.

Runtime events include at least:

```text
call.requested
call.offered
call.scheduled
call.ringing
call.answered
call.started
call.ended
call.missed
call.declined
call.cancelled
call.failed
call.summary_ready
```

## 21. Telephone transport

Telephone delivery is a later transport over the same call broker and session contract.

### 21.1 Number strategy

The first telephone tranche SHOULD use one verified company-owned number. The staff member identifies itself immediately when the founder answers. A telephone number is a routing identity, not staff identity or authority.

Per-staff numbers MAY be added later for selected staff members when direct callbacks justify the cost and operational burden. Qorpera MUST NOT provision one number per staff member by default.

### 21.2 Outbound call path

The telephone provider:

1. Receives an approved outbound attempt from the call broker.
2. Dials the founder from the verified company number.
3. Connects answered audio to the live voice runtime through a bidirectional media or SIP bridge.
4. Reports attempt state to the host journal.
5. Never receives company context beyond what is required for transport and compliance.

### 21.3 Call opening

The staff member MUST identify itself, state the reason, and ask whether the founder can talk before giving a long explanation.

```text
Hi Jonas, it is Brain from Company41. I have a purchase approval that expires
at 3 PM. It should take about four minutes. Can you talk now?
```

If another person answers, the agent MUST NOT disclose sensitive company context. It asks for the founder or ends the call according to policy.

### 21.4 Callback

Calling the shared company number MAY resume the most recent relevant staff call after founder authentication, or present a minimal staff chooser. A per-staff number maps to a `staffAgentId` but never bypasses founder authentication or authority.

## 22. Privacy, consent, and retention

- Agent-initiated in-app and telephone calls require explicit founder opt-in.
- Captions and transcript retention are separate settings from audio recording.
- Audio recording is off by default.
- When audio or transcripts are retained, the call opening and UI disclose it according to applicable law and policy.
- Call audio, transcripts, summaries, phone numbers, and provider identifiers follow explicit retention limits.
- Raw audio and transcripts do not enter company files unless the founder exports them.
- Summaries MAY be retained with the thread while raw transcript retention is shorter or disabled.
- Deleting recoverable call content follows the normal native data-management flow; provenance required for authority decisions remains retained in the narrow canonical record.
- Telephone deployment requires regional telecom, automated-calling, caller-identity, recording, and privacy review before activation.

## 23. Accessibility

- The header call button, incoming ring, call window, thread records, hover actions, and summary are fully keyboard accessible.
- Hover-only actions also appear on keyboard focus and through an accessible menu.
- Call state and microphone state are expressed in text, not color or animation alone.
- Captions are available during in-app calls where the provider supports them.
- Live captions use restrained announcements and do not flood screen readers token by token.
- Reduced-motion mode replaces waveform animation with a static activity indicator.
- The call window remains usable at 200 percent zoom and cannot trap focus.
- Ending a call requires one unambiguous control but no confirmation dialog during an active conversation.
- Mute state is announced immediately.

## 24. Failure and recovery

The UI names the useful cause and preserves the asynchronous path.

- **Voice unavailable:** Keep the thread usable and offer **Continue in thread**.
- **Microphone denied:** Explain how to enable it; do not repeatedly prompt.
- **Connection failed:** Update the single call record to **Failed call** and offer retry or thread reply.
- **Agent runtime failed:** End or reconnect the media session without losing the call record.
- **Summary failed:** Preserve call metadata and transcript reference; offer summary retry.
- **Telephone provider failed:** Do not silently fall back to another number or transport outside policy.
- **App restart during call:** Reconcile active provider state; restore the call window when possible, otherwise close the attempt honestly.
- **Hard brake:** Prevent new agent-initiated attempts and end active agent-controlled outward effects according to hard-brake policy.

## 25. Observability and success measures

The feature is successful when it reduces interaction cost without making the founder feel monitored or interrupted.

Measure:

- Founder-started call completion.
- Agent call requests by host decision.
- Answer, decline, miss, cancel, and failure rates by purpose and transport.
- Calls immediately followed by **Do not call me for this** or policy tightening.
- Median expected versus actual duration.
- Number of asynchronous turns avoided after a call.
- Deadline escalations that were announced before ringing.
- Duplicate or stale calls prevented by reconciliation.
- Calls where staff had not completed available safe work.
- Approvals discussed versus approvals completed through native review.
- Call summaries corrected by the founder.
- Per-staff and global call disablement.
- Accessibility completion for starting, answering, muting, captioning, ending, reading summary, and calling back.

Raw call count, minutes spoken, and answer rate are not primary success metrics. Low call volume can indicate correct restraint.

## 26. Delivery phases

### Phase 0 — Contract and visual prototype

- Ratify this specification.
- Prototype the selected compact popup, header call button, flat completed-call record, missed-call record, hover actions, incoming ring, and summary.
- Confirm the thread remains the conversation canvas with no Calls or artifact tab.

### Phase 1 — Founder-started in-app calls

- Add the call button immediately beside Company Computer.
- Start an attended voice session for the selected staff member.
- Keep the thread and shell usable under the movable call window.
- Persist one completed or failed call record.
- Produce a bounded summary and continuation envelope.
- Keep native approvals separate.

### Phase 2 — Agent call requests and offers

- Mount the native-harness instruction block.
- Add the brokered `request_founder_call` tool.
- Persist structured call requests.
- Let the host choose `continue_async`, `post_call_offer`, `schedule_call`, or `deny`.
- Add call-offer and **Call me** thread actions without automatic ringing.

### Phase 3 — Proactive in-app ringing

- Add founder call policy, quiet hours, purpose/staff allowlists, cooldowns, and call limits.
- Add incoming ring, answer, decline, callback time, and thread-reply actions.
- Add announced deadline escalation.
- Deduplicate and supersede stale requests.

### Phase 4 — Telephone calls

- Verify the founder's phone number and explicit opt-in.
- Provision one verified company number.
- Add telephone provider, media bridge, attempt reconciliation, caller identity, and compliance controls.
- Add shared-number callback routing.
- Keep per-staff numbers deferred until usage proves they are valuable.

### Phase 5 — Calibrated call policy

- Use accepted, declined, missed, corrected, and disabled-call signals to recommend policy changes.
- Do not silently loosen call policy.
- Evaluate whether limited, founder-approved adaptive ranking improves channel selection over explicit rules.

## 27. Release acceptance criteria

The first in-app release is complete only when:

- Calls are visibly separate from presentations and artifacts.
- The call button is directly beside Company Computer in the selected-staff header.
- Conversation remains the default canvas and is not labeled **Findings** or another artifact.
- The call window is compact, movable, minimizable, and does not disable normal app use.
- The thread has no call-specific connector or **Read from** footer.
- A call produces exactly one durable native thread record.
- Completed-call hover/focus exposes **Summary** and **Call back**.
- Missed-call hover/focus exposes **See why**.
- The correct durable staff identity and avatar appear in header, call window, and thread record.
- Staff can request but cannot directly place an agent-initiated call.
- The host can decline, defer, schedule, or offer a call independently of the model request.
- Safe autonomous work is completed before a call request.
- Voice discussion cannot bypass native authority.
- Ending, failure, restart, and summary-failure paths preserve an honest thread record.
- Keyboard, captions, reduced motion, zoom, and screen-reader requirements pass.

Telephone release additionally requires opt-in, verified caller identity, quiet hours, attempt reconciliation, missed-call behavior, retention controls, regional compliance review, and a successful callback path through the shared company number.
