# Design QA

Source visual truth: `.artifacts/design-qa/source-target.png`

Implementation evidence:

- `.artifacts/design-qa/connector-form.png`
- `.artifacts/design-qa/artifact-view.png`
- `.artifacts/design-qa/comparison.png`

Viewport: 1280 × 720 CSS pixels, `devicePixelRatio: 1`.

Source pixels: 1486 × 1058. Implementation pixels: 1280 × 720 per state. The source is a two-state presentation board; the implementation was compared as the corresponding live chat and artifact states, then normalized into one 1486 × 1476 comparison image.

State: Financial Officer conversation with a pending financial-ledger source request, plus the selected Financial Health artifact with three unmeasured starter metrics and two source needs.

## Full-view comparison

The live shell preserves the source hierarchy and density: staff rail, compact identity header, unobtrusive artifact tab, open white artifact canvas, and a single dominant table. The source board shows chart data that the current starter artifact does not have. The implementation intentionally omits that chart in this empty-data state and renders a chart only when a metric contains at least two dated numeric observations.

## Focused comparison

- Connector form: the live form matches the supplied answer-sheet structure—one gray surface, compact heading and explanation, one white four-row list with A–D markers, row dividers, and one custom input. It has no connector logo, provider card, radio-card grid, or separate primary CTA.
- Artifact tabs: the inactive tab is uncontained text with a neutral inline count; the selected tab has a 1px black outline, white fill, 4px radius, and no warning color.
- Artifact content: the live artifact uses a compact measures table with Current, Change, Target, Status, Source, and Updated columns. Source needs are plain divided rows with quiet actions rather than alert cards.
- Fonts and typography: Segoe UI Variable/system fallbacks, compact 10–14px product type, weights, and wrapping align with the source and existing Qorpera tokens.
- Spacing and rhythm: the grouped form, 40px artifact gutters, section gaps, and row heights preserve the source's restrained density at the smaller live viewport.
- Colors and tokens: white canvas, warm near-black text, gray separators, and sparse finance green match the selected direction. Attention uses neutral/brown dots instead of amber badges.
- Image and asset fidelity: no illustrative or raster assets are required by this interface. The chart uses a real canvas data rendering only when observations exist; no decorative CSS or SVG substitute was introduced.
- Copy and content: connector choices remain capability-oriented and the browser-verification boundary is explicit. Artifact source actions say “Choose source” instead of assuming Google Sheets.

## Findings

No actionable P0, P1, or P2 differences remain.

P3: the live 1280 × 720 viewport necessarily shows less vertical artifact content than the 1486 × 1058 source board; scrolling preserves access to the remaining source rows.

P3: the current fixture has no dated metric history, so the source's chart cannot be reproduced honestly in this state. The rendering path is present and the artifact schema now preserves strictly chronological numeric observations.

## Comparison history

Initial browser inspection found a P1 user-control mismatch in the artifact source row: it still exposed “Connect Google Sheets.” This was replaced with the generic “Choose source” action, which returns to the grouped choice form. The post-fix artifact capture confirms no provider is assumed.

The post-fix full and focused comparison found no further P0, P1, or P2 issues.

## Interaction and runtime checks

- Opened Financial Officer from the staff rail.
- Opened and closed the Financial Health artifact through its header tab.
- Returned from a source row to the grouped connector form.
- Selected “Company files and spreadsheets” and verified that the choice was sent back to the agent with the artifact and data-need context.
- Verified renderer syntax with `node --check`.
- Ran the repository browser smoke check as part of `npm run check`.
- No visible page failure or broken interaction occurred in the in-app browser. The current in-app browser binding does not expose a historical console-message reader.

## Verification

- `npm run check`: passed.
- `company-artifacts.test.ts` and `app-server.test.ts`: 19 tests passed.
- `connection-requests.test.ts` and `staff-templates.test.ts`: 10 tests passed.

final result: passed

---

# Design QA — Company Computer 16:10 borderless viewer

## Comparison target

- Visual target: the 1335 × 969 Grok Bot viewer and 335 × 169 dock-detail
  screenshots supplied in the 2026-08-27 product-review session.
- Durable implementation evidence: `packages/shell/userland/screens.css`,
  `packages/shell/userland/screen-viewer.js`, and the exact contract assertions
  in `packages/shell/test/userland-wiring.test.ts`.
- The review-session screenshots and generated comparison captures were
  temporary inputs, not repository artifacts, so this record does not cite
  their expired `/var/folders` or `/tmp` paths.
- State: Research Lead's Company Computer connected and live, native XFCE dock visible.

