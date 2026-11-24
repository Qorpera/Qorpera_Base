/* The 2D studio's motion sampler (status-2d-v1 `motion.mjs`): the symbolic states' poses (the writing dots, the
 * "!" and the Done flourish) and each state's time. figure-motion.ts loads this module on the first figure it
 * mounts, so it is its own chunk and never holds up the first screen; until it arrives a figure shows its
 * still artwork. Every eye is drawn (ui/figure-acts.ts); the studio's recorded eye clips are no longer read. */
export { localTime, pose, timelines } from "./avatars/status-2d-v1/motion.mjs";
