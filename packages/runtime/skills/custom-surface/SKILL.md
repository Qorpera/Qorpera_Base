---
name: custom-surface
description: How to shape and fill a custom Studio surface for planning, sketching, calculators, trackers, GTM rooms, or any bespoke workspace. Use in every session on a custom interface.
---

# Custom Studio surface

A custom Studio surface is a living workspace tailored to a goal that product or identity surfaces do not cover: a pricing lab, GTM room, launch tracker, sketching board, supplier matrix, or investor room. Shape the page freely first, then fill it piece by piece.

## Shape freely first
- Read the member's goal, company vision, brief, and relevant company files under `/company` (`company_read`, `company_list`, or read-only workspace search).
- Shape the layout file freely with the tabs and blocks this workspace needs (`explainer` videos, `report` articles and posts, `artifacts` images and diagrams, `module` custom tools, and strategy or data blocks on any tab). When structure is a genuine taste choice, offer two or three concrete options by asking once early, then build on the answer.
- Fill the layout one coherent deliverable per `stage_surface_patch` call so each piece lands and approves cleanly on its own.

## Show, narrate, don't dump text
- Never build a text-only page. Lead each tab with a visual model, diagram, imagery, interactive simulator, or narrated animated `explainer` video (recorded with `narrate_explainer`).
- For multi-section or multi-tab workspaces, add a guided Studio voice tour and record its spoken clips with `narrate_explainer` so a real voice walks the founder across sections and tabs with spotlight, pulse, and smooth scroll effects.
- Keep text light and scannable: one-line takeaways, concise labels, and progressive disclosure for detail rather than walls of paragraphs or dense spreadsheets.

## How to work
- Write reports, analyses, memos, and blog posts as structured report articles, standalone HTML pages, or PDFs — never plain Markdown notes; stage each piece in its own change.
- Use three-tier epistemics: distinguish verified company facts (files, databases, confirmed decisions), benchmark market facts (taxes, fees, rival prices with cited sources), and hypothesis working bets (with test and kill criteria). Never invent company traction, revenue, or signed customers; never draw stand-in clipart in place of real art or photos.
- For commercial or pricing rooms, pressure-test real incentives, rivals, margins, and capacity ceilings instead of passive worksheets.
- Write to the member about the workspace and decisions — never mention file paths, schemas, or tool names in change titles, summaries, or replies.

## Native blocks first, module when blocks cannot
- Prefer native blocks (they inherit company Identity tokens and light or dark themes automatically): `plays`, `economics`, `hypotheses`, `landscape`, `explainer`, `title`, `facts`, `spec_list`, `table`, `cards`, `report`, `stage_3d`, `palette`, `brand_mark`, `type_specimen`, `swatch_row`, and `artifacts`.
- Use a `module` block (an interactive app inside its own subfolder) only when no native block fits — for example a custom sketchpad, funnel tool, or drag-and-drop planner.
- Link the company Identity tokens stylesheet inside modules so they wear the company look; never hardcode brand colors or fonts. Modules have no network access, read files through the built-in read and list bridge, and hand founder inputs back through the built-in tell bridge. Auto-height modules must not lock to viewport height.
