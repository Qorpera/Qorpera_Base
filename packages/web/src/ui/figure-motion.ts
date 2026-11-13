import type { Activity, MotionPose } from "../../public/assets/avatars/status-2d-v1/motion.mjs";
import type { EyeGeometry } from "../../public/assets/avatars/status-2d-v1/recorded-motion.mjs";
import {
	type Act,
	both,
	calling,
	callingCues,
	callingStill,
	type Effect,
	type EyePose,
	HOP_LAND,
	HOP_LAUNCH,
	hoppingDots,
	type IdleLife,
	idleLife,
	lean,
	MOMENT_LENGTH,
	type Moment,
	moment,
	momentCues,
	nextIdle,
	REST,
	raisedHand,
	whirl,
} from "./figure-acts.ts";
import { alignRegion, boxCanvas, bucketOf, level, type Region } from "./figure-levels.ts";
import type * as MotionData from "./figure-motion-data.ts";
import type { WorkingSchedule, WorkingStep } from "./working-sequence.ts";

export type { Activity, Moment };

export interface FigureArtwork {
	faces: Record<string, EyeGeometry[]>;
	/** Resolves once the plate can be drawn (its light field runs in a worker where it can). */
	prepare(id: string, image: HTMLImageElement): Promise<void> | void;
	drawable(id: string, color: string): CanvasImageSource;
	/** The approved shade of `color` on a dark surface. */
	colorOnDark(id: string, color: string): string;
}
export interface MotionOptions {
	activity?: Activity;
	still?: boolean;
	/** A local identity keeps the opening blink from restarting on view refresh. */
	identity?: string;
	/** The raised hand beside the figure (the rail's, styles/app.css `.rail-hand`): the figure brings it up,
	 * waves it, and takes it along when it jumps. */
	hand?: HTMLElement;
	/** Left alone, the figure still blinks, looks around and moves now and then (the rail's figures). */
	alive?: boolean;
}
export interface FigureMotion {
	dispose(): void;
	/** A short act over whatever the figure is doing: a cheer when its work is done, a perk under the pointer. */
	play(kind: Moment): void;
}

/** The recorded motion, once its chunk has arrived. A figure is `ready` only
 * after it has, so everything that paints can rely on it. */
let motion: typeof MotionData | undefined;
let motionLoading: Promise<typeof MotionData> | undefined;
let motionFailed = false;

/** Fetch the recorded motion (its own chunk, about 950 KB before compression)
 * once, on the first figure. A browser keeps a module it failed to load for
 * the page's life without fetching it again, so a failed load stays failed
 * here too: every figure keeps its still artwork until the page is reloaded. */
export function loadFigureMotion(): Promise<typeof MotionData> {
	motionLoading ??= import("./figure-motion-data.ts").then(
		(loaded) => {
			motion = loaded;
			return loaded;
		},
		(error: unknown) => {
			motionFailed = true;
			throw error;
		},
	);
	return motionLoading;
}

const prepared = new Map<string, Promise<void>>();
const surfaces = new Map<string, { body: HTMLCanvasElement; source: CanvasImageSource }>();
/** One clock per agent and activity, shared by every view of that agent. A
 * Working clock also carries the agent's own order of recorded pieces. */
interface Clock {
	elapsed: number;
	users: number;
	schedule?: WorkingSchedule;
	/** Which of its acts come when (figure-acts.ts): one agent's views agree, two agents differ. */
	seed: number;
	/** An idle figure's life: what it does now, and what it does next and when (on performance.now()'s clock). */
	life?: IdleLife;
	idle?: { kind: Moment | "look"; t: number };
	next?: { at: number; kind: Moment | "look" };
}
const clocks = new Map<string, Clock>();
/** When each agent's hand went up (performance.now()), kept while a view shows it: a rebuilt row's hand is
 * already up. */
const raised = new Map<string, { at: number; users: number }>();
const live = new Set<LiveMotion>();
let frame = 0;
let last = 0;
/** The timer for the next idle figure's move, while nothing else moves. */
let wake = 0;
let media: MediaQueryList | undefined;
let visibility: IntersectionObserver | undefined;
let sizes: ResizeObserver | undefined;
let lifetime: AbortController | undefined;

interface LiveMotion {
	host: HTMLElement;
	canvas: HTMLCanvasElement;
	fallback: HTMLImageElement;
	artwork: FigureArtwork;
	id: string;
	color: string;
	/** The colour on screen: `color`, or its dark-surface shade on the dark theme. */
	shown: string;
	activity: Activity;
	still: boolean;
	clock: Clock;
	visible: boolean;
	ready: boolean;
	painted: string;
	side: number;
	/** This figure's eye boxes by level (figure-levels boxCanvas). */
	boxes: Map<number, HTMLCanvasElement>;
	hand?: HTMLElement;
	handKey: string;
	alive: boolean;
	/** A one-play act, `t` seconds in; `cued` is how far its effects have gone off. */
	moment?: { kind: Moment; t: number; cued: number };
	/** How far the activity's own effects have gone off, in its clock's seconds. */
	cued: number;
	/** Where a turn stood at the last frame (-1 outside one), for the effects it sets off on the way. */
	turned: number;
	/** The lean of the body's look, eased, and when it was last eased. */
	leaning: number;
	leanedAt: number;
	/** Where the hand trails the body, in frame units. */
	trail: { x: number; y: number };
	/** The transforms on the page, so an unchanged pose writes nothing. */
	posed: string;
	handPosed: string;
	/** Where the effects go (made with the first one). */
	effects?: HTMLElement;
}

