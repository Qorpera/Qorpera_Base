import type { FigureId } from "./avatar.ts";
import { figureArtwork } from "./avatar.ts";
import { h } from "./dom.ts";
import { type FigureArtwork, loadFigureMotion } from "./figure-motion.ts";

/*
 * The desktop the member is about to see, while an agent's computer sleeps or starts (COMPUTER-OPEN-BRIEF, 13 Nov
 * 2026; Jonas: "a better animation more in line with the qorpera style"). The screen is off and dark; on it the agent's
 * own figure, painted as the rail paints it, sleeps or wakes up: its eyes open, blink and glance with the product's
 * recorded eye motion while it waits. When the machine boots the screen lights up to the hour's tone, the figure
 * settles into the wallpaper's flat tone (the machine's own backdrop, drawn here from the same traced paths:
 * public/assets/desktop/backdrops, scripts/desktop-backdrops.mjs), and the dock's three icons arrive. The first real
 * picture then lands on the same scene.
 *
 * Every moving part is a transform or an opacity, by CSS animations and transitions or Web Animations: no frame loop
 * and no canvas drawn per frame. The avatar is painted once. A timer picks the next eye move; it stops while the scene
 * is hidden, detached or in a background tab. Reduced motion shows the still scene.
 */

/** What the scene shows: `off` (nothing known yet), `asleep`, `waking` (the wake on its way, or the machine waits for
 * room or hours), `starting` (placed and booting), `screen` (it runs, its screen is coming on), `settled` (a picture). */
export type ScenePhase = "off" | "asleep" | "waking" | "starting" | "screen" | "settled";

export interface SceneLook {
	/** The figure on the machine's backdrop: the agent's, or the Qorpera wordmark when it is not known. */
	readonly figure: FigureId | "neutral";
	/** The agent's colour, for its avatar before the screen comes on. */
	readonly color: string;
	/** The company's time zone (the machine's clock and backdrop follow it), else UTC as the machine does. */
	readonly timeZone: string | null | undefined;
}

/** The machine's backdrop rule (backdrops-source/*.html, light(h)): the ground's lightness by the hour. */
export function hourLight(hour: number): number {
	const ramp = (a: number, b: number, t: number) =>
		a + ((b - a) * (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, t))))) / 2;
	if (hour < 5) return 6;
	if (hour < 8) return ramp(6, 95, (hour - 5) / 3);
	if (hour < 18) return 95;
	if (hour < 21) return ramp(95, 6, (hour - 18) / 3);
	return 6;
}

/** The hour's ground and figure (hue 225, the figure five points off the ground), as the machine paints them. */
export function hourColours(hour: number): { ground: string; figure: string; figureLight: number } {
	const light = hourLight(hour);
	const dark = light < 50;
	const figure = dark ? light + 5.5 : light - 5;
	const saturation = dark ? 8 : 6;
	return {
		ground: `hsl(225 ${saturation}% ${light}%)`,
		figure: `hsl(225 ${saturation}% ${figure}%)`,
		figureLight: figure,
	};
}

/** The hour and the dock's date and time in the machine's zone (the company's, else UTC). */
export function desktopClock(
	now: Date,
	timeZone: string | null | undefined,
): { hour: number; date: string; time: string } {
	const read = (zone: string) => {
		const parts = Object.fromEntries(
			new Intl.DateTimeFormat("en-GB", {
				timeZone: zone,
				weekday: "short",
				day: "2-digit",
				month: "short",
				hour: "2-digit",
				minute: "2-digit",
				hourCycle: "h23",
			})
				.formatToParts(now)
				.map((part) => [part.type, part.value]),
		);
		return {
			hour: Number(parts.hour) % 24,
			date: `${parts.weekday} ${parts.day} ${parts.month}`,
			time: `${parts.hour}:${parts.minute}`,
		};
	};
	try {
		return read(timeZone || "UTC");
	} catch {
		return read("UTC");
	}
}

interface Backdrop {
	transform: string;
	evenodd: boolean;
	paths: { d: string; transform: string }[];
}
const backdrops = new Map<string, Promise<Backdrop | undefined>>();
/** One figure's backdrop paths, fetched once (about 5 KB). Nothing when they cannot be had: the scene shows no flat
 * figure then, and the live picture brings the real one. */
