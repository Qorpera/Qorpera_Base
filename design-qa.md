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

# Messages-inspired shell design QA

## Comparison inputs

- Messages target: `/var/folders/22/56b7j39x69jbd4453ydwk4n40000gn/T/TemporaryItems/NSIRD_screencaptureui_LqccQa/Screenshot 2026-08-26 at 17.39.25.png`
- Messages row-alignment target: `/var/folders/22/56b7j39x69jbd4453ydwk4n40000gn/T/TemporaryItems/NSIRD_screencaptureui_MklIur/Screenshot 2026-08-26 at 18.11.09.png`
- Messages label target: `/var/folders/22/56b7j39x69jbd4453ydwk4n40000gn/T/TemporaryItems/NSIRD_screencaptureui_zrWv7p/Screenshot 2026-08-26 at 18.53.16.png`
- Existing Qorpera state: `/var/folders/22/56b7j39x69jbd4453ydwk4n40000gn/T/TemporaryItems/NSIRD_screencaptureui_5wooqk/Screenshot 2026-08-26 at 17.39.41.png`
- Browser-rendered implementation: `/Users/jonas/.codex/visualizations/2026/08/26/01a03ebc-9da3-7213-98f8-53c561be0367/qorpera-shell-font-metrics-final.jpg`
- Original-versus-revised comparison: `/Users/jonas/.codex/visualizations/2026/08/26/01a03ebc-9da3-7213-98f8-53c561be0367/qorpera-shell-original-vs-revised.png`
- Focused Messages-versus-Qorpera rail comparison: `/Users/jonas/.codex/visualizations/2026/08/26/01a03ebc-9da3-7213-98f8-53c561be0367/messages-vs-qorpera-rail-final.png`
- Focused row-alignment comparison: `/Users/jonas/.codex/visualizations/2026/08/26/01a03ebc-9da3-7213-98f8-53c561be0367/messages-vs-qorpera-row-alignment-final.png`
- Focused typography/icon comparison: `/Users/jonas/.codex/visualizations/2026/08/26/01a03ebc-9da3-7213-98f8-53c561be0367/messages-vs-qorpera-type-icons-final.png`
- Focused label-metrics comparison: `/Users/jonas/.codex/visualizations/2026/08/26/01a03ebc-9da3-7213-98f8-53c561be0367/messages-font-metrics-final.png`

## Viewport and normalization

- Browser viewport: 1363 × 862 CSS px at device scale factor 1.
- Existing Qorpera source and implementation: 1363 × 862 px with no density normalization.
- Messages sidebar source crop: 325 × 775 px. Implementation sidebar crop: 304 × 775 px. Both are shown at native scale in the focused comparison so the rail-width difference remains explicit.
- State: light appearance, expanded navigation rail, active `New Agent` conversation, idle composer, translucent sidebar enabled.

## Findings

No actionable P0, P1, or P2 differences remain for the requested styling scope.

- Fonts and typography: macOS rail controls now resolve through `-apple-system`/`BlinkMacSystemFont` before cross-platform fallbacks, with native text rendering instead of forced geometric precision. Names use 13 px/600, Search is 13 px/400, and subtitles remain 10.5 px/400. Direct analysis of the shared `New` run gives the same 26 × 10 px bright-glyph footprint in the Messages source and corrected system-font candidate; the previous 13.5 px name rule was measurably too wide.
- Spacing and layout rhythm: Search begins at x=14, y=54 with a 28 px height and 7 px radius, directly below the 48 px titlebar. The selected row now uses 10/11 px rail margins, a 64 px height, and a 6 px radius. Its avatar remains 44 px, centered on the reference avatar's centerline; its name starts at x=74 and y=9 within the row, matching the reference.
- Colors and visual tokens: the selected row and scoped focus/switch states use macOS system blue. On macOS the rail and agent panel are transparent CSS surfaces over Electron's native `sidebar` vibrancy; the earlier warm CSS wash was removed. Turning translucency off disables native vibrancy and restores the neutral `#f3f3f1` rail surface.
- Image quality and asset fidelity: the existing staff-character PNGs, filters, sizes, and motion wiring are unchanged. Only their rail backing is transparent so the original figures do not acquire pale square tiles on the blue or translucent surfaces.
- Copy and content: existing product copy remains unchanged. The new General setting is labeled `Translucent sidebar` and explains its effect.
- Icons: the existing Search vector remains the same product icon but now renders with rounded joins/caps, a 2.2-unit stroke, and pixel-aligned 14 px geometry. The existing `+` control remains text-based and functional but uses the native macOS font at 20 px/400 with an integer line-height and a one-pixel optical lift.

## Full-view comparison evidence

The existing Qorpera state and revised render keep the same rail width, avatar scale, and main-content boundary. The staff rows adopt the reference's tighter 64 px density. The remaining visual changes are isolated to shell chrome: Search moves below the titlebar, selection becomes blue, and the rail surface becomes native material on macOS.