/* On the dark theme a figure takes its dark-surface shade from the approved
 * visual system: charcoal, the palette's ink and the company logos' ink,
 * turns light as text does. Only the painting changes, never the stored
 * colour. */
function shownColor(entry: LiveMotion): string {
	return document.documentElement.dataset.theme === "dark"
		? entry.artwork.colorOnDark(entry.id, entry.color)
		: entry.color;
}

function base(): URL {
	return new URL("./assets/avatars/status-2d-v1/", document.baseURI);
}

function capsule(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	width: number,
	height: number,
	rotation = 0,
): void {
	ctx.save();
	ctx.translate(x, y);
	ctx.rotate((rotation * Math.PI) / 180);
	ctx.beginPath();
	ctx.roundRect(-width / 2, -height / 2, width, height, Math.min(width, height) / 2);
	ctx.fill();
	ctx.restore();
}

async function prepare(entry: LiveMotion): Promise<void> {
	const { id, artwork } = entry;
	let loaded = prepared.get(id);
	if (!loaded) {
		loaded = Promise.all(
			[id, `${id}-face`].map(async (name) => {
				const image = new Image();
				image.src = new URL(`${name}.webp`, base()).href;
				await image.decode();
				return image;
			}),
		)
			.then(async ([image, face]) => {
				await artwork.prepare(id, image!);
				await artwork.prepare(`${id}-face`, face!);
			})
			.catch((error: unknown) => {
				prepared.delete(id);
				throw error;
			});
		prepared.set(id, loaded);
	}
	await loaded;
	if (!live.has(entry)) return;
	const color = shownColor(entry);
	entry.shown = color;
	const key = id + color;
	if (!surfaces.has(key)) {
		const source = artwork.drawable(id, color),
			plate = artwork.drawable(`${id}-face`, color);
		const body = document.createElement("canvas");
		body.width = body.height = 512;
		const ctx = body.getContext("2d")!;
		ctx.drawImage(source, 0, 0, 512, 512);
		const patch = document.createElement("canvas");
		patch.width = patch.height = 512;
		const pc = patch.getContext("2d")!;
		pc.scale(5.12, 5.12);
		pc.fillStyle = "#fff";
		pc.filter = "blur(1.5px)";
		for (const eye of artwork.faces[id] ?? [])
			capsule(pc, eye.x, eye.y, eye.width + 3.2, eye.height + 3.2, eye.rotation);
		pc.setTransform(1, 0, 0, 1, 0, 0);
		pc.filter = "none";
		pc.globalCompositeOperation = "source-in";
		pc.drawImage(plate, 0, 0, 512, 512);
		pc.globalCompositeOperation = "destination-in";
		pc.drawImage(source, 0, 0, 512, 512);
		ctx.drawImage(patch, 0, 0);
		surfaces.set(key, { body, source });
	}
}

function strokes(ctx: CanvasRenderingContext2D, paths: MotionPose["strokes"], front: boolean, size: number): void {
	for (const s of paths) {
		const tilt = ([-18, 62, -54, 22, 84, -38][s.lane % 6]! * Math.PI) / 180;
		const rx = 50 * s.expansion,
			ry = [12, 17, 13, 10, 15, 19][s.lane % 6]! * s.expansion;
		ctx.strokeStyle = s.color;
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		let previous: { x: number; y: number } | undefined;
		for (let j = 0; j <= 40; j++) {
			const a = s.head - s.length + (s.length * j) / 40,
				x = Math.cos(a) * rx,
				y = Math.sin(a) * ry;
			const point = {
				x: 50 + x * Math.cos(tilt) - y * Math.sin(tilt),
				y: 50 + x * Math.sin(tilt) + y * Math.cos(tilt),
				front: Math.sin(a) > 0,
			};
			if (previous && point.front === front) {
				ctx.lineWidth = Math.max(
					size < 32 ? 0.9 : 0.55,
					s.width * (0.2 + 0.8 * Math.sin((Math.PI * j) / 41) ** 0.55),
				);
				ctx.beginPath();
				ctx.moveTo(previous.x, previous.y);
				ctx.lineTo(point.x, point.y);
				ctx.stroke();
			}
			previous = point;
		}
	}
}

/** One drawn eye against the figure's own: a pill, or (from `smile` 0.5 up) an arch that rises into a smile.
 * `spacing` and `height` are the pair's, the units of the pose's place. */
