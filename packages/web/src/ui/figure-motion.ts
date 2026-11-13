import type { Activity, MotionPose } from "../../public/assets/avatars/status-2d-v1/motion.mjs";
import {
	type Act,
	type Ask,
	asking,
	askingCues,
	askingStill,
	both,
	type Effect,
	type EyePose,
	hoppingDots,
	IDLE_OPENING,
	type IdleLife,
	idleLife,
	idleOpening,
	MOMENT_LENGTH,
	type Moment,
	moment,
	momentCues,
	nextIdle,
	openEyes,
	type Prop,
	REST,
	working,
	workingCues,
	workingStill,
	writingAsk,
	writingAskCues,
} from "./figure-acts.ts";
import { alignRegion, boxCanvas, bucketOf, level, type Region } from "./figure-levels.ts";
import type * as MotionData from "./figure-motion-data.ts";

export type { Activity, Ask, Moment };

/** Where a figure's eye is drawn on its artwork, in the 100-unit frame (motion-model.js `faces`). */
export interface EyeGeometry {
	x: number;
	y: number;
	width: number;
	height: number;
	rotation: number;
}
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
	/** What waits on the member, if anything does: a question to answer ("question") or anything else ("bang").
	 * A figure that needs them (`Waiting`) becomes that symbol; one that works comes back as it between spells. */
	ask?: Ask;
	/** Left alone, the figure still blinks, looks around and moves now and then (the rail's figures). */
	alive?: boolean;
}
export interface FigureMotion {
	dispose(): void;
	/** A short act over whatever the figure is doing: a cheer when its work is done. */
	play(kind: Moment): void;
}

/** The studio's motion sampler (the symbolic states' poses and each state's time), once its chunk has arrived.
 * A figure is `ready` only after it has, so everything that paints can rely on it. */
let motion: typeof MotionData | undefined;
let motionLoading: Promise<typeof MotionData> | undefined;
let motionFailed = false;

/** Fetch the sampler (its own chunk, about 140 KB before compression) once, on the first figure. A browser keeps
 * a module it failed to load for the page's life without fetching it again, so a failed load stays failed here
 * too: every figure keeps its still artwork until the page is reloaded. */
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
/** One clock per agent and activity, shared by every view of that agent. */
interface Clock {
	elapsed: number;
	users: number;
	/** Which of its acts come when (figure-acts.ts): one agent's views agree, two agents differ. */
	seed: number;
	/** An idle figure's life: what it does now, and what it does next and when (on performance.now()'s clock). */
	life?: IdleLife;
	idle?: { kind: Moment; t: number };
	next?: { at: number; kind: Moment };
}
const clocks = new Map<string, Clock>();
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
	ask?: Ask;
	alive: boolean;
	/** A one-play act, `t` seconds in; `cued` is how far its effects have gone off, `asked` when it was asked for
	 * (performance.now()): one that could not start in time, on a figure out of view, is dropped. */
	moment?: { kind: Moment; t: number; cued: number; asked: number };
	/** How far the activity's own effects have gone off, in its clock's seconds. */
	cued: number;
	/** The transform on the canvas, so an unchanged pose writes nothing. */
	posed: string;
	/** The stars a working figure juggles (made with the first frame that has them), the transforms on them, and
	 * the figure's side they were sized for. */
	props?: HTMLElement[];
	propsPosed: string[];
	propsSide: number;
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

/* ---- acting: the body, the eyes, the symbol and the air around the figure (figure-acts.ts) ---- */

const round = (value: number, places = 2) => Number(value.toFixed(places));
/** The longest stretch of an activity's clock whose effects a figure still shows: past it, it missed them. */
const EFFECTS_GAP = 0.5;
/** How fast the acts of a figure that needs the member and of one that works are played: a little under the pace
 * they were written at (Jonas, 13 Nov 2026: "slightly too fast"). The acts keep their own time (figure-acts.ts);
 * the figure's clock is turned into it here. The cheer, the writing dots and an idle figure's moves play as written. */
const PACE = 0.85;

