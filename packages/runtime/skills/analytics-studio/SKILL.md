---
name: analytics-studio
description: How to build the company's Analytics interface, or a numbers tab on any interface: real numbers, how they move, what they mean. Use in every session on an Analytics interface, and before adding or changing a numbers tab elsewhere.
---

# Analytics

This page shows how the company is doing, in its own numbers, and what to do about it. A founder looks for ten seconds and should leave knowing whether things are better or worse than last time, and why.

On another interface, a numbers tab follows the same rules for that page's subject (one product's sales, a plan's targets): one tab in its layout, in its colours.

## Where numbers come from
- Only from questions: the platform's own (orders, site, money; data_describe on qorpera lists them) or a named question in a company database. Read each with data_query and look at the answer before you draw it.
- Bind every chart and figure to its question with an ask source, so it is asked live when the page opens. Never copy rows into a file.
- A number with no question behind it stays an empty home. Never invent, estimate or fill in a demo number, and never stand one number in for another (visits are not buyers). Say what would fill it.
- When a company database holds something no question answers yet (bookings, sign-ups), save one named question for it in that database, with a top line saying what it counts. It is saved at once; the page change that uses it goes through review.

## Name each number once
- Keep the numbers file the layout's Numbers tab reads: one entry a number, with its name as the founders say it, what it counts, what it leaves out (refunds, VAT, test payments), its question and unit. Two places showing "money in" mean the same thing.
- Use the company's words ("rooms booked", not "conversions").

## What good looks like
- One big shape a tab. Now opens with the one number that says whether the company is moving, over time against the same days before, with at most four figures above it. Never a grid of tiles.
- Every chart heading is the question it answers: "Are more people buying?", not "Orders over time". No question, no chart.
- Compare like with like: the first 26 days of this month with the first 26 of last. Days for 90 days, weeks for a quarter, months for a year.
- Under about 30 in a period, write counts ("3 orders, up from 1"), never a percentage or a trend word.
- Bars start at zero. An estimate is dashed and called one. A gap is a gap, never a zero.
- The line under the title is a reading with its date ("26 Nov: orders are up on October, mostly Sandstone"), written only from numbers on the page.
- When a member asks why something moved, answer with a report under Questions: the numbers that show it, what you ruled out, and one decision. One report a question.

## Colour
- Choose the page's colours once, in the layout's colors, and every chart follows. Charts name jobs (main, compare, up, down, series), never colours.
- Start from the company preset, which links the jobs to Identity's palette. Choose one-colour for parts of one whole, calm when one series matters, bright when more than five things must be told apart, or your own; say why.
- With no Identity yet, keep the quiet company preset; link to Identity once it has a palette.
- Things with a colour of their own keep it: bind a product's colourway to its own page.
- Say direction twice: the up or down colour and an arrow or sign. Down is never the brand's main colour.
- At most five series; group the rest as "Other".

## How to work
- Shape first: find which questions answer for this company, then compose the layout with compose_surface_layout. No shop, no Sales tab; a service may lead with bookings. Never keep a home nothing will fill.
- One piece per change: the layout, then Now, then one tab at a time.
- Counts and sums only. Never put a person's name, email, a single order or a single visit on the page.
- Check with inspect_surface in light and dark and at phone width before finishing.
- Write to the member about the business, never about files, questions or tools by name.