## Normalization

- Source pixels: 1335 × 969; source desktop crop: approximately 1308 × 819.
- Source dock detail: 335 × 169.
- Implementation pixels and CSS viewport: 1308 × 768 at the desktop app
  capture surface's 1× output. With the committed 58 px header, 12 px bottom
  inset, and 8:5 aspect ratio, the stage measures 1116.8 × 698 CSS px
  (1117 × 698 when rounded to whole pixels).
- Full-view comparison: both app views normalized to 768 px high without changing either aspect ratio.
- Stage comparison: both 16:10 desktop regions normalized to 800 × 500 px.
- Dock comparison: the 335 × 169 source crop is paired with an equal-size implementation crop.

## Required fidelity surfaces

- Fonts and typography: the existing Qorpera title and live-status typography remain unchanged, readable, and clear of the macOS traffic lights. The XFCE tooltip and app labels remain native guest UI.
- Spacing and layout rhythm: the desktop is centered with a fixed 16:10 ratio. Wide windows create even side gutters; tall windows create even top and bottom gutters. The 58 px safe header and 12 px outer inset remain intact.
- Colors and visual tokens: the near-black viewer shell remains consistent with the reference. The desktop has no visible bezel, border highlight, or frame shadow.
- Image quality and asset fidelity: noVNC renders the real 1920 × 1200 guest raster without stretching. The existing Qorpera wallpaper and native Chrome, Files, and Terminal icons remain the source assets.
- Copy and content: the screen identity, live takeover hint, and close action are unchanged.

## Findings

- No actionable P0, P1, or P2 differences remain for the requested ratio and borderless treatment.
- P3: the reference window is tall enough to letterbox the 16:10 desktop vertically, while the implementation capture is shorter and pillarboxes it horizontally. This is the expected responsive result of preserving the same ratio rather than stretching either desktop.
- P3: wallpaper palette and exact app-icon artwork differ intentionally because the implementation keeps Qorpera's live agent wallpaper and installed guest applications.

## Comparison history

1. Initial P1: the guest and viewer used a 1920 × 1080 / 16:9 canvas while the selected source used a 16:10 desktop.
2. Initial P2: the viewer added a visible 1 px highlight, 12 px radius, and two-layer frame shadow that read as a bezel absent from the source.
3. Fix: changed the guest to 1920 × 1200, centered an 8:5 stage responsively, removed its border and shadow, and reduced its crop radius to 8 px.
4. Post-fix review: the live app showed an unstretched 16:10 raster, clean
   8 px rounded clipping, no stage border or shadow, and launchers floating
   without a dock surface.

## Interaction and runtime checks

- Opened the Research Lead computer from the agent side panel.
- Verified the loading state remained centered inside the new 16:10 stage.
- Verified the viewer reached `Live · you can take over at any time` with the real VNC session.
- Verified the close action remains visible and accessibility-exposed.
- Verified the current live VNC output at 1920 × 1200; the packaged screen-session contract now starts at that geometry.
- The focused shell wiring suite passed 21 tests; the guest packaging contract passed; `npm run check` passed.

final result: passed

---

# Settings simplification design QA

## Comparison inputs

- Selected source mockup: `/Users/jonas/.codex/generated_images/01a034c2-8b32-7df3-ab81-3ba4b566ec12/exec-a3419bf1-1d5a-4dee-ab59-de58cdfb3b5e.png`
- General implementation: `/Users/jonas/.codex/visualizations/2026/08/24/01a034c2-8b32-7df3-ab81-3ba4b566ec12/general-settings-implementation.png`
- Company implementation: `/Users/jonas/.codex/visualizations/2026/08/24/01a034c2-8b32-7df3-ab81-3ba4b566ec12/company-settings-implementation.png`
- Combined comparison: `/Users/jonas/.codex/visualizations/2026/08/24/01a034c2-8b32-7df3-ab81-3ba4b566ec12/settings-comparison.png`
- Viewport: 958 x 843 CSS pixels per settings page at 1x density
- States: General selected; Company selected

## Full-page review

- The General page now contains Account, Plan & billing, and Appearance only. The removed Company summary no longer competes with account settings.
- The Company page retains the plain company-name heading and staff content. Company File sits below Staff at work with enough separation to read as a distinct storage destination.
- Both pages preserve the existing settings shell, sidebar, typography, neutral palette, spacing system, and responsive content width.
- No content is cropped, overflowing, or visually misaligned at the comparison viewport.

## Focused component review