/** What the figure does this frame, and the effects that go off on the way. `elapsed` is the activity's clock. */
function acting(entry: LiveMotion, elapsed: number, reduced: boolean): Act {
	const { clock, activity } = entry;
	if (reduced) {
		// What waits on the member shows at rest whatever the figure is busy with: the symbol alone, as the badge
		// that stood beside a working or a writing figure did.
		if (activity === "Waiting") return askingStill(entry.ask ?? "bang");
		if (entry.ask && (activity === "Working" || activity === "Thinking")) return askingStill(entry.ask);
		if (activity === "Working") return workingStill();
		return { body: REST, eyes: activity === "Idle" ? openEyes() : undefined };
	}
	const effects: Effect[] = [];
	let act: Act = { body: REST };
	// The effects since this figure last showed them. A figure that was out of view while another view of the
	// agent kept the clock going, or a frame that came late, has a gap: nothing in it goes off now.
	const since = elapsed - entry.cued > EFFECTS_GAP || elapsed < entry.cued ? elapsed : entry.cued;
	if (activity === "Waiting") {
		act = asking(elapsed * PACE, entry.ask ?? "bang", clock.seed);
		for (const cue of askingCues(since * PACE, elapsed * PACE, clock.seed)) effects.push(cue.effect);
	} else if (activity === "Working") {
		act = working(elapsed * PACE, clock.seed, entry.ask);
		for (const cue of workingCues(since * PACE, elapsed * PACE, clock.seed, entry.ask)) effects.push(cue.effect);
	} else if (activity === "Thinking" && entry.ask) {
		// The dots write on; every few seconds they become what waits on the member, at the pace of one that asks.
		act = writingAsk(elapsed * PACE, entry.ask);
		for (const cue of writingAskCues(since * PACE, elapsed * PACE)) effects.push(cue.effect);
	} else if (activity === "Idle") act.eyes = idleOpening(elapsed);
	else if (activity === "Done") {
		// The studio's flourish, with the short cheer's jump under it.
		act.body = moment("hooray", elapsed - 0.12).body;
		for (const cue of momentCues("hooray", since - 0.12, elapsed - 0.12)) effects.push(cue.effect);
	}
	entry.cued = elapsed;
	// An idle figure's own moves: the eyes' on every figure, the body's on figures large enough to show them.
	const idle = clock.idle;
	if (idle && entry.alive) {
		const moved = moment(idle.kind, idle.t);
		if (entry.side >= 40) act.body = both(act.body, moved.body);
		if (moved.eyes) act.eyes = moved.eyes;
	}
	const playing = entry.moment;
	if (playing) {
		const played = moment(playing.kind, playing.t);
		act.body = both(act.body, played.body);
		// A cheer's smile is for a figure that has its eyes: the dots and the symbols have none.
		if (played.eyes && act.eyes) act.eyes = played.eyes;
		for (const cue of momentCues(playing.kind, playing.cued, playing.t)) effects.push(cue.effect);
		playing.cued = playing.t;
	}
	for (const effect of effects) burst(entry, effect);
	return act;
}

/** Puts the body's pose on the canvas, writing only what changed. */
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
	juggle(entry, act.props);
}

/** The effects' layer over the figure, made when first needed. */
function effectsLayer(entry: LiveMotion): HTMLElement {
	let layer = entry.effects;
	if (!layer) {
		layer = document.createElement("span");
		layer.className = "figure-fx";
		entry.host.append(layer);
		entry.effects = layer;
	}
	return layer;
}

/** Puts the stars a working figure juggles where the act has them: three small stars over the figure, each a
 * transform on its own element, written only when it changes. A figure too small to show them has none. */
