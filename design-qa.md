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