- Plan & billing presents the current plan, subscription state, and a single plan-management action in one compact row.
- Company File is a single full-width interactive storage row. The folder mark, storage description, and usage bar read as one click target without a redundant open button.
- Exceptional Company File recovery and review actions remain available outside the primary storage row when those states occur.
- Interactive rows and buttons retain visible hover and keyboard-focus states.

## Iteration history

1. Captured both implementation states at 1280 x 720 to check the overall hierarchy and spacing.
2. Re-captured both states at the source mockup's 958 x 843 per-page viewport and compared them with the selected mockup in one input.
3. Confirmed the final hierarchy, spacing, clipping, and action placement without additional visual corrections.

Final result: passed

---

# Feedback modal design QA

## Comparison target

- Source visual truth: `/var/folders/22/56b7j39x69jbd4453ydwk4n40000gn/T/TemporaryItems/NSIRD_screencaptureui_zdnMJk/Screenshot 2026-08-24 at 19.14.12.png`
- Normalized source: `/Users/jonas/.codex/visualizations/2026/08/24/01a034c5-251f-7483-aae8-dad4ccc1da22/feedback-pipeline/feedback-reference.png`
- Implementation: `http://127.0.0.1:4187/#feedback-preview`
- Implementation screenshot: `/Users/jonas/.codex/visualizations/2026/08/24/01a034c5-251f-7483-aae8-dad4ccc1da22/feedback-pipeline/feedback-implementation.png`
- Full-view comparison: `/Users/jonas/.codex/visualizations/2026/08/24/01a034c5-251f-7483-aae8-dad4ccc1da22/feedback-pipeline/feedback-qa-comparison.png`
- Focused modal comparison: `/Users/jonas/.codex/visualizations/2026/08/24/01a034c5-251f-7483-aae8-dad4ccc1da22/feedback-pipeline/feedback-qa-focus.png`
- State: feedback modal open, empty details, no category selected.

## Normalization

- Source pixels: 3594 × 2250.
- Normalized source pixels: 1600 × 1000.
- Implementation pixels: 1600 × 1000.
- CSS viewport: 1600 × 1000 for full-view capture and 1600 × 500 for the focused crop.
- Density: the source was downsampled to the implementation pixel dimensions; the browser capture used the in-app browser's default density.

## Fidelity review

- Fonts and typography: both use a neutral system UI family with closely matched title weight, form-label size, and compact control text. The implementation intentionally uses Qorpera's existing font tokens.
- Spacing and layout rhythm: modal width, centered placement, header spacing, chip row, textarea, and full-width submit action align with the reference. Radius and shadow remain consistent with Qorpera's existing modal grammar.
- Colors and visual tokens: white surface, soft gray overlay, neutral borders, blue focus ring, black active controls, and disabled gray submit state match the source while using existing Qorpera tokens.
- Image quality and asset fidelity: the modal contains no raster imagery, logos, or bespoke illustration assets. Existing native form and close controls remain sharp at the captured density.
- Copy and content: the final product direction removes diagnostic and privacy disclosure rows from the modal, leaving categories, required details, and the submit action. The submitted diagnostics remain restricted to app version, platform, architecture, and company type; conversation content, files, and browser history remain excluded by the implementation.

## Interaction and accessibility checks

- Category selection changes `aria-pressed` and is reversible.
- Required details enable the submit action only after non-whitespace input.
- Basic diagnostics are sent automatically without adding a decision to the feedback form.
- Focus moves into the textarea on open, remains trapped inside the modal, and returns to the invoking control on close.
- Escape and backdrop click close the modal; close is suppressed during submission.
- Submission exposes pending, success, and retry states through an `aria-live` status region.
- No feedback-specific console warnings or errors were present in the browser preview. The static preview's main renderer reports its expected missing Electron bridge because it is running outside Electron; that does not affect the isolated feedback flow.

## Comparison history

- Initial P2: the implementation modal was roughly 95 px taller than the normalized reference, the overlay was too dark, and the submit action did not span the form width.
- Fix: removed the extra subtitle and character count, reduced textarea and vertical spacing, matched the reference width, softened the overlay, and made Submit full-width.
- Post-fix evidence: `feedback-qa-comparison.png` and `feedback-qa-focus.png` show matched modal proportions, hierarchy, density, and control placement. No actionable P0, P1, or P2 differences remain.
- Product simplification after the captured comparison removed the diagnostic toggle and privacy paragraph. The modal is therefore intentionally shorter than the comparison evidence while preserving its established width, hierarchy, and control styling.

## Residual test gap

- The browser preview validates presentation and client-side interaction. The Electron IPC and hosted RPC wiring are covered by focused source-level tests; a live hosted submission was not made during visual QA because it would create production feedback data and requires the migration to be deployed.