function juggle(entry: LiveMotion, props: Prop[] | undefined): void {
	const side = entry.side / 1.12;
	if (side < 30 || (!props && !entry.props)) return;
	if (!entry.props) {
		const layer = effectsLayer(entry);
		// Three of the stars' colours, an agent's own three, and never the figure's own colour: a star stands out
		// against the body it passes.
		const colours = ACCENTS.filter((colour) => colour !== entry.color.toLowerCase());
		entry.props = (props ?? []).map((_, index) => {
			const star = document.createElement("span");
			star.className = "figure-bit figure-sparkle figure-prop";
			star.style.setProperty("--bit", colours[(entry.clock.seed + index * 2) % colours.length]!);
			layer.append(star);
			return star;
		});
	}
	if (entry.propsSide !== side) {
		entry.propsSide = side;
		const size = `${round(Math.max(7, side * 0.24), 1)}px`;
		for (const star of entry.props) star.style.width = star.style.height = size;
	}
	entry.props.forEach((star, index) => {
		const prop = props?.[index];
		// The frame is the canvas, which stands 6% proud of the figure's box on every side.
		const at = (value: number) => round(((value / 100) * 1.12 - 0.06) * side, 1);
		const shown = prop && prop.scale > 0.001;
		const transform = shown
			? `translate(${at(prop.x)}px, ${at(prop.y)}px) translate(-50%, -50%) rotate(${round(prop.turn, 0)}deg) scale(${round(prop.scale, 3)})`
			: "scale(0)";
		// A star on the far side of the figure goes under the figure's canvas (styles/app.css).
		const behind = Boolean(shown && prop.behind);
		const posed = `${transform}${behind ? " behind" : ""}`;
		if (posed !== entry.propsPosed[index]) {
			star.style.transform = transform;
			star.classList.toggle("is-behind", behind);
			entry.propsPosed[index] = posed;
		}
	});
}

/** The symbol a figure has become, in the figure's colour, on the 100-unit frame: a "?" or a "!" standing on
 * the figure's ground. */
function drawSymbol(ctx: CanvasRenderingContext2D, symbol: Ask, color: string): void {
	ctx.save();
	ctx.fillStyle = ctx.strokeStyle = color;
	ctx.lineCap = ctx.lineJoin = "round";
	if (symbol === "bang") {
		ctx.beginPath();
		ctx.roundRect(41.25, 12, 17.5, 48.5, 8.75);
		ctx.fill();
		ctx.beginPath();
		ctx.arc(50, 78, 9.8, 0, Math.PI * 2);
		ctx.fill();
	} else {
		ctx.lineWidth = 15.5;
		ctx.beginPath();
		ctx.arc(50, 35.5, 16.5, Math.PI * 1.08, Math.PI * 2.24);
		ctx.quadraticCurveTo(52.5, 52.5, 50.5, 62);
		ctx.stroke();
		ctx.beginPath();
		ctx.arc(50.5, 79.5, 9.3, 0, Math.PI * 2);
		ctx.fill();
	}
	ctx.restore();
}

/* The effects: a few small shapes that fly and fade (styles/app.css `.figure-bit`), each gone when its
 * animation ends. A cheer's stars and the stars a working figure juggles take the vivid colours above; the stars
 * of a change into a symbol are in the figure's own colour. */
/** The stars' colours: the vivid ones of the agents' own colour row (avatar-appearance.js: Gold, Pink, Sky,
 * Green, Purple, Orange), so they stand out on the rail and on a figure of any colour (Jonas, 13 Nov 2026: "more
 * vibrant"; the studio's Done accents were pastels). */
const ACCENTS = ["#fcb51b", "#fa59ac", "#3faff3", "#0fbd59", "#a145f7", "#f96e2d"];
const EASE_OUT = "cubic-bezier(0.2, 0.7, 0.2, 1)";
const CENTRED = "translate(-50%, -50%)";

