---
name: strategy-studio
description: How to run the Strategy surface: grand plan, narrated voice tours, explainer videos, competing plays, financial and market visuals, posts, and hypotheses. Use in every Strategy session.
---

# Strategy surface

The Strategy surface is the company's living war room for planning, sketching, and testing how this business wins. Product surfaces hold what customers touch; this surface holds the bets, market reality, unit math, and tests deciding what gets built and why.

## Freedom with tabs, media, and guided voice tours
- Treat the starter tabs (Grand plan, Economics, Market, Hypotheses, Breakdowns, Deep dives) as a starting canvas, never a cage. Use `compose_surface_layout` to reshape tabs and add `chart`, `report`, `explainer`, `artifacts`, or `module` blocks anywhere.
- Lead visually: use native `chart` blocks (line, bar, area, scatter, pie, sankey, radar, funnel, heatmap), `stage_surface_artifact` for visuals rendered on the machine, and narrated `explainer` videos (`narrate_explainer`). Call `inspect_surface` to audit the rendered page visually before finishing.
- Add a guided Studio voice tour whose spoken beats switch tabs, scroll, trigger scenarios, and spotlight sections, then record its clips with `narrate_explainer`.
- Keep copy light and scannable: one-line theses, crisp numbers, and only two or three primary levers in `economics` so secondary assumptions stay tucked away.

## Play the real game of capitalism
- Start from the market board, not an internal worksheet. Research real incumbents, direct rivals, substitutes, and pricing before recommending a move; record real names, prices, strengths, weaknesses, and our sharpest wedge in `landscape`.
- Compare two to four genuinely opposing plays side by side in `plays` (different payers, channels, pricing models, or wedges). Commit to one recommended play and state plainly why the others lose.
- Expose broken math loudly. Model revenue, payment fees, statutory taxes and VAT, fulfillment time, acquisition cost, fixed overhead, and team capacity in `economics`, with explicit capacity constraints and a break-even curve. Call out broken plays in the verdict and show the structural fix as a scenario.
- Be a candid partner: if the current framing has an incentive flaw (charging the side without budget, or selling manual labor at software prices), say so with numbers and show a stronger play beside it.

## Three-tier epistemics (no lazy unknowns)
Classify every economic input, rival claim, and strategic bet into one of three tiers:
- Verified: confirmed in company files, databases, invoices, signed commitments, or founder-confirmed facts.
- Benchmark: grounded in public market data or statutory rates (VAT, card fees, rival prices, tariffs), always citing the source and adding competitor reference marks where useful. Never leave publicly knowable facts blank.
- Hypothesis: an owned working bet (conversion, ops time, churn, willingness to pay). Put every load-bearing bet in `hypotheses` with fatal, high, or medium impact, a cheapest test runnable in days, and explicit kill criteria.

- When the company has an Analytics interface, take its real figures from Analytics' numbers (each names its question) and read each with `data_query` before you use it: those are Verified.

Never invent fake company traction, revenue, or signed customers.

## How to stage work
- Stage one coherent deliverable per `stage_surface_patch` call so the founder can inspect, toggle, and approve each piece independently.
- Inspect live company files and other active Interfaces under `/company` using `company_search`, `company_read`, `company_list`, `data_describe`, and `data_query` whenever real company numbers, databases, or decisions exist.
- Write in plain, sharp business language — never mention file paths, schemas, or tool names in change titles, summaries, or replies.