final result: passed

---

# Pinned agents design QA

**Source visual truth**

- `/var/folders/22/56b7j39x69jbd4453ydwk4n40000gn/T/codex-clipboard-a0b3ba77-3093-4750-bbf3-0e4bf3280818.png`
- `/var/folders/22/56b7j39x69jbd4453ydwk4n40000gn/T/codex-clipboard-305fe514-7fae-4a4c-981e-ec86bf1d5c75.png`
- `/var/folders/22/56b7j39x69jbd4453ydwk4n40000gn/T/TemporaryItems/NSIRD_screencaptureui_69ZLHO/Screenshot 2026-08-26 at 20.32.30.png`

**Implementation evidence**

- Browser-rendered implementation: `/Users/jonas/.codex/visualizations/2026/08/26/01a03f58-a5b1-7b53-9c8c-e61dd4f13d03/pinned-agent-implementation.png`
- Combined source/implementation comparison: `/Users/jonas/.codex/visualizations/2026/08/26/01a03f58-a5b1-7b53-9c8c-e61dd4f13d03/pinned-agent-comparison.png`
- Single pinned-agent state: `/Users/jonas/.codex/visualizations/2026/08/26/01a03f58-a5b1-7b53-9c8c-e61dd4f13d03/pinned-agent-single.png`

**Viewport and state**

- Implementation viewport: 600 × 460 CSS px at browser density 1; screenshot: 600 × 460 px.
- Primary reference: 322 × 486 px at source capture density 1.
- Comparison normalized by preserving each source's 1:1 CSS-pixel scale and aligning the 287 px sidebar region rather than stretching either capture.
- State: three pinned agents above one ordinary conversation, with a selected pinned agent. A second capture verifies the single pinned-agent state.

**Full-view comparison evidence**

- The pinned area sits directly below search, uses three centered tracks at the reference spacing, and leaves the ordinary conversation list in its existing full-width row layout.
- A one-item grid centers its 72 px card within the 287 px rail; measured center offset is -0.5 px.
- Selection and hover use the existing rail surface color and 10 px radius, matching the references' quiet rounded highlight.
- Search filtering removes the pinned container when no pinned result remains. Compact rail rules return pinned cards to the existing vertical icon-only layout.

**Focused region comparison evidence**

- The sidebar itself is the focused region and is readable at 1:1 scale in the combined comparison. No additional crop was needed.

**Required fidelity surfaces**

- Fonts and typography: existing Segoe/system stack is preserved; pinned labels use 11 px/14 px, medium weight, one-line ellipsis as in the reference.
- Spacing and layout rhythm: 72 px cards, 56 px avatar slots, centered auto-fit tracks, 7 × 10 px grid gaps, and 15/12 px vertical padding reproduce the reference density.
- Colors and tokens: existing chrome, text, hover, selection, and agent colors are reused; no new palette was introduced.
- Image quality and asset fidelity: the implementation reuses the product's existing staff creature assets and face system at native scale; no replacement or generated placeholder asset is used.
- Copy and content: pinned cards show only the agent name; ordinary rows retain name, activity, and timestamp.

**Findings**

- No actionable P0, P1, or P2 visual differences in the pinned-agent feature.

**Open Questions**

- None. Differences in exact avatar artwork across the three references are covered by the app's existing selectable agent-character system and are outside this layout change.

**Primary interactions tested**

- Existing pin/unpin preference rerenders the roster into or out of the grid through the unchanged context-menu action.
- Multi-item and single-item grid states render correctly.
- Selected-card state and search-empty behavior are represented.
- Browser console warnings/errors checked: none.

**Comparison history**

- Initial comparison found no P0/P1/P2 issue, so no fix-and-recapture iteration was required.

**Implementation checklist**

- [x] Pinned agents render above rooms and ordinary agent rows.
- [x] Single and multiple pinned-agent layouts center correctly.
- [x] Active, hover, search, context menu, and compact rail behavior remain intact.
- [x] The ordinary conversation list remains unchanged.

**Follow-up polish**

- None required for this pass.

final result: passed

---

# Pinned agent drag-and-drop design QA

**Source visual truth**

- `/var/folders/22/56b7j39x69jbd4453ydwk4n40000gn/T/TemporaryItems/NSIRD_screencaptureui_jL5a1I/Screenshot 2026-08-26 at 20.46.35.png`

**Implementation evidence**

