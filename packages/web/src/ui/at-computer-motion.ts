/* "At its computer" (20260930742000; Jonas, 13 Nov 2026: "an animation the avatar could do in the sidepanel to
 * indicate it. like it's gaming"): the agent's figure while it uses its desktop computer. Lit from below
 * and in front by a screen whose light steps softly through a few tints of the agent's own colour; the eyes dart in
 * quick short moves with a rare blink, as when one plays or reads fast; now and then a small lean toward the screen.
 *
 * Everything is a function of the clock and a seed, so every view of one agent agrees, and the figure is repainted only
 * when something visible changed: during a hold (most of the time) the frame key stays the same and nothing is drawn. */

export interface AtComputerFace {
	x: number;
	y: number;
	width: number;
	height: number;
	rotation: number;
	alpha: number;
}

export interface AtComputerFrame {
	/** Changes only when something visible changes: the painter skips the frame otherwise. */
	key: string;
	face: [AtComputerFace, AtComputerFace];
	/** 0..1: how far the figure leans toward the screen. */
	lean: number;
	/** The light's tint: from tint `from` to tint `to` by `mix` (indices into atComputerTints). */
	from: number;
	to: number;
	mix: number;
	/** 0..1: the light's strength now (a soft flicker). */
	strength: number;
}

/** One loop of the schedule, then it repeats (long enough that nobody sees the seam). */
const LOOP_S = 40;
/** Steps are drawn at this rate while something moves; nothing is drawn while all holds. */
const STEP_HZ = 30;
/** Where the eyes rest: a little down, toward a screen below the face. */
const LOOK_Y = 0.2;

interface Gaze {
	at: number;
	x: number;
	y: number;
	/** How long the move into this gaze takes. */
	move: number;
}
interface Pulse {
	at: number;
	length: number;
}
interface Light {
	at: number;
	tint: number;
	strength: number;
}
interface Schedule {
	gazes: Gaze[];
	blinks: Pulse[];
	leans: Pulse[];
	lights: Light[];
}

