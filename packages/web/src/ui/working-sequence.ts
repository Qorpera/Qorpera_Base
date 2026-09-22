import { type RecordedFrame, recordedClips } from "../../public/assets/avatars/status-2d-v1/recorded-clips.mjs";

/* The Working figure is the studio's recording, played as pieces instead of
 * one 10.83-second loop. The recording ends with the eyes at rest, lower
 * left, and begins with them up and to the right, so a plain loop jumped at
 * every restart. Here each agent draws its own order from a seeded random
 * source: holds, blinks and glances between turns, joined at frames whose eye
 * positions match. Every turn is a spin of its own: the eye field swings into
 * the spin's angle as the eyes leave, the stripes whirl about that angle in
 * either sense, and the eyes come back along it and settle into a new rest
 * tilt, mirrored or not. Two views of the same agent share one schedule, so
 * they show the same frame. */

export type Clip = "Working" | "Waiting";

/** Where the recorded eye field sits on the body: mirrored across the body's
 * vertical axis, turned by `tilt` degrees about its centre, and slid by
 * (`x`, `y`) source pixels while a join settles. */
export interface EyeField {
	mirror: boolean;
	tilt: number;
	x: number;
	y: number;
}
export interface StrokeField {
	mirror: boolean;
	tilt: number;
}
export interface WorkingStep {
	clip: Clip;
	frame: number;
	eyes: EyeField;
	strokes: StrokeField;
}

/** The recorded frames of a turn: the eyes leave over `exit`, are gone over
 * `hidden`, and come back and settle over `entry`, all inclusive. */
interface Spin {
	exit: [number, number];
	hidden: [number, number];
	entry: [number, number];
}
interface Piece {
	clip: Clip;
	/** First and last recorded frame, inclusive; `from` above `to` plays backwards. */
	from: number;
	to: number;
	spin?: Spin;
}
/** One turn's transforms: the eye field swings from the rest tilt it had to
 * the spin angle while the eyes leave, takes the spin's mirror while they are
 * hidden, and swings from the spin angle to its new rest tilt as they return. */
interface Turn {
	fromMirror: boolean;
	fromTilt: number;
	mirror: boolean;
	angle: number;
	tilt: number;
}
interface Segment extends Piece {
	start: number;
	length: number;
	eyes: EyeField;
	turn?: Turn;
	strokes: StrokeField;
	slide: { x: number; y: number };
}
export interface WorkingSchedule {
	seed: number;
	segments: Segment[];
	random(): number;
	field: EyeField;
	strokes: StrokeField;
	sinceTurn: number;
}

export const FPS = 60;
/** Frames over which a join's eye offset eases away. */
export const SLIDE_FRAMES = 8;

// The recording's pieces. Frame numbers are the studio's 650 Working frames
// and 279 Waiting frames. Rest pieces start and end with the eyes at rest.
const SPIN_A: Spin = { exit: [80, 93], hidden: [94, 107], entry: [108, 170] };
const SPIN_B: Spin = { exit: [508, 523], hidden: [524, 538], entry: [539, 600] };
const OPENING: Piece[] = [{ clip: "Working", from: 0, to: 214, spin: SPIN_A }];
const REST: { weight: number; pieces: Piece[] }[] = [
	{ weight: 3, pieces: [{ clip: "Working", from: 215, to: 320 }] },
	{ weight: 2, pieces: [{ clip: "Working", from: 600, to: 640 }] },
	{ weight: 2, pieces: [{ clip: "Working", from: 185, to: 215 }] },
	{
		weight: 2,
		pieces: [
			{ clip: "Working", from: 320, to: 430 },
			{ clip: "Working", from: 430, to: 320 },
		],
	},
	// A short squint to the side: the Waiting clip's opening, played back out.
	{
		weight: 1,
		pieces: [
			{ clip: "Waiting", from: 0, to: 24 },
			{ clip: "Waiting", from: 24, to: 0 },
		],
	},
];
const TURNS: { weight: number; pieces: Piece[] }[] = [
	{ weight: 3, pieces: [{ clip: "Working", from: 430, to: 640, spin: SPIN_B }] },
	{ weight: 1, pieces: [{ clip: "Working", from: 320, to: 640, spin: SPIN_B }] },
	// The first pass of the recording, reached through a squint to the side.
	{
		weight: 2,
		pieces: [
			{ clip: "Waiting", from: 0, to: 40 },
			{ clip: "Working", from: 80, to: 215, spin: SPIN_A },
		],
	},
];
/** How far, in degrees, a spin's axis swings away from the rest tilt. */
const SWING: [number, number] = [15, 70];
const REST_RUNS = [1, 2, 2, 3];

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function pick<T extends { weight: number }>(random: () => number, options: T[]): T {
	let roll = random() * options.reduce((sum, option) => sum + option.weight, 0);
	for (const option of options) {
		roll -= option.weight;
		if (roll < 0) return option;
	}
	return options[options.length - 1]!;
}

/** The centre of the eye pair in source pixels, or undefined while an eye is hidden. */
export function eyeCentre(frame: RecordedFrame): { x: number; y: number } | undefined {
	const rings = frame.eyes.filter((ring) => ring.length);
	if (rings.length !== 2) return undefined;
	let x = 0,
		y = 0;
	for (const ring of rings) {
		let rx = 0,
			ry = 0;
		for (const [px, py] of ring) {
			rx += px;
			ry += py;
		}
		x += rx / ring.length / 2;
		y += ry / ring.length / 2;
	}
	return { x, y };
}

