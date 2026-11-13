/* How a figure acts: what its body does (hops, leans, squash and stretch), where its drawn eyes look
 * and how they look (wide, shut in a smile), which symbol it becomes (a "?" or a "!" when it needs the
 * member, a star while it works), and which small effects go off in the air around it. Pure arithmetic
 * over time, so two views of one agent act alike and a test can read a pose at any second;
 * figure-motion.ts puts the result on the page. Nothing here is recorded: every eye and every symbol
 * is drawn, so it is sharp at any size.
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
export type Eyes = [EyePose, EyePose];
/** What a figure asks with: a question the member has to answer, or anything else that waits on them. */
export type Ask = "question" | "bang";
/** What a figure can become, in its own colour: the two asks, and the star of work. As the writing dots,
 * a symbol stands in the figure's place. */
export interface SymbolPose {
	kind: Ask | "star";
	/** Degrees about its middle (the star spins). */
	turn: number;
	/** About its middle (the star swells). */
	scale: number;
}
/** dust: where a jump lands. pop: the small stars as a figure becomes a symbol. bits: what a working star
 * throws off. sparkles, shower, twinkle: the stars of a cheer (a burst, a wider and slower one, a single
 * star). */
export type Effect = "dust" | "pop" | "bits" | "sparkles" | "shower" | "twinkle";
export interface Cue {
	at: number;
	effect: Effect;
}
export interface Act {
	body: BodyPose;
	/** Drawn eyes; none leaves them to the studio's symbolic pose (the dots), or to the symbol. */
	eyes?: Eyes;
	/** The figure has become this: it is drawn in the figure's place. */
	symbol?: SymbolPose;
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
/** Both eyes alike. */
const pair = (eye: Partial<EyePose>): Eyes => [
	{ ...EYE, ...eye },
	{ ...EYE, ...eye },
];
/** The figure's own eyes, as the artwork has them. */
export const openEyes = (): Eyes => pair({});

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

interface Hop {
	start: number;
	length: number;
	height: number;
}
function hops(t: number, list: readonly Hop[], give?: number): { body: BodyPose; air: number } {
	let body = REST,
		air = 0;
	for (const each of list) {
		const u = (t - each.start) / each.length;
		if (u <= 0 || u >= 1) continue;
		body = both(body, hop(u, each.height, give));
		air = Math.max(air, aloft(u));
	}
	return { body, air };
}
const landings = (list: readonly Hop[], from = 0): Cue[] =>
	list.map((each) => ({ at: from + each.start + each.length * HOP_LAND, effect: "dust" as const }));
const within = (cues: Cue[], from: number, to: number) => cues.filter((cue) => cue.at > from && cue.at <= to);

/** A small whole number from a seed and two counters: which of an agent's variations comes when. */
function pick(seed: number, a: number, b: number, of: number): number {
	let h = (seed ^ Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 1, 0x85ebca6b)) >>> 0;
	h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
	h ^= h >>> 12;
	return (h >>> 0) % of;
}

/* ---- becoming a symbol ----------------------------------------------------------------------------
 * A figure becomes a symbol the way a coin shows its other side: it jumps, turns once round in the
 * air, and where it is edge on for the second time the one is swapped for the other. It comes back the
 * same way, a little quicker. */

/** How long a figure takes to become a symbol, and to come back. */
export const BECOME = 0.92;
export const RETURN = 0.72;
/** The part of the change at which the swap happens: edge on, the second time. */
const SWAP = HOP_LAUNCH + 0.75 * (HOP_LAND - HOP_LAUNCH);

/** The jump and turn of a change, `u` from 0 to 1: the body's pose, whether the swap has happened, and how
 * far the front faces us (1 facing, 0 edge on, below 0 its back). */
