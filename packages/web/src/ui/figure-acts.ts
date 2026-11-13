/* How a figure acts: what its body does (hops, leans, squash and stretch), where its eyes look when
 * they are drawn rather than recorded, what its raised hand does, and which small effects go off in
 * the air around it. Pure arithmetic over time, so two views of one agent act alike and a test can
 * read a pose at any second; figure-motion.ts puts the result on the page.
 *
 * The body is in the artwork's 100-unit frame (the figure's canvas): `y` is negative upwards, and
 * the scales turn about the feet. A move is decisive or absent: a figure in the rail is some fifty
 * pixels tall, where a one-unit drift is half a pixel of shimmer. */

export interface BodyPose {
	x: number;
	y: number;
	/** Degrees, about the feet. */
	turn: number;
	scaleX: number;
	scaleY: number;
}
/** A drawn eye against the figure's own (figure-motion.ts): `x` in eye spacings, `y` in eye heights,
 * the sizes as factors, and `smile` from 0 (the pill) to 1 (a happy arch). */
export interface EyePose {
	x: number;
	y: number;
	width: number;
	height: number;
	rotation: number;
	alpha: number;
	smile: number;
}
export interface HandPose {
	/** 0 hidden to 1 raised, past 1 while it springs up. */
	show: number;
	/** Degrees about the wrist. */
	wave: number;
}
export type Effect = "dust" | "sparkles" | "sparks" | "ring";
export interface Cue {
	at: number;
	effect: Effect;
}
export interface Act {
	body: BodyPose;
	/** Drawn eyes; none keeps the recorded ones. */
	eyes?: [EyePose, EyePose];
	hand?: HandPose;
}

const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value));
/** 0 before `from`, 1 after `to`, eased between. */
const ease = (from: number, to: number, t: number) => {
	const x = clamp((t - from) / (to - from));
	return x * x * (3 - 2 * x);
};
/** Up over [a, b], held, and down over [c, d]. */
const pulse = (t: number, a: number, b: number, c: number, d: number) => ease(a, b, t) * (1 - ease(c, d, t));
const TAU = Math.PI * 2;

export const REST: BodyPose = Object.freeze({ x: 0, y: 0, turn: 0, scaleX: 1, scaleY: 1 });
const EYE: EyePose = Object.freeze({ x: 0, y: 0, width: 1, height: 1, rotation: 0, alpha: 1, smile: 0 });

/** Two body poses at once: offsets add, scales multiply. */
export function both(a: BodyPose, b: BodyPose): BodyPose {
	return {
		x: a.x + b.x,
		y: a.y + b.y,
		turn: a.turn + b.turn,
		scaleX: a.scaleX * b.scaleX,
		scaleY: a.scaleY * b.scaleY,
	};
}

/** `k` above zero squashes (shorter and wider), below zero stretches; the width gives a little less than the
 * height takes, as a soft body does. */
function squash(k: number): Pick<BodyPose, "scaleX" | "scaleY"> {
	return { scaleX: 1 + 0.75 * k, scaleY: 1 - k };
}

/** Where a hop leaves the ground and where it lands, as parts of its length. */
export const HOP_LAUNCH = 0.2;
export const HOP_LAND = 0.7;

/** One hop over `u` from 0 to 1: a crouch, the air (stretched leaving and falling, round at the top), and
 * a landing that gives and settles. `height` is in frame units, `give` how soft the body is. */
export function hop(u: number, height: number, give = 0.13): BodyPose {
	if (!(u > 0 && u < 1)) return REST;
	let y = 0,
		k = 0;
	if (u < HOP_LAUNCH) k = give * pulse(u, 0, 0.12, 0.14, HOP_LAUNCH);
	else if (u < HOP_LAND) {
		const v = (u - HOP_LAUNCH) / (HOP_LAND - HOP_LAUNCH);
		y = -height * 4 * v * (1 - v);
		k = -0.7 * give * Math.abs(1 - 2 * v) ** 1.5 * ease(0, 0.15, v);
	} else {
		const w = (u - HOP_LAND) / (1 - HOP_LAND);
		const settle = give * Math.exp(-4.5 * w) * Math.cos(TAU * 1.3 * w) * (1 - ease(0.8, 1, w));
		k = -0.7 * give + (settle + 0.7 * give) * ease(0, 0.1, w);
	}
	return { x: 0, y, turn: 0, ...squash(k) };
}

