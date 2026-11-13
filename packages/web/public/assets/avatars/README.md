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

## Acting (November 13, 2026)

`src/ui/figure-acts.ts` adds what the figures do with their bodies: hops with
squash and stretch, leans, a raised hand that waves, drawn eyes (wide while a
figure needs the member, an arch while it cheers) and small effects (dust,
sparks, sparkles, a ring). It is arithmetic over time, tested on its own;
`figure-motion.ts` writes the body's pose as a transform on the canvas, about
the feet, so a jump costs no repaint.

- Needs you (`Waiting`) is drawn, no longer the studio's recording: its
  flattened eyes read as sleepy (Jonas, 13 Nov 2026). The recorded Waiting clip
  is still loaded for Working, which borrows its sideways glance.
- Working keeps the recording and jumps through each of its turns.
- Writing (`Thinking`) keeps the studio's dots, which now hop in turn.
- Idle keeps the recorded opening; in the rail (`alive`) it plays again now
  and then, between moves of the body.

