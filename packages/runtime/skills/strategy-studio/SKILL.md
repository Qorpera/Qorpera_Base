---
name: strategy-studio
description: How to run the Strategy surface: start from the company's vision, then the grand plan, competing plays, financial and market visuals, hypotheses, narrated tours, and research posts. Use in every Strategy session.
---

# Strategy surface

The Strategy surface is the company's war room for how this business wins: the bets, market reality, unit math, and tests deciding what gets built and why.

## Start from the vision
- Read the company's vision first, whole: the text its founders approved. Why the company exists, who it is for and what it refuses come from there in the founders' own words, never from your reading of the market.
- Where the vision is silent on something the plan rests on (money they will put in, what may give way, who they already know), ask the founder with `surface_ask`, as open questions, before you build on it. Only they know it, so it is a hard blocker, not a preference. Never draft their reason for them to confirm.

## Tabs, media, and voice tours
- The starter tabs are a start, never a cage: `compose_surface_layout` reshapes them and adds `chart`, `explainer`, `artifacts`, or `module` blocks anywhere.
- Lead visually: `chart` blocks, `stage_surface_artifact` for visuals rendered on the machine, and narrated `explainer` videos (`narrate_explainer`). Call `inspect_surface` to audit the page before finishing.
- Add a voice tour whose spoken beats switch tabs, scroll, trigger scenarios and spotlight sections; record its clips with `narrate_explainer`.
- Keep the tabs to few words and two or three primary levers in `economics`.

## Posts are research
- A question that needs evidence becomes a research post: `read_skill` research-posts and follow it, from the plan the founder approves to the second reader's check. One question per post.
- Posts live only in the Research tab's `library`. Name its themes before their posts exist: an open one shows empty.
- Never write a post from memory, or one that restates numbers already on a tab. A number no post or company file backs is a question to research, and says so until it is.

## Play the real game of capitalism
- Start from the market, not an internal worksheet. Research real incumbents, rivals, substitutes, and pricing before recommending a move; record names, prices, strengths, weaknesses, and our sharpest wedge in `landscape`.
- Compare two to four opposing plays in `plays` (different payers, channels, pricing models, or wedges). Commit to one and state plainly why the others lose.
- Expose broken math loudly. Model revenue, payment fees, taxes and VAT, fulfillment time, acquisition cost, overhead, and capacity in `economics`, with capacity constraints and a break-even curve. Call out broken plays in the verdict and show the fix as a scenario.
- Be candid: if the framing has an incentive flaw (charging the side without budget, selling labor at software prices), say so with numbers and show a stronger play beside it.

## Three tiers
Classify every input, rival claim, and bet:
- Verified: confirmed in company files, databases, invoices, signed commitments, or by the founder. Figures from an Analytics interface count once read with `data_query`.
- Benchmark: public market data or statutory rates, always with its source and competitor reference marks where useful. Never leave publicly knowable facts blank.
- Hypothesis: an owned bet (conversion, churn, willingness to pay). Put each load-bearing one in `hypotheses` with its impact, a cheapest test runnable in days, and kill criteria.

Never invent traction, revenue, or signed customers.

## How to stage work
- Stage one deliverable per `stage_surface_patch` call so the founder approves each piece on its own.
- Never ask about taste or framing: stage a concrete view and let the founder steer from the live canvas.
- Read live company files and other Interfaces with `company_search`, `company_read`, `company_list`, `data_describe`, and `data_query`.
- Write in plain, sharp business language. Never mention file paths, schemas, or tool names in titles, summaries, or replies.
