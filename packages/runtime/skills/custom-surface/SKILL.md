---
name: custom-surface
description: How to shape and fill a custom Studio surface for planning, sketching, calculators, trackers, GTM rooms, or any bespoke workspace no template covers. Use in every session on a custom interface.
---

# Custom Studio surface

A custom Studio surface is a living workspace tailored to a specific goal that product or identity surfaces do not cover — such as a pricing lab, GTM war room, launch tracker, sketching board, supplier matrix, or investor room. Its starter layout is nearly empty on purpose: shape the page first, then fill it.

## Shape first
- Read the member's goal, the company vision, the brief, and relevant company files (use `company_search` and read-only `data_describe` / `data_query` when live records exist).
- Stage a `layout.json` whose tabs and blocks create the exact homes this workspace needs, each with a clear heading. Where structure is a genuine taste choice, offer 2 or 3 concrete layout directions via `surface_ask` and build the one the member picks.
- Then fill the homes piece by piece.

## Show, don't dump text (visuals & video first)
- Never build a text-only page. Lead every tab with a clear visual model, diagram, interactive simulator, imagery, or a short narrated explainer video (`scenes.js` + `narrate_explainer`).
- Whenever a static chart or picture cannot cleanly carry the story or mechanism, stage a narrated `explainer` video instead of writing long prose.
- Keep supporting text light and scannable: one-line takeaways, concise labels, progressive disclosure for secondary detail — never walls of paragraphs or dense multi-column spreadsheets.

## How to work
- Stage one cohesive deliverable per `stage_surface_patch` call so the member sees and approves each piece independently. Never dump the whole workspace in one giant patch.
- Write reports, analyses, memos, and essays as structured `*.report.json` articles (or self-contained `.html` pages when custom visual presentation is asked for), never loose raw Markdown notes; stage each piece in its own change.
- Use three-tier epistemics instead of leaving everything blank: distinguish `verified` company facts (files, databases, confirmed decisions), `benchmark` public/market facts (statutory taxes, payment fees, competitor list prices — always with `source`), and `hypothesis` working bets (clearly labeled with what test confirms or kills them). Never invent company traction, revenue, or signed customers; never leave publicly researchable benchmarks blank.
- For strategic, commercial, or pricing workspaces, pressure-test the real market incentives, rival alternatives, margins, and capacity ceilings instead of building a passive worksheet.
- Settle what you can by reading and researching. Use `surface_ask` only for genuine founder calls or taste choices, with concrete options.
- Write to the member about the workspace and decisions, never about file paths, schemas, or tool names in change titles, summaries, or replies.

## Native blocks first, module when blocks cannot
- Prefer native blocks — they inherit the company's Identity tokens and light/dark themes automatically:
  - Strategy & decision blocks: `plays` (scannable competing bets), `economics` (visual money-flow + 2–3 core levers + scenarios & break-even ceiling), `hypotheses` (visual proof-chain track + expandable kill criteria), and `landscape` (visual positioning map + focused rival cards).
  - General blocks: `explainer` (narrated 3Blue1Brown-style animated video), `title`, `facts`, `spec_list`, `table`, `cards`, `report`, `stage_3d`, `palette`, `brand_mark`, `type_specimen`, `swatch_row`, and `artifacts` (for visual SVGs, HTML boards, PDFs, or images).
- Use a `module` block (an interactive HTML/JS app inside its own subfolder) only when no native block fits — for example, a bespoke interactive sketchpad, funnel simulator, drag-and-drop planner, or custom visual calculator.
- Link `/identity/tokens.css` inside modules so they wear the company look; never hardcode brand colors or fonts. Modules have no network access, can read company/surface files via `qorpera.read(path)` and `qorpera.list(prefix)`, and can hand founder inputs or decisions back into a Surface session via `qorpera.tell(text, about)`.
- A module with `height: "auto"` sizes itself to its content and must not lock itself to `100vh`.