function drawnEye(
	ctx: CanvasRenderingContext2D,
	eye: EyeGeometry,
	pose: EyePose,
	spacing: number,
	height: number,
): void {
	const x = eye.x + pose.x * spacing,
		y = eye.y + pose.y * height;
	const width = Math.max(0.2, eye.width * pose.width),
		tall = Math.max(0.2, eye.height * pose.height);
	const rotation = eye.rotation + pose.rotation;
	ctx.globalAlpha = pose.alpha;
	if (pose.smile <= 0.5) {
		capsule(ctx, x, y, width, Math.max(0.2, tall * (1 - 1.7 * pose.smile)), rotation);
		return;
	}
	// The shut eye (a flat pill as wide as the eye) bends up into an arch a little wider.
	const rise = (pose.smile - 0.5) * 2;
	const stroke = tall * 0.15 + (eye.width * 0.62 - tall * 0.15) * rise;
	const reach = (width - stroke) / 2 + (spacing * 0.31 - (width - stroke) / 2) * rise;
	const sag = Math.max(0.05, rise * reach * 1.05);
	ctx.save();
	ctx.translate(x, y);
	ctx.rotate((rotation * Math.PI) / 180);
	ctx.lineWidth = stroke;
	ctx.lineCap = "round";
	ctx.strokeStyle = "#fff";
	ctx.beginPath();
	ctx.ellipse(0, sag / 2, reach, sag, 0, Math.PI, Math.PI * 2);
	ctx.stroke();
	ctx.restore();
}

/** The box drawn eyes cover, [left, top, right, bottom] in frame units, or undefined when none shows. */
function drawnEyesBox(
	eyes: EyeGeometry[],
	poses: EyePose[],
	spacing: number,
	height: number,
): [number, number, number, number] | undefined {
	let box: [number, number, number, number] | undefined;
	eyes.forEach((eye, index) => {
		const pose = poses[index];
		if (!pose || pose.alpha <= 0) return;
		const x = eye.x + pose.x * spacing,
			y = eye.y + pose.y * height;
		// Whichever is larger: the pill, or the smile's arch with its stroke.
		const reach =
			Math.max(eye.width * pose.width, eye.height * pose.height, pose.smile > 0.5 ? spacing * 0.62 + eye.width : 0) /
				2 +
			1;
		box = box
			? [
					Math.min(box[0], x - reach),
					Math.min(box[1], y - reach),
					Math.max(box[2], x + reach),
					Math.max(box[3], y + reach),
				]
			: [x - reach, y - reach, x + reach, y + reach];
	});
	return box;
}

const signature = (poses: EyePose[]) =>
	poses
		.map((pose) =>
			[pose.x, pose.y, pose.width, pose.height, pose.rotation, pose.alpha, pose.smile]
				.map((n) => n.toFixed(3))
				.join(),
		)
		.join("|");

/* ---- acting: the body, the hand and the air around the figure (figure-acts.ts) ---- */

const round = (value: number, places = 2) => Number(value.toFixed(places));

/** What the figure does this frame beyond its recorded eyes, and the effects that go off on the way. `elapsed`
 * is the activity's clock, `step` the working recording's place. */
function acting(entry: LiveMotion, elapsed: number, step: WorkingStep | undefined, reduced: boolean, now: number): Act {
	if (reduced) return entry.activity === "Waiting" ? callingStill() : { body: REST, hand: { show: 1, wave: 0 } };
	const { clock, activity } = entry;
	const effects: Effect[] = [];
	let act: Act = { body: REST };
	if (activity === "Waiting") {
		act = calling(elapsed, clock.seed);
		for (const cue of callingCues(entry.cued, elapsed, clock.seed)) effects.push(cue.effect);
		entry.cued = elapsed;
	} else if (step) {
		const turn = step.whirl;
		if (turn) {
			act.body = whirl(turn.u, turn.sense);
			if (entry.turned >= 0 && entry.turned < HOP_LAUNCH && turn.u >= HOP_LAUNCH) effects.push("sparks");
			if (entry.turned >= 0 && entry.turned < HOP_LAND && turn.u >= HOP_LAND) effects.push("dust");
		}
		entry.turned = turn ? turn.u : -1;
		// The body leans the way the eyes look, a moment behind them; a turn stands it up, and a blink (no eyes
		// to follow) leaves it where it is.
		const target = turn ? 0 : step.gaze ? lean(step.gaze).turn / 4.5 : entry.leaning;
		const passed = Math.min(0.1, Math.max(0, (now - entry.leanedAt) / 1000));
		entry.leanedAt = now;
		entry.leaning += (target - entry.leaning) * (1 - Math.exp(-passed * 7));
		if (Math.abs(entry.leaning) > 0.02) act.body = both(act.body, lean({ x: entry.leaning * 14, y: 0 }));
	} else if (activity === "Done") {
		// The studio's flourish, with the cheer's jump under it.
		act.body = moment("cheer", elapsed - 0.12).body;
		for (const cue of momentCues("cheer", entry.cued - 0.12, elapsed - 0.12)) effects.push(cue.effect);
		entry.cued = elapsed;
	}
	// An idle figure's own moves, on figures large enough to show them.
	const idle = clock.idle;
	if (idle && idle.kind !== "look" && entry.alive && entry.side >= 40)
		act.body = both(act.body, moment(idle.kind, idle.t).body);
	const playing = entry.moment;
	if (playing) {
		const played = moment(playing.kind, playing.t);
		act.body = both(act.body, played.body);
		// The recorded eyes of a working figure stay: its stripes turn with them.
		if (played.eyes && !step && !act.eyes) act.eyes = played.eyes;
		for (const cue of momentCues(playing.kind, playing.cued, playing.t)) effects.push(cue.effect);
		playing.cued = playing.t;
	}
	if (entry.hand && !act.hand) act.hand = raisedHand((now - (raised.get(entry.handKey)?.at ?? now)) / 1000);
	for (const effect of effects) burst(entry, effect);
	return act;
}

