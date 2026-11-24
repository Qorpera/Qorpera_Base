---
name: product-studio
description: How to build a product's page in its Studio interface, and what a good one looks like. Use in every session on a Product interface.
---

# Product Studio

This page sells and specifies one product. A buyer knows what it is from the first line; an engineer finds every number without reading prose. The layout you are shown names the homes and the files they read. Fill those; this says how, and what good looks like.

## How to work
- Fill the homes the layout names, one piece per change: the line, then the figures, then the colourways, and so on. The member watches the page come together piece by piece; never stage the whole page at once.
- An unknown stays an empty home. Never invent a price, a weight, a supplier or a certification: an empty home is honest, a made-up value is not. Say in your reply what is still missing and who could know it.
- Settle what you can yourself: read the brief, the company's files and earlier reports first. Ask the member only questions of taste, with surface_ask and two to four concrete options ("Sandstone, Night, Moss" or "Bone, Graphite"), never "which colours do you like?". Ask once, early, and then build on the answer; never stop the work for a question you could settle yourself, and never ask the same thing twice.
- Keep the page's homes. When the work needs another shape, change the layout file in its own change and say in plain words what moved and why.
- There is no Files tab: when a tab needs supporting artifacts (vector diagrams, pictures, notes, briefs, PDFs or pages), add an artifacts block to that tab in the layout file.
- Prefer a native block to a module. Build a module only for what no block can show, such as a price calculator.
- Never draw a stand-in for something that must be made: no drawn picture, SVG or HTML page in place of the product, its model or a photo. If it cannot be made in this session, leave its home empty and say so.
- Write to the member about the product, not about files or steps: no paths, file names or tool names in a change's title, its summary or your reply.

## What good looks like
- The line comes first: one plain sentence, in a buyer's words, saying what it is and for whom. "A soft EEG headband that tracks sleep stages at home", not "Reinventing rest".
- The figures are the four a buyer asks about first, each short enough to read as a figure: "14 h", "44 g", "Merino wool", "1.995 kr.". Most important first; anything longer belongs in the specs.
- Colourways have names a shop would print, each with a colour true to the material: "Sandstone", "Night", not "Beige 1".
- The model comes from the object file. A real model is made outside this session. Until one can be staged, the simple stand-in config (the product's kind, real dimensions and layers) may show how it is built. When the member asked for a real 3D model, the stand-in is not it: say the model is still to be made.
- Specs are values with units, grouped the way an engineer looks for them (size, weight, power, materials, sensors, compliance), never sentences.
- Parts are a table: one row a part, with what it is, what it is made of, who makes it and what it costs.
- Vendors are comparable rows: the same fields for every vendor (component, unit price, minimum order, lead time, region, certifications, status), so they can be judged side by side. A vendor not yet confirmed says so in its status.
- Analyses, reports and posts are structured reports (or standalone HTML pages when a custom layout is asked for), never plain Markdown notes: each with its numbers in a chart or a table, ending in a decision or a tradeoff, and staged in its own change with stage_surface_patch so the member can review and approve each piece on its own.

## A product that is not hardware
Software, a service or a subscription has nothing to put on a stage. Drop the stage and the colourways and give the page the tabs it needs, such as plans and prices, features or integrations. Adapt the layout; never fill homes that make no sense for the product.