function change(u: number, height: number): { body: BodyPose; swapped: boolean; facing: number } {
	const round = clamp((u - HOP_LAUNCH) / (HOP_LAND - HOP_LAUNCH));
	const facing = u > HOP_LAUNCH && u < HOP_LAND ? Math.cos(TAU * round) : 1;
	return {
		body: both(hop(u, height, 0.15), { x: 0, y: 0, turn: 0, scaleX: 0.12 + 0.88 * Math.abs(facing), scaleY: 1 }),
		swapped: u >= SWAP,
		facing,
	};
}
const symbolOf = (kind: SymbolPose["kind"], turn = 0, scale = 1): SymbolPose => ({ kind, turn, scale });
/** Eyes that show only while the front faces us. */
const facingEyes = (eyes: Partial<EyePose>, facing: number): Eyes =>
	pair({ ...eyes, alpha: clamp((facing - 0.15) / 0.3) });

/** A figure becoming `kind`, `s` seconds in: itself until the swap, the symbol after. */
function become(kind: SymbolPose["kind"], s: number, eyes: Partial<EyePose>): Act {
	const { body, swapped, facing } = change(s / BECOME, 23);
	return swapped ? { body, symbol: symbolOf(kind) } : { body, eyes: facingEyes(eyes, facing) };
}
/** A symbol coming back as the figure, `s` seconds in. */
function comeBack(kind: SymbolPose["kind"], s: number, eyes: Partial<EyePose>): Act {
	const { body, swapped, facing } = change(s / RETURN, 17);
	return swapped ? { body, eyes: facingEyes(eyes, facing) } : { body, symbol: symbolOf(kind) };
}
/** The effects of a change that starts at `at`: small stars at the swap, dust where it lands. */
const changeCues = (at: number, length: number, pop: boolean): Cue[] => [
	...(pop ? [{ at: at + SWAP * length, effect: "pop" as const }] : []),
	{ at: at + HOP_LAND * length, effect: "dust" },
];

/* ---- needs you: the figure becomes its question ----------------------------------------------------
 * It jumps, spins and comes down as a "?" (a question waits for the member) or a "!" (anything else
 * that waits on them), in its own colour. The symbol keeps asking: every couple of seconds it hops or
 * shakes. Now and then it turns back into the figure, which looks to both sides for the member with
 * wide eyes, and becomes the symbol again. */

const WIDE = { width: 1.05, height: 1.08 };
const ASK_HOLD = 6.4;
const ASK_PEEK = 1.7;
const ASK_PERIOD = BECOME + ASK_HOLD + RETURN + ASK_PEEK;
/** The symbol's own asks: the first one, and how often after it. */
const ASK_BEAT_FIRST = 1;
const ASK_BEAT_EVERY = 2.1;
const ASK_HOPS: Hop[] = [
	{ start: 0, length: 0.5, height: 11 },
	{ start: 0.44, length: 0.42, height: 6 },
];

/** A symbol that asks, `s` seconds into its hold: still, with a pair of hops or a shake every couple of seconds. */
function askingSymbol(kind: Ask, s: number, vary: number): BodyPose {
	if (s < ASK_BEAT_FIRST) return REST;
	const beat = Math.floor((s - ASK_BEAT_FIRST) / ASK_BEAT_EVERY);
	const local = s - ASK_BEAT_FIRST - beat * ASK_BEAT_EVERY;
	if ((beat + vary) % 2 === 0) return hops(local, ASK_HOPS).body;
	// A "!" shakes from side to side; a "?" rocks on its dot.
	if (kind === "bang")
		return {
			x: 3.4 * pulse(local, 0, 0.05, 0.42, 0.56) * Math.sin(TAU * (local / 0.14)),
			y: 0,
			turn: 0,
			scaleX: 1,
			scaleY: 1,
		};
	return {
		x: 0,
		y: 0,
		turn: 13 * pulse(local, 0, 0.1, 0.78, 0.98) * Math.sin(TAU * (local / 0.4)),
		scaleX: 1,
		scaleY: 1,
	};
}
/** The figure between two spells as its symbol: wide eyes, a look to both sides, a blink. */
function lookingForYou(s: number): Eyes {
	const look = -0.42 * pulse(s, 0.2, 0.34, 0.62, 0.76) + 0.42 * pulse(s, 0.76, 0.9, 1.18, 1.32);
	return pair({ ...WIDE, x: look, height: WIDE.height * blink(s, 1.42) });
}

