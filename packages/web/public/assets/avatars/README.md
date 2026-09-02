# Vendored: the approved agent visual system

Copied verbatim from `Qorpera/Qorpera_Website`, `landing/public/avatars`, which
vendors them from the visual workspace
(`Qorpera_Base-step2/.artifacts/qorpera-avatar-assets`). Do not edit here.
Re-copy when the workspace bakes a new revision.

Load order matters; each reads the globals the previous ones set:

1. `motion-model.js` — the roster (Planet, Acorn, Flame, Rocket, Crown, Heart,
   Ghost), their native colours, origins, body rhythms and eye geometry.
2. `avatar-appearance.js` — the eleven-colour palette and the linear-light
   recolouring pipeline.
3. `motion-visuals.js` — eye poses, the writing form, the creation burst.
4. `vector-figures.js` — builds one figure from its traced silhouette.
5. `vector-rig.js` — drives a built figure. The body stands still; the life is
   in the eyes. Nothing follows the pointer.
6. `vector-baked.js` — the baked traces, so the client never ships the tracer.

`src/ui/avatar.ts` is the only module that touches these globals.