/** How far through the air a hop is (0 on the ground, 1 at the top). */
function aloft(u: number): number {
	if (u <= HOP_LAUNCH || u >= HOP_LAND) return 0;
	const v = (u - HOP_LAUNCH) / (HOP_LAND - HOP_LAUNCH);
	return 4 * v * (1 - v);
}

/** A blink at `at`: the eye's height as a factor. */
function blink(t: number, at: number): number {
	return 1 - 0.92 * pulse(t, at, at + 0.055, at + 0.09, at + 0.2);
}

/* ---- needs you: the figure asks for the member ---------------------------------------------------
 * It jumps up as the hand goes up, waves, and then keeps asking: every few seconds a pair of hops, a
 * wiggle or a lean towards the glass with a look to both sides, its eyes wide the whole time. */

interface Hop {
	start: number;
	length: number;
	height: number;
}
const ENTRANCE: Hop[] = [
	{ start: 0.04, length: 0.66, height: 21 },
	{ start: 0.66, length: 0.5, height: 11 },
];
/** The first ask after the entrance, and how often after that. */
const ASK_FIRST = 3.4;
const ASK_EVERY = 5.6;
const ASK_KINDS = ["hops", "wiggle", "hops", "peek"] as const;
const ASK_HOPS: Hop[] = [
	{ start: 0, length: 0.56, height: 13 },
	{ start: 0.5, length: 0.46, height: 8 },
];

function ask(t: number, seed: number): { kind: (typeof ASK_KINDS)[number]; at: number; since: number } | undefined {
	if (t < ASK_FIRST) return undefined;
	const n = Math.floor((t - ASK_FIRST) / ASK_EVERY);
	const at = ASK_FIRST + n * ASK_EVERY;
	return { kind: ASK_KINDS[(n + seed) % ASK_KINDS.length]!, at, since: t - at };
}

function hops(t: number, list: Hop[], from = 0): { body: BodyPose; air: number } {
	let body = REST,
		air = 0;
	for (const each of list) {
		const u = (t - from - each.start) / each.length;
		if (u <= 0 || u >= 1) continue;
		body = both(body, hop(u, each.height));
		air = Math.max(air, aloft(u));
	}
	return { body, air };
}

/** The figure while its work waits on the member, `t` seconds in. `seed` sets which ask comes when. */
export function calling(t: number, seed = 0): Act {
	const asking = ask(t, seed);
	let { body, air } = hops(t, ENTRANCE);
	// Wide, and a blink once it has landed.
	let open = 1.08 * blink(t, 1.32) * blink(t, 2.5),
		look = 0,
		up = 0;
	let waving = pulse(t, 0.3, 0.45, 1.45, 1.75) * Math.sin(TAU * 3.1 * (t - 0.3)) * 21;
	if (asking) {
		const s = asking.since;
		waving += pulse(s, 0.02, 0.16, 1.05, 1.3) * Math.sin(TAU * 3.1 * s) * 18;
		open *= blink(s, 1.5) * blink(s, 1.78);
		if (asking.kind === "hops") {
			const jumps = hops(s, ASK_HOPS);
			body = both(body, jumps.body);
			air = Math.max(air, jumps.air);
		} else if (asking.kind === "wiggle") {
			const amount = pulse(s, 0, 0.14, 0.86, 1.1);
			body = both(body, {
				x: 2.2 * amount * Math.sin(TAU * (s / 0.38)),
				y: 0,
				turn: 7 * amount * Math.sin(TAU * (s / 0.38)),
				...squash(-0.04 * amount),
			});
			// A look up at its own hand while it shakes.
			look = 0.22 * amount;
			up = -0.2 * amount;
		} else {
			// A lean towards the glass, and a look to both sides: is anyone there?
			const near = pulse(s, 0, 0.26, 1.2, 1.5);
			body = both(body, { x: 0, y: 1.5 * near, turn: 0, scaleX: 1 + 0.08 * near, scaleY: 1 + 0.08 * near });
			look = -0.4 * pulse(s, 0.26, 0.4, 0.62, 0.76) + 0.4 * pulse(s, 0.72, 0.86, 1.08, 1.24);
			open *= 1 + 0.06 * near;
		}
	}
	// In the air the eyes go up with it and open wider.
	const eye: EyePose = {
		...EYE,
		x: look,
		y: up - 0.16 * air,
		width: 1.05,
		height: open * (1 + 0.07 * air),
	};
	return {
		body,
		eyes: [eye, { ...eye }],
		hand: {
			// Springs up a beat after the jump starts, then sways while it waits.
			show: t < 0.1 ? 0 : 1 - Math.exp(-9 * (t - 0.1)) * Math.cos(15 * (t - 0.1)),
			wave: waving + 4 * Math.sin(TAU * 0.4 * t) * ease(1.6, 2.4, t),
		},
	};
}