/** A figure whose work waits on the member, `t` seconds in. `seed` sets which of the symbol's asks comes when. */
export function asking(t: number, kind: Ask, seed = 0): Act {
	const cycle = Math.floor(Math.max(0, t) / ASK_PERIOD);
	const at = Math.max(0, t) - cycle * ASK_PERIOD;
	if (at < BECOME) return become(kind, at, WIDE);
	if (at < BECOME + ASK_HOLD)
		return { body: askingSymbol(kind, at - BECOME, pick(seed, cycle, 0, 2)), symbol: symbolOf(kind) };
	if (at < BECOME + ASK_HOLD + RETURN) return comeBack(kind, at - BECOME - ASK_HOLD, WIDE);
	return { body: REST, eyes: lookingForYou(at - BECOME - ASK_HOLD - RETURN) };
}
/** The asking figure at rest, for a member who wants no motion: the symbol alone. */
export function askingStill(kind: Ask): Act {
	return { body: REST, symbol: symbolOf(kind) };
}
/** What goes off around the asking figure in (`from`, `to`]: stars as it becomes the symbol, dust where it
 * lands and where the symbol hops. */
export function askingCues(from: number, to: number, seed = 0): Cue[] {
	const cues: Cue[] = [];
	for (let cycle = Math.floor(Math.max(0, from) / ASK_PERIOD); cycle * ASK_PERIOD < to; cycle++) {
		const start = cycle * ASK_PERIOD;
		cues.push(...changeCues(start, BECOME, true), ...changeCues(start + BECOME + ASK_HOLD, RETURN, false));
		for (let beat = 0; ASK_BEAT_FIRST + beat * ASK_BEAT_EVERY + 1 < ASK_HOLD; beat++)
			if ((beat + pick(seed, cycle, 0, 2)) % 2 === 0)
				cues.push(...landings(ASK_HOPS, start + BECOME + ASK_BEAT_FIRST + beat * ASK_BEAT_EVERY));
	}
	return within(cues, from, to);
}

/* ---- working: the figure becomes a star -------------------------------------------------------------
 * A working figure jumps, spins and comes down as a four-pointed star in its own colour: the sign of
 * work being made. The star works in spells, each drawn from the agent's seed: it ticks round a quarter
 * turn at a time, whirls, swells, or hops and spins, throwing off small stars. Between spells it turns
 * back into the figure for a moment (a look at the member and a nod, a look around, or a smile) and is
 * off again. A figure whose work also waits on the member comes back as its "?" or "!" in between. */

const SPELL = 1.4;
const SPELLS = 3;
const STAR_HOLD = SPELL * SPELLS;
const WORK_PEEK = 1.5;
const WORK_PERIOD = BECOME + STAR_HOLD + RETURN + WORK_PEEK;
/** With something waiting on the member: the ask's symbol for a while, between two shorter looks. */
const WORK_ASK_HOLD = 2.6;
const WORK_ASK = BECOME + WORK_ASK_HOLD + RETURN + 0.9;
const SPELL_KINDS = ["tick", "whirl", "swell", "hop"] as const;
const TICKS = [0.08, 0.5, 0.92];
const STAR_HOP: Hop = { start: 0.12, length: 0.95, height: 15 };

/** Past 1 and back: a turn that snaps into place. */
function snap(x: number): number {
	const u = clamp(x) - 1;
	return 1 + 2.70158 * u ** 3 + 1.70158 * u ** 2;
}
/** One spell of the star, `s` seconds in: its body's pose and the star's own turn and size. Every spell turns
 * the star by quarter turns in all, so it ends as it began. */