/** Puts the body's pose on the canvas and the hand's on the hand, writing only what changed. */
function place(entry: LiveMotion, act: Act): void {
	const { body } = act;
	const still = body.x === 0 && body.y === 0 && body.turn === 0 && body.scaleX === 1 && body.scaleY === 1;
	const posed = still
		? ""
		: `translate(${round(body.x)}%, ${round(body.y)}%) rotate(${round(body.turn)}deg) scale(${round(body.scaleX, 3)}, ${round(body.scaleY, 3)})`;
	if (posed !== entry.posed) {
		entry.canvas.style.transform = posed;
		entry.posed = posed;
	}
	const { hand } = entry;
	if (!hand) return;
	const pose = act.hand ?? { show: 1, wave: 0 };
	// The hand goes where the body goes, a beat behind it.
	entry.trail.x += (body.x - entry.trail.x) * 0.4;
	entry.trail.y += (body.y - entry.trail.y) * 0.4;
	if (Math.abs(body.x - entry.trail.x) < 0.05) entry.trail.x = body.x;
	if (Math.abs(body.y - entry.trail.y) < 0.05) entry.trail.y = body.y;
	const unit = entry.side / 100;
	const handPosed = `translate(${round(entry.trail.x * unit, 1)}px, ${round(entry.trail.y * unit, 1)}px) rotate(${round(pose.wave, 1)}deg) scale(${round(Math.max(0, pose.show), 3)})`;
	if (handPosed !== entry.handPosed) {
		hand.style.transform = handPosed;
		entry.handPosed = handPosed;
	}
}

/* The effects: a few small shapes that fly and fade (styles/app.css `.figure-bit`), each gone when its
 * animation ends. Colours are the studio's: the Done flourish's accents and the working stripes'. */
const ACCENTS = ["#97cf66", "#a584d2", "#63bea9", "#658fd0", "#d98fa4", "#cfb94d"];
const STRIPES = ["#e594ab", "#5177c2", "#6ac2cb", "#8fd06d", "#c558a7", "#816aca"];
const EASE_OUT = "cubic-bezier(0.2, 0.7, 0.2, 1)";

function burst(entry: LiveMotion, effect: Effect): void {
	const side = entry.side / 1.12;
	// Too small to read, or nowhere to play.
	if (!entry.visible || side < 30 || typeof entry.host.animate !== "function") return;
	let layer = entry.effects;
	if (!layer) {
		layer = document.createElement("span");
		layer.className = "figure-fx";
		entry.host.append(layer);
		entry.effects = layer;
	}
	const fly = (
		className: string,
		at: [number, number],
		size: [number, number],
		frames: Keyframe[],
		timing: KeyframeAnimationOptions,
		color?: string,
	) => {
		const bit = document.createElement("span");
		bit.className = `figure-bit ${className}`;
		bit.style.left = `${at[0]}px`;
		bit.style.top = `${at[1]}px`;
		bit.style.width = `${size[0]}px`;
		bit.style.height = `${size[1]}px`;
		if (color) bit.style.setProperty("--bit", color);
		layer.append(bit);
		const animation = bit.animate(frames, { fill: "both", easing: EASE_OUT, ...timing });
		animation.onfinish = animation.oncancel = () => bit.remove();
	};
	const centred = "translate(-50%, -50%)";
	if (effect === "dust") {
		// Two puffs pushed out along the ground, clear of the body.
		const puff = Math.max(4, side * 0.11);
		for (const way of [-1, 1])
			fly(
				"figure-dust",
				[side * (0.5 + way * 0.36), side * 0.93],
				[puff, puff],
				[
					{ transform: `${centred} scale(0.4)`, opacity: 0.7 },
					{ transform: `${centred} translate(${way * side * 0.2}px, ${-side * 0.07}px) scale(1.5)`, opacity: 0 },
				],
				{ duration: 460 },
			);
	} else if (effect === "sparkles") {
		for (let index = 0; index < 7; index++) {
			const angle = ((-120 + index * 40 + (index % 2 ? 9 : -7)) * Math.PI) / 180;
			const reach = side * (0.6 + 0.14 * (index % 2));
			const x = Math.sin(angle) * reach,
				y = -Math.cos(angle) * reach;
			const star = Math.max(6, side * (0.17 + 0.035 * (index % 3)));
			fly(
				"figure-sparkle",
				[side * 0.5, side * 0.46],
				[star, star],
				[
					{ transform: `${centred} translate(${x * 0.3}px, ${y * 0.3}px) scale(0) rotate(0deg)` },
					{ transform: `${centred} translate(${x * 0.85}px, ${y * 0.85}px) scale(1) rotate(70deg)`, offset: 0.45 },
					{ transform: `${centred} translate(${x}px, ${y}px) scale(0) rotate(130deg)` },
				],
				{ duration: 700 + index * 22, delay: index * 16 },
				ACCENTS[index % ACCENTS.length],
			);
		}
	} else if (effect === "sparks") {
		for (let index = 0; index < 6; index++) {
			const degrees = index * 60 + 24;
			const angle = (degrees * Math.PI) / 180;
			const reach = side * (0.6 + 0.1 * (index % 2));
			const x = Math.cos(angle) * reach,
				y = Math.sin(angle) * reach;
			fly(
				"figure-spark",
				[side * 0.5, side * 0.5],
				[Math.max(5, side * 0.12), Math.max(2, side * 0.05)],
				[
					{
						transform: `${centred} translate(${x * 0.5}px, ${y * 0.5}px) rotate(${degrees}deg) scaleX(0.3)`,
						opacity: 1,
					},
					{
						transform: `${centred} translate(${x * 0.9}px, ${y * 0.9}px) rotate(${degrees}deg) scaleX(1)`,
						opacity: 1,
						offset: 0.55,
					},
					{ transform: `${centred} translate(${x}px, ${y}px) rotate(${degrees}deg) scaleX(0.2)`, opacity: 0 },
				],
				{ duration: 480, delay: index * 12 },
				STRIPES[index % STRIPES.length],
			);
		}
	} else if (entry.hand) {
		// A ring off the hand as it starts to wave, from where the hand is now.
		const from = entry.host.getBoundingClientRect(),
			hand = entry.hand.getBoundingClientRect();
		const ring = Math.max(10, hand.width * 0.8);
		fly(
			"figure-ring",
			[hand.left + hand.width / 2 - from.left, hand.top + hand.height / 2 - from.top],
			[ring, ring],
			[
				{ transform: `${centred} scale(0.5)`, opacity: 0.8 },
				{ transform: `${centred} scale(2.2)`, opacity: 0 },
			],
			{ duration: 660 },
		);
	}
}

