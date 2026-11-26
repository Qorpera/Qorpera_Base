---
name: identity-studio
description: How to build the company's Identity, its marks, words, palette, type and voice, and what a good one looks like. Use in every session on the Identity interface.
---

# Identity Studio

Identity is how the company looks and sounds: its marks, name, purpose, palette, type and voice. Every other interface wears it. The layout names the homes and the company files they read. Fill those files; this says how, and what good looks like.

## How to work
- Fill the homes one piece per change: name and mission, then palette, then type, then a mark. The member watches the identity come together piece by piece; never stage it all at once.
- An unknown stays an empty home. Never invent a mission, strategy or story the founders have not given you or the company's files do not hold. Say in your reply what is still missing.
- Settle what you can yourself: read the brief, vision and company files first. Ask the member only questions of taste, with surface_ask and two or three concrete options, never questions you can answer by reading. Ask once, early, then build on the answer; never stop for a question you could settle yourself, and never ask twice.
- Reshape tabs or blocks with `compose_surface_layout`, stage machine-rendered marks or mockups with `stage_surface_artifact`, and call `inspect_surface` (light and dark) to audit contrast before finishing.
- There is no Files tab: add an `artifacts` block to any tab for mockups, vector art, pictures, PDFs or guidelines.
- Prefer native blocks over a `module`; build a `module` only for what no native block can show.
- Never draw placeholder marks, clipart or fake photos. If something cannot be made in this session, leave its home empty and say so.
- Write to the member about the identity, never file paths, file names or tool names.

## What good looks like
- The logo and wordmark are real vector marks: clean paths, no embedded pictures, lettering turned into outlines so it never depends on a font. Draw each on a transparent ground: no background rectangle or panel inside the file. The page always shows a mark on plain white and on the black of Qorpera's dark theme, so it must read on both; one that vanishes on dark is not done, and a version made for dark ground is a mark in light colours, still on a transparent ground. Keep the logo simple enough to work as a small icon.
- The name, mission, ambition and strategy live in the company file the layout binds. The mission is one sentence of what the company does and for whom. The ambition says where it is going. The strategy is a few named moves, each with one line on what it means in practice. No slogans; no words like "innovative" or "seamless".
- Palette and type live in the tokens file. Name colours by role and character ("ink", "paper", "signal"), keep to a few, and check that text reads on its ground. Choose real type families, each with a role: headings, body, figures. Never write the compiled stylesheet; it is made from the tokens.
- Voice is a short note: three or four traits, each with a line the company would say and one it never would. Not an essay.
- Philosophy, brand essays and posts are structured reports, standalone HTML pages or PDFs, never plain Markdown notes: argued with concrete examples, each staged in its own change with stage_surface_patch so the member can review and approve each piece on its own. Any tab can hold them: add or widen a report block there to match.
- Every other interface wears these tokens and marks. Change them deliberately: when changing a colour, typeface or mark, name what will look different elsewhere (product pages, website, apps).
- For a choice of direction, give two or three real options the member can picture, named concretely: "Ink on paper with a serif for headings" or "Warm sand with a rounded sans". Never adjectives alone, such as "modern" or "bold".
