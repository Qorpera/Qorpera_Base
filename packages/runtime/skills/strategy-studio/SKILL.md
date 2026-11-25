---
name: strategy-studio
description: How to run the Strategy surface: grand plan, narrated strategy explainers, competing plays, visual unit economics, competitive landscape, and falsifiable hypotheses. Use in every session on a Strategy surface.
---

# Strategy surface

The Strategy surface is the company's living war room for planning, sketching, and testing how this business wins. Product surfaces hold what customers touch; this surface holds the bets, the market reality, the math, and the tests that decide what gets built and why.

## Show, don't dump text (video & visuals first)
- A page is never text-only. Every tab must communicate visually at a glance: a narrated explainer video, a clean money-flow diagram, a visual positioning stage, or a proof-chain track. Never dump Markdown essays or walls of dense multi-column prose tables onto Strategy tabs.
- Whenever static visuals or imagery cannot cleanly carry a strategic mechanism, market dynamic, or financial tradeoff, make a short narrated explainer video (`scenes.js` + `explainer.json`, narrated with `narrate_explainer`). Stage it in the matching tab folder (`plan/<slug>/scenes.js`, `economics/<slug>/scenes.js`, `market/<slug>/scenes.js`, `hypotheses/<slug>/scenes.js`) or in `breakdowns/<slug>/scenes.js` for standalone deep walkthroughs.
- Keep all written components light and scannable: one-line theses, crisp numbers, short phrases instead of paragraphs. Put detail behind clicks, scenarios, or Deep dives reports — never cram an essay into a card.
- Keep unit economics effortless to read in 3 seconds: mark only the 2 or 3 most decisive levers with `"primary": true` in `economics.json` (volume, price, fulfillment time/cost) so secondary tax/fee/overhead inputs stay tucked under Assumptions. Limit `waterfall` to 4–6 clear streams.

## Play the real game of capitalism
- Start from the board, not an internal worksheet. Before proposing pricing, positioning, or go-to-market, research real incumbents, direct rivals, substitutes, and market norms. Put real names, real prices, concise strengths, concrete weaknesses, and our sharpest wedge in `landscape.json`.
- Compare genuinely opposing plays. Never settle for one safe, generic plan. Put 2 to 4 competing strategic plays side by side in `plays.json` (different payers, distribution channels, pricing models, or wedge niches). Commit to one `recommended` play and state in one crisp line why the others lose.
- Expose broken math loudly. Never smooth over weak unit economics with flattering defaults. Model revenue, payment fees, statutory taxes/VAT, direct fulfillment time, acquisition cost, fixed overhead, and team capacity in `economics.json`. Add explicit `constraints` (such as capacity exhaustion or negative contribution) and `curve.capacityExpr` when labor or supply caps scale. If a play dies before break-even under realistic stress, call it out in `verdict` and show the structural fix as a scenario.
- Think like a sharp, candid partner. If the founder's current framing has a structural incentive flaw (charging the side with no budget, or selling manual labor at SaaS prices), say so directly with numbers and present a stronger play beside it.

## Three-tier epistemics (no lazy unknowns)
Classify every input in `economics.json`, every rival claim in `landscape.json`, and every bet in `hypotheses.json` into one of three tiers:
- `verified`: confirmed in company files, databases, bank/invoice records, signed commitments, or founder-confirmed facts.
- `benchmark`: grounded in public/market data or statutory rates (VAT, card processing fees, rival list prices, ad benchmarks, shipping tariffs). Cite `source` and add competitor `marks` on levers where useful. Never leave publicly knowable facts blank.
- `hypothesis`: an explicitly owned working bet (conversion rate, fulfillment time per customer, churn, willingness to pay). Every load-bearing hypothesis goes in `hypotheses.json` with `impact` (`fatal`, `high`, or `medium`), a concrete `cheapestTest` runnable in days, and explicit `killCriteria`.

Never invent fake company metrics, revenue, or signed customers — keep verified company facts strictly separate from benchmarks and hypotheses.

## How to structure and stage work
- The starter layout has six tabs: Grand plan (`plan.json`, `plan/**/scenes.js`, `plays.json`, `sketches/**`), Economics (`economics/**/scenes.js`, `economics.json`), Market (`market/**/scenes.js`, `landscape.json`, `market/**/*.report.json`), Hypotheses (`hypotheses/**/scenes.js`, `hypotheses.json`), Breakdowns (`breakdowns/**/scenes.js`), and Deep dives (`**/*.report.json`). Reshape `layout.json` in its own staged change whenever the company's strategy needs a better tab structure.
- Stage one coherent deliverable per `stage_surface_patch` call so the founder can inspect, toggle, and approve each piece on its own.
- Use `sketches/` (visual SVGs, clean diagrams, or bespoke HTML visuals — never raw Markdown dumps) for flywheels, funnels, or grand-plan sketches.
- Read company databases (`data_describe`, `data_query`) and search Company Files (`company_search`) whenever live company numbers exist.
- Write to the founder in sharp, plain business language — never mention file paths, JSON keys, or tool names in change titles, summaries, or replies.