- Browser-rendered drag state: `/Users/jonas/.codex/visualizations/2026/08/26/01a03f58-a5b1-7b53-9c8c-e61dd4f13d03/pinned-agent-drag-implementation.png`
- Combined source/implementation comparison: `/Users/jonas/.codex/visualizations/2026/08/26/01a03f58-a5b1-7b53-9c8c-e61dd4f13d03/pinned-agent-drag-comparison.png`
- Interactive QA harness: `http://127.0.0.1:4173/visualizations/2026/08/26/01a03f58-a5b1-7b53-9c8c-e61dd4f13d03/pinned-agent-qa.html`

**Viewport and state**

- Source pixels: 299 × 370 at source capture density 1.
- Implementation pixels: 299 × 370 at browser density 1.
- CSS viewport: 299 × 370. The comparison uses a content-region capture with the persistent search header excluded to match the reference crop without rescaling.
- State: one pinned agent is being reordered in a four-item pinned grid; the floating preview overlaps the source slot and the ordinary agent list remains below.

**Full-view comparison evidence**

- The pinned region expands to a two-row, three-column grid and uses the same soft gray rounded container as the reference.
- The implementation measures 268 × 204 px at x=9, closely matching the reference's approximately 273 × 205 px pinned surface while preserving the product's existing 9 px rail inset.
- The floating preview is an 80 × 92 px elevated card at x=52 and remains readable above the dimmed source.
- The ordinary list resumes immediately below the pinned drop region with the existing 69 px row height and no overlap or clipping.

**Focused region comparison evidence**

- The full 299 × 370 sidebar is readable at 1:1 scale in the combined comparison, including avatar scale, source opacity, ghost elevation, card label, grid wrap, and list-row text. No additional focused crop was needed.

**Required fidelity surfaces**

- Fonts and typography: existing system UI type, 11 px pinned labels, 13 px list names, compact timestamps, truncation, and weights are preserved.
- Spacing and layout rhythm: the three-column grid, 204 px two-row drop surface, rail inset, row spacing, 10 px radius, and floating-card offset match the reference intent.
- Colors and visual tokens: the implementation reuses the existing chrome, border, shadow, text, selection, and per-agent color tokens. Dragging dims the source to 0.28 opacity.
- Image quality and asset fidelity: existing staff creature raster assets remain sharp and correctly masked; the drag preview clones the real agent card rather than substituting a placeholder or CSS drawing.
- Copy and content: pinned cards retain the agent name only; ordinary rows keep name, timestamp, and activity text.

**Findings**

- No actionable P0, P1, or P2 differences remain.
- P3: the reference crop places the pinned surface flush to the left edge, while the implementation keeps the product's established 9 px rail inset. This is intentional consistency with the existing sidebar rather than a drag-state defect.

**Primary interactions tested**

- Dragged an ordinary agent into the pinned region; the resulting order was persisted as `p1,p2,p3,l1,l2`.
- Dragged a pinned agent back into the ordinary list; the resulting order was persisted as `p1,p3,l1,p2,l2`.
- Pure ordering tests cover list reordering, insertion at a pinned-grid position, and unpinning into a specific list position.
- Click suppression after a completed drag and cleanup on rerender are implemented in the pointer interaction layer.
- No visible browser failure occurred. The selected browser surface does not expose a historical console-message reader for this static harness.

**Comparison history**

- Initial visual evidence showed the core drag treatment but represented list-to-pinned movement with a one-row grid, while the reference represented a two-row pinned reorder.
- The QA fixture was normalized to the same 299 × 370 content crop and four-item pinned state. The post-fix comparison confirms the rounded drop container, source dimming, floating preview, grid wrap, and list hierarchy with no P0/P1/P2 difference.

**Implementation checklist**

- [x] Reorder agents within the ordinary list.
- [x] Reorder agents within the pinned grid.
- [x] Drag an ordinary agent into the pinned region to pin it.
- [x] Drag a pinned agent into the list to unpin it.
- [x] Persist the unified agent order and existing pinned preference.
- [x] Preserve click behavior when no drag threshold is crossed.

final result: passed

---

# Design QA — Company Computer viewer frame (superseded intermediate pass)

This earlier pass established the 58 px header, the 78 px macOS traffic-light
gutter, resilient heading overflow, and a 12 px renderer inset. Those header
and spacing corrections remain in the final implementation.

Its proposed low-contrast stage border, 12 px radius, and frame shadow were
superseded by the later 16:10 borderless review above. The final stage has an
8:5 ratio, an 8 px clipping radius, `border: 0`, and `box-shadow: none`.
The temporary system screenshots and comparison captures used during this
intermediate review are intentionally not cited as durable repository files.