function backdrop(figure: string): Promise<Backdrop | undefined> {
	let loading = backdrops.get(figure);
	if (!loading) {
		loading = fetch(new URL(`./assets/desktop/backdrops/${figure}.json`, document.baseURI))
			.then(async (response) => (response.ok ? ((await response.json()) as Backdrop) : undefined))
			.catch(() => undefined)
			.then((value) => {
				if (!value) backdrops.delete(figure);
				return value;
			});
		backdrops.set(figure, loading);
	}
	return loading;
}

const SVG = "http://www.w3.org/2000/svg";
function svg<K extends keyof SVGElementTagNameMap>(
	tag: K,
	attrs: Record<string, string> = {},
	...children: SVGElement[]
): SVGElementTagNameMap[K] {
	const element = document.createElementNS(SVG, tag);
	for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
	element.append(...children);
	return element;
}

/** The dock's three icons, drawn as the machine draws them (deploy/lxd-company-computer-guest/design/dock-icons.js). */
const TILES = { browser: ["#5aa9ff", "#2563eb"], files: ["#ffd166", "#f59e0b"], terminal: ["#3b4252", "#1b1f2a"] };
let gradients = 0;
function dockIcon(name: keyof typeof TILES): HTMLElement {
	const [top, bottom] = TILES[name];
	const id = `computer-scene-dock-${name}-${++gradients}`;
	const glyph =
		name === "browser"
			? svg(
					"g",
					{ fill: "none", stroke: "#fff", "stroke-width": "5.5", "stroke-linecap": "round" },
					svg("circle", { cx: "56", cy: "48", r: "27" }),
					svg("ellipse", { cx: "56", cy: "48", rx: "12", ry: "27" }),
					svg("path", { d: "M29 48h54" }),
				)
			: name === "files"
				? svg(
						"g",
						{},
						svg("path", {
							d: "M27 34a6 6 0 0 1 6-6h14.5a6 6 0 0 1 4.6 2.2l3.4 4.1H79a6 6 0 0 1 6 6V66a6 6 0 0 1-6 6H33a6 6 0 0 1-6-6z",
							fill: "#fff",
							"fill-opacity": ".55",
						}),
						svg("path", {
							d: "M27 45a5 5 0 0 1 5-5h48a5 5 0 0 1 5 5v21a6 6 0 0 1-6 6H33a6 6 0 0 1-6-6z",
							fill: "#fff",
						}),
					)
				: svg(
						"g",
						{
							fill: "none",
							stroke: "#fff",
							"stroke-width": "6",
							"stroke-linecap": "round",
							"stroke-linejoin": "round",
						},
						svg("path", { d: "M32 33l16 15-16 15" }),
						svg("path", { d: "M56 64h24", stroke: "#7ee787" }),
					);
	const drawing = svg(
		"svg",
		{ viewBox: "0 0 112 112", "aria-hidden": "true" },
		svg(
			"defs",
			{},
			svg(
				"linearGradient",
				{ id, x1: "0", y1: "0", x2: "0", y2: "1" },
				svg("stop", { offset: "0", "stop-color": top as string }),
				svg("stop", { offset: "1", "stop-color": bottom as string }),
			),
		),
		svg("rect", { x: "10", y: "2", width: "92", height: "92", rx: "22", fill: `url(#${id})` }),
		svg("rect", {
			x: "10.75",
			y: "2.75",
			width: "90.5",
			height: "90.5",
			rx: "21.25",
			fill: "none",
			stroke: "#fff",
			"stroke-opacity": ".16",
			"stroke-width": "1.5",
		}),
		glyph,
	);
	return h("span", { class: "computer-scene-dock-icon" }, drawing);
}

/** One eye's pose in the product's eye-track units: x by the pair's spacing, y by the eye's height, its width and
 * height as fractions, its turn and its visibility. */
interface Eye {
	x: number;
	y: number;
	w: number;
	h: number;
	r: number;
	a: number;
}
const REST: Eye = { x: 0, y: 0, w: 1, h: 1, r: 0, a: 1 };
/** Shut: a lid line, a little lower, wider and bold enough to read at 400 px (round 3). */
const SHUT: Eye = { x: 0, y: 0.2, w: 1.16, h: 0.2, r: 0, a: 1 };
interface EyeMove {
	frames: [Eye, Eye][];
	ms: number;
	offsets?: number[];
	easing?: string;
}

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const between = (low: number, high: number) => low + Math.random() * (high - low);