// The studio's 100-unit compositor. Bodies keep their original shading and
// silhouette; recorded eyes keep one fixed transform across the entire face.
function paint(entry: LiveMotion, now = performance.now()): void {
	const { canvas, artwork, activity } = entry;
	const { drawRecordedEyes, drawWorkingStrokes, localTime, pose, recordedEyesBox, stepKey, timelines, workingStep } =
		motion!;
	const reduced = Boolean(media?.matches) || entry.still;
	const duration = timelines[activity].end - timelines[activity].start;
	const elapsed = reduced ? (activity === "Working" ? 1 : duration) : entry.clock.elapsed;
	// Working plays the agent's own order of recorded pieces; the reduced
	// still keeps the studio's frame at one second.
	const step = activity === "Working" && !reduced ? workingStep(entry.clock.schedule!, elapsed) : undefined;
	const sample = step
		? step.frame
		: Math.min(Math.round(duration * 60) - 1, Math.floor(localTime(activity, elapsed) * 60 + 1e-6));
	const clip = step?.clip ?? activity;
	const act = acting(entry, elapsed, step, reduced, now);
	place(entry, act);
	const p = pose(activity, elapsed, { reduced });
	// Idle and Working show the recording's own eyes; the others, and any act that brings its own, are drawn.
	const drawn: EyePose[] | undefined =
		act.eyes ??
		(activity === "Idle" || activity === "Working" ? undefined : p.face.map((face) => ({ ...face, smile: 0 })));
	const side = Math.max(1, Math.round(entry.side * Math.min(window.devicePixelRatio || 1, 3)));
	const key = `${side}:${step ? stepKey(step) : sample}:${reduced}:${drawn ? signature(drawn) : ""}`;
	if (entry.painted === key) return;
	entry.painted = key;
	const ctx = canvas.getContext("2d")!;
	if (canvas.width !== side) {
		canvas.width = canvas.height = side;
		// The 512px body is drawn several times smaller; ask for the resampler
		// that averages, so silhouettes stay as soft as an image element's.
		ctx.imageSmoothingQuality = "high";
	}
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.clearRect(0, 0, side, side);
	ctx.scale(side / 100, side / 100);
	const asset = surfaces.get(entry.id + entry.shown)!;
	if (step?.clip === "Working") drawWorkingStrokes(ctx, sample, false, step.strokes);
	else if (!step) strokes(ctx, p.strokes, false, entry.side);
	if (p.body > 0.001) {
		const bucket = bucketOf(side),
			surface = entry.id + entry.shown;
		const eyes = artwork.faces[entry.id]!;
		const scale = Math.min(512, bucket);
		const spacing = eyes[1]!.x - eyes[0]!.x,
			height = (eyes[0]!.height + eyes[1]!.height) / 2;
		// The eyes are drawn at 512 as the studio draws them (recorded ones are a small raster,
		// stretched), halved to the body's level, then cut to the body there: the same silhouette
		// (its level is cached) on a quarter or less of the pixels. All of it happens on canvases
		// the size of the box the eyes cover, a fraction of the layer: in Safari, a full 512px
		// layer per moving figure per frame was most of the page's main-thread time while agents
		// worked, and visible as dropped frames. `layer` is that box's canvas at the body's level,
		// `at` where its corner sits on the figure (in 512px units), and `size` its extent there.
		let layer: HTMLCanvasElement | undefined,
			at: [number, number] = [0, 0],
			size: [number, number] = [scale, scale];
		const box = drawn ? drawnEyesBox(eyes, drawn, spacing, height) : recordedEyesBox(eyes, clip, sample, step?.eyes);
		if (box) {
			// Aligned to two pixels at the body's level, so the box's halvings and the final resampling
			// fall on the same pixel grid as the whole layer's would.
			const region = alignRegion(box.map((value) => value * 5.12) as Region, Math.max(1, scale / 2));
			at = [region[0], region[1]];
			let width = region[2] - region[0],
				tall = region[3] - region[1],
				level512 = 512;
			let current = boxCanvas(entry.boxes, 512, width, tall);
			const ec = current.getContext("2d")!;
			ec.setTransform(5.12, 0, 0, 5.12, -region[0], -region[1]);
			ec.globalCompositeOperation = "source-over";
			ec.fillStyle = "#fff";
			if (drawn) {
				eyes.forEach((eye, index) => {
					const face = drawn[index];
					if (face && face.alpha > 0) drawnEye(ec, eye, face, spacing, height);
				});
				ec.globalAlpha = 1;
			} else drawRecordedEyes(ec, eyes, clip, sample, step?.eyes);
			while (level512 > scale) {
				level512 /= 2;
				const next = boxCanvas(entry.boxes, level512, width / 2, tall / 2);
				const nc = next.getContext("2d")!;
				// At exactly 2:1 plain bilinear sampling is the 2x2 average (figure-levels.ts).
				nc.imageSmoothingQuality = "low";
				nc.drawImage(current, 0, 0, width, tall, 0, 0, width / 2, tall / 2);
				width /= 2;
				tall /= 2;
				current = next;
			}
			layer = current;
			size = [width, tall];
		}
		const k = scale / 512;
		if (layer) {
			const lc = layer.getContext("2d")!;
			lc.save();
			// In layer pixels: at 512 nothing is halved, and the layer is the canvas the eyes were drawn on, still
			// under their 5.12x (and box) transform.
			lc.setTransform(1, 0, 0, 1, 0, 0);
			lc.beginPath();
			lc.rect(0, 0, size[0], size[1]);
			lc.clip();
			lc.globalCompositeOperation = "destination-in";
			lc.drawImage(
				level(`${surface}:source`, asset.source, bucket),
				at[0] * k,
				at[1] * k,
				size[0],
				size[1],
				0,
				0,
				size[0],
				size[1],
			);
			lc.restore();
		}
		ctx.save();
		ctx.translate(50 + p.x, 50 + p.y);
		ctx.rotate((p.turn * Math.PI) / 180);
		ctx.scale(p.scaleX * p.body, p.scaleY * p.body);
		ctx.translate(-50, -50);
		// No feather: the edge comes from the artwork's own (tightened)
		// coverage, smoothed by the halving (Jonas, 20 Oct).
		ctx.drawImage(level(`${surface}:body`, asset.body, bucket), 0, 0, 100, 100);
		ctx.globalAlpha = p.eyes;
		if (layer)
			ctx.drawImage(
				layer,
				0,
				0,
				size[0],
				size[1],
				(at[0] * k * 100) / scale,
				(at[1] * k * 100) / scale,
				(size[0] * 100) / scale,
				(size[1] * 100) / scale,
			);
		ctx.restore();
	}
	ctx.fillStyle = entry.shown;
	if (p.stemWidth > 0.001) {
		const half = p.stemWidth / 2,
			top = p.stemTop,
			bottom = p.stemBottom,
			r = half * 0.7;
		ctx.beginPath();
		ctx.moveTo(50 - half, top + half);
		ctx.quadraticCurveTo(50 - half, top, 50, top);
		ctx.quadraticCurveTo(50 + half, top, 50 + half, top + half);
		ctx.lineTo(50 + r * 0.7, bottom - r);
		ctx.quadraticCurveTo(50 + r * 0.7, bottom, 50, bottom);
		ctx.quadraticCurveTo(50 - r * 0.7, bottom, 50 - r * 0.7, bottom - r);
		ctx.closePath();
		ctx.fill();
	}
	if (p.alertDotR > 0) {
		ctx.beginPath();
		ctx.arc(50, p.alertDotY, p.alertDotR, 0, Math.PI * 2);
		ctx.fill();
	}
	// The writing dots hop in turn; a member who wants no motion keeps the studio's still.
	const dots =
		activity === "Thinking" && !reduced
			? hoppingDots(p.dots, elapsed)
			: p.dots.map((dot) => ({ ...dot, scaleX: 1, scaleY: 1 }));
	for (const dot of dots)
		if (dot.r > 0) {
			ctx.globalAlpha = dot.alpha;
			ctx.beginPath();
			ctx.ellipse(dot.x, dot.y, dot.r * dot.scaleX, dot.r * dot.scaleY, 0, 0, Math.PI * 2);
			ctx.fill();
		}
	ctx.globalAlpha = 1;
	if (step?.clip === "Working") drawWorkingStrokes(ctx, sample, true, step.strokes);
	else if (!step) strokes(ctx, p.strokes, true, entry.side);
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	canvas.dataset.frame = String(sample);
	if (step) canvas.dataset.clip = clip;
	else delete canvas.dataset.clip;
	// Only on the first paint: rewriting an unchanged attribute every frame still costs a style check.
	if (canvas.hidden) canvas.hidden = false;
	if (!entry.fallback.hidden) entry.fallback.hidden = true;
}

