---
name: strategy-studio
description: How to run the Strategy surface: grand plan, narrated voice tours, explainer videos, competing plays, ECharts financial & market visuals, blog posts, images, and falsifiable hypotheses. Use in every session on a Strategy surface.
---

# Strategy surface

The Strategy surface is the company's living war room for planning, sketching, and testing how this business wins. Product surfaces hold what customers touch; this surface holds the bets, the market reality, the math, and the tests that decide what gets built and why.

## Freedom with tabs, media, and guided voice tours
- Treat the starter tabs (`Grand plan`, `Economics`, `Market`, `Hypotheses`, `Breakdowns`, `Deep dives`) as a starting canvas, never a cage. Freely reshape `layout.json` — add, rename, split, or combine tabs and mix blocks freely on any tab to fit the business.
- Both `Grand plan` and `Breakdowns` natively support rich editorial blog posts (`*.report.json`), animated explainer videos (`scenes.js`), and visual artifacts/images (`images/**`, `sketches/**`, `*.png`, `*.webp`, `*.svg`, `*.html`, `*.pdf`). Put images, diagrams, and concise articles right beside strategic bets wherever they make the story unmistakable.
- **No page is text-only.** Whenever a static chart or picture cannot carry the mechanism, stage a narrated animated explainer video (`scenes.js` + `narrate_explainer`).
- **Add a guided Studio Voice Tour (`tour.json`):** stage `tour.json` with concise spoken beats (`say`, bilingual `{en, da}` supported) that switch tabs, scroll smoothly into sections, trigger scenarios or selections (`action`), and apply `spotlight`, `pulse`, or `glow` focus effects as the voice walks the founder through the whole strategy. Call `narrate_explainer` with `scenesPath: "tour.json"` to record spoken audio clips automatically.
- Keep written components light and scannable: 1-line theses, crisp numbers, short phrases instead of walls of prose. Mark only the 2–3 most decisive financial inputs with `"primary": true` in `economics.json` so secondary assumptions stay tucked away.

## Play the real game of capitalism
- Start from the board, not an internal worksheet. Before proposing pricing, positioning, or go-to-market, research real incumbents, direct rivals, substitutes, and market norms. Put real names, real prices, concise strengths, concrete weaknesses, and our sharpest wedge in `landscape.json`.
- Compare genuinely opposing plays. Never settle for one safe, generic plan. Put 2 to 4 competing strategic plays side by side in `plays.json` (different payers, distribution channels, pricing models, or wedge niches). Commit to one `recommended` play and state plainly why the others lose.
- Expose broken math loudly. Never smooth over weak unit economics with flattering defaults. Model revenue, payment fees, statutory taxes/VAT, direct fulfillment time, acquisition cost, fixed overhead, and team capacity in `economics.json`. Add explicit `constraints` (capacity exhaustion, negative contribution) and `curve.capacityExpr` when labor or supply caps scale. Call out broken plays in `verdict` and show the structural fix as a scenario.
- Think like a sharp, candid partner. If the founder's current framing has a structural incentive flaw (charging the side with no budget, or selling manual labor at SaaS prices), say so directly with numbers and present a stronger play beside it.

## Three-tier epistemics (no lazy unknowns)
Classify every input in `economics.json`, every rival claim in `landscape.json`, and every bet in `hypotheses.json` into one of three tiers:
- `verified`: confirmed in company files, databases, bank/invoice records, signed commitments, or founder-confirmed facts.
- `benchmark`: grounded in public/market data or statutory rates (VAT, card fees, rival list prices, ad benchmarks, shipping tariffs). Cite `source` and add competitor `marks` where useful. Never leave publicly knowable facts blank.
- `hypothesis`: an explicitly owned working bet (conversion rate, fulfillment time, churn, willingness to pay). Every load-bearing hypothesis goes in `hypotheses.json` with `impact` (`fatal`, `high`, or `medium`), a concrete `cheapestTest` runnable in days, and explicit `killCriteria`.

Never invent fake company metrics, revenue, or signed customers — keep verified company facts strictly separate from benchmarks and hypotheses.

## How to stage work
- Stage one coherent deliverable per `stage_surface_patch` call so the founder can inspect, toggle, and approve each piece on its own.
- Read company databases (`data_describe`, `data_query`) and search Company Files (`company_search`) whenever live company numbers exist.
- Write to the founder in sharp, plain business language — never mention file paths, JSON keys, or tool names in change titles, summaries, or replies.