/** Relative luminance of a #rrggbb colour (0 to 1). */
function luminance(hex: string): number {
	const channel = (index: number) => {
		const value = Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;
		return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/** Shut eyes on a light figure (gold, sky, a light palette colour) are a dark tone of its own colour; on the others,
 * white (round 3: white lids vanished on the crown, the star and the cloud). */
export function lidColour(color: string): string {
	if (!/^#[\da-f]{6}$/i.test(color) || luminance(color) < 0.32) return "#ffffff";
	const shade = (index: number) =>
		Math.round(Number.parseInt(color.slice(1 + index * 2, 3 + index * 2), 16) * 0.42)
			.toString(16)
			.padStart(2, "0");
	return `#${shade(0)}${shade(1)}${shade(2)}`;
}

const plates = new Map<string, Promise<void>>();
/** Paints the agent's avatar once, as the rail paints it (the product's light field in the agent's colour, its own
 * eyes covered by the face plate as figure-motion.ts prepares a body), and a grey copy at the hour's wallpaper tone that
 * keeps the shading: the figure loses its colour first, then flattens into the wallpaper (round 3). */
async function paintAvatar(
	artwork: FigureArtwork,
	figure: FigureId,
	color: string,
	colour: HTMLCanvasElement,
	grey: HTMLCanvasElement,
	greyLight: number,
): Promise<boolean> {
	let ready = plates.get(figure);
	if (!ready) {
		const load = async (name: string) => {
			const image = new Image();
			image.src = new URL(`./assets/avatars/status-2d-v1/${name}.webp`, document.baseURI).href;
			await image.decode();
			return image;
		};
		ready = Promise.all([load(figure), load(`${figure}-face`)])
			.then(async ([body, face]) => {
				await artwork.prepare(figure, body);
				await artwork.prepare(`${figure}-face`, face);
			})
			.catch((error: unknown) => {
				plates.delete(figure);
				throw error;
			});
		plates.set(figure, ready);
	}
	await ready;
	const source = artwork.drawable(figure, color);
	const plate = artwork.drawable(`${figure}-face`, color);
	colour.width = colour.height = 512;
	const ctx = colour.getContext("2d");
	if (!ctx) return false;
	ctx.drawImage(source, 0, 0, 512, 512);
	const patch = document.createElement("canvas");
	patch.width = patch.height = 512;
	const pc = patch.getContext("2d");
	if (!pc) return false;
	pc.scale(5.12, 5.12);
	pc.fillStyle = "#fff";
	pc.filter = "blur(1.5px)";
	for (const eye of artwork.faces[figure] ?? []) {
		const width = eye.width + 3.2;
		const height = eye.height + 3.2;
		pc.save();
		pc.translate(eye.x, eye.y);
		pc.rotate((eye.rotation * Math.PI) / 180);
		pc.beginPath();
		pc.roundRect(-width / 2, -height / 2, width, height, Math.min(width, height) / 2);
		pc.fill();
		pc.restore();
	}
	pc.setTransform(1, 0, 0, 1, 0, 0);
	pc.filter = "none";
	pc.globalCompositeOperation = "source-in";
	pc.drawImage(plate, 0, 0, 512, 512);
	pc.globalCompositeOperation = "destination-in";
	pc.drawImage(source, 0, 0, 512, 512);
	ctx.drawImage(patch, 0, 0);
	// The grey copy: each pixel's luminance moved to the wallpaper figure's tone, its shading kept at 60 %.
	grey.width = grey.height = 512;
	const gc = grey.getContext("2d", { willReadFrequently: true });
	if (!gc) return true;
	const pixels = ctx.getImageData(0, 0, 512, 512);
	const data = pixels.data;
	let sum = 0;
	let count = 0;
	for (let index = 0; index < data.length; index += 4) {
		if ((data[index + 3] as number) < 250) continue;
		sum +=
			0.2126 * (data[index] as number) + 0.7152 * (data[index + 1] as number) + 0.0722 * (data[index + 2] as number);
		count++;
	}
	const mean = count ? sum / count : 128;
	const target = (greyLight / 100) * 255;
	for (let index = 0; index < data.length; index += 4) {
		const value =
			0.2126 * (data[index] as number) + 0.7152 * (data[index + 1] as number) + 0.0722 * (data[index + 2] as number);
		const shaded = Math.max(0, Math.min(255, target + (value - mean) * 0.6));
		// The wallpaper's grey is cool (hue 225): a touch more blue.
		data[index] = shaded * 0.985;
		data[index + 1] = shaded * 0.99;
		data[index + 2] = Math.min(255, shaded * 1.02);
	}
	gc.putImageData(pixels, 0, 0);
	return true;
}

/** The scene of one computer window. */
export class ComputerScene {
	readonly el: HTMLElement;
	#look: SceneLook;
	#phase: ScenePhase = "off";
	#built: string | undefined;
	#eyes: HTMLElement[] = [];
	#faces: { x: number; y: number; width: number; height: number; rotation: number }[] = [];
	#moves: Animation[] = [];
	#timer: ReturnType<typeof setTimeout> | undefined;
	#motion: Awaited<ReturnType<typeof loadFigureMotion>> | undefined;
	readonly #screen = h("div", { class: "computer-scene-screen" });
	readonly #line = h("span", { class: "computer-scene-line" });
	readonly #lineShort = h("span", { class: "computer-scene-line is-short" });
	readonly #lineSide = h("span", { class: "computer-scene-line is-side" });
	readonly #note = h("p", { class: "computer-scene-note" });
	readonly #stop = new AbortController();

	constructor(look: SceneLook) {
		this.#look = look;
		this.el = h("div", { class: "computer-scene", hidden: true, "aria-hidden": "true" }, this.#screen);
		this.el.dataset.phase = "off";
		document.addEventListener("visibilitychange", () => this.#visibility(), { signal: this.#stop.signal });
	}

	get phase(): ScenePhase {
		return this.#phase;
	}

	/** Whose desktop it is (the figure, its colour, the company's zone): drawn anew when the figure or colour changed. */
	look(look: SceneLook): void {
		this.#look = look;
	}

	/** The window's words as the scene shows them (the window's own text carries them for screen readers): one line in
	 * the dock, its short form for a small window, and the full sentence of a wait under the figure in a large one. */
	say(line: string, short = "", note = ""): void {
		this.#line.textContent = line;
		this.#lineSide.textContent = line;
		this.#lineShort.textContent = short;
		this.el.dataset.short = short ? "true" : "false";
		this.#note.textContent = note;
		this.#note.hidden = !note;
	}

	/** Shows the scene in a phase. Nothing is skipped backwards but sleep: a machine may fall asleep again. */
	set(phase: ScenePhase): void {
		this.el.hidden = false;
		this.#build();
		if (phase === this.#phase) return;
		const from = this.#phase;
		this.#phase = phase;
		this.el.dataset.phase = phase;
		clearTimeout(this.#timer);
		if (phase === "off" || phase === "asleep") {
			this.#pose(SHUT);
			return;
		}
		if (phase === "settled") {
			this.#stopEyes();
			return;
		}
		if (from === "off" || from === "asleep" || from === "settled") this.#wake();
		else if (phase === "starting") this.#lookAtDock();
		else this.#live(2500);
	}

	/** The scene goes: a picture is up (after its cross-fade), or the window shows a state the scene does not draw. */
	hide(): void {
		clearTimeout(this.#timer);
		this.#stopEyes();
		this.el.hidden = true;
		this.#phase = "settled";
		this.el.dataset.phase = "settled";
	}

	dispose(): void {
		this.hide();
		this.#stop.abort();
	}

	/** Builds the screen for the look: the dark screen, the hour's frame, the avatar, the eyes and the dock. */
	#build(): void {
		const now = desktopClock(new Date(), this.#look.timeZone);
		const key = `${this.#look.figure}|${this.#look.color}|${now.hour}`;
		if (this.#built === key) return;
		this.#built = key;
		this.#stopEyes();
		const night = hourColours(0);
		const hour = hourColours(now.hour);
		const { figure } = this.#look;
		const off = h("div", { class: "computer-scene-ground is-off" });
		off.style.background = night.ground;
		const ground = h("div", { class: "computer-scene-ground" });
		ground.style.background = hour.ground;
		const flatOn = svg("svg", {
			class: "computer-scene-flat is-on",
			viewBox: "0 0 1920 1200",
			preserveAspectRatio: "none",
		});
		const flatOff = svg("svg", {
			class: "computer-scene-flat is-off",
			viewBox: "0 0 1920 1200",
			preserveAspectRatio: "none",
		});
		void backdrop(figure).then((paths) => {
			if (!paths || this.#built !== key) return;
			const group = (fill: string) =>
				svg(
					"g",
					{ transform: paths.transform, fill, "fill-rule": paths.evenodd ? "evenodd" : "nonzero" },
					...paths.paths.map((path) =>
						svg("path", { d: path.d, ...(path.transform ? { transform: path.transform } : {}) }),
					),
				);
			flatOn.append(group(hour.figure));
			flatOff.append(group("hsl(225 8% 15.5%)"));
		});
		const artwork = figure === "neutral" ? undefined : figureArtwork();
		const colour = h("canvas", { class: "computer-scene-avatar-art is-colour" });
		const grey = h("canvas", { class: "computer-scene-avatar-art is-grey" });
		const avatar = h("div", { class: "computer-scene-avatar" }, grey, colour);
		this.el.dataset.avatar = "false";
		if (artwork && figure !== "neutral")
			void paintAvatar(artwork, figure, this.#look.color, colour, grey, hour.figureLight)
				.then((painted) => {
					if (painted && this.#built === key) this.el.dataset.avatar = "true";
				})
				.catch(() => undefined);
		this.#faces = figure === "neutral" ? [] : (artwork?.faces[figure] ?? []);
		const eyes = h("div", { class: "computer-scene-eyes" });
		this.#eyes = this.#faces.map((face) => {
			const shape = h("span", { class: "computer-scene-eye-shape" });
			const box = h("span", { class: "computer-scene-eye" }, shape);
			box.style.left = `${face.x}%`;
			box.style.top = `${face.y}%`;
			box.style.width = `${face.width}%`;
			box.style.height = `${face.height}%`;
			box.style.rotate = `${face.rotation}deg`;
			eyes.append(box);
			return shape;
		});
		this.el.style.setProperty("--computer-scene-lid", lidColour(this.#look.color));
		const body = h(
			"div",
			{ class: `computer-scene-body${figure === "neutral" ? " is-neutral" : ""}` },
			flatOn,
			flatOff,
			avatar,
			eyes,
		);
		const date = h("span", { class: "computer-scene-date" }, now.date);
		const time = h("span", { class: "computer-scene-time" }, now.time);
		const dock = h(
			"div",
			{ class: "computer-scene-dock" },
			date,
			h("span", { class: "computer-scene-icons" }, dockIcon("browser"), dockIcon("files"), dockIcon("terminal")),
			time,
			this.#line,
			this.#lineShort,
			this.#lineSide,
		);
		this.#screen.replaceChildren(ground, off, body, dock, this.#note);
		this.#pose(this.#phase === "off" || this.#phase === "asleep" ? SHUT : REST);
	}

	#wake(): void {
		if (reduced() || !this.#eyes.length) {
			this.#pose(REST);
			return;
		}
		void this.#recorded("Idle", 0, 3.7).then((move) => {
			if (!move || this.#phase === "asleep" || this.#phase === "off" || this.#phase === "settled") return;
			this.#play(move, () => (this.#phase === "starting" ? this.#lookAtDock() : this.#live(1500)));
		});
	}

	/** The eyes go down to the dock as its icons arrive, and back. */
	#lookAtDock(): void {
		if (reduced() || !this.#eyes.length) return;
		this.#play(this.#glance(0, 0.95, 1.6), () => this.#live(2200));
	}

	/** The calm loop while it waits: a blink, a glance, now and then a look at the dock or the recorded wait. */
	#live(after = between(3200, 6500)): void {
		clearTimeout(this.#timer);
		if (reduced() || !this.#eyes.length || !["waking", "starting", "screen"].includes(this.#phase)) return;
		this.#timer = setTimeout(() => {
			if (document.visibilityState === "hidden" || !this.el.isConnected || this.el.hidden) {
				this.#live();
				return;
			}
			const roll = Math.random();
			if (roll >= 0.86) {
				void this.#recorded("Waiting", 0, 4.6, true).then((move) => {
					if (move && ["waking", "starting", "screen"].includes(this.#phase)) this.#play(move, () => this.#live());
					else this.#live();
				});
				return;
			}
			this.#play(
				roll < 0.42
					? this.#blink()
					: roll < 0.68
						? this.#glance(between(-0.7, 0.7), between(-0.5, 0.15), between(1.4, 2.2))
						: this.#glance(between(-0.15, 0.15), 0.95, 1.8),
				() => this.#live(),
			);
		}, after);
	}

	/** The product's recorded eye motion (its eye tracks) from `from` to `to` seconds, at 30 frames a second. */
	async #recorded(clip: "Idle" | "Waiting", from: number, to: number, back = false): Promise<EyeMove | undefined> {
		try {
			this.#motion ??= await loadFigureMotion();
		} catch {
			return undefined;
		}
		const frames: [Eye, Eye][] = [];
		for (let seconds = from; seconds <= to; seconds += 1 / 30) {
			const face = this.#motion.pose(clip, seconds).face;
			const eye = (index: number): Eye => {
				const value = face[index];
				return value
					? { x: value.x, y: value.y, w: value.width, h: value.height, r: value.rotation, a: value.alpha }
					: REST;
			};
			frames.push([eye(0), eye(1)]);
		}
		if (back) frames.push([REST, REST], [REST, REST]);
		return { frames, ms: (frames.length * 1000) / 30 };
	}

	#blink(): EyeMove {
		const shut: Eye = { x: 0, y: 0.05, w: 1.05, h: 0.1, r: 0, a: 1 };
		return {
			frames: [
				[REST, REST],
				[shut, shut],
				[REST, REST],
			],
			ms: 190,
			offsets: [0, 0.42, 1],
		};
	}

	#glance(x: number, y: number, seconds: number): EyeMove {
		const at: Eye = { x, y, w: 1, h: 1 - Math.abs(y) * 0.12, r: 0, a: 1 };
		return {
			frames: [
				[REST, REST],
				[at, at],
				[at, at],
				[REST, REST],
			],
			ms: seconds * 1000,
			offsets: [0, 0.16, 0.78, 1],
			easing: "ease-in-out",
		};
	}

	/** An eye's transform in its own box (the box is the eye's size, so a percentage is the figure's own unit). */
	#keyframe(eye: Eye, index: number): Keyframe {
		const faces = this.#faces;
		const face = faces[index];
		if (!face || faces.length < 2) return {};
		const spacing = (faces[1]?.x ?? 0) - (faces[0]?.x ?? 0);
		const height = ((faces[0]?.height ?? 0) + (faces[1]?.height ?? 0)) / 2;
		const dx = ((eye.x * spacing) / face.width) * 100;
		const dy = ((eye.y * height) / face.height) * 100;
		return {
			transform: `translate(${dx}%, ${dy}%) rotate(${eye.r}deg) scale(${Math.max(0.03, eye.w)}, ${Math.max(0.03, eye.h)})`,
			opacity: String(eye.a),
		};
	}

	#play(move: EyeMove, done: () => void): void {
		this.#stopEyes(true);
		if (typeof Element.prototype.animate !== "function") {
			done();
			return;
		}
		this.#moves = this.#eyes.map((shape, index) =>
			shape.animate(
				move.frames.map((pair, frame) => ({
					...this.#keyframe(pair[index] as Eye, index),
					...(move.offsets ? { offset: move.offsets[frame] } : {}),
				})),
				{ duration: move.ms, easing: move.easing ?? "linear", fill: "forwards" },
			),
		);
		const first = this.#moves[0];
		if (document.visibilityState === "hidden") for (const animation of this.#moves) animation.pause();
		first?.finished.then(done, () => undefined);
	}

	#stopEyes(keep = false): void {
		for (const animation of this.#moves) {
			if (keep) {
				try {
					animation.commitStyles();
				} catch {
					// An element not rendered keeps its last pose as it was.
				}
			}
			animation.cancel();
		}
		this.#moves = [];
	}

	#pose(eye: Eye): void {
		this.#stopEyes();
		this.#eyes.forEach((shape, index) => {
			const frame = this.#keyframe(eye, index);
			shape.style.transform = String(frame.transform ?? "");
			shape.style.opacity = String(frame.opacity ?? "1");
		});
	}

	#visibility(): void {
		const hidden = document.visibilityState === "hidden";
		this.el.classList.toggle("is-paused", hidden);
		for (const animation of this.#moves) hidden ? animation.pause() : animation.play();
	}
}
