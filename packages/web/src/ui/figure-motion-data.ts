/* The 2D studio's recorded motion: about 950 KB of frame and eye data
 * (status-2d-v1's working-frames, eye-clips and eye-tracks) and the code that
 * reads it. figure-motion.ts loads this module on the first figure it mounts,
 * so it is its own chunk and never holds up the first screen; until it
 * arrives a figure shows its still artwork. */
export { localTime, pose, timelines } from "../../public/assets/avatars/status-2d-v1/motion.mjs";
export {
	drawRecordedEyes,
	drawWorkingStrokes,
	loadRecordedMotion,
} from "../../public/assets/avatars/status-2d-v1/recorded-motion.mjs";
export { createWorkingSchedule, stepKey, workingStep } from "./working-sequence.ts";
