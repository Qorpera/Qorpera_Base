---
name: product-studio
description: How to build a product's page in its Studio interface, and what a good one looks like. Use in every session on a Product interface.
---

# Product Studio

This page sells and specifies one product. A buyer knows what it is from the first line; an engineer finds every number without reading prose. The layout names the homes and files they read. Fill those; this says how, and what good looks like.

## How to work
- Fill the homes one piece per change: the line, then figures, then colourways, and so on. The member watches the page come together piece by piece; never stage the whole page at once.
- An unknown stays an empty home. Never invent a price, weight, supplier or certification: an empty home is honest, a made-up value is not. Say in your reply what is still missing and who could know it.
- Settle what you can yourself: read the brief, company files and earlier reports first. Never stop to ask taste or colour questions — stage a concrete direction (or toggleable Preview variants) with stage_surface_patch so the member steers live. Reserve surface_ask strictly for real hard blockers (it escalates to the Co-Founder).
- Reshape tabs or add `chart` blocks with `compose_surface_layout`, stage machine-rendered visuals or 3D models with `stage_surface_artifact`, and call `inspect_surface` to audit the rendered page before finishing.
- There is no Files tab: add an `artifacts` block to any tab for vector diagrams, pictures, briefs, PDFs or pages.
- Prefer native blocks over a `module`; build a `module` only for what no native block can show, such as a calculator.
- Never draw a stand-in for a real product, model or photo. If it cannot be made in this session, leave its home empty and say so.
- Write to the member about the product, never file paths, file names or tool names.

## What good looks like
- The line comes first: one plain sentence, in a buyer's words, saying what it is and for whom. "A soft EEG headband that tracks sleep stages at home", not "Reinventing rest".
- The figures are the four a buyer asks about first, each short enough to read as a figure: "14 h", "44 g", "Merino wool", "1.995 kr.". Most important first; anything longer belongs in specs.
- Colourways have names a shop would print, each with a colour true to the material: "Sandstone", "Night", not "Beige 1".
- The model comes from the object file. A real model is made outside this session. Until one can be staged, the simple stand-in config (kind, real dimensions and layers) may show how it is built. When the member asked for a real 3D model, the stand-in is not it: say the model is still to be made.
- Specs are values with units, grouped as an engineer looks for them (size, weight, power, materials, sensors, compliance), never sentences.
- Parts are a table: one row a part, with what it is, what it is made of, who makes it and what it costs.
- Vendors are comparable rows: the same fields for every vendor (component, unit price, minimum order, lead time, region, certifications, status) so they can be judged side by side. An unconfirmed vendor says so in its status.
- Analyses, reports and posts are structured reports, standalone HTML pages or PDFs, never plain Markdown notes: each with numbers in a chart or table, ending in a decision or tradeoff, staged in its own change with stage_surface_patch so the member can review and approve each piece on its own. Any tab can hold them: add or widen a report block there to match.

## A product that is not hardware
Software, a service or a subscription has nothing to put on a stage. Drop the stage and colourways and give the page the tabs it needs, such as plans and prices, features or integrations. Adapt the layout; never fill homes that make no sense for the product.
