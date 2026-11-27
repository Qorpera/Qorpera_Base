---
name: analytics-studio
description: How to build the company's Analytics interface, or a numbers tab on any interface: real numbers, how they move, what they mean. Use on every Analytics interface, and before adding or changing a numbers tab elsewhere.
---

# Analytics

This page shows how the company is doing, in its own numbers, and what to do about it. In ten seconds a founder should know whether things are better or worse than last time, and why.

On another interface, a numbers tab follows these rules for that page's subject (one product's sales, a plan's targets), in the page's colours.

## Where numbers come from
- Only from questions: the platform's own (orders, site, money; data_describe on qorpera lists them) or a named question in a company database. Read each with data_query before you draw it.
- Bind every chart and figure to its question with an ask source, asked live when the page opens; never copy rows into a file.
- A question that answers "Not connected" keeps its home: bind it anyway (it fills itself once connected), never draw or write it as zero, and say in your reply what to connect.
- A number no question answers stays an empty home; say what would fill it. Never invent a number, and never stand one in for another (visits are not buyers).
- When a company database holds something no question answers (bookings, sign-ups), save one named question for it there, its top line saying what it counts (saved at once; the page change goes through review).

## Name each number once
- Keep the numbers file the Numbers tab reads: one entry a number, named as the founders say it, what it counts, what it leaves out (refunds, VAT), its question and unit.
- Use the company's words ("rooms booked", not "conversions").

## What good looks like
- Every tab, not only Now, has one big chart and at most four figures. More detail goes to a new tab, a table or a report under Questions, never a second big chart on a tab, never a grid of tiles.
- Now's chart is the one number that says whether the company is moving, against the same days before.
- Every chart heading is the question it answers: "Are more people buying?", not "Orders over time".
- Compare like with like: the first 26 days of this month with the first 26 of last. Days for 90 days, weeks for a quarter, months for a year.
- A month chart starts at the first month with data; when its question takes a range, ask from there.
- Under about 30 in a period, write counts ("3 orders, up from 1"), never a percentage or a trend word.
- Bars start at zero. A gap is a gap, never a zero.
- An estimate: give its ask "estimate": true (drawn dashed) and call it an estimate in its caption.
- The line under the title is a reading with its date ("26 Nov: orders are up on October"), written only from numbers on the page.
- When a member asks why something moved, answer with one report under Questions: the numbers that show it, what you ruled out, and one decision.

## Colour
- Choose the page's colours once, in the layout's colors; every chart follows. Charts name jobs (main, compare, up, down, series), never colours.
- Start from the company preset (Identity's palette; quiet with no Identity yet). Choose one-colour for parts of one whole, calm when one series matters, bright when more than five must be told apart, or your own; say why.
- A product's colourway keeps its colour: bind it to its page.
- Say direction twice: the up or down colour and an arrow or sign. Down is never the brand's main colour.
- At most five series; group the rest as "Other".

## How to work
- Shape first: find which questions answer for this company, then compose_surface_layout. No shop, no Sales tab (a shop not connected yet keeps it); a service may lead with bookings.
- One piece per change: the layout, then Now, then one tab at a time.
- Counts and sums only. Never put a person's name, email, a single order or visit on the page.
- Check with inspect_surface in light, dark and at phone width.
- Write to the member about the business, never about files, questions or tools by name.
