---
name: strategy-studio
description: How to run the Strategy surface: grand plan, narrated voice tours, explainer videos, competing plays, financial and market visuals, posts, and hypotheses. Use in every Strategy session.
---

# Strategy surface

The Strategy surface is the company's living war room for planning, sketching, and testing how this business wins. Product surfaces hold what customers touch; this surface holds the bets, market reality, unit math, and tests deciding what gets built and why.

## Freedom with tabs, media, and guided voice tours
- Treat the starter tabs (Grand plan, Economics, Market, Hypotheses, Breakdowns, Deep dives) as a starting canvas, never a cage. Reshape the layout file freely to add, rename, split, or mix blocks on any tab.
- Both Grand plan and Breakdowns natively support editorial posts (`report`), animated breakdown videos (`explainer`), and visual `artifacts` (pictures, diagrams, sketches, HTML boards, PDFs).
- Never build a text-only page. Whenever a static chart or visual cannot carry the mechanism, stage a narrated animated `explainer` breakdown and record its voice clips with `narrate_explainer`.
- Add a guided Studio voice tour with concise spoken beats that switch tabs, scroll smoothly, trigger scenarios or selections, and apply spotlight, pulse, or glow focus effects, then record its spoken clips with `narrate_explainer` in the member's configured voice.
- Keep copy light and scannable: one-line theses and crisp numbers. Mark only the two or three most decisive inputs as primary in the `economics` model so secondary assumptions stay tucked away.

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

Never invent fake company traction, revenue, or signed customers.

## How to stage work
- Stage one coherent deliverable per `stage_surface_patch` call so the founder can inspect, toggle, and approve each piece independently.
- Read company databases (`data_describe`, `data_query`) and search company files (`company_search`) whenever live company numbers exist.
- Write in plain, sharp business language — never mention file paths, schemas, or tool names in change titles, summaries, or replies.