function burst(entry: LiveMotion, effect: Effect): void {
	const side = entry.side / 1.12;
	// Too small to read, or nowhere to play.
	if (!entry.visible || side < 30 || typeof entry.host.animate !== "function") return;
	const layer = effectsLayer(entry);
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
	/** A star that flies out from the figure's middle by (`x`, `y`), turning, and is gone at the end; a slow one
	 * hangs a moment and sinks a little. */
	const star = (x: number, y: number, size: number, duration: number, delay: number, sink: number, color: string) =>
		fly(
			"figure-sparkle",
			[side * 0.5, side * 0.46],
			[size, size],
			[
				{ transform: `${CENTRED} translate(${x * 0.3}px, ${y * 0.3}px) scale(0) rotate(0deg)` },
				{ transform: `${CENTRED} translate(${x * 0.88}px, ${y * 0.88}px) scale(1) rotate(70deg)`, offset: 0.4 },
				{
					transform: `${CENTRED} translate(${x * 0.97}px, ${y * 0.97 + sink * 0.4}px) scale(0.9) rotate(105deg)`,
					offset: 0.72,
				},
				{ transform: `${CENTRED} translate(${x}px, ${y + sink}px) scale(0) rotate(150deg)` },
			],
			{ duration, delay },
			color,
		);
	if (effect === "dust") {
		// Two puffs pushed out along the ground, clear of the body.
		const puff = Math.max(4, side * 0.11);
		for (const way of [-1, 1])
			fly(
				"figure-dust",
				[side * (0.5 + way * 0.36), side * 0.93],
				[puff, puff],
				[
					{ transform: `${CENTRED} scale(0.4)`, opacity: 0.7 },
					{ transform: `${CENTRED} translate(${way * side * 0.2}px, ${-side * 0.07}px) scale(1.5)`, opacity: 0 },
				],
				{ duration: 460 },
			);
	} else if (effect === "pop") {
		// The figure has become a symbol: five small stars in its own colour, out to all sides.
		for (let index = 0; index < 5; index++) {
			const angle = ((index * 72 - 20) * Math.PI) / 180;
			const reach = side * (0.56 + 0.1 * (index % 2));
			star(
				Math.sin(angle) * reach,
				-Math.cos(angle) * reach,
				Math.max(6, side * 0.18),
				620,
				index * 14,
				0,
				entry.shown,
			);
		}
	} else if (effect === "sparkles") {
		// A burst over the head and shoulders.
		for (let index = 0; index < 7; index++) {
			const angle = ((-120 + index * 40 + (index % 2 ? 9 : -7)) * Math.PI) / 180;
			const reach = side * (0.6 + 0.14 * (index % 2));
			star(
				Math.sin(angle) * reach,
				-Math.cos(angle) * reach,
				Math.max(7, side * (0.2 + 0.04 * (index % 3))),
				760 + index * 24,
				index * 16,
				0,
				ACCENTS[index % ACCENTS.length]!,
			);
		}
	} else if (effect === "shower") {
		// The twirl's: a full ring, wider, larger and slower, that hangs and sinks.
		for (let index = 0; index < 10; index++) {
			const angle = ((index * 36 + 14) * Math.PI) / 180;
			const reach = side * (0.72 + 0.16 * (index % 3 === 0 ? 1 : 0));
			star(
				Math.sin(angle) * reach,
				-Math.cos(angle) * reach * 0.86,
				Math.max(8, side * (0.23 + 0.06 * (index % 2))),
				1250 + index * 30,
				index * 26,
				side * 0.1,
				ACCENTS[(index + 2) % ACCENTS.length]!,
			);
		}
	} else {
		// A twinkle: one star that pops beside the figure, turns on the spot and goes.
		const way = Math.random() < 0.5 ? -1 : 1;
		const size = Math.max(8, side * 0.24);
		fly(
			"figure-sparkle",
			[side * (0.5 + way * (0.44 + 0.16 * Math.random())), side * (0.1 + 0.4 * Math.random())],
			[size, size],
			[
				{ transform: `${CENTRED} translateY(${size * 0.5}px) scale(0) rotate(-40deg)` },
				{ transform: `${CENTRED} scale(1.25) rotate(10deg)`, offset: 0.3 },
				{ transform: `${CENTRED} scale(1) rotate(25deg)`, offset: 0.5 },
				{ transform: `${CENTRED} translateY(${-size * 0.3}px) scale(0) rotate(90deg)` },
			],
			{ duration: 760 },
			ACCENTS[Math.floor(Math.random() * ACCENTS.length)],
		);
	}
}