/** The asking figure at rest, for a member who wants no motion: wide eyes, the hand up. */
export function callingStill(): Act {
	const eye: EyePose = { ...EYE, width: 1.05, height: 1.08 };
	return { body: REST, eyes: [eye, { ...eye }], hand: { show: 1, wave: 0 } };
}

/** A raised hand beside a figure that is busy with something else, `t` seconds after it went up: up with a
 * spring, a slow sway, and a wave every few seconds. */
export function raisedHand(t: number): HandPose {
	const since = t % 6.5;
	return {
		show: t < 0.05 ? 0 : 1 - Math.exp(-9 * (t - 0.05)) * Math.cos(15 * (t - 0.05)),
		wave: 4 * Math.sin(TAU * 0.4 * t) + 17 * pulse(since, 0.3, 0.45, 1.3, 1.6) * Math.sin(TAU * 3.1 * (since - 0.3)),
	};
}

function landings(list: Hop[], from: number): Cue[] {
	return list.map((each) => ({ at: from + each.start + each.length * HOP_LAND, effect: "dust" as const }));
}

/** What goes off around the asking figure in (`from`, `to`]: dust where it lands, a ring off the hand as
 * a wave starts. */
export function callingCues(from: number, to: number, seed = 0): Cue[] {
	const cues: Cue[] = [...landings(ENTRANCE, 0), { at: 0.36, effect: "ring" }];
	const first = Math.max(0, Math.floor((from - ASK_FIRST) / ASK_EVERY));
	const last = Math.floor((to - ASK_FIRST) / ASK_EVERY);
	for (let n = first; n <= last; n++) {
		const at = ASK_FIRST + n * ASK_EVERY;
		cues.push({ at: at + 0.06, effect: "ring" });
		if (ASK_KINDS[(n + seed) % ASK_KINDS.length] === "hops") cues.push(...landings(ASK_HOPS, at));
	}
	return cues.filter((cue) => cue.at > from && cue.at <= to);
}

/* ---- working: the recorded turn becomes a whirl ----------------------------------------------------
 * The recording spins the eyes off one side and back on the other while the stripes whirl. The body
 * now jumps through it: down as the eyes start to leave, up and pinched thin while they are gone,
 * and a soft landing as they come back. Between turns it leans the way it looks. */

/** `u` runs 0 to 1 across a turn (working-sequence.ts `whirl`), `sense` is the way it spins. */
export function whirl(u: number, sense: 1 | -1): BodyPose {
	const jump = hop(u, 15, 0.14);
	const air = aloft(u);
	// Thin in the air, as a coin on its edge, tipping into the spin and out of it.
	return both(jump, {
		x: 0,
		y: 0,
		turn: sense * 9 * Math.sin(TAU * clamp((u - HOP_LAUNCH) / (HOP_LAND - HOP_LAUNCH))),
		scaleX: 1 - 0.24 * air ** 2,
		scaleY: 1,
	});
}

/** The lean of a look: `gaze` is how far the eyes sit from rest, in the recording's pixels. */
export function lean(gaze: { x: number; y: number }): BodyPose {
	const side = clamp(gaze.x / 14, -1, 1);
	return { x: 2.4 * side, y: 0, turn: 4.5 * side, scaleX: 1, scaleY: 1 };
}

/* ---- writing: the three dots hop ---------------------------------------------------------------- */