function spell(kind: (typeof SPELL_KINDS)[number], s: number): { body: BodyPose; turn: number; scale: number } {
	if (kind === "tick") {
		let turn = 0,
			scale = 1;
		for (const at of TICKS) {
			turn += 90 * snap((s - at) / 0.3);
			scale += 0.08 * pulse(s, at, at + 0.07, at + 0.1, at + 0.3);
		}
		return { body: REST, turn, scale };
	}
	if (kind === "whirl")
		return { body: REST, turn: 720 * ease(0.06, 1.3, s), scale: 1 + 0.13 * pulse(s, 0.06, 0.5, 0.8, 1.3) };
	if (kind === "swell")
		return {
			body: REST,
			turn: 22 * pulse(s, 0, 0.2, 0.95, 1.25) * Math.sin(TAU * (s / 1.25)),
			scale: 1 + 0.2 * pulse(s, 0.05, 0.28, 0.32, 0.6) + 0.14 * pulse(s, 0.62, 0.84, 0.88, 1.16),
		};
	const u = (s - STAR_HOP.start) / STAR_HOP.length;
	return { body: hop(u, STAR_HOP.height), turn: 180 * ease(HOP_LAUNCH, HOP_LAND, u), scale: 1 };
}
/** The figure between two spells as the star. */
function workPeek(s: number, which: number): Act {
	if (which === 0) {
		// A look at the member, a blink and a nod.
		return {
			body: { x: 0, y: 0, turn: 0, ...squash(0.07 * pulse(s, 0.62, 0.7, 0.74, 0.92)) },
			eyes: pair({ height: blink(s, 0.36) * blink(s, 1.2) }),
		};
	}
	if (which === 1) {
		const look = -0.42 * pulse(s, 0.1, 0.24, 0.5, 0.64) + 0.42 * pulse(s, 0.64, 0.78, 1.04, 1.2);
		return {
			body: { x: 1.4 * look, y: 0, turn: 3 * look, scaleX: 1, scaleY: 1 },
			eyes: pair({ x: look, height: blink(s, 1.26) }),
		};
	}
	return { body: REST, eyes: pair({ smile: pulse(s, 0.08, 0.24, 1.05, 1.3) }) };
}

function workAt(t: number, ask: Ask | undefined): { cycle: number; at: number; period: number } {
	const period = WORK_PERIOD + (ask ? WORK_ASK : 0);
	const cycle = Math.floor(Math.max(0, t) / period);
	return { cycle, at: Math.max(0, t) - cycle * period, period };
}

/** A working figure `t` seconds in. `ask` is what also waits on the member, if anything does. */
export function working(t: number, seed = 0, ask?: Ask): Act {
	const { cycle, at } = workAt(t, ask);
	if (at < BECOME) return become("star", at, {});
	if (at < BECOME + STAR_HOLD) {
		const s = at - BECOME;
		const index = Math.min(SPELLS - 1, Math.floor(s / SPELL));
		const now = spell(SPELL_KINDS[pick(seed, cycle, index, SPELL_KINDS.length)]!, s - index * SPELL);
		return { body: now.body, symbol: symbolOf("star", now.turn, now.scale) };
	}
	if (at < BECOME + STAR_HOLD + RETURN) return comeBack("star", at - BECOME - STAR_HOLD, {});
	if (at < WORK_PERIOD) return workPeek(at - BECOME - STAR_HOLD - RETURN, pick(seed, cycle, 9, 3));
	if (!ask) return { body: REST, eyes: openEyes() };
	// Something waits on the member too: the figure comes back as its ask before it works on.
	const s = at - WORK_PERIOD;
	if (s < BECOME) return become(ask, s, WIDE);
	if (s < BECOME + WORK_ASK_HOLD) return { body: askingSymbol(ask, s - BECOME, 0), symbol: symbolOf(ask) };
	if (s < BECOME + WORK_ASK_HOLD + RETURN) return comeBack(ask, s - BECOME - WORK_ASK_HOLD, WIDE);
	return {
		body: REST,
		eyes: pair({ ...WIDE, height: WIDE.height * blink(s, BECOME + WORK_ASK_HOLD + RETURN + 0.3) }),
	};
}
/** A working figure at rest, for a member who wants no motion: the star alone. */
export function workingStill(): Act {
	return { body: REST, symbol: symbolOf("star") };
}
/** What goes off around a working figure in (`from`, `to`]: stars and dust as it changes, and what the star
 * throws off in its spells. */