/** Repaint a ready figure whose shown colour the theme has changed. */
function recolor(entry: LiveMotion): void {
	if (!entry.ready || shownColor(entry) === entry.shown) return;
	entry.ready = false;
	void prepare(entry).then(() => {
		if (!live.has(entry)) return;
		entry.ready = true;
		entry.painted = "";
		if (entry.visible) paint(entry);
		schedule();
		recolor(entry);
	});
}

function moving(entry: LiveMotion, now = performance.now()): boolean {
	if (!motion || entry.still || media?.matches) return false;
	// A one-play act, and a raised hand: it sways and waves for as long as it is up.
	if (entry.moment || entry.hand) return true;
	const { activity, clock } = entry;
	if (activity === "Working" || activity === "Thinking" || activity === "Waiting") return true;
	const { timelines } = motion;
	if (clock.elapsed < timelines[activity].end - timelines[activity].start) return true;
	// An idle figure in the middle of a move of its own, or due one.
	return Boolean(clock.life && (clock.idle || (clock.next && now >= clock.next.at)));
}
function schedule(): void {
	if (frame || document.hidden) return;
	const now = performance.now();
	if ([...live].some((entry) => entry.ready && entry.visible && moving(entry, now))) {
		last = now;
		frame = requestAnimationFrame(tick);
	} else rest();
}
/** Nothing moves: wake for the next idle figure's move. */
function rest(): void {
	window.clearTimeout(wake);
	wake = 0;
	if (document.hidden || media?.matches) return;
	let soonest = Number.POSITIVE_INFINITY;
	for (const entry of live)
		if (entry.ready && entry.visible && !entry.still && entry.clock.next && !entry.clock.idle)
			soonest = Math.min(soonest, entry.clock.next.at);
	if (soonest === Number.POSITIVE_INFINITY) return;
	wake = window.setTimeout(
		() => {
			wake = 0;
			schedule();
		},
		Math.max(0, soonest - performance.now()) + 8,
	);
}
/** A clock's next second: its time, and an idle figure's life on it. */
function advance(clock: Clock, activity: Activity, passed: number, now: number): void {
	clock.elapsed += passed;
	if (!clock.life || activity !== "Idle") return;
	const { timelines } = motion!;
	const idle = clock.idle;
	if (idle) {
		idle.t += passed;
		const length = idle.kind === "look" ? timelines.Idle.end - timelines.Idle.start : MOMENT_LENGTH[idle.kind];
		if (idle.t < length) return;
		clock.idle = undefined;
		const drawn = nextIdle(clock.life);
		clock.next = { at: now + drawn.wait * 1000, kind: drawn.kind };
	} else if (clock.next && now >= clock.next.at) {
		clock.idle = { kind: clock.next.kind, t: 0 };
		// A look around is the recording again: the blink that opens into a glance.
		if (clock.next.kind === "look") clock.elapsed = 0;
	}
}
function tick(now: number): void {
	frame = 0;
	if (document.hidden) return;
	const elapsed = (now - last) / 1000;
	last = now;
	const advanced = new Set<LiveMotion["clock"]>();
	// An idle figure that cheers starts its recorded blink once the cheer is over.
	for (const entry of live) if (entry.activity === "Idle" && entry.moment?.kind === "cheer") advanced.add(entry.clock);
	for (const entry of live) {
		if (!entry.ready || !entry.visible || !entry.host.isConnected) continue;
		if (moving(entry, now) && !advanced.has(entry.clock)) {
			advance(entry.clock, entry.activity, elapsed, now);
			advanced.add(entry.clock);
		}
		const playing = entry.moment;
		if (playing) {
			playing.t += elapsed;
			if (playing.t >= MOMENT_LENGTH[playing.kind]) entry.moment = undefined;
		}
		paint(entry, now);
	}
	if ([...live].some((entry) => entry.ready && entry.visible && moving(entry, now)))
		frame = requestAnimationFrame(tick);
	else rest();
}

