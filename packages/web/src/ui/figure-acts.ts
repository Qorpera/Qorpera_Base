/* How a figure acts: what its body does (hops, leans, squash and stretch), where its drawn eyes look
 * and how they look (wide, shut in a smile), which symbol it becomes when it needs the member (a "?"
 * or a "!"), the stars it juggles while it works, and which small effects go off in the air around it.
 * Pure arithmetic over time, so two views of one agent act alike and a test can read a pose at any second;
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
/** A star a working figure juggles, on the figure's 100-unit frame: where its middle is, how far it has
 * turned, and its size as a factor (0 while it is away). */
export interface Prop {
	x: number;
	y: number;
	turn: number;
	scale: number;
	/** It is on the far side of the figure, which hides it where they overlap. */
	behind?: boolean;
}
/** dust: where a jump lands. pop: the small stars as a figure becomes a symbol. sparkles, shower, twinkle:
 * the stars of a cheer (a burst, a wider and slower one, a single star). */
export type Effect = "dust" | "pop" | "sparkles" | "shower" | "twinkle";
export interface Cue {
	at: number;
	effect: Effect;
}
export interface Act {
	body: BodyPose;
	/** Drawn eyes; none leaves them to the studio's symbolic pose (the dots), or to the symbol. */
	eyes?: Eyes;
	/** The figure has become this, in its own colour: it is drawn in the figure's place, as the writing dots are. */
	symbol?: Ask;
	/** The stars a working figure juggles. */
	props?: Prop[];
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
/** Eyes that show only while the front faces us. */
const facingEyes = (eyes: Partial<EyePose>, facing: number): Eyes =>
	pair({ ...eyes, alpha: clamp((facing - 0.15) / 0.3) });

/** A figure becoming `kind`, `s` seconds in: itself until the swap, the symbol after. */
function become(kind: Ask, s: number, eyes: Partial<EyePose>): Act {
	const { body, swapped, facing } = change(s / BECOME, 23);
	return swapped ? { body, symbol: kind } : { body, eyes: facingEyes(eyes, facing) };
}
/** A symbol coming back as the figure, `s` seconds in. */
function comeBack(kind: Ask, s: number, eyes: Partial<EyePose>): Act {
	const { body, swapped, facing } = change(s / RETURN, 17);
	return swapped ? { body, eyes: facingEyes(eyes, facing) } : { body, symbol: kind };
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
	if (at < BECOME + ASK_HOLD) return { body: askingSymbol(kind, at - BECOME, pick(seed, cycle, 0, 2)), symbol: kind };
	if (at < BECOME + ASK_HOLD + RETURN) return comeBack(kind, at - BECOME - ASK_HOLD, WIDE);
	return { body: REST, eyes: lookingForYou(at - BECOME - ASK_HOLD - RETURN) };
}
/** The asking figure at rest, for a member who wants no motion: the symbol alone. */
export function askingStill(kind: Ask): Act {
	return { body: REST, symbol: kind };
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

/* ---- working: the figure juggles ---------------------------------------------------------------------
 * A working figure stays itself and keeps three small stars in the air. It bumps one up at every
 * beat, from its left shoulder and its right in turn, bouncing from side to side under them. Where
 * its eyes are changes every couple of seconds: over the top with each star, on one star all the way
 * round, up at the top of the arc, on the member, from one shoulder to the other. Every few seconds it
 * shows a trick. There are eleven, and an agent goes through all of them, in an order of its own,
 * before it shows any again: a smile, a look at the member, a twirl under the stars, a round of
 * higher throws, one star sent sky high, a header off the top of its head, a halo of them circling
 * overhead, a "ta-da" with the stars held out, and three ways of sending them round itself, in front
 * of it and behind (a level ring, a ring that tilts as it turns, and a spiral up over its head and
 * down). A figure whose work
 * also waits on the member catches its stars now and then, becomes its "?" or "!" for a moment, and
 * takes them up again. */

/** A bump every beat. Three stars: each is in the air for three beats. */
const BEAT = 0.46;
const STARS = 3;
/** A star is bumped up from the inside of one shoulder, lands on the outside of the other, and rolls in across
 * it to be bumped again: the two ways over the top are not the same path, so the stars pass and never meet. */
const SHOULDER_Y = 33;
const BUMP_X = 12;
const LAND_X = 30;
/** The top of the head, where a header goes off and where formations stand. */
const HEAD_Y = 11;
/** How high over the shoulders a star flies, and how many of its three beats it is in the air. */
const ARC = 35;
const FLIGHT = 2.3;
/** The beat, after a bump, at which that star is at the top. */
const TOP = FLIGHT / 2;
/** Each round of beats throws a little lower or higher than the last, by the agent's seed. */
const ROUND_ARC = [0.92, 1, 1.08];
/** A trick every this many beats (a round), over the beats in between: most over the middle four, the ones that
 * send the stars round the figure over six. */
const TRICK_EVERY = 8;
const TRICK_FROM = 2;
const TRICK_TO = 6;
export const TRICKS = [
	"smile",
	"check",
	"twirl",
	"high",
	"sky",
	"header",
	"halo",
	"tada",
	"orbit",
	"swirl",
	"spiral",
] as const;
export type Trick = (typeof TRICKS)[number];
/** The tricks that send the stars round the figure, in front of it and behind. */
const ROUNDS: readonly Trick[] = ["orbit", "swirl", "spiral"];
/** The tricks that take the stars out of the air and hold them in a figure of their own. */
const FORMATIONS: readonly Trick[] = ["halo", "tada", ...ROUNDS];
/** The beats of its round a trick runs over. */
const beatsOf = (kind: Trick): [number, number] => (ROUNDS.includes(kind) ? [1, 7] : [TRICK_FROM, TRICK_TO]);
/** With something waiting on the member: this many beats of juggling, then the ask for a while. */
const JUGGLE_BEATS = 16;
const JUGGLE_ASK_HOLD = 2.6;
const JUGGLE_PERIOD = JUGGLE_BEATS * BEAT + BECOME + JUGGLE_ASK_HOLD + RETURN;

const orders = new Map<string, Trick[]>();
/** The trick of a seed's `round`: none in the first (the stars are only just out), then every trick once, in a
 * shuffled order, before any comes again, and never the same one twice running. */
export function trickOf(round: number, seed: number): Trick | undefined {
	if (round < 1) return undefined;
	const block = Math.floor((round - 1) / TRICKS.length);
	const key = `${seed}:${block}`;
	let order = orders.get(key);
	if (!order) {
		const random = mulberry32((seed ^ Math.imul(block + 1, 0x9e3779b1)) >>> 0);
		order = [...TRICKS];
		for (let index = order.length - 1; index > 0; index--) {
			const other = Math.floor(random() * (index + 1));
			[order[index], order[other]] = [order[other]!, order[index]!];
		}
		// A block may not open on the trick the one before it closed on.
		const before = block > 0 ? trickOf(block * TRICKS.length, seed) : undefined;
		if (order[0] === before) [order[0], order[1]] = [order[1]!, order[0]!];
		orders.set(key, order);
	}
	return order[(round - 1) % TRICKS.length];
}
/** The trick at beat `q`: how far into its round that is, how much the trick is on (0 before and after), and the
 * seconds since it began. */
function trickAt(
	q: number,
	seed: number,
): { kind: Trick | undefined; round: number; local: number; on: number; s: number } {
	const round = Math.floor(q / TRICK_EVERY);
	const local = q - round * TRICK_EVERY;
	const kind = trickOf(round, seed);
	if (!kind) return { kind, round, local, on: 0, s: 0 };
	const [from, to] = beatsOf(kind);
	return { kind, round, local, on: pulse(local, from, from + 0.7, to - 0.7, to), s: (local - from) * BEAT };
}

/** Where a star bumped at beat `bumped` is, `since` beats later, while it is in the air. The one bumped as a
 * "sky" or a "header" trick starts goes its own way: far higher, or off the top of the head on the way over. */
function flown(bumped: number, since: number, seed: number): { x: number; y: number } {
	const way = bumped % 2 === 0 ? 1 : -1;
	const u = since / FLIGHT;
	const from = 50 - way * BUMP_X,
		to = 50 + way * LAND_X;
	const round = Math.floor(bumped / TRICK_EVERY);
	const local = bumped - round * TRICK_EVERY;
	const trick = trickOf(round, seed);
	if (trick === "header" && local === TRICK_FROM) {
		// Up to the head, off it, and down to the shoulder: two small arcs.
		if (u < 0.5) {
			const a = u / 0.5;
			return { x: from + (50 - from) * a, y: SHOULDER_Y + (HEAD_Y - SHOULDER_Y) * a - 13 * 4 * a * (1 - a) };
		}
		const b = (u - 0.5) / 0.5;
		return { x: 50 + (to - 50) * b, y: HEAD_Y + (SHOULDER_Y - HEAD_Y) * b - 12 * 4 * b * (1 - b) };
	}
	const arc =
		ARC *
		ROUND_ARC[pick(seed, round, 5, ROUND_ARC.length)]! *
		(trick === "high" && local >= TRICK_FROM && local < TRICK_TO ? 1.16 : 1) *
		(trick === "sky" && local === TRICK_FROM ? 1.8 : 1);
	return { x: from + (to - from) * u, y: SHOULDER_Y - arc * 4 * u * (1 - u) };
}

/** Where star `star` is in the juggling itself at beat `q`: in the air, or on a shoulder between two bumps. */
function juggled(star: number, q: number, seed: number): Prop {
	const bumped = star + STARS * Math.floor((q - star) / STARS);
	const since = q - bumped;
	const way = bumped % 2 === 0 ? 1 : -1;
	if (since < FLIGHT)
		return { ...flown(bumped, since, seed), turn: way * 300 * (since / FLIGHT) + bumped * 40, scale: 1 };
	// On the shoulder: it sinks in a little and rolls across to where it is bumped from.
	const w = (since - FLIGHT) / (STARS - FLIGHT);
	return {
		x: 50 + way * LAND_X - way * (LAND_X - BUMP_X) * w,
		y: SHOULDER_Y + 3 * Math.sin(Math.PI * w),
		turn: way * 300 - way * 100 * w + bumped * 40,
		scale: 1,
	};
}

/** How far round the figure star `star` is in a trick that sends the stars round it, `s` seconds in: the angle
 * on its ring (0 to the right, a quarter turn on at the front). */
const roundAngle = (kind: Trick, star: number, s: number) =>
	TAU * (s / (kind === "spiral" ? 0.8 : 0.9)) + (star * TAU) / STARS;
/** A point at `angle` on a ring round the figure: `across` wide and `deep` front to back, about (50, `middle`),
 * tipped by `tilt` radians. The front half is the lower half as we see it; the far half is behind the figure. */
function ringed(angle: number, across: number, deep: number, middle: number, tilt: number): Prop {
	const x = across * Math.cos(angle),
		y = deep * Math.sin(angle);
	return {
		x: 50 + x * Math.cos(tilt) - y * Math.sin(tilt),
		y: middle + x * Math.sin(tilt) + y * Math.cos(tilt),
		turn: (angle * 180) / Math.PI,
		scale: 0.96 + 0.2 * Math.sin(angle),
		behind: Math.sin(angle) < 0,
	};
}
/** How far up the spiral has climbed, `s` seconds in: 0 round the middle, 1 over the head. */
const climbed = (s: number) => pulse(s, 0.35, 1.25, 1.45, 2.35);

/** Where the stars stand in a formation, `s` seconds into it. */
function formation(kind: Trick, star: number, s: number): Prop {
	if (kind === "halo") {
		// Round and round over the head, larger as they come to the front.
		const angle = TAU * (s / 0.85) + (star * TAU) / STARS;
		return {
			x: 50 + 22 * Math.cos(angle),
			y: HEAD_Y - 6 + 6.5 * Math.sin(angle),
			turn: (angle * 180) / Math.PI,
			scale: 0.92 + 0.22 * Math.sin(angle),
		};
	}
	if (kind === "tada") {
		// Held out in a fan, swelling once as the figure hops.
		return {
			x: 50 + (star - 1) * 27,
			y: HEAD_Y - 5 - (star === 1 ? 12 : 0),
			turn: s * 90,
			scale: 1.15 + 0.3 * pulse(s, 0.45, 0.7, 0.75, 1.1),
		};
	}
	const angle = roundAngle(kind, star, s);
	// Round the figure's middle, level; or on a ring that tips one way and the other as it turns.
	if (kind === "orbit") return ringed(angle, 44, 10, 55, -0.1);
	if (kind === "swirl") return ringed(angle, 44, 11, 53, 0.5 * Math.sin(TAU * (s / 2.6)));
	// The spiral: round and round while the ring climbs from the middle to over the head, drawing in, and down again.
	const up = climbed(s);
	const ring = ringed(angle, 44 - 20 * up, 10 - 3 * up, 56 - 54 * up, 0);
	// Over the head there is nothing to go behind.
	return { ...ring, behind: ring.behind && up < 0.7 };
}

/** The three stars at beat `q`: each bumped up from one shoulder, over the top, down onto the other, and across
 * it to be bumped again, or held in the formation of the moment. `out` is how far the figure has them out at
 * all (0 none, 1 all in the air). */
function stars(q: number, seed: number, out: number): Prop[] {
	const trick = trickAt(q, seed);
	const held = trick.kind && FORMATIONS.includes(trick.kind) ? trick.on : 0;
	return Array.from({ length: STARS }, (_, star) => {
		// Star `star` is bumped at beats star, star + 3, star + 6…; before its first it is still away.
		if (q < star) return { x: 50, y: SHOULDER_Y, turn: 0, scale: 0 };
		let prop = juggled(star, q, seed);
		if (held > 0) {
			const to = formation(trick.kind!, star, trick.s);
			prop = {
				x: prop.x + (to.x - prop.x) * held,
				y: prop.y + (to.y - prop.y) * held,
				turn: prop.turn + (to.turn - prop.turn) * held,
				scale: prop.scale + (to.scale - prop.scale) * held,
				// It goes behind once it is on its way round, where the ring's far side is clear of the figure.
				behind: Boolean(to.behind) && held > 0.6,
			};
		}
		// It pops out at its first bump.
		return { ...prop, scale: prop.scale * out * ease(star, star + 0.6, q) };
	});
}

/** The eyes on a point of the frame. */
const lookAt = (x: number, y: number): Partial<EyePose> => ({
	x: clamp((x - 50) / 55, -0.5, 0.5),
	y: clamp((y - 42) / 78, -0.64, 0.2),
});
/** One pair of eyes on the way to another. */
const mixEyes = (from: Eyes, to: Eyes, w: number): Eyes =>
	from.map((eye, index) => {
		const other = to[index]!;
		const mixed = { ...eye };
		for (const key of Object.keys(eye) as (keyof EyePose)[]) mixed[key] = eye[key] + (other[key] - eye[key]) * w;
		return mixed;
	}) as Eyes;

/** Where a juggling figure's eyes are between tricks, a phrase of four beats at a time: over the top with each
 * star ("sweep"), on one star all the way round ("follow"), up at the top of the arc ("top"), on the member
 * ("member"), or on one shoulder and then the other ("sides"). */
export const GAZES = ["sweep", "follow", "top", "member", "sides"] as const;
export type Gaze = (typeof GAZES)[number];
const PHRASE = 4;
/** The gaze of a seed's `phrase`: drawn from its seed, and not the one before it. */
export function gazeOf(phrase: number, seed: number): Gaze {
	const drawn = (of: number) => pick(seed, of, 7, GAZES.length);
	let index = drawn(phrase);
	// Not the gaze of the phrase before (as it was drawn; it may itself have stepped on, which is rare).
	if (phrase > 0 && index === drawn(phrase - 1)) index = (index + 1) % GAZES.length;
	return GAZES[index]!;
}
/** The eyes of one gaze at beat `q`, in the phrase `phrase`. */
function gazed(kind: Gaze, q: number, phrase: number, seed: number): EyePose {
	const local = q - phrase * PHRASE;
	// A blink somewhere in the phrase, by the seed.
	const open = blink(local * BEAT, (0.8 + 0.022 * pick(seed, phrase, 10, 100)) * BEAT);
	if (kind === "sweep")
		// A star is at the top a little over a beat after its bump: the eyes go over with it and come back for the next.
		return {
			...EYE,
			x: 0.44 * Math.sin(Math.PI * (q - TOP + 0.1)),
			y: -(0.42 + 0.12 * Math.cos(TAU * (q - TOP))),
			height: 1.04 * open,
		};
	if (kind === "follow") {
		// One star, wherever it goes: up, over, down onto the shoulder and across.
		const star = juggled(pick(seed, phrase, 8, STARS), q, seed);
		return { ...EYE, ...lookAt(50 + (star.x - 50) * 1.25, star.y - 6), height: 1.05 * open };
	}
	if (kind === "top") return { ...EYE, x: 0.1 * Math.sin((Math.PI * q) / 2), y: -0.56, height: 1.06 * open };
	if (kind === "member")
		// It does not need to look: eyes on the member, a blink, and the stars keep going.
		return { ...EYE, y: 0.03, height: blink(local * BEAT, 1.9 * BEAT) };
	// One shoulder, where the stars come down, and then the other.
	const first = pick(seed, phrase, 9, 2) ? 1 : -1;
	return { ...EYE, x: first * 0.44 * (1 - 2 * ease(1.7, 2.3, local)), y: -0.1, height: open };
}
/** A juggling figure's eyes between tricks at beat `q`: the phrase's gaze, eased in from the one before. */
function gazing(q: number, seed: number): EyePose {
	const phrase = Math.floor(q / PHRASE);
	const now = gazed(gazeOf(phrase, seed), q, phrase, seed);
	const settled = ease(0, 0.8, q - phrase * PHRASE);
	if (phrase === 0 || settled >= 1) return now;
	const before = gazed(gazeOf(phrase - 1, seed), q, phrase - 1, seed);
	return mixEyes([before, before], [now, now], settled)[0];
}

/** The juggling figure at beat `q`: its bounce from side to side, its eyes, and the trick of the moment. `on` is
 * how much it is at it (it eases in and out of juggling). */
function juggling(q: number, seed: number, on: number): { body: BodyPose; eyes: Eyes } {
	const trick = trickAt(q, seed);
	const { kind, local, s } = trick;
	const held = kind && FORMATIONS.includes(kind) ? trick.on : 0;
	// On the ground at each beat, leaning to the side it bumps from; up between beats. It stands while it holds
	// the stars in a formation.
	const bounce = on * (1 - held);
	const side = -Math.cos(Math.PI * q) * bounce;
	const up = Math.abs(Math.sin(Math.PI * q)) ** 1.3 * bounce;
	let body: BodyPose = {
		x: 2.4 * side,
		y: -(3.4 + (kind === "high" ? 2.2 * trick.on : 0)) * up,
		turn: 4 * side,
		...squash(0.06 * (1 - up) * bounce),
	};
	const gaze = gazing(q, seed);
	let eyes = pair({ ...gaze, x: gaze.x * on, y: gaze.y * on, width: 1 + 0.03 * on });
	if (kind === "smile") eyes = mixEyes(eyes, pair({ ...eyes[0], smile: 1 }), trick.on);
	else if (kind === "check") {
		// A look down at the member and a blink, the stars still going.
		const down = pulse(local, TRICK_FROM, TRICK_FROM + 0.6, TRICK_TO - 1.2, TRICK_TO - 0.4);
		eyes = mixEyes(eyes, pair({ height: blink(local * BEAT, 3.6 * BEAT) }), down);
	} else if (kind === "twirl") {
		// Once round under the stars, a little off the ground.
		const turned = change((local - 3) / 2, 12);
		body = both(body, turned.body);
		eyes = mixEyes(eyes, pair({ ...eyes[0], alpha: 0 }), 1 - clamp((turned.facing - 0.15) / 0.3));
	} else if (kind === "sky" || kind === "header") {
		// All eyes on the one star that goes its own way, wide; a hop as the header goes off, or as the sky star lands.
		const thrown = trick.round * TRICK_EVERY + TRICK_FROM;
		const watched = pulse(local, TRICK_FROM + 0.1, TRICK_FROM + 0.5, TRICK_FROM + FLIGHT - 0.4, TRICK_FROM + FLIGHT);
		const star = flown(thrown, clamp(q - thrown, 0, FLIGHT), seed);
		eyes = mixEyes(eyes, pair({ ...lookAt(star.x, star.y), width: 1.07, height: 1.12 }), watched);
		const hopAt = kind === "header" ? TRICK_FROM + TOP - 0.3 : TRICK_FROM + FLIGHT - 0.15;
		body = both(body, hop((local - hopAt) / 1.1, kind === "header" ? 9 : 7));
	} else if (kind === "halo") {
		// Pleased with itself: a smile, and a rock from side to side under the ring.
		const rock = Math.sin(TAU * (s / 0.85)) * held;
		body = both(body, { x: 1.4 * rock, y: 0, turn: 3 * rock, scaleX: 1, scaleY: 1 });
		eyes = mixEyes(eyes, pair({ smile: 1 }), held);
	} else if (kind === "tada") {
		// A hop with the stars held out, looking at the member: wide eyes, then a smile.
		body = both(body, hop((s - 0.3) / 0.7, 11));
		eyes = mixEyes(eyes, pair({ width: 1.06, height: 1.12, smile: pulse(s, 0.75, 0.95, 1.45, 1.7) }), held);
	} else if (kind && ROUNDS.includes(kind)) {
		// The stars go round it. Its eyes go with one of them across the front and come back to meet it again
		// while it is behind; the body turns a little with the ring.
		const across = Math.cos(roundAngle(kind, 0, s));
		const tilt = kind === "swirl" ? 0.5 * Math.sin(TAU * (s / 2.6)) : 0;
		const up = kind === "spiral" ? climbed(s) : 0;
		body = both(body, {
			x: 1.5 * across * held,
			y: 0,
			turn: (2.2 * across + 9 * tilt) * held,
			...squash(-0.05 * up * held),
		});
		if (kind === "spiral") body = both(body, hop((s - 2.2) / 0.62, 9));
		const watching: Partial<EyePose> =
			kind === "spiral"
				? { ...lookAt(50 + 30 * across, 56 - 54 * up), width: 1.05, height: 1.04 + 0.08 * up }
				: { x: 0.46 * across, y: 0.1 + 0.16 * tilt * across, height: 1.03, smile: kind === "swirl" ? 1 : 0 };
		eyes = mixEyes(eyes, pair(watching), held);
	}
	return { body, eyes };
}

function workAt(t: number, ask: Ask | undefined): { cycle: number; at: number } {
	if (!ask) return { cycle: 0, at: Math.max(0, t) };
	const cycle = Math.floor(Math.max(0, t) / JUGGLE_PERIOD);
	return { cycle, at: Math.max(0, t) - cycle * JUGGLE_PERIOD };
}

/** A working figure `t` seconds in. `ask` is what also waits on the member, if anything does. */
export function working(t: number, seed = 0, ask?: Ask): Act {
	const { cycle, at } = workAt(t, ask);
	const q = at / BEAT;
	// It eases into its juggling, and (with something waiting) out of it before it asks.
	const on = ease(0, 1.4, q) * (ask ? 1 - ease(JUGGLE_BEATS - 1.4, JUGGLE_BEATS - 0.2, q) : 1);
	if (!ask || q < JUGGLE_BEATS) return { ...juggling(q, seed + cycle, on), props: stars(q, seed + cycle, on) };
	const s = at - JUGGLE_BEATS * BEAT;
	if (s < BECOME) return become(ask, s, WIDE);
	if (s < BECOME + JUGGLE_ASK_HOLD) return { body: askingSymbol(ask, s - BECOME, 0), symbol: ask };
	return comeBack(ask, s - BECOME - JUGGLE_ASK_HOLD, {});
}
/** The trick a working figure shows at `t` seconds, if it shows one then. */
export function workingTrick(t: number, seed = 0): Trick | undefined {
	const trick = trickAt(Math.max(0, t) / BEAT, seed);
	return trick.on > 0 ? trick.kind : undefined;
}
/** A working figure at rest, for a member who wants no motion: looking up at its three stars, held in their arc. */
export function workingStill(): Act {
	return {
		body: REST,
		eyes: pair({ y: -0.5 }),
		props: [0.22, 0.5, 0.78].map((u) => ({
			x: 50 - LAND_X + 2 * LAND_X * u,
			y: SHOULDER_Y - ARC * 4 * u * (1 - u),
			turn: u * 90,
			scale: 1,
		})),
	};
}
/** What goes off around a working figure in (`from`, `to`]: dust where a twirl lands, a star or two beside a
 * "ta-da", and stars and dust as it becomes its ask and comes back. */
export function workingCues(from: number, to: number, seed = 0, ask?: Ask): Cue[] {
	const cues: Cue[] = [];
	const period = ask ? JUGGLE_PERIOD : TRICK_EVERY * BEAT;
	for (let cycle = Math.floor(Math.max(0, from) / period); cycle * period < to; cycle++) {
		const start = cycle * period;
		const rounds = ask ? JUGGLE_BEATS / TRICK_EVERY : 1;
		for (let round = 0; round < rounds; round++) {
			// The seed and the round as `working` counts them: a cycle's own seed with an ask, the round alone without.
			const trick = trickOf(ask ? round : cycle, ask ? seed + cycle : seed);
			const at = (beats: number) => start + (round * TRICK_EVERY + beats) * BEAT;
			if (trick === "twirl") cues.push({ at: at(3 + 2 * HOP_LAND), effect: "dust" });
			else if (trick === "tada")
				cues.push(
					{ at: at(TRICK_FROM) + 0.55, effect: "twinkle" },
					{ at: at(TRICK_FROM) + 0.8, effect: "twinkle" },
				);
		}
		if (ask) {
			const asks = start + JUGGLE_BEATS * BEAT;
			cues.push(...changeCues(asks, BECOME, true), ...changeCues(asks + BECOME + JUGGLE_ASK_HOLD, RETURN, false));
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