function random(seed: number): () => number {
	let a = seed >>> 0 || 1;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const schedules = new Map<number, Schedule>();

function scheduleFor(seed: number): Schedule {
	let schedule = schedules.get(seed);
	if (schedule) return schedule;
	const rnd = random(seed);
	const between = (a: number, b: number) => a + (b - a) * rnd();
	const gazes: Gaze[] = [];
	let t = 0;
	let x = between(-0.1, 0.1);
	gazes.push({ at: 0, x, y: LOOK_Y, move: 0 });
	while (t < LOOP_S) {
		if (rnd() < 0.72) {
			// A line read fast: three to five short hops rightward, then one quick sweep back.
			x = between(-0.75, -0.5);
			t += between(0.22, 0.45);
			gazes.push({ at: t, x, y: LOOK_Y + between(-0.03, 0.04), move: 0.09 });
			const hops = 3 + Math.floor(rnd() * 3);
			for (let i = 0; i < hops && t < LOOP_S; i++) {
				x = Math.min(0.75, x + between(0.25, 0.4));
				t += between(0.16, 0.36);
				gazes.push({ at: t, x, y: LOOK_Y + between(-0.025, 0.025), move: 0.06 });
			}
		} else {
			// A dart to something on the screen, held a little longer.
			x = between(-0.7, 0.7);
			t += between(0.3, 0.6);
			gazes.push({ at: t, x, y: LOOK_Y + between(-0.06, 0.07), move: 0.07 });
			t += between(0.6, 1.2);
		}
	}
	// Back where the loop began, so the seam has no jump.
	gazes.push({ at: LOOP_S, x: gazes[0]!.x, y: gazes[0]!.y, move: 0.09 });
	const blinks: Pulse[] = [];
	for (let at = between(1.5, 3); at < LOOP_S - 1; at += between(4.5, 8.5)) blinks.push({ at, length: 0.15 });
	const leans: Pulse[] = [];
	for (let at = between(3, 6); at < LOOP_S - 3; at += between(8, 13)) leans.push({ at, length: between(1.6, 2.4) });
	const lights: Light[] = [];
	let tint = 0;
	for (let at = 0; at < LOOP_S; at += between(0.18, 0.7)) {
		tint = (tint + 1 + Math.floor(rnd() * (atComputerTints.length - 1))) % atComputerTints.length;
		lights.push({ at, tint, strength: between(0.5, 1) });
	}
	schedule = { gazes, blinks, leans, lights };
	schedules.set(seed, schedule);
	return schedule;
}

/** How much of the agent's colour each tint keeps (the rest is white): the screen's light is the agent's own. */
export const atComputerTints = [0.8, 0.45, 1, 0.6] as const;

const ease = (u: number) => 1 - (1 - u) ** 3;
const smooth = (u: number) => u * u * (3 - 2 * u);
const clamp = (u: number) => Math.min(1, Math.max(0, u));

/** The seed of an identity (an agent id), so two figures of one company do not move in step. */
export function atComputerSeed(identity: string): number {
	let seed = 2166136261;
	for (const character of identity) seed = Math.imul(seed ^ character.charCodeAt(0), 16777619) >>> 0;
	return seed;
}

export function atComputerFrame(seconds: number, seed: number, reduced: boolean): AtComputerFrame {
	if (reduced) {
		const face = { x: 0, y: LOOK_Y, width: 1, height: 1, rotation: 0, alpha: 1 };
		return { key: "ac:still", face: [face, { ...face }], lean: 0, from: 0, to: 0, mix: 0, strength: 1 };
	}
	const { gazes, blinks, leans, lights } = scheduleFor(seed);
	// Stepped time: a move is drawn at STEP_HZ, and a hold not at all.
	const t = (((Math.floor(seconds * STEP_HZ) / STEP_HZ) % LOOP_S) + LOOP_S) % LOOP_S;
	let index = 0;
	while (index + 1 < gazes.length && gazes[index + 1]!.at <= t) index++;
	const now = gazes[index]!,
		before = gazes[Math.max(0, index - 1)]!;
	const u = now.move > 0 ? ease(clamp((t - now.at) / now.move)) : 1;
	const gx = before.x + (now.x - before.x) * u,
		gy = before.y + (now.y - before.y) * u;
	let open = 1;
	for (const blink of blinks) {
		const v = (t - blink.at) / blink.length;
		if (v >= 0 && v <= 1) open = 1 - 0.88 * Math.sin(Math.PI * v);
	}
	let lean = 0;
	for (const pulse of leans) {
		const v = (t - pulse.at) / pulse.length;
		if (v >= 0 && v <= 1) lean = smooth(clamp(v / 0.3)) * (1 - smooth(clamp((v - 0.7) / 0.3)));
	}
	let light = 0;
	while (light + 1 < lights.length && lights[light + 1]!.at <= t) light++;
	const shown = lights[light]!,
		previous = lights[(light + lights.length - 1) % lights.length]!;
	// A quick change of tint, 0.08 s, as a screen's picture changes.
	const mix = smooth(clamp((t - shown.at) / 0.08));
	const strength = previous.strength + (shown.strength - previous.strength) * mix;
	const face = { x: gx, y: gy, width: 1, height: open, rotation: 0, alpha: 1 };
	const r2 = (value: number) => Math.round(value * 100);
	return {
		key: `ac:${r2(gx)}:${r2(gy)}:${r2(open)}:${r2(lean)}:${previous.tint}>${shown.tint}:${r2(mix)}:${r2(strength)}`,
		face: [face, { ...face }],
		lean,
		from: previous.tint,
		to: shown.tint,
		mix,
		strength,
	};
}

/** A `#rrggbb` colour's channels (a grey for anything else). */
export function hexChannels(hex: string): [number, number, number] {
	const value = /^#[\da-f]{6}$/i.test(hex) ? Number.parseInt(hex.slice(1, 7), 16) : 0x777777;
	return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** The light's colour now: the agent's colour mixed toward white by the two tints. */
export function atComputerLight(color: string, frame: AtComputerFrame): [number, number, number] {
	const base = /^#[\da-f]{6}$/i.test(color) ? hexChannels(color) : ([255, 255, 255] as [number, number, number]);
	const keep = atComputerTints[frame.from]! + (atComputerTints[frame.to]! - atComputerTints[frame.from]!) * frame.mix;
	return base.map((c) => Math.round(255 + (c - 255) * keep)) as [number, number, number];
}