export function workingCues(from: number, to: number, seed = 0, ask?: Ask): Cue[] {
	const cues: Cue[] = [];
	const { period } = workAt(0, ask);
	for (let cycle = Math.floor(Math.max(0, from) / period); cycle * period < to; cycle++) {
		const start = cycle * period;
		cues.push(...changeCues(start, BECOME, true), ...changeCues(start + BECOME + STAR_HOLD, RETURN, false));
		for (let index = 0; index < SPELLS; index++) {
			const at = start + BECOME + index * SPELL;
			const kind = SPELL_KINDS[pick(seed, cycle, index, SPELL_KINDS.length)]!;
			if (kind === "tick") for (const tick of TICKS) cues.push({ at: at + tick + 0.12, effect: "bits" });
			else if (kind === "whirl") cues.push({ at: at + 0.45, effect: "bits" }, { at: at + 0.8, effect: "bits" });
			else if (kind === "swell") cues.push({ at: at + 0.3, effect: "bits" });
			else cues.push(...landings([STAR_HOP], at));
		}
		if (ask) {
			const asks = start + WORK_PERIOD;
			cues.push(...changeCues(asks, BECOME, true), ...changeCues(asks + BECOME + WORK_ASK_HOLD, RETURN, false));
			cues.push(...landings(ASK_HOPS, asks + BECOME + ASK_BEAT_FIRST));
		}
	}
	return within(cues, from, to);
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

/* ---- idle: the opening, and a figure left alone still lives ----------------------------------------- */

/** How long an idle figure's opening plays. */
export const IDLE_OPENING = 2.2;
/** An idle figure's eyes `t` seconds in: a blink that opens into a glance up, a settle, and one more blink. */
export function idleOpening(t: number): Eyes {
	const up = pulse(t, 0.45, 0.66, 1.12, 1.4);
	const open = 0.08 + 0.92 * ease(0.08, 0.26, t) + 0.1 * pulse(t, 0.2, 0.3, 0.34, 0.5);
	return pair({ x: 0.1 * up, y: -0.36 * up, height: open * blink(t, 1.8) });
}

/* ---- moments: short acts over whatever the figure is doing ----------------------------------------- */

/** cheer: work done, the long one; hooray: the short one. perk: the pointer came over it. The rest are an idle
 * figure's own: the eyes' (blink, blinks, left, right, up, smile) and the body's (stretch, sway, skip). */
export type Moment =
	| "cheer"
	| "hooray"
	| "perk"
	| "stretch"
	| "sway"
	| "skip"
	| "blink"
	| "blinks"
	| "left"
	| "right"
	| "up"
	| "smile";
export const MOMENT_LENGTH: Record<Moment, number> = {
	cheer: 3.6,
	hooray: 1.5,
	perk: 0.44,
	stretch: 1,
	sway: 1.3,
	skip: 0.56,
	blink: 0.26,
	blinks: 0.62,
	left: 1.25,
	right: 1.25,
	up: 1.35,
	smile: 1.3,
};

const HOORAY: Hop[] = [
	{ start: 0.04, length: 0.64, height: 19 },
	{ start: 0.64, length: 0.46, height: 9 },
];
/** The long cheer's jumps: two, then the twirl. */
const CHEER: Hop[] = [
	{ start: 0.04, length: 0.66, height: 19 },
	{ start: 0.68, length: 0.48, height: 10 },
];
const TWIRL: Hop = { start: 1.24, length: 0.86, height: 25 };

/** A moment `t` seconds in. A moment that brings no eyes leaves the figure's own. */
export function moment(kind: Moment, t: number): Act {
	if (kind === "cheer") {
		// Work done, with time to enjoy it: two jumps, a twirl in the air (thin as a coin, once round), a happy
		// rock from side to side, and stars the whole way. The eyes are shut in a smile until it is over.
		const { body } = hops(t, CHEER);
		const u = (t - TWIRL.start) / TWIRL.length;
		// Once round: edge on, its back, edge on, and facing again as it comes down.
		const round = clamp((u - HOP_LAUNCH) / (HOP_LAND - HOP_LAUNCH));
		const facing = u > HOP_LAUNCH && u < HOP_LAND ? Math.cos(TAU * round) : 1;
		const rock = pulse(t, 2.14, 2.34, 2.96, 3.2) * Math.sin(TAU * ((t - 2.14) / 0.5));
		const twirl = both(hop(u, TWIRL.height, 0.15), {
			x: 2.2 * rock,
			y: 0,
			turn: 6 * rock,
			scaleX: 0.16 + 0.84 * Math.abs(facing),
			scaleY: 1,
		});
		return {
			body: both(body, twirl),
			// Its back has no eyes.
			eyes: pair({
				smile: pulse(t, 0.06, 0.2, 3.1, 3.34),
				alpha: clamp((facing - 0.15) / 0.3),
				height: blink(t, 3.4),
			}),
		};
	}
	if (kind === "hooray") return { body: hops(t, HOORAY).body, eyes: pair({ smile: pulse(t, 0.06, 0.2, 1.08, 1.34) }) };
	if (kind === "perk") return { body: hop(t / MOMENT_LENGTH.perk, 7, 0.1) };
	if (kind === "skip") return { body: hop(t / MOMENT_LENGTH.skip, 8, 0.11) };
	if (kind === "stretch") {
		// Up on its toes and down again.
		const up = pulse(t, 0, 0.34, 0.5, 0.78);
		const settle = 0.03 * Math.exp(-6 * Math.max(0, t - 0.78)) * Math.sin(TAU * 3 * Math.max(0, t - 0.78));
		return { body: { x: 0, y: 0, turn: 0, ...squash(-0.075 * up + settle) } };
	}
	if (kind === "sway") {
		// A slow rock from side to side.
		const amount = pulse(t, 0, 0.3, 0.95, 1.3);
		const swing = amount * Math.sin(TAU * (t / 0.65));
		return { body: { x: 1.6 * swing, y: 0, turn: 4.5 * swing, scaleX: 1, scaleY: 1 } };
	}
	if (kind === "blink") return { body: REST, eyes: pair({ height: blink(t, 0.02) }) };
	if (kind === "blinks") return { body: REST, eyes: pair({ height: blink(t, 0.02) * blink(t, 0.36) }) };
	if (kind === "smile") return { body: REST, eyes: pair({ smile: pulse(t, 0, 0.16, 1.02, 1.3) }) };
	if (kind === "up") {
		const away = pulse(t, 0, 0.2, 0.95, 1.2);
		return { body: REST, eyes: pair({ x: 0.08 * away, y: -0.4 * away, height: blink(t, 1.12) }) };
	}
	// A look to one side, the body leaning a little after it, and a blink on the way back.
	const side = kind === "left" ? -1 : 1;
	const away = pulse(t, 0, 0.16, 0.86, 1.06);
	const follow = pulse(t, 0.08, 0.34, 0.9, 1.2);
	return {
		body: { x: 1.4 * side * follow, y: 0, turn: 3 * side * follow, scaleX: 1, scaleY: 1 },
		eyes: pair({ x: 0.42 * side * away, height: blink(t, 0.98) }),
	};
}

export function momentCues(kind: Moment, from: number, to: number): Cue[] {
	const cues: Cue[] =
		kind === "cheer"
			? [
					{ at: 0.3, effect: "sparkles" },
					...landings(CHEER.slice(0, 1)),
					{ at: TWIRL.start + TWIRL.length * 0.42, effect: "shower" },
					...landings([TWIRL]),
					{ at: 2.3, effect: "twinkle" },
					{ at: 2.62, effect: "twinkle" },
					{ at: 2.94, effect: "twinkle" },
				]
			: kind === "hooray"
				? [{ at: 0.3, effect: "sparkles" }, ...landings(HOORAY.slice(0, 1))]
				: [];
	return within(cues, from, to);
}

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
const IDLE_MOVES: readonly [Moment, number][] = [
	["blink", 0.26],
	["blinks", 0.1],
	["left", 0.11],
	["right", 0.11],
	["up", 0.08],
	["smile", 0.07],
	["stretch", 0.1],
	["sway", 0.09],
	["skip", 0.08],
];
/** What an idle figure does next and how long it waits first: mostly its eyes (a blink, a look around, a
 * smile), now and then a move of the body. */
export function nextIdle(life: IdleLife): { wait: number; kind: Moment } {
	let roll = life.random();
	const wait = 4 + 9 * life.random();
	for (const [kind, share] of IDLE_MOVES) {
		roll -= share;
		if (roll < 0) return { wait, kind };
	}
	return { wait, kind: "blink" };
}
