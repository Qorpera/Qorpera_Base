# Agent artwork and 2D motion

`index.html` loads `motion-model.js` (the twelve characters and their measured
eye geometry), then `avatar-appearance.js` (the eleven-color palette and the
painting: one grain-free light field per body and face plate, painted in the
chosen color through an OKLab tone ramp; October 20, 2026). The light field
itself is in `light-field.js`, loaded between the two; it also runs as a worker
(the same file), so preparing artwork no longer holds up the page's first draw
(November 9, 2026). These came from
`Qorpera_Website/landing/public/avatars`. `src/ui/avatar.ts` is the only product
module that touches their globals.

The product now renders the original artwork through `src/ui/figure-motion.ts`
and the September 5 Assets Room **2D Motion Studio** sources in `status-2d-v1`.
The older `vector-*` and `motion-visuals.js` files are retained for the archived
design prototypes; the product no longer loads them.

The renderer defaults to Idle. Its optional activity is a local presentation
input, with no runtime subscription, command, or activity-state binding.

## Acting, and drawn eyes (November 13, 2026)

`src/ui/figure-acts.ts` is what the figures do: hops with squash and stretch,
leans, drawn eyes (wide while a figure looks for the member, an arch while it
cheers), the symbols a figure becomes in its own colour (a "?" or a "!" when
its work waits on the member, a four-pointed star while it works: it jumps,
turns once round in the air and is swapped where it is edge on), and small
effects (dust, stars). It is arithmetic over time, tested on its own;
`figure-motion.ts` writes the body's pose as a transform on the canvas, about
the feet, so a jump costs no repaint, and repaints the eyes or the symbol only
when they change.

Every eye is now drawn. The product no longer reads the studio's recorded eye
clips or the Working stripes (Jonas, 13 Nov 2026: the recording looked grainy
and blurry stretched up, and Working was too close to another product's
animation): Needs you, Working and Idle are acts of our own, and Writing keeps
the studio's dots, which hop in turn. `status-2d-v1`'s `motion.mjs` is still
the sampler for the symbolic states (the dots, the "!", the Done flourish).
The recorded files (`recorded-motion.mjs`, `recorded-clips.mjs`, `eye-clips.mjs`,
`working-frames.mjs`, `working-palette.mjs`, the `*-reference-*.webp` sheets) and
`src/ui/working-sequence.ts` are left in place, unread, until the new motion is
approved.
