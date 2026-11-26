---
name: product-studio
description: How to build a product's page in its Studio interface, and what a good one looks like. Use in every session on a Product interface.
---

# Product Studio

This page sells and specifies one product. A buyer knows what it is at first glance from the 3D stage, renders and headline figures; an engineer finds every number in Specs and Vendors without wading through prose. The starter layout already sets up Overview, Specs, Vendors, Reports and Breakdowns. Keep and fill those native homes.

## Keep the Product template
- Keep Overview's native structure for physical products: `stage_3d`, `title`, `swatch_row`, `facts` and the Overview `artifacts` visuals gallery, plus Specs, Vendors, Reports and Breakdowns.
- Never replace Overview with a monolithic `module` iframe, never build nested tab bars inside a `module`, and never put prose walls on Overview.
- Use `module` only as a focused extra block or tab for an interactive widget native blocks cannot draw (such as a live sizing or pricing calculator).
- For competing directions in one session, vary the native Product page (3D model, renders, colourways, figures, specs and parts) across separate option-group changes instead of embedding an in-page switcher.

## How to work
- Fill the homes piece by piece: 3D model and visuals, then the line, figures and colourways, then specs, parts and vendors.
- An unknown stays an empty home. Never invent a price, weight, supplier or certification: say in your reply what is still missing and who could know it.
- Read the brief, company files and earlier reports first. Never stop to ask taste or colour questions — stage a concrete direction (or toggleable Preview variants) with stage_surface_patch so the member steers live. Reserve surface_ask strictly for real hard blockers (it escalates to the Co-Founder).
- Build real visuals and 3D models in this session: generate studio renders, worn shots and exploded views placed under pictures or renders (so Overview shows them cleanly), and use `stage_surface_artifact` for GLB 3D models, Blender renders, charts or PDFs made on the coding machine.
- Use `compose_surface_layout` only to add a focused block (such as `chart` or an extra `artifacts` section) or remove unused homes; call `inspect_surface` after staging (including option-group changes) to verify the real rendered page before finishing.
- Write to the member about the product, never file paths, file names or tool names.

## What good looks like
- The 3D stage holds a real multi-part GLB 3D model built in this session on the coding machine (using Blender when installed, or a Python or Node script exporting multi-part PBR geometry with named nodes and tintable materials), staged via `stage_surface_artifact` and wired in the object file so it turns, pulls apart and tints with `swatch_row`. Use the simple stand-in config only when a real GLB cannot be built, and say so clearly.
- Visuals look like real industrial design renders and product photography, never crude diagram boxes or broken images.
- The line is one plain buyer sentence ("A soft EEG headband that tracks sleep stages at home", not "Reinventing rest").
- The four headline figures are brief values ("14 h", "44 g", "Merino wool", "1.995 kr."); longer details go in Specs.
- Colourways have shop-ready material names ("Sandstone", "Night", not "Beige 1").
- Specs are grouped values with units (size, weight, power, materials, sensors, compliance), never prose.
- Parts are a table with what it is, material, supplier and unit cost; Vendors are comparable rows with identical fields and unconfirmed vendors marked in status.
- Reports and analyses are structured reports, standalone HTML pages or PDFs, staged one per change with stage_surface_patch.

## Non-hardware products
Software, a service or a subscription has no 3D stage. Drop `stage_3d` and `swatch_row` and use the native tabs it needs, such as plans and prices, features or integrations.