## Focused comparison evidence

The Messages target and revised rail align the titlebar/search sequence within 3 px vertically: Messages Search begins at y=57 and Qorpera at y=54. Both use 14 px Search insets. In the focused row comparison, both selected rows start at x=10, measure 64 px high, and place the name at x=74 and 9–10 px below the row top. The final computed name style is the native macOS system stack at 13 px/600 with a 15.34 px line height, and the label remains exactly 9 px below the selected-row top. Qorpera intentionally preserves its narrower 304 px rail and its existing 44 px character identities. The production window supplies native macOS traffic lights and AppKit material; the browser harness cannot render either.

## Comparison history

1. Initial implementation: `/Users/jonas/.codex/visualizations/2026/08/26/01a03ebc-9da3-7213-98f8-53c561be0367/qorpera-shell-initial.png`
   - [P1] The macOS rail surface was fully transparent in the browser-rendered fallback, allowing the yellow desktop backing color to dominate.
   - Fix: restored an 86% warm-gray material tint over the native/sidebar blur and increased the matching titlebar tint.
2. Post-fix implementation: `/Users/jonas/.codex/visualizations/2026/08/26/01a03ebc-9da3-7213-98f8-53c561be0367/qorpera-shell-final.png`
   - [P1] The warm overlay was visibly unlike the neutral native Messages material.
   - [P1] Existing character images appeared to sit on pale square avatar tiles against the new blue/gray surfaces.
   - [P2] Search used a near-white 30 px field with 10 px side insets instead of the compact macOS search treatment.
   - Fixes: removed the warm CSS tint and delegated material/color to Electron's native `sidebar` vibrancy; made only the rail avatar backing transparent while preserving assets and filters; changed Search to a 28 px macOS-style fill with 14 px side insets; limited system blue to scoped selection/focus/switch states instead of changing global shell tokens.
3. Revised implementation: `/Users/jonas/.codex/visualizations/2026/08/26/01a03ebc-9da3-7213-98f8-53c561be0367/qorpera-shell-revised-final.png`
   - [P2] The selected highlight remained 69 px high with only 8 px rail margins, and the agent name began at x=68 and roughly 18 px below the row top instead of the reference's x=74 and 9–10 px vertical offset.
   - Fix: changed normal rail rows to 64 px high with 10 px outer rail insets, a 6 px radius, and a 44 px avatar track positioned so the existing avatar center remains unchanged; moved the copy to x=74 and top-aligned it 9 px below the row edge.
4. Row-alignment implementation: `/Users/jonas/.codex/visualizations/2026/08/26/01a03ebc-9da3-7213-98f8-53c561be0367/qorpera-shell-row-alignment-final-v2.png`
   - [P2] Rail copy and the text-based `+` still inherited a softer cross-platform font fallback on macOS; the scaled Search vector produced a near-one-pixel fractional stroke.
   - Fix: put the macOS system font first for rail text and controls, restored native text rendering, made Search 13 px/400, strengthened and rounded the Search vector stroke, and rendered `+` at 20 px/400 on an integer line-height.
5. Typography/icon implementation: `/Users/jonas/.codex/visualizations/2026/08/26/01a03ebc-9da3-7213-98f8-53c561be0367/qorpera-shell-type-icons-final.png`
   - [P2] The active name still rendered at 13.5 px/600. In the exact label crop this made Qorpera's text appear wider and heavier than Messages even though the family and baseline were correct.
   - Fix: reduced macOS staff names to 13 px/600 while preserving the native system stack, native text rendering, and the matched 9 px row-relative baseline.
6. Font-metrics implementation: `/Users/jonas/.codex/visualizations/2026/08/26/01a03ebc-9da3-7213-98f8-53c561be0367/qorpera-shell-font-metrics-final.jpg`
   - The focused label comparison measures the Messages reference's shared `New` bright-glyph run at 26 × 10 px and the corrected 13 px/600 candidate at the same 26 × 10 px footprint. The implementation's computed style confirms 13 px/600 and unchanged row alignment. No P0/P1/P2 findings remain.

## Primary interactions and diagnostics

- Search focus and text entry were exercised in the in-app browser; the focused field uses the scoped system-blue ring and accepts/clears text.
- The focused shell regression verifies Search remains wired below the titlebar and the translucency preference remains a persistent accessible switch that calls the native material IPC.
- Browser console: no warnings or errors.
- Native material configuration uses Electron `sidebar` vibrancy with `active` visual effect state; the off state calls `setVibrancy(null)`.

## Follow-up polish

- P3: validate the exact native material response against light and dark real-world wallpapers after the next normal application build; browser rendering cannot reproduce AppKit vibrancy or native traffic lights.

final result: passed