export interface Dot {
	x: number;
	y: number;
	r: number;
	alpha: number;
	/** The dot's width and height as factors of `r`: it lands soft too. */
	scaleX: number;
	scaleY: number;
}
const DOT_EVERY = 1.26;

/** The writing dots at `t` seconds: each hops in turn, left to right, where the studio's only swelled. `dots` are
 * the studio's, which still bring them out of the body and set their size. */
export function hoppingDots(dots: { x: number; y: number; r: number; alpha: number }[], t: number): Dot[] {
	return dots.map((dot, index) => {
		// The first hop starts once the dots have spread (0.34 s in the studio's pose).
		const since = t - 0.42 - index * 0.17;
		const u = since < 0 ? 0 : (since % DOT_EVERY) / 0.62;
		const body = hop(u, 15, 0.16);
		const lit = u > 0 && u < 1 ? 1 - ease(0.72, 1, u) : 0;
		return {
			x: dot.x,
			y: dot.y + body.y + (1 - body.scaleY) * dot.r,
			r: dot.r > 0 ? 6.9 * (dot.r / Math.max(dot.r, 6.5)) : 0,
			alpha: 0.5 + 0.5 * lit,
			scaleX: body.scaleX,
			scaleY: body.scaleY,
		};
	});
}

/* ---- moments: short acts over whatever the figure is doing ----------------------------------------- */

export type Moment = "cheer" | "perk" | "stretch" | "sway" | "skip";
export const MOMENT_LENGTH: Record<Moment, number> = { cheer: 1.5, perk: 0.44, stretch: 1, sway: 1.3, skip: 0.56 };

/** A moment `t` seconds in. */
export function moment(kind: Moment, t: number): Act {
	if (kind === "cheer") {
		// Work done: a jump and a smaller one, eyes shut in a smile, sparkles at the top.
		const { body } = hops(t, [
			{ start: 0.04, length: 0.64, height: 19 },
			{ start: 0.64, length: 0.46, height: 9 },
		]);
		const eye: EyePose = { ...EYE, smile: pulse(t, 0.06, 0.2, 1.08, 1.34) };
		return { body, eyes: [eye, { ...eye }] };
	}
	if (kind === "perk") return { body: hop(t / MOMENT_LENGTH.perk, 7, 0.1) };
	if (kind === "skip") return { body: hop(t / MOMENT_LENGTH.skip, 8, 0.11) };
	if (kind === "stretch") {
		// Up on its toes and down again.
		const up = pulse(t, 0, 0.34, 0.5, 0.78);
		const settle = 0.03 * Math.exp(-6 * Math.max(0, t - 0.78)) * Math.sin(TAU * 3 * Math.max(0, t - 0.78));
		return { body: { x: 0, y: 0, turn: 0, ...squash(-0.075 * up + settle) } };
	}
	// A slow rock from side to side.
	const amount = pulse(t, 0, 0.3, 0.95, 1.3);
	return {
		body: {
			x: 1.6 * amount * Math.sin(TAU * (t / 0.65)),
			y: 0,
			turn: 4.5 * amount * Math.sin(TAU * (t / 0.65)),
			...squash(0),
		},
	};
}

export function momentCues(kind: Moment, from: number, to: number): Cue[] {
	const cues: Cue[] =
		kind === "cheer"
			? [
					{ at: 0.3, effect: "sparkles" },
					{ at: 0.04 + 0.64 * HOP_LAND, effect: "dust" },
				]
			: [];
	return cues.filter((cue) => cue.at > from && cue.at <= to);
}

/* ---- idle: a figure left alone still lives ---------------------------------------------------------- */

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

export interface IdleLife {
	random(): number;
}
export function idleLife(seed: number): IdleLife {
	return { random: mulberry32(seed) };
}
/** What an idle figure does next and how long it waits first: mostly a look around (the recorded blink and glance,
 * `look`), now and then a move of the body. */
export function nextIdle(life: IdleLife): { wait: number; kind: Moment | "look" } {
	const roll = life.random();
	const wait = 7 + 13 * life.random();
	return { wait, kind: roll < 0.5 ? "look" : roll < 0.7 ? "stretch" : roll < 0.88 ? "sway" : "skip" };
}
