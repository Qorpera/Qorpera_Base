import type { Activity, MotionPose } from "../../public/assets/avatars/status-2d-v1/motion.mjs";
import type { EyeGeometry } from "../../public/assets/avatars/status-2d-v1/recorded-motion.mjs";
import { bucketOf, level } from "./figure-levels.ts";
import type * as MotionData from "./figure-motion-data.ts";
import type { WorkingSchedule } from "./working-sequence.ts";

export type { Activity };

export interface FigureArtwork {
	faces: Record<string, EyeGeometry[]>;
	prepare(id: string, image: HTMLImageElement): void;
	drawable(id: string, color: string): CanvasImageSource;
	/** The approved shade of `color` on a dark surface. */
	colorOnDark(id: string, color: string): string;
}
export interface MotionOptions {
	activity?: Activity;
	still?: boolean;
	/** A local identity keeps the opening blink from restarting on view refresh. */
	identity?: string;
}
export interface FigureMotion {
	dispose(): void;
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
}
const clocks = new Map<string, Clock>();
const live = new Set<LiveMotion>();
let frame = 0;
let last = 0;
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
			.then(([image, face]) => {
				artwork.prepare(id, image!);
				artwork.prepare(`${id}-face`, face!);
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

// The studio's 100-unit compositor. Bodies keep their original shading and
// silhouette; recorded eyes keep one fixed transform across the entire face.
let eyesCanvas: HTMLCanvasElement | undefined;
function paint(entry: LiveMotion): void {
	const { canvas, artwork, activity } = entry;
	const { drawRecordedEyes, drawWorkingStrokes, localTime, pose, stepKey, timelines, workingStep } = motion!;
	const reduced = Boolean(media?.matches) || entry.still;
	const duration = timelines[activity].end - timelines[activity].start;
	const elapsed = reduced ? (activity === "Working" ? 1 : duration) : entry.clock.elapsed;
	const recorded = ["Idle", "Working", "Waiting"].includes(activity);
	// Working plays the agent's own order of recorded pieces; the reduced
	// still keeps the studio's frame at one second.
	const step = activity === "Working" && !reduced ? workingStep(entry.clock.schedule!, elapsed) : undefined;
	const sample = step
		? step.frame
		: Math.min(Math.round(duration * 60) - 1, Math.floor(localTime(activity, elapsed) * 60 + 1e-6));
	const clip = step?.clip ?? activity;
	const side = Math.max(1, Math.round(entry.side * Math.min(window.devicePixelRatio || 1, 3)));
	const key = `${side}:${step ? stepKey(step) : sample}:${reduced}`;
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
	const p = pose(activity, elapsed, { reduced });
	const asset = surfaces.get(entry.id + entry.shown)!;
	if (step?.clip === "Working") drawWorkingStrokes(ctx, sample, false, step.strokes);
	else if (!step) strokes(ctx, p.strokes, false, entry.side);
	if (p.body > 0.001) {
		// The eyes are drawn at the body's level, not at 512 and shrunk.
		const bucket = bucketOf(side),
			surface = entry.id + entry.shown;
		eyesCanvas ??= document.createElement("canvas");
		if (eyesCanvas.width !== bucket) eyesCanvas.width = eyesCanvas.height = bucket;
		const ec = eyesCanvas.getContext("2d")!;
		ec.setTransform(1, 0, 0, 1, 0, 0);
		ec.clearRect(0, 0, bucket, bucket);
		ec.setTransform(bucket / 100, 0, 0, bucket / 100, 0, 0);
		ec.globalCompositeOperation = "source-over";
		ec.fillStyle = "#fff";
		const eyes = artwork.faces[entry.id]!;
		if (recorded) drawRecordedEyes(ec, eyes, clip, sample, step?.eyes);
		else {
			const spacing = eyes[1]!.x - eyes[0]!.x,
				height = (eyes[0]!.height + eyes[1]!.height) / 2;
			for (let i = 0; i < 2; i++) {
				const eye = eyes[i]!,
					f = p.face[i]!;
				ec.globalAlpha = f.alpha;
				capsule(
					ec,
					eye.x + f.x * spacing,
					eye.y + f.y * height,
					Math.max(0.2, eye.width * f.width),
					Math.max(0.2, eye.height * f.height),
					eye.rotation + f.rotation,
				);
			}
		}
		ec.globalAlpha = 1;
		ec.setTransform(1, 0, 0, 1, 0, 0);
		ec.globalCompositeOperation = "destination-in";
		ec.drawImage(level(`${surface}:source`, asset.source, bucket), 0, 0, bucket, bucket);
		ctx.save();
		ctx.translate(50 + p.x, 50 + p.y);
		ctx.rotate((p.turn * Math.PI) / 180);
		ctx.scale(p.scaleX * p.body, p.scaleY * p.body);
		ctx.translate(-50, -50);
		// No feather: the edge comes from the artwork's own (tightened)
		// coverage, smoothed by the halving (Jonas, 20 Oct).
		ctx.drawImage(level(`${surface}:body`, asset.body, bucket), 0, 0, 100, 100);
		ctx.globalAlpha = p.eyes;
		ctx.drawImage(eyesCanvas, 0, 0, 100, 100);
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
	for (const dot of p.dots)
		if (dot.r > 0) {
			ctx.globalAlpha = dot.alpha;
			ctx.beginPath();
			ctx.arc(dot.x, dot.y, dot.r, 0, Math.PI * 2);
			ctx.fill();
		}
	ctx.globalAlpha = 1;
	if (step?.clip === "Working") drawWorkingStrokes(ctx, sample, true, step.strokes);
	else if (!step) strokes(ctx, p.strokes, true, entry.side);
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	canvas.dataset.frame = String(sample);
	if (step) canvas.dataset.clip = clip;
	else delete canvas.dataset.clip;
	canvas.hidden = false;
	entry.fallback.hidden = true;
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

function moving(entry: LiveMotion): boolean {
	if (!motion || entry.still || media?.matches) return false;
	const { timelines } = motion;
	const duration = timelines[entry.activity].end - timelines[entry.activity].start;
	return entry.activity === "Working" || entry.activity === "Thinking" || entry.clock.elapsed < duration;
}
function schedule(): void {
	if (!frame && !document.hidden && [...live].some((entry) => entry.ready && entry.visible && moving(entry))) {
		last = performance.now();
		frame = requestAnimationFrame(tick);
	}
}
function tick(now: number): void {
	frame = 0;
	if (document.hidden) return;
	const elapsed = (now - last) / 1000;
	last = now;
	const advanced = new Set<LiveMotion["clock"]>();
	for (const entry of live) {
		if (!entry.ready || !entry.visible || !entry.host.isConnected) continue;
		if (moving(entry) && !advanced.has(entry.clock)) {
			entry.clock.elapsed += elapsed;
			advanced.add(entry.clock);
		}
		paint(entry);
	}
	if ([...live].some((entry) => entry.ready && entry.visible && moving(entry))) frame = requestAnimationFrame(tick);
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
	const clockKey = `${options.identity ?? id + color}:${activity}`;
	const clock = clocks.get(clockKey) ?? { elapsed: 0, users: 0 };
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
				if (document.hidden && frame) {
					cancelAnimationFrame(frame);
					frame = 0;
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
				loaded.loadRecordedMotion(activity, base()),
				// Working borrows the Waiting clip's sideways glance between turns.
				activity === "Working" ? loaded.loadRecordedMotion("Waiting", base()) : undefined,
			]),
		),
	])
		.then(() => {
			if (!live.has(entry)) return;
			if (activity === "Working") clock.schedule ??= motion!.createWorkingSchedule();
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
			if (!live.size) {
				if (frame) cancelAnimationFrame(frame);
				frame = 0;
				visibility?.disconnect();
				sizes?.disconnect();
				lifetime?.abort();
				lifetime = undefined;
				eyesCanvas = undefined;
			}
		},
	};
}
