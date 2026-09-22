# Assets Room: 2D Motion Studio, September 5, 2026

Source: `Qorpera_Base-step2/.artifacts/qorpera-avatar-assets/status-2d`, linked
to `Documents/Codex/2026-09-05/ope/outputs/qorpera-2d-motion`.

`motion.mjs`, `eye-tracks.mjs`, `eye-clips.mjs`, `working-frames.mjs`,
`working-palette.mjs`, `recorded-clips.mjs`, and the ten reference WebP sheets
are copied unchanged. Keep their clocks, contours, and trajectories together.
`recorded-motion.mjs` changes only initialization/loading: it creates scratch
canvases lazily, loads only the selected activity, accepts the static asset
base URL (the product JS is bundled), and permits retry after a failed load.
Its eye extraction, placement, and stroke compositing remain the studio's.

The TypeScript compositor in `src/ui/figure-motion.ts` ports the studio's
`preview.mjs` drawing code, adds the app's selected-card silhouette, and owns
one frame scheduler with reduced motion, visibility, resize, and disposal.
It uses the app's 112% artwork frame instead of the studio preview's stage
padding. Idle/Working/Waiting use integer source frames; the symbolic states
use the unchanged motion sampler. No runtime binding is provided.

- Idle: 222 frames, then hold.
- Working: all 650 frames, repeating the complete 10.83-second clip.
- Waiting: 279 frames, then hold.
- Blocked: contract into a held exclamation mark.
- Thinking: three dots on a fixed baseline, pulsing every 1.4 seconds.
- Done: flourish, slower eye reaction, then hold.

The seven bodies and face plates come from the Assets Room's `assets` and
`motion-assets` directories. `artwork-manifest.json` records source and output
hashes. Bodies and the Planet plate are lossless WebP conversions. The other
six face plates are first drawn to 512 × 512 in Chromium Canvas 2D, matching
the existing `avatar-appearance.prepare` downsampling, then encoded losslessly.
This reduces the artwork from 8,939,482 to 2,420,098 bytes without rescaling
the original bodies. The browser requests only the characters it mounts.

Do not replace these assets with 3D experiments or regenerate the motions.
Update this versioned directory and its references when adopting a new study.

## Working as sequenced pieces (September 22, 2026)

The recording's last Working frame holds the eyes at rest, lower left, while
its first frame has them up and to the right, so repeating the whole clip
jumped the eyes at every restart. `src/ui/working-sequence.ts` now plays the
recording as pieces joined at frames whose eye positions match: the opening
and first pass (frames 0–214) exactly as recorded, then holds (215–320,
600–640), the blink (185–215), the look to the far left and back (320–430,
reversed), a short squint from the Waiting clip (0–24, reversed), and the
turns (430–640, 320–640, or a squint into 86–215). A small offset eases away
over eight frames at each join. Each agent draws its own order from a seeded
random source shared by all its views. While the eyes are hidden inside a
turn, the field may mirror across the body and tilt up to about twenty
degrees, and the stripes take the new side with a direction of their own.
`recorded-motion.mjs` accepts these field transforms as an optional last
argument; the frames, contours and atlases are unchanged. Reduced motion
keeps the studio's still at one second.
