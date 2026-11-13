/* How a figure acts: what its body does (hops, leans, squash and stretch), where its drawn eyes look
 * and how they look (wide, narrowed, shut in a smile), what the mark beside an asking figure does, and
 * which small effects go off in the air around it. Pure arithmetic over time, so two views of one
 * agent act alike and a test can read a pose at any second; figure-motion.ts puts the result on the
 * page. Nothing here is recorded: every eye is drawn, so it is sharp at any size.
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
/** The mark beside a figure that needs the member. */
export interface MarkPose {
	/** 0 hidden to 1 up, past 1 while it springs up. */
	show: number;
	/** Degrees about its foot. */
	wave: number;
}
/** dust: where a jump lands. sparkles, shower, twinkle: the stars of a cheer (a burst, a wider and slower
 * one, a single star). bits: what flies off a working figure. idea: one star over its head. rays: off the
 * mark of a figure that asks. */
export type Effect = "dust" | "sparkles" | "shower" | "twinkle" | "bits" | "idea" | "rays";
export interface Cue {
	at: number;
	effect: Effect;
}
export interface Act {
	body: BodyPose;
	/** Drawn eyes; none leaves them to the studio's symbolic pose (the dots, the "!"). */
	eyes?: Eyes;
	mark?: MarkPose;
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

/* ---- needs you: the figure asks for the member ---------------------------------------------------
 * It jumps as its mark pops up, and then keeps asking: every few seconds a pair of hops, a wiggle or
 * a lean towards the glass with a look to both sides, its eyes wide the whole time. */

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

function ask(t: number, seed: number): { kind: (typeof ASK_KINDS)[number]; since: number } | undefined {
	if (t < ASK_FIRST) return undefined;
	const n = Math.floor((t - ASK_FIRST) / ASK_EVERY);
	return { kind: ASK_KINDS[(n + seed) % ASK_KINDS.length]!, since: t - ASK_FIRST - n * ASK_EVERY };
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
			// A look up at its own mark while it shakes.
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
	return {
		body,
		// In the air the eyes go up with it and open wider.
		eyes: pair({ x: look, y: up - 0.16 * air, width: 1.05, height: open * (1 + 0.07 * air) }),
		mark: {
			// Springs up a beat after the jump starts, then sways while it waits.
			show: t < 0.1 ? 0 : 1 - Math.exp(-9 * (t - 0.1)) * Math.cos(15 * (t - 0.1)),
			wave: waving + 4 * Math.sin(TAU * 0.4 * t) * ease(1.6, 2.4, t),
		},
	};
}

/** The asking figure at rest, for a member who wants no motion: wide eyes, the mark up. */
export function callingStill(): Act {
	return { body: REST, eyes: pair({ width: 1.05, height: 1.08 }), mark: { show: 1, wave: 0 } };
}

/** The mark beside a figure that is busy with something else, `t` seconds after it came up: up with a
 * spring, a slow sway, and a shake every few seconds. */
export function waitingMark(t: number): MarkPose {
	const since = t % 6.5;
	return {
		show: t < 0.05 ? 0 : 1 - Math.exp(-9 * (t - 0.05)) * Math.cos(15 * (t - 0.05)),
		wave: 4 * Math.sin(TAU * 0.4 * t) + 17 * pulse(since, 0.3, 0.45, 1.3, 1.6) * Math.sin(TAU * 3.1 * (since - 0.3)),
	};
}

/** What goes off around the asking figure in (`from`, `to`]: dust where it lands, rays off the mark as it
 * starts to shake. */
export function callingCues(from: number, to: number, seed = 0): Cue[] {
	const cues: Cue[] = [...landings(ENTRANCE), { at: 0.36, effect: "rays" }];
	const first = Math.max(0, Math.floor((from - ASK_FIRST) / ASK_EVERY));
	const last = Math.floor((to - ASK_FIRST) / ASK_EVERY);
	for (let n = first; n <= last; n++) {
		const at = ASK_FIRST + n * ASK_EVERY;
		cues.push({ at: at + 0.06, effect: "rays" });
		if (ASK_KINDS[(n + seed) % ASK_KINDS.length] === "hops") cues.push(...landings(ASK_HOPS, at));
	}
	return within(cues, from, to);
}

/* ---- working: our own, drawn ---------------------------------------------------------------------
 * A working figure keeps its eyes on its work, a little down and narrowed, and works in bars: it taps
 * along a line (the eyes step across it, the body taps at each step, a bit flies off), it gets into
 * the zone (eyes set, a fast run of taps), it stops to think (a look up and away, then the idea: eyes
 * wide, a hop, a star over its head), or it checks in with a look at the member. Each agent draws its
 * own order from its seed; every bar starts and ends on the same pose, so any order joins. */

type BarKind = "type" | "zone" | "think" | "check";
const BAR_LENGTH: Record<BarKind, number> = { type: 1.9, zone: 2.2, think: 2.7, check: 1.5 };
/** The eyes on the work. */
const AT_WORK = { y: 0.12, height: 0.86 };
const TAPS = [0.2, 0.5, 0.8, 1.1];
const TAP: Omit<Hop, "start"> = { length: 0.28, height: 4.6 };
const ZONE_TAPS = [0.34, 0.5, 0.66, 0.82, 0.98, 1.14, 1.3, 1.46];
const ZONE_TAP: Omit<Hop, "start"> = { length: 0.16, height: 2.8 };
const IDEA_AT = 1.45;

interface Bar {
	kind: BarKind;
	start: number;
}
const programs = new Map<number, { bars: Bar[]; length: number }>();
/** An agent's bars: a long loop drawn once from its seed. It opens tapping, and never thinks, checks in or
 * gets into the zone twice running. */
function program(seed: number): { bars: Bar[]; length: number } {
	let made = programs.get(seed);
	if (!made) {
		const random = mulberry32(seed);
		const bars: Bar[] = [];
		let length = 0,
			last: BarKind = "check";
		for (let index = 0; index < 28; index++) {
			const roll = random();
			let kind: BarKind = roll < 0.5 ? "type" : roll < 0.7 ? "zone" : roll < 0.9 ? "think" : "check";
			if (index === 0 || (kind === last && kind !== "type")) kind = "type";
			bars.push({ kind, start: length });
			length += BAR_LENGTH[kind];
			last = kind;
		}
		made = { bars, length };
		programs.set(seed, made);
	}
	return made;
}
function barAt(t: number, seed: number): { kind: BarKind; since: number; start: number } {
	const { bars, length } = program(seed);
	const loop = Math.floor(Math.max(0, t) / length);
	const at = Math.max(0, t) - loop * length;
	let bar = bars[0]!;
	for (const each of bars) if (each.start <= at) bar = each;
	return { kind: bar.kind, since: at - bar.start, start: loop * length + bar.start };
}

function bar(kind: BarKind, s: number): { body: BodyPose; eyes: Eyes } {
	if (kind === "type") {
		// The eyes step along the line, a tap at each step, then sweep back with a blink.
		let x = -0.42 * ease(0, 0.14, s);
		TAPS.forEach((tap, index) => {
			if (index) x += 0.28 * ease(tap - 0.08, tap, s);
		});
		x *= 1 - ease(1.38, 1.6, s);
		const { body } = hops(
			s,
			TAPS.map((start) => ({ start, ...TAP })),
			0.08,
		);
		return { body, eyes: pair({ x, y: AT_WORK.y, height: AT_WORK.height * blink(s, 1.42) }) };
	}
	if (kind === "zone") {
		// Eyes set (narrow, tipped in at the top), leaning in, a fast run of taps; then it lets go.
		const set = pulse(s, 0, 0.22, 1.62, 1.86);
		const { body } = hops(
			s,
			ZONE_TAPS.map((start) => ({ start, ...ZONE_TAP })),
			0.06,
		);
		const eye = { y: AT_WORK.y + 0.04 * set, height: (AT_WORK.height - 0.34 * set) * blink(s, 1.9) };
		const out = pulse(s, 1.86, 1.98, 2.02, 2.2);
		return {
			body: both(body, {
				x: 0,
				y: 0,
				turn: 0,
				scaleX: (1 + 0.04 * set) * (1 - 0.03 * out),
				scaleY: (1 + 0.04 * set) * (1 + 0.05 * out),
			}),
			eyes: [
				{ ...EYE, ...eye, rotation: 13 * set },
				{ ...EYE, ...eye, rotation: -13 * set },
			],
		};
	}
	if (kind === "think") {
		// A look up and away, one eye narrowed, the body tipped; then the idea: eyes wide, a hop.
		const away = pulse(s, 0, 0.3, 1.2, IDEA_AT);
		const idea = pulse(s, IDEA_AT, IDEA_AT + 0.1, 2.15, 2.45);
		const jump = hop((s - IDEA_AT) / 0.62, 13);
		const eye = {
			x: -0.34 * away,
			y: AT_WORK.y * (1 - away) * (1 - idea) - 0.5 * away - 0.1 * idea,
			height: (AT_WORK.height + (1.2 - AT_WORK.height) * idea) * blink(s, 2.5),
			width: 1 + 0.06 * idea,
		};
		return {
			body: both(jump, { x: -1.6 * away, y: 0, turn: -5 * away, scaleX: 1, scaleY: 1 }),
			eyes: [
				{ ...EYE, ...eye, height: eye.height * (1 - 0.28 * away) },
				{ ...EYE, ...eye },
			],
		};
	}
	// A look at the member, a blink and a nod.
	const up = pulse(s, 0, 0.2, 1.1, 1.36);
	return {
		body: { x: 0, y: 0, turn: 0, ...squash(0.07 * pulse(s, 0.72, 0.8, 0.84, 1)) },
		eyes: pair({ y: AT_WORK.y * (1 - up), height: (AT_WORK.height + (1 - AT_WORK.height) * up) * blink(s, 0.46) }),
	};
}

/** A working figure `t` seconds in. */
export function working(t: number, seed = 0): Act {
	const now = barAt(t, seed);
	return bar(now.kind, now.since);
}
/** A working figure at rest, for a member who wants no motion: its eyes on its work. */
export function workingStill(): Act {
	return { body: REST, eyes: pair(AT_WORK) };
}
/** What goes off around a working figure in (`from`, `to`]: a bit at each tap, every other one in the zone,
 * and a star as the idea comes. */
export function workingCues(from: number, to: number, seed = 0): Cue[] {
	const cues: Cue[] = [];
	// Every bar that (`from`, `to`] touches, from the one `from` is in.
	let at = Math.max(0, from);
	for (let bars = 0; bars < 1000; bars++) {
		const now = barAt(at, seed);
		const taps =
			now.kind === "type" ? TAPS : now.kind === "zone" ? ZONE_TAPS.filter((_, index) => index % 2 === 0) : [];
		for (const tap of taps) cues.push({ at: now.start + tap + 0.06, effect: "bits" });
		if (now.kind === "think") cues.push({ at: now.start + IDEA_AT + 0.16, effect: "idea" });
		const next = now.start + BAR_LENGTH[now.kind];
		if (next >= to) break;
		at = next + 1e-6;
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