/** The symbolic states draw themselves from the studio's pose, which changes every frame; the others change
 * only when their drawn eyes do. */
const SYMBOLIC: readonly Activity[] = ["Blocked", "Thinking", "Done"];

// The studio's 100-unit compositor. Bodies keep their original shading and silhouette; every eye is drawn.
function paint(entry: LiveMotion): void {
	const { canvas, artwork, activity } = entry;
	const { localTime, pose, timelines } = motion!;
	const reduced = Boolean(media?.matches) || entry.still;
	const duration = timelines[activity].end - timelines[activity].start;
	// A member who wants no motion sees each state's still: its end, or (working, which has none) one second in.
	const elapsed = reduced ? (activity === "Working" ? 1 : duration) : entry.clock.elapsed;
	const sample = Math.min(Math.round(duration * 60) - 1, Math.floor(localTime(activity, elapsed) * 60 + 1e-6));
	const act = acting(entry, elapsed, reduced);
	place(entry, act);
	const p = pose(activity, elapsed, { reduced });
	const { symbol } = act;
	const drawn: EyePose[] = act.eyes ?? p.face.map((face) => ({ ...face, smile: 0 }));
	const side = Math.max(1, Math.round(entry.side * Math.min(window.devicePixelRatio || 1, 3)));
	const look = symbol ?? signature(drawn);
	const key = `${side}:${SYMBOLIC.includes(activity) ? sample : ""}:${reduced}:${look}`;
	canvas.dataset.frame = String(sample);
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
	strokes(ctx, p.strokes, false, entry.side);
	// A figure that has become a symbol is drawn as the symbol, in its own colour.
	if (symbol) drawSymbol(ctx, symbol, entry.shown);
	else if (p.body > 0.001) {
		const bucket = bucketOf(side),
			surface = entry.id + entry.shown;
		const eyes = artwork.faces[entry.id]!;
		const scale = Math.min(512, bucket);
		const spacing = eyes[1]!.x - eyes[0]!.x,
			height = (eyes[0]!.height + eyes[1]!.height) / 2;
		// The eyes are drawn at 512, halved to the body's level, then cut to the body there: the same
		// silhouette (its level is cached) on a quarter or less of the pixels. All of it happens on canvases
		// the size of the box the eyes cover, a fraction of the layer: in Safari, a full 512px layer per
		// moving figure per frame was most of the page's main-thread time, and visible as dropped frames.
		// `layer` is that box's canvas at the body's level, `at` where its corner sits on the figure (in
		// 512px units), and `size` its extent there.
		let layer: HTMLCanvasElement | undefined,
			at: [number, number] = [0, 0],
			size: [number, number] = [scale, scale];
		const box = drawnEyesBox(eyes, drawn, spacing, height);
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
			eyes.forEach((eye, index) => {
				const face = drawn[index];
				if (face && face.alpha > 0) drawnEye(ec, eye, face, spacing, height);
			});
			ec.globalAlpha = 1;
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
	// A writing figure that has become its ask for a moment shows the symbol, not its dots.
	for (const dot of dots)
		if (dot.r > 0 && !symbol) {
			ctx.globalAlpha = dot.alpha;
			ctx.beginPath();
			ctx.ellipse(dot.x, dot.y, dot.r * dot.scaleX, dot.r * dot.scaleY, 0, 0, Math.PI * 2);
			ctx.fill();
		}
	ctx.globalAlpha = 1;
	strokes(ctx, p.strokes, true, entry.side);
	ctx.setTransform(1, 0, 0, 1, 0, 0);
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
	if (entry.moment) return true;
	const { activity, clock } = entry;
	if (activity === "Working" || activity === "Thinking" || activity === "Waiting") return true;
	const { timelines } = motion;
	// Idle plays its drawn opening; Blocked and Done play the studio's time.
	if (clock.elapsed < (activity === "Idle" ? IDLE_OPENING : timelines[activity].end - timelines[activity].start))
		return true;
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
	const idle = clock.idle;
	if (idle) {
		idle.t += passed;
		if (idle.t < MOMENT_LENGTH[idle.kind]) return;
		clock.idle = undefined;
		const drawn = nextIdle(clock.life);
		clock.next = { at: now + drawn.wait * 1000, kind: drawn.kind };
	} else if (clock.next && now >= clock.next.at) clock.idle = { kind: clock.next.kind, t: 0 };
}
/** How long a one-play act waits for its figure to come on screen before it is dropped, in milliseconds. */
const MOMENT_WAITS = 2000;
function tick(now: number): void {
	frame = 0;
	if (document.hidden) return;
	const elapsed = (now - last) / 1000;
	last = now;
	const advanced = new Set<LiveMotion["clock"]>();
	const shown = (entry: LiveMotion) => entry.ready && entry.visible && entry.host.isConnected;
	for (const entry of live) {
		// A one-play act asked for on a figure that was out of view is stale by the time the figure shows: it goes.
		const asked = entry.moment;
		if (asked && asked.t === 0 && now - asked.asked > MOMENT_WAITS) entry.moment = undefined;
	}
	// An idle figure that cheers starts its opening blink once the cheer is over: its clock waits for it. Only a
	// figure on screen holds the clock, so one out of view never stops the other views of its agent.
	for (const entry of live)
		if (
			shown(entry) &&
			entry.activity === "Idle" &&
			(entry.moment?.kind === "cheer" || entry.moment?.kind === "hooray")
		)
			advanced.add(entry.clock);
	for (const entry of live) {
		if (!shown(entry)) continue;
		if (moving(entry, now) && !advanced.has(entry.clock)) {
			advance(entry.clock, entry.activity, elapsed, now);
			advanced.add(entry.clock);
		}
		const playing = entry.moment;
		if (playing) {
			playing.t += elapsed;
			if (playing.t >= MOMENT_LENGTH[playing.kind]) entry.moment = undefined;
		}
		paint(entry);
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
		ask: options.ask,
		alive: Boolean(options.alive),
		cued: clock.elapsed,
		posed: "",
		propsPosed: [],
		propsSide: 0,
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
						// Back in view: what went off around the agent's other views while it was away stays missed.
						if (record.isIntersecting && !item.visible) item.cued = item.clock.elapsed;
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
	// Until the motion's code and the artwork are both here the figure shows its still artwork; its clock
	// starts at the first painted frame.
	void Promise.all([prepare(entry), loadFigureMotion()])
		.then(() => {
			if (!live.has(entry)) return;
			if (activity === "Idle" && entry.alive && !entry.still && !clock.life) {
				// Its first move of its own comes after the opening blink has played.
				clock.life = idleLife(clock.seed ^ Math.floor(Math.random() * 2 ** 32));
				const drawn = nextIdle(clock.life);
				clock.next = {
					at: performance.now() + (Math.max(0, IDLE_OPENING - clock.elapsed) + drawn.wait) * 1000,
					kind: drawn.kind,
				};
			}
			entry.ready = true;
			if (entry.visible) paint(entry);
			schedule();
			// The theme may have changed while the artwork loaded.
			recolor(entry);
		})
		.catch(() => {
			// Artwork that failed is fetched again by a figure built anew (the rail
			// rebuilds these). The motion sampler cannot come back in this page, so
			// without it the figure keeps its still artwork and asks for no rebuild.
			if (live.has(entry) && !motionFailed) host.dataset.motionUnavailable = "true";
		});
	return {
		dispose() {
			if (!live.delete(entry)) return;
			visibility?.unobserve(host);
			sizes?.unobserve(host);
			if (--clock.users === 0) clocks.delete(clockKey);
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
			// A cheer takes over from a smaller act; nothing takes over from a cheer.
			if (
				!live.has(entry) ||
				entry.still ||
				media?.matches ||
				(entry.moment && kind !== "cheer" && kind !== "hooray")
			)
				return;
			entry.moment = { kind, t: 0, cued: 0, asked: performance.now() };
			schedule();
		},
	};
}