const centres = new Map<string, { x: number; y: number } | undefined>();
function centreAt(clip: Clip, frame: number): { x: number; y: number } | undefined {
	const key = `${clip}:${frame}`;
	if (!centres.has(key)) centres.set(key, eyeCentre(recordedClips[clip].frames[frame]!));
	return centres.get(key);
}

const smooth = (x: number) => x * x * (3 - 2 * x);

function append(schedule: WorkingSchedule, piece: Piece, turn: boolean): void {
	const previous = schedule.segments[schedule.segments.length - 1];
	const start = previous ? previous.start + previous.length : 0;
	const slide = { x: 0, y: 0 };
	if (previous) {
		const before = centreAt(previous.clip, previous.to),
			after = centreAt(piece.clip, piece.from);
		if (before && after) {
			slide.x = before.x - after.x;
			slide.y = before.y - after.y;
		}
	}
	const segment: Segment = {
		...piece,
		start,
		length: Math.abs(piece.to - piece.from) + 1,
		eyes: schedule.field,
		strokes: schedule.strokes,
		slide,
	};
	if (turn && piece.spin) {
		// The mirror sets the spin's sense: mirrored stripes whirl the other way
		// round, and the eyes come back on the side they left.
		const mirror = schedule.random() < 0.5;
		const sense = mirror ? -1 : 1;
		const angle = schedule.field.tilt + sense * (SWING[0] + (SWING[1] - SWING[0]) * schedule.random());
		// A positive tilt levels the resting pair; the mirrored pair levels the other way.
		const tilt = sense * (-8 + 30 * schedule.random());
		segment.turn = { fromMirror: schedule.field.mirror, fromTilt: schedule.field.tilt, mirror, angle, tilt };
		segment.strokes = { mirror, tilt: angle };
		schedule.field = { mirror, tilt, x: 0, y: 0 };
		schedule.strokes = segment.strokes;
	}
	schedule.segments.push(segment);
}

function extend(schedule: WorkingSchedule, frames: number): void {
	while (true) {
		const last = schedule.segments[schedule.segments.length - 1];
		if (last && last.start + last.length > frames) return;
		if (!last) {
			for (const piece of OPENING) append(schedule, piece, true);
			schedule.sinceTurn = 0;
			continue;
		}
		if (schedule.sinceTurn >= REST_RUNS[Math.floor(schedule.random() * REST_RUNS.length)]!) {
			// A turn needs the eyes at rest first; the Waiting glance carries its own entry.
			for (const piece of pick(schedule.random, TURNS).pieces) append(schedule, piece, true);
			schedule.sinceTurn = 0;
		} else {
			for (const piece of pick(schedule.random, REST).pieces) append(schedule, piece, false);
			schedule.sinceTurn++;
		}
	}
}

export function createWorkingSchedule(seed = Math.floor(Math.random() * 2 ** 32)): WorkingSchedule {
	return {
		seed,
		segments: [],
		random: mulberry32(seed),
		field: { mirror: false, tilt: 0, x: 0, y: 0 },
		strokes: { mirror: false, tilt: 0 },
		sinceTurn: 0,
	};
}

/** The recorded frame and field transforms to draw at `seconds` into Working. */
export function workingStep(schedule: WorkingSchedule, seconds: number): WorkingStep {
	const n = Math.max(0, Math.floor(seconds * FPS + 1e-6));
	extend(schedule, n);
	let low = 0,
		high = schedule.segments.length - 1;
	while (low < high) {
		const mid = (low + high + 1) >> 1;
		if (schedule.segments[mid]!.start <= n) low = mid;
		else high = mid - 1;
	}
	const segment = schedule.segments[low]!;
	const k = n - segment.start;
	const frame = segment.from + (segment.to >= segment.from ? k : -k);
	const field = spinField(segment, frame);
	const remaining = 1 - smooth(Math.min(1, k / SLIDE_FRAMES));
	return {
		clip: segment.clip,
		frame,
		eyes: { ...field, x: segment.slide.x * remaining, y: segment.slide.y * remaining },
		strokes: segment.strokes,
	};
}

const between = (frame: number, [a, b]: [number, number]) => smooth(Math.min(1, Math.max(0, (frame - a) / (b - a))));
function spinField(segment: Segment, frame: number): EyeField {
	const { turn, spin } = segment;
	if (!turn || !spin) return segment.eyes;
	if (frame < spin.exit[0]) return { mirror: turn.fromMirror, tilt: turn.fromTilt, x: 0, y: 0 };
	if (frame <= spin.exit[1])
		return {
			mirror: turn.fromMirror,
			tilt: turn.fromTilt + (turn.angle - turn.fromTilt) * between(frame, spin.exit),
			x: 0,
			y: 0,
		};
	// The mirror flips halfway through the hidden frames, unseen on both sides.
	if (frame <= spin.hidden[1])
		return {
			mirror: frame < (spin.hidden[0] + spin.hidden[1]) / 2 ? turn.fromMirror : turn.mirror,
			tilt: turn.angle,
			x: 0,
			y: 0,
		};
	return { mirror: turn.mirror, tilt: turn.angle + (turn.tilt - turn.angle) * between(frame, spin.entry), x: 0, y: 0 };
}

/** A stable text form of a step, for repaint keys. */
export function stepKey(step: WorkingStep): string {
	const { eyes, strokes } = step;
	return `${step.clip}:${step.frame}:${eyes.mirror ? "m" : ""}${eyes.tilt.toFixed(1)}:${eyes.x.toFixed(2)},${eyes.y.toFixed(2)}:${strokes.mirror ? "m" : ""}${strokes.tilt.toFixed(1)}`;
}
