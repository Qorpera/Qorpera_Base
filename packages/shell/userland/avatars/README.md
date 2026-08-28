# Agent visual system

Approved figure and motion direction, 2026-08-28. This directory is used by the actual shell, not a development gallery.

## Assets

The seven 512 px RGBA masters are Planet, Acorn, Flame, Rocket, Crown, Heart, and Ghost. Storm and Folio are not selectable. Keep the masters unchanged: image alpha defines their silhouette and their original material lighting is the source for recoloring.

The RGB `*-face-plate.png` files are clean material patches, not alternate avatars. The controller masks these patches over the original eyes and places measured SVG eyes above them. Native artwork remains visible outside those masks.

`qorpera.png` is the approved Rocket/Crown logo, also shipped as `assets/qorpera.png`. Its SHA-256 is `32cb535aa801453ec1baa4ad0e50c45c65b92c03dece1d00f0a2490d41f0050f`. The Windows ICO contains 16, 32, 48, 64, 128, and 256 px PNG renditions of the same master.

## Rendering contract

- `motion-model.js` owns figure identities, measured eyes, body poses, and the pausable clock.
- `motion-visuals.js` owns eye movement, geometric typing, hover reactions, and neon stroke geometry. Creation runs at 80% speed with 1.725× stroke width; effects are finite.
- `avatar-appearance.js` recolors in sRGB/linear light, preserving alpha and white eyes. Edge-aware lighting smoothing removes amplified grain without flattening broad shadows. Native colors bypass recoloring.
- `avatar-state.js` owns per-agent transitions and message receipts. Identity is company plus agent ID, never the selected figure.
- `avatar-controller.js` binds all placements to that actor. DOM replacement, recoloring, and offscreen remounts do not restart its phase. Group separators erase underlying pixels with `destination-out`; they never paint a white ring.
- `status-text.js` and `avatar-system.css` provide stationary ink-weight waves and layout rules. Rail avatars have no pointer-hover motion. Completed bubbles have no avatar; activity appears below the conversation.

The selector is seven compact figures in one row. The eleven palette choices use centered rows of six and five. A figure and its color are independent settings. Keep the client palette, shell IPC color validation, and character catalog tests synchronized when changing either contract.

Sidebar priority is Needs you → current work → New → last public message. Read receipts require the matching rendered reply to intersect the focused conversation viewport. They do not resolve outstanding requests.

## Verification

From `packages/shell`, run the specific `avatar-system.test.ts`, `avatar-controller.test.ts`, `avatar-renderer.test.ts`, `staff-templates.test.ts`, and `userland-wiring.test.ts` files with Vitest. Pixel tests cover every figure/color combination without native graphics dependencies. Controller tests use a deterministic DOM/WAAPI boundary; they are not a substitute for visual review in the packaged app.

`packages/coding-agent/test/session-preview.test.ts` covers safe public snippets, message identity, append/truncation behavior, and room preview allowlisting. Run the root `npm run check` before committing.