function hash(text: string): number {
	let seed = 0;
	for (const character of text) seed = (seed * 31 + character.charCodeAt(0)) >>> 0;
	return seed;
}

/** UI-only motion. It neither reads nor binds an agent runtime. */
export function mountFigureMotion(
	host: HTMLElement,
	id: string,
	color: string,
	artwork: FigureArtwork,
	options: MotionOptions = {},
): FigureMotion {
	const canvas = document.createElement("canvas");
	canvas.className = "figure-canvas";
	canvas.hidden = true;
	const fallback = new Image();
	fallback.className = "figure-fallback";
	fallback.alt = "";
	fallback.src = new URL(`${id}.webp`, base()).href;
	host.append(fallback, canvas);
	host.dataset.activity = options.activity ?? "Idle";
	const activity = options.activity ?? "Idle";
	const identity = options.identity ?? id + color;
	const clockKey = `${identity}:${activity}`;
	const clock = clocks.get(clockKey) ?? { elapsed: 0, users: 0, seed: hash(identity) };
	clock.users++;
	clocks.set(clockKey, clock);
	if (options.hand) {
		const up = raised.get(identity) ?? { at: performance.now(), users: 0 };
		up.users++;
		raised.set(identity, up);
	}
	const entry: LiveMotion = {
		host,
		canvas,
		fallback,
		artwork,
		id,
		color,
		shown: color,
		activity,
		clock,
		still: Boolean(options.still),
		visible: false,
		ready: false,
		painted: "",
		side: 36,
		boxes: new Map(),
		hand: options.hand,
		handKey: identity,
		alive: Boolean(options.alive),
		cued: clock.elapsed,
		turned: -1,
		leaning: 0,
		leanedAt: 0,
		trail: { x: 0, y: 0 },
		posed: "",
		handPosed: "",
	};
	live.add(entry);
	if (!lifetime) {
		lifetime = new AbortController();
		media = window.matchMedia("(prefers-reduced-motion: reduce)");
		media.addEventListener(
			"change",
			() => {
				for (const item of live)
					if (item.ready && item.visible) {
						item.painted = "";
						paint(item);
					}
				schedule();
			},
			{ signal: lifetime.signal },
		);
		window.addEventListener(
			"qorpera-theme-change",
			() => {
				for (const item of live) recolor(item);
			},
			{ signal: lifetime.signal },
		);
		// A window moved to a screen of another pixel density repaints its figures at that density.
		const signal = lifetime.signal;
		const watchDensity = () =>
			window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`).addEventListener(
				"change",
				() => {
					for (const item of live) if (item.ready && item.visible) paint(item);
					watchDensity();
				},
				{ once: true, signal },
			);
		watchDensity();
		document.addEventListener(
			"visibilitychange",
			() => {
				if (document.hidden) {
					if (frame) cancelAnimationFrame(frame);
					frame = 0;
					window.clearTimeout(wake);
					wake = 0;
				} else schedule();
			},
			{ signal: lifetime.signal },
		);
		visibility = new IntersectionObserver((records) => {
			for (const record of records)
				for (const item of live)
					if (item.host === record.target) {
						item.visible = record.isIntersecting;
						if (item.ready && item.visible) paint(item);
					}
			schedule();
		});
		sizes = new ResizeObserver((records) => {
			for (const record of records)
				for (const item of live)
					if (item.host === record.target) {
						item.side = record.contentRect.width * 1.12;
						if (item.ready && item.visible) paint(item);
					}
		});
	}
	visibility!.observe(host);
	sizes!.observe(host);
	// Until the recorded motion and the artwork are both here the figure shows
	// its still artwork; its clock starts at the first painted frame.
	void Promise.all([
		prepare(entry),
		loadFigureMotion().then((loaded) =>
			Promise.all([
				// A figure that asks for the member is drawn, not recorded (figure-acts.ts).
				activity === "Waiting" ? undefined : loaded.loadRecordedMotion(activity, base()),
				// Working borrows the Waiting clip's sideways glance between turns.
				activity === "Working" ? loaded.loadRecordedMotion("Waiting", base()) : undefined,
			]),
		),
	])
		.then(() => {
			if (!live.has(entry)) return;
			if (activity === "Working") clock.schedule ??= motion!.createWorkingSchedule();
			if (activity === "Idle" && entry.alive && !entry.still && !clock.life) {
				// Its first move of its own comes after the opening blink has played.
				clock.life = idleLife(clock.seed ^ Math.floor(Math.random() * 2 ** 32));
				const { timelines } = motion!;
				const drawn = nextIdle(clock.life);
				const opening = Math.max(0, timelines.Idle.end - timelines.Idle.start - clock.elapsed);
				clock.next = { at: performance.now() + (opening + drawn.wait) * 1000, kind: drawn.kind };
			}
			entry.ready = true;
			if (entry.visible) paint(entry);
			schedule();
			// The theme may have changed while the artwork loaded.
			recolor(entry);
		})
		.catch(() => {
			// Artwork that failed is fetched again by a figure built anew (the rail
			// rebuilds these). The recorded motion cannot come back in this page, so
			// without it the figure keeps its still artwork and asks for no rebuild.
			if (live.has(entry) && !motionFailed) host.dataset.motionUnavailable = "true";
		});
	return {
		dispose() {
			if (!live.delete(entry)) return;
			visibility?.unobserve(host);
			sizes?.unobserve(host);
			if (--clock.users === 0) clocks.delete(clockKey);
			if (entry.hand) {
				const up = raised.get(identity);
				if (up && --up.users === 0) raised.delete(identity);
			}
			if (!live.size) {
				if (frame) cancelAnimationFrame(frame);
				frame = 0;
				window.clearTimeout(wake);
				wake = 0;
				visibility?.disconnect();
				sizes?.disconnect();
				lifetime?.abort();
				lifetime = undefined;
			}
		},
		play(kind) {
			// A cheer takes over from a perk; nothing takes over from a cheer.
			if (!live.has(entry) || entry.still || media?.matches || (entry.moment && kind !== "cheer")) return;
			entry.moment = { kind, t: 0, cued: 0 };
			schedule();
		},
	};
}
