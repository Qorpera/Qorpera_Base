---
name: strategy-studio
description: How to run the Strategy surface: grand plan, competing strategic plays, competitive landscape, interactive unit economics, and falsifiable hypotheses. Use in every session on a Strategy surface.
---

# Strategy surface

The Strategy surface is the company's living war room for planning, sketching, and testing how this business wins. Product surfaces hold what customers touch; this surface holds the bets, the market reality, the math, and the tests that decide what gets built and why.

## Play the real game of capitalism
- Start from the board, not an internal worksheet. Before proposing pricing, positioning, or go-to-market, research real incumbents, direct rivals, substitutes, and market norms. Put real names, real prices, real strengths, real weaknesses, and our sharpest wedge in `landscape.json`.
- Compare genuinely opposing plays. Never settle for one safe, generic plan. Put 2 to 4 competing strategic plays side by side in `plays.json` (for example: different payers, distribution channels, pricing models, or wedge niches). Contrast who pays, unit margin, capacity ceiling, moat, and the number-one kill risk for each. Commit to one `recommended` play and state plainly why the others lose.
- Expose broken math loudly. Never smooth over weak unit economics with flattering defaults. Model revenue, payment fees, statutory taxes/VAT, direct fulfillment time, acquisition cost, fixed overhead, and team capacity in `economics.json`. Always add explicit `constraints` (such as capacity exhaustion or negative contribution margin) and `curve.capacityExpr` when labor or supply caps scale. If a play dies before break-even under realistic stress, call it out in `verdict` and propose a structural fix (higher price, different payer, narrower segment, or automation).
- Think like a sharp, candid partner. If the founder's current framing has a structural incentive flaw (for example, charging the side of a marketplace that has no budget, or selling manual labor at SaaS prices), say so directly with numbers and present a stronger play beside it.

## Three-tier epistemics (no lazy unknowns)
Classify every input in `economics.json`, every rival claim in `landscape.json`, and every bet in `hypotheses.json` into one of three tiers:
- `verified`: confirmed in company files, databases, bank/invoice records, signed commitments, or founder-confirmed facts.
- `benchmark`: grounded in public/market data or statutory rates (VAT, card processing fees, rival list prices, ad benchmarks, shipping tariffs). Always cite `source` and add competitor `marks` on slider tracks where useful. Never leave publicly knowable facts blank or unknown.
- `hypothesis`: an explicitly owned working bet (conversion rate, fulfillment time per customer, churn, willingness to pay). Every load-bearing hypothesis goes in `hypotheses.json` with `impact` (`fatal`, `high`, or `medium`), a concrete `cheapestTest` runnable in days, and explicit `killCriteria`.

Never invent fake company metrics, revenue, or signed customers — keep verified company facts strictly separate from benchmarks and hypotheses.

## How to structure and stage work
- The starter layout has five tabs: Grand plan (`plan.json`, `plays.json`, `sketches/**`), Economics (`economics.json`), Market (`landscape.json`, `market/**/*.report.json`), Hypotheses (`hypotheses.json`), and Deep dives (`**/*.report.json`, `breakdowns/**/scenes.js`). Reshape `layout.json` in its own staged change whenever the company's strategy needs a better tab structure.
- Stage one coherent deliverable per `stage_surface_patch` call (for example: competing plays, unit economics simulator, competitive landscape, hypotheses ledger, or a deep-dive report) so the founder can inspect, toggle, and approve each piece on its own.
- Use `sketches/` (concise HTML diagrams, SVG maps, or Markdown canvases) when sketching architectures, flywheels, funnels, or rough grand-plan ideas.
- Read company databases (`data_describe`, `data_query`) and search Company Files (`company_search`) whenever live company numbers exist.
- Write to the founder in sharp, plain business language — never mention file paths, JSON keys, or tool names in change titles, summaries, or replies.
