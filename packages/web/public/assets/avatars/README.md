# Agent artwork and 2D motion

`index.html` loads `motion-model.js` (the seven characters and their measured
eye geometry), then `avatar-appearance.js` (the eleven-color palette and the
existing linear-light recoloring pipeline). These came from
`Qorpera_Website/landing/public/avatars`. `src/ui/avatar.ts` is the only product
module that touches their globals.

The product now renders the original artwork through `src/ui/figure-motion.ts`
and the September 5 Assets Room **2D Motion Studio** sources in `status-2d-v1`.
The older `vector-*` and `motion-visuals.js` files are retained for the archived
design prototypes; the product no longer loads them.

The renderer defaults to Idle. Its optional activity is a local presentation
input, with no runtime subscription, command, or activity-state binding.
