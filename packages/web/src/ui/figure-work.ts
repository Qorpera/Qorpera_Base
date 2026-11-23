import type { BodyPose, EyePose } from "./figure-acts.ts";

export type Paint = (ctx: CanvasRenderingContext2D) => void;
export interface Point {
	x: number;
	y: number;
}
interface Placed extends Point {
	front: boolean;
}
export interface Box {
	top: number;
	bot: number;
	lef: number;
	rig: number;
	cx: number;
	cy: number;
	w: number;
	h: number;
}
export interface EyeSpot {
	x: number;
	y: number;
	height: number;
}
export interface Shape {
	box: Box;
	prof: number[];
	lprof: number[];
	edge: [number, number][];
	look: Point;
	spacing: number;
	eyeHeight: number;
	top: Point;
	low: Point;
}
interface Tint {
	soft: string;
	ink: string;
}
export interface WorkFrame {
	body: BodyPose;
	eyes: [EyePose, EyePose];
	behind: Paint[];
	front: Paint[];
	over: Paint[];
}
interface FxFrame {
	behind?: Paint[];
	front?: Paint[];
	over?: Paint[];
	body?: BodyPose;
	look?: Point;
	lw?: number;
}
interface Fx {
	dur: number;
	run(s: number, t: number, shape: Shape, n: number): FxFrame;
}

export const AIR_MARGIN = 25;
const TAU = Math.PI * 2;
const STILL: BodyPose = Object.freeze({ x: 0, y: 0, turn: 0, scaleX: 1, scaleY: 1 });
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const seg = (u: number, a: number, b: number) => clamp((u - a) / (b - a));
const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const easeOut = (x: number) => 1 - (1 - x) ** 3;
const easeIn = (x: number) => x * x * x;
const back = (x: number) => 1 + 2.5 * (x - 1) ** 3 + 1.5 * (x - 1) ** 2;
const bump = (u: number, a: number, b: number) => {
	const x = seg(u, a, b);
	return x <= 0 || x >= 1 ? 0 : Math.sin(Math.PI * x);
};
const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
const ramped = (u: number, a: number, b: number, ramp = 0.35) =>
	u < a || u > b ? 0 : clamp(Math.min((u - a) / ramp, (b - u) / ramp));
const cycle = (t: number, length: number) => ({ u: ((t % length) + length) % length, n: Math.floor(t / length) });
export function hash(n: number): number {
	const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
	return x - Math.floor(x);
}

const channels = (hex: string) =>
	/^#[\da-f]{6}$/i.test(hex) ? [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) : [136, 136, 136];
const toHex = (values: number[]) =>
	`#${values
		.map((v) =>
			Math.round(clamp(v, 0, 255))
				.toString(16)
				.padStart(2, "0"),
		)
		.join("")}`;
export function mix(a: string, b: string, f: number): string {
	const from = channels(a),
		to = channels(b);
	return toHex(from.map((v, i) => lerp(v, to[i]!, f)));
}
function saturate(hex: string, k = 1.6, dl = -0.06): string {
	const [r, g, b] = channels(hex).map((v) => v / 255) as [number, number, number];
	const mx = Math.max(r, g, b),
		mn = Math.min(r, g, b);
	let h = 0,
		sat = 0,
		l = (mx + mn) / 2;
	if (mx !== mn) {
		const d = mx - mn;
		sat = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
		h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
		h /= 6;
	}
	sat = Math.min(1, sat * k);
	l = clamp(l + dl, 0.2, 0.8);
	const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat,
		p = 2 * l - q;
	const f = (t: number) => {
		const x = (t + 1) % 1;
		return x < 1 / 6 ? p + (q - p) * 6 * x : x < 0.5 ? q : x < 2 / 3 ? p + (q - p) * (2 / 3 - x) * 6 : p;
	};
	return toHex([f(h + 1 / 3), f(h), f(h - 1 / 3)].map((v) => v * 255));
}
export function tintOf(color: string): Tint {
	const ink = saturate(color);
	return { ink, soft: mix(ink, "#ffffff", 0.45) };
}

let unit = 1;
let tint: Tint = tintOf("#888888");
const minW = (w: number) => Math.max(w, 1.1 / unit);
function glow(c: CanvasRenderingContext2D, color: string, px: number): void {
	if (unit < 0.75) return;
	c.shadowColor = color;
	c.shadowBlur = Math.min(4, px * unit * 0.5);
}
function sparkle(c: CanvasRenderingContext2D, x: number, y: number, r: number, rot: number, col: string, a = 1): void {
	if (r <= 0.01 || a <= 0.001) return;
	c.save();
	c.translate(x, y);
	c.rotate(rot);
	c.globalAlpha *= a;
	c.fillStyle = col;
	c.beginPath();
	for (let i = 0; i < 4; i++) {
		const p = (i * Math.PI) / 2,
			n = ((i + 1) * Math.PI) / 2,
			m = (p + n) / 2;
		if (i === 0) c.moveTo(Math.cos(p) * r, Math.sin(p) * r);
		c.quadraticCurveTo(Math.cos(m) * r * 0.16, Math.sin(m) * r * 0.16, Math.cos(n) * r, Math.sin(n) * r);
	}
	c.fill();
	c.restore();
}
function sparkleGlow(
	c: CanvasRenderingContext2D,
	x: number,
	y: number,
	r: number,
	rot: number,
	col: string,
	a: number,
	glowCol: string,
): void {
	if (r <= 0.02 || a <= 0) return;
	c.save();
	glow(c, glowCol, r * 1.4);
	sparkle(c, x, y, r, rot, col, a);
	c.restore();
}
function glowOf(c: CanvasRenderingContext2D, x: number, y: number, r: number, inner: string, outer: string): void {
	c.save();
	const g = c.createRadialGradient(x, y, 0, x, y, r);
	g.addColorStop(0, inner);
	g.addColorStop(0.3, outer);
	g.addColorStop(1, "rgba(255,255,255,0)");
	c.fillStyle = g;
	c.beginPath();
	c.arc(x, y, r, 0, TAU);
	c.fill();
	c.restore();
}
const ring =
	(cx: number, cy: number, rx: number, ry: number, tilt: number) =>
	(a: number): Placed => {
		const ct = Math.cos(tilt),
			st = Math.sin(tilt),
			x0 = Math.cos(a) * rx,
			y0 = Math.sin(a) * ry;
		return { x: cx + x0 * ct - y0 * st, y: cy + x0 * st + y0 * ct, front: Math.sin(a) > 0 };
	};
interface Stroke {
	width: number;
	alpha: number;
	color: (f: number) => string;
}
function path(
	c: CanvasRenderingContext2D,
	at: (a: number) => Placed,
	head: number,
	len: number,
	st: Stroke,
	front: boolean,
	dir = 1,
): void {
	const N = 72;
	let prev: Placed | undefined;
	c.save();
	c.lineCap = "round";
	for (let j = 0; j <= N; j++) {
		const f = j / N,
			p = at(head - dir * len * (1 - f));
		if (prev && p.front === front) {
			c.lineWidth = minW(st.width * (0.12 + 0.88 * f ** 0.7));
			c.globalAlpha = st.alpha * f ** 0.6;
			c.strokeStyle = st.color(f);
			c.beginPath();
			c.moveTo(prev.x, prev.y);
			c.lineTo(p.x, p.y);
			c.stroke();
		}
		prev = p;
	}
	c.restore();
}
function smokePuff(c: CanvasRenderingContext2D, x: number, y: number, r: number, a: number): void {
	c.save();
	c.globalAlpha = a;
	for (const [dx, dy, k] of [
		[0, 0, 1],
		[-0.55, 0.2, 0.7],
		[0.5, 0.25, 0.75],
	] as const) {
		const R = r * k,
			cx = x + dx * r,
			cy = y + dy * r,
			g = c.createRadialGradient(cx - R * 0.3, cy - R * 0.35, 0, cx, cy, R);
		g.addColorStop(0, "rgba(255,255,255,0.98)");
		g.addColorStop(0.6, "rgba(232,227,221,0.9)");
		g.addColorStop(1, "rgba(214,207,199,0)");
		c.fillStyle = g;
		c.beginPath();
		c.arc(cx, cy, R, 0, TAU);
		c.fill();
	}
	c.restore();
}
function cotyledon(c: CanvasRenderingContext2D, x: number, y: number, len: number, rot: number): void {
	c.save();
	c.translate(x, y);
	c.rotate(rot);
	const g = c.createLinearGradient(0, -len * 0.3, 0, len * 0.3);
	g.addColorStop(0, "#9bd36a");
	g.addColorStop(1, "#4f9a35");
	c.fillStyle = g;
	c.beginPath();
	c.moveTo(0, 0);
	c.bezierCurveTo(len * 0.25, -len * 0.42, len * 0.9, -len * 0.4, len, 0);
	c.bezierCurveTo(len * 0.85, len * 0.3, len * 0.3, len * 0.28, 0, 0);
	c.fill();
	c.restore();
}
function zigzag(
	c: CanvasRenderingContext2D,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	n: number,
	amp: number,
	seed: number,
): void {
	c.beginPath();
	c.moveTo(x0, y0);
	const dx = x1 - x0,
		dy = y1 - y0,
		L = Math.hypot(dx, dy) || 1,
		nx = -dy / L,
		ny = dx / L;
	for (let i = 1; i < n; i++) {
		const f = i / n,
			o = (hash(seed + i * 1.7) - 0.5) * 2 * amp;
		c.lineTo(x0 + dx * f + nx * o, y0 + dy * f + ny * o);
	}
	c.lineTo(x1, y1);
}
function boltLine(
	c: CanvasRenderingContext2D,
	from: Point,
	to: Point,
	seed: number,
	a: number,
	wide: number,
	n = 7,
	amp = 2.8,
): void {
	c.save();
	c.lineCap = "round";
	c.lineJoin = "round";
	c.globalAlpha = a;
	glow(c, "#ffb800", 8);
	c.strokeStyle = "#ffc21a";
	c.lineWidth = minW(wide);
	zigzag(c, from.x, from.y, to.x, to.y, n, amp, seed);
	c.stroke();
	c.shadowBlur = 0;
	c.strokeStyle = "#fffbe6";
	c.lineWidth = minW(wide * 0.38);
	zigzag(c, from.x, from.y, to.x, to.y, n, amp, seed);
	c.stroke();
	c.restore();
}
function ecg(s: number): number {
	const gs = (m: number, w: number, h: number) => h * Math.exp(-((s - m) * (s - m)) / (2 * w * w));
	return (
		gs(0.12, 0.03, 1.4) + gs(0.28, 0.008, -1.4) + gs(0.31, 0.011, 9) + gs(0.345, 0.012, -2.8) + gs(0.56, 0.05, 2.4)
	);
}
function dot(
	c: CanvasRenderingContext2D,
	x: number,
	y: number,
	r: number,
	color: string,
	glowColor: string,
	a: number,
) {
	c.save();
	c.globalAlpha = a;
	glow(c, glowColor, 3);
	c.fillStyle = color;
	c.beginPath();
	c.arc(x, y, Math.max(r, 0.7 / unit), 0, TAU);
	c.fill();
	c.restore();
}

export function applyBody(c: CanvasRenderingContext2D, b: BodyPose): void {
	c.translate(50 + b.x, 90 + b.y);
	c.rotate((b.turn * Math.PI) / 180);
	c.scale(b.scaleX, b.scaleY);
	c.translate(-50, -90);
}
function bodyPoint(b: BodyPose, x: number, y: number): Point {
	const r = (b.turn * Math.PI) / 180,
		dx = (x - 50) * b.scaleX,
		dy = (y - 90) * b.scaleY;
	return { x: 50 + b.x + dx * Math.cos(r) - dy * Math.sin(r), y: 90 + b.y + dx * Math.sin(r) + dy * Math.cos(r) };
}

export function shapeOf(source: CanvasImageSource, eyes: readonly EyeSpot[]): Shape {
	const canvas = document.createElement("canvas");
	canvas.width = canvas.height = 100;
	const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
	ctx.drawImage(source, 0, 0, 100, 100);
	const data = ctx.getImageData(0, 0, 100, 100).data;
	const solid = (x: number, y: number) => (data[(y * 100 + x) * 4 + 3] ?? 0) > 160;
	let top = 100,
		bot = 0,
		lef = 100,
		rig = 0;
	for (let y = 0; y < 100; y++)
		for (let x = 0; x < 100; x++)
			if (solid(x, y)) {
				top = Math.min(top, y);
				bot = Math.max(bot, y);
				lef = Math.min(lef, x);
				rig = Math.max(rig, x);
			}
	if (bot < top) {
		top = 20;
		bot = 90;
		lef = 20;
		rig = 80;
	}
	const prof: number[] = [],
		lprof: number[] = [],
		edge: [number, number][] = [];
	for (let x = 0; x < 100; x++) {
		let y = 0;
		while (y < 100 && !solid(x, y)) y++;
		prof.push(y);
	}
	for (let y = 0; y < 100; y++) {
		let x = 0;
		while (x < 100 && !solid(x, y)) x++;
		lprof.push(x);
	}
	for (let y = 1; y < 99; y++)
		for (let x = 1; x < 99; x++)
			if (solid(x, y) && (!solid(x - 1, y) || !solid(x + 1, y) || !solid(x, y - 1) || !solid(x, y + 1)))
				edge.push([x, y]);
	const box = { top, bot, lef, rig, cx: (lef + rig) / 2, cy: (top + bot) / 2, w: rig - lef, h: bot - top };
	let peak = { x: box.cx, y: 999 };
	for (let x = lef; x <= rig; x++) if (prof[x]! < peak.y) peak = { x, y: prof[x]! };
	let end = peak.x;
	while (prof[end + 1] === peak.y) end++;
	let low: [number, number] = [box.cx, bot];
	for (const e of edge) if (e[1] > low[1] - 0.01 && (e[1] > low[1] || e[0] < low[0])) low = e;
	const [left, right] = eyes;
	return {
		box,
		prof,
		lprof,
		edge: edge.length ? edge : [[box.cx, top]],
		look: left && right ? { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 } : { x: box.cx, y: box.cy },
		spacing: left && right ? Math.max(1, right.x - left.x) : 12,
		eyeHeight: left && right ? Math.max(1, (left.height + right.height) / 2) : 14,
		top: { x: (peak.x + end) / 2, y: peak.y },
		low: { x: low[0], y: low[1] },
	};
}
function edgeAt(shape: Shape, a: number): Point {
	const { box } = shape;
	let best = shape.edge[0]!,
		bd = 9;
	for (const e of shape.edge) {
		const d = Math.abs(((Math.atan2(e[1] - box.cy, e[0] - box.cx) - a + 3 * Math.PI) % TAU) - Math.PI);
		const farther = Math.hypot(e[0] - box.cx, e[1] - box.cy) > Math.hypot(best[0] - box.cx, best[1] - box.cy);
		if (d < bd - 0.02 || (Math.abs(d - bd) <= 0.02 && farther)) {
			bd = d;
			best = e;
		}
	}
	return { x: best[0], y: best[1] };
}

function slowBlink(u: number, t: number, close: number, hold: number, open: number): number {
	if (u < t || u > t + close + hold + open) return 1;
	if (u < t + close) return 1 - 0.9 * ease((u - t) / close);
	if (u < t + close + hold) return 0.1;
	return 0.1 + 0.9 * ease((u - t - close - hold) / open);
}
const SPOTS: readonly Point[] = [
	{ x: 0, y: 0 },
	{ x: 2.2, y: -1.4 },
	{ x: -2, y: 0.8 },
	{ x: 1.4, y: 1.4 },
	{ x: -1.6, y: -1.8 },
];
function glances(t: number): { x: number; y: number; open: number } {
	const { u, n } = cycle(t, 4.2);
	const a = SPOTS[Math.floor(hash(n) * 5)]!,
		b = SPOTS[Math.floor(hash(n + 1) * 5)]!,
		f = ease(seg(u, 3.45, 3.8));
	return { x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f), open: slowBlink(u, 3.25, 0.25, 0.3, 0.4) };
}
const lookToward = (shape: Shape, p: Point, w: number): Point => ({
	x: clamp((p.x - shape.look.x) / 14, -2.4, 2.4) * w,
	y: clamp((p.y - shape.look.y) / 14, -2, 2) * w,
});

interface ThreadPath {
	dur: number;
	turns: number;
	dir: number;
	start: number;
	at: (a: number) => Placed;
}
export function threadPath(shape: Shape, k: number): ThreadPath {
	const r = (j: number) => hash(k * 7.13 + j);
	const { box } = shape;
	const dir = r(4) > 0.5 ? 1 : -1,
		start = dir > 0 ? -1.4 : Math.PI + 1.4;
	if (k % 3 === 2)
		return {
			dur: 2.6,
			turns: 1.15,
			dir,
			start,
			at: (a) => ring(box.cx, box.cy, 54, 13, lerp(-0.25, 1.35, ease(clamp((dir * (a - start)) / (TAU * 1.15)))))(a),
		};
	return {
		dur: lerp(2.0, 2.6, r(5)),
		turns: lerp(1.0, 1.25, r(6)),
		dir,
		start,
		at: ring(box.cx, box.cy + lerp(-10, 6, r(2)), 55, lerp(10, 16, r(3)), lerp(-0.45, 0.4, r(1))),
	};
}
function threadPass(s: number, shape: Shape, k: number): { look: Point; w: number; behind: Paint; front: Paint } {
	const o = threadPath(shape, k),
		t0 = 0.2,
		p = seg(s, t0, t0 + o.dur);
	const head = o.start + o.dir * easeOut(p) * TAU * o.turns,
		len = 2.4 * Math.sin(Math.PI * p),
		tip = o.at(head),
		w = bump(s, t0 - 0.2, t0 + o.dur + 0.4);
	const on = p > 0 && p < 1;
	const { soft, ink } = tint;
	const style: Stroke = { width: 2.2, alpha: 0.95, color: (f) => mix(soft, ink, f) };
	const draw = (front: boolean) => (c: CanvasRenderingContext2D) => {
		if (on) path(c, o.at, head, len, style, front, o.dir);
	};
	return { look: lookToward(shape, tip, w), w, behind: draw(false), front: draw(true) };
}

const sprout: Fx = {
	dur: 5.4,
	run(s, _t, shape) {
		const N = shape.top,
			g = ease(seg(s, 0.1, 1.3)) * (1 - ease(seg(s, 4.3, 5.1))),
			open = back(seg(s, 1.0, 1.7)) * (1 - ease(seg(s, 3.9, 4.5)));
		const sway = 0.1 * Math.sin(s * 2.1) * open,
			x = N.x,
			y = N.y + 2,
			h = 19 * g;
		return {
			look: { x, y: y - h - 4 },
			lw: bump(s, 0, 5.0),
			front: [
				(c) => {
					if (g <= 0.01) return;
					c.save();
					c.translate(x, y);
					c.rotate(sway);
					c.strokeStyle = "#4f8f33";
					c.lineCap = "round";
					c.lineWidth = minW(2.8);
					c.beginPath();
					c.moveTo(0, 0);
					c.quadraticCurveTo(-3.6, -h * 0.55, 0.8, -h);
					c.stroke();
					c.strokeStyle = "#7cc24f";
					c.lineWidth = minW(0.9);
					c.beginPath();
					c.moveTo(-0.7, -1);
					c.quadraticCurveTo(-4.1, -h * 0.55, 0.2, -h + 0.5);
					c.stroke();
					if (open > 0.02) {
						cotyledon(c, 0.8, -h, 13 * open, Math.PI + 0.5 - 0.25 * open);
						cotyledon(c, 0.8, -h, 13 * open, -0.5 + 0.25 * open);
					}
					c.restore();
				},
			],
		};
	},
};

function tongue(c: CanvasRenderingContext2D, x: number, y: number, h: number, w: number, a: number): void {
	if (h <= 0.2 || a <= 0) return;
	c.save();
	c.globalAlpha = a;
	glow(c, "#ff9a1a", 5);
	const g = c.createLinearGradient(x, y, x, y - h);
	g.addColorStop(0, "#ffd84a");
	g.addColorStop(0.6, "#ff9f1c");
	g.addColorStop(1, "rgba(255,110,30,0.2)");
	c.fillStyle = g;
	c.beginPath();
	c.moveTo(x, y - h);
	c.bezierCurveTo(x + w * 0.2, y - h * 0.6, x + w * 0.7, y - h * 0.3, x + w * 0.5, y);
	c.bezierCurveTo(x + w * 0.3, y + w * 0.35, x - w * 0.3, y + w * 0.35, x - w * 0.5, y);
	c.bezierCurveTo(x - w * 0.7, y - h * 0.3, x - w * 0.2, y - h * 0.6, x, y - h);
	c.fill();
	c.restore();
}
const flare: Fx = {
	dur: 3.8,
	run(s, t, shape, n) {
		const tip = shape.top,
			{ box } = shape,
			halo = bump(s, 0, 2.0);
		const licks = [0.05, 0.4, 0.75, 1.1].map((t0, i) => {
			const q = seg(s, t0, t0 + 1.0);
			return {
				q,
				x: tip.x + (i % 2 ? 2.5 : -2) + 2.5 * Math.sin(q * 6 + i),
				y: tip.y + 7 - 13 * easeIn(q),
				h: (17 - 1.5 * i) * Math.sin(Math.PI * Math.min(1, q * 1.15)),
				w: 9 - i,
			};
		});
		return {
			look: { x: tip.x, y: tip.y - 16 },
			lw: 0.8 * bump(s, 0.1, 3.4),
			behind: [
				(c) => {
					if (halo <= 0) return;
					const R = box.w * 0.5,
						outer = R + 16 * halo,
						g = c.createRadialGradient(box.cx, box.cy + 2, R * 0.7, box.cx, box.cy + 2, outer);
					g.addColorStop(0, `rgba(255,206,90,${0.95 * halo})`);
					g.addColorStop(0.5, `rgba(255,170,60,${0.45 * halo})`);
					g.addColorStop(1, "rgba(255,150,50,0)");
					c.fillStyle = g;
					c.beginPath();
					c.arc(box.cx, box.cy + 2, outer, 0, TAU);
					c.fill();
				},
			],
			front: [
				(c) => {
					for (const L of licks) if (L.q > 0 && L.q < 1) tongue(c, L.x, L.y, L.h, L.w, (1 - L.q) ** 0.7);
					for (let i = 0; i < 12; i++) {
						const t0 = 0.15 + i * 0.13,
							p = seg(s, t0, t0 + 1.8);
						if (p <= 0 || p >= 1) continue;
						const side = i % 2 ? 1 : -1,
							x = tip.x + side * (2 + 20 * hash(n * 9 + i) * easeOut(p)) + 4 * Math.sin(p * 5 + i * 1.7) * p,
							y = tip.y + 2 - 23 * easeOut(p) * (0.7 + 0.4 * hash(i * 3 + n)),
							r = (1.9 + 1.4 * hash(i + n * 5)) * (1 - 0.55 * p);
						const col = p < 0.3 ? mix("#fff0a0", "#ffb020", p / 0.3) : mix("#ff9a1a", "#d43c12", (p - 0.3) / 0.7);
						const flicker = 0.8 + 0.2 * Math.sin(t * 25 + i * 4);
						c.save();
						c.globalAlpha = Math.min(1, p * 8) * (1 - p) ** 0.8 * flicker;
						glow(c, "#ff8a1f", 6);
						c.fillStyle = col;
						c.beginPath();
						c.arc(x, y, Math.max(r, 0.8 / unit), 0, TAU);
						c.fill();
						c.restore();
					}
				},
			],
		};
	},
};
const sparks: Fx = {
	dur: 2.8,
	run(s, _t, shape, n) {
		const { box } = shape,
			G = box.bot,
			first = hash(n) > 0.5 ? 1 : -1;
		const list: [number, number][] = [
			[0.15, first],
			[0.75, -first],
			[1.2, first],
		];
		let lookP: Point | undefined,
			lw = 0;
		const draws = list.map(([t0, side], j): Paint => {
			const big = j !== 2,
				x0 = box.cx + side * box.w * 0.42,
				y0 = box.cy - 4 + j * 4,
				reach = big ? 34 : 22,
				lift = big ? 26 : 16,
				p = seg(s, t0, t0 + 0.95);
			const pos = (q: number) => ({
				x: x0 + side * reach * q,
				y: y0 - lift * Math.sin(Math.PI * q * 0.8) + 34 * q * q,
			});
			const land = pos(1),
				b = seg(s, t0 + 0.95, t0 + 1.3),
				pop = bump(s, t0 - 0.02, t0 + 0.14);
			if (p > 0 && p < 1 && !lookP) {
				lookP = pos(p);
				lw = 0.7;
			}
			return (c) => {
				if (pop > 0) sparkleGlow(c, x0, y0, 6 * pop, 0.4, "#fff6c8", pop, "#ff9a1a");
				if (p > 0 && p < 1) {
					c.save();
					for (let k = 0; k < 14; k++) {
						const q = p - k * 0.022;
						if (q < 0) break;
						const e = pos(q);
						c.globalAlpha = (1 - k / 14) * 0.95;
						glow(c, "#ff7a1a", 4);
						c.fillStyle = k ? "#ff8a1f" : "#fff0a0";
						c.beginPath();
						c.arc(e.x, Math.min(e.y, G), Math.max((big ? 2.4 : 1.8) * (1 - k / 16), 0.5 / unit), 0, TAU);
						c.fill();
					}
					c.restore();
				}
				if (b > 0 && b < 1)
					dot(
						c,
						land.x + side * 6 * b,
						Math.min(land.y, G) - 5 * Math.sin(Math.PI * b),
						1.6,
						"#ff8a1f",
						"#ff7a1a",
						1 - b,
					);
			};
		});
		return { look: lookP ?? { x: box.cx, y: box.cy }, lw, front: draws };
	},
};

function rocketPose(s: number, shape: Shape): { lift: number; thrust: number; body: BodyPose } {
	const lift = ease(seg(s, 0.35, 1.1)) * (1 - ease(seg(s, 4.5, 5.4))),
		tilt = 10 * ease(seg(s, 0.7, 1.5)) * (1 - ease(seg(s, 4.2, 5.0))),
		thrust = ease(seg(s, 0.1, 0.8)) * (1 - ease(seg(s, 4.7, 5.5)));
	return {
		lift,
		thrust,
		body: {
			x: -0.75 * (90 - shape.box.cy) * Math.sin((tilt * Math.PI) / 180),
			y: -9 * lift + 0.8 * Math.sin(s * 5.5) * lift,
			turn: tilt,
			scaleX: 1,
			scaleY: 1,
		},
	};
}
function rocketFlame(c: CanvasRenderingContext2D, x: number, y: number, L: number, W: number): void {
	if (L <= 0.3) return;
	c.save();
	glow(c, "#ffb020", 7);
	const shape = (w: number, l: number) => {
		c.beginPath();
		c.moveTo(x - w / 2, y);
		c.bezierCurveTo(x - w * 0.66, y + l * 0.32, x - w * 0.22, y + l * 0.72, x, y + l);
		c.bezierCurveTo(x + w * 0.22, y + l * 0.72, x + w * 0.66, y + l * 0.32, x + w / 2, y);
		c.closePath();
	};
	let g = c.createLinearGradient(x, y, x, y + L);
	g.addColorStop(0, "#fff1a0");
	g.addColorStop(0.35, "#ffc21a");
	g.addColorStop(0.75, "rgba(255,150,30,0.8)");
	g.addColorStop(1, "rgba(255,110,30,0)");
	c.fillStyle = g;
	shape(W, L);
	c.fill();
	c.shadowBlur = 0;
	g = c.createLinearGradient(x, y, x, y + L * 0.6);
	g.addColorStop(0, "#fffbe0");
	g.addColorStop(0.5, "#ffe45c");
	g.addColorStop(1, "rgba(255,214,60,0)");
	c.fillStyle = g;
	shape(W * 0.55, L * 0.66);
	c.fill();
	c.restore();
}
const liftoff: Fx = {
	dur: 6.0,
	run(s, _t, shape) {
		const { box } = shape,
			P = rocketPose(s, shape),
			flicker = 1 + 0.13 * Math.sin(s * 31) + 0.08 * Math.sin(s * 47 + 1);
		const L = P.thrust > 0.01 ? (9 + 22 * P.thrust) * flicker : 0,
			W = 11 + 5 * P.thrust,
			by = box.bot - 3;
		const puffs: { x: number; y: number; r: number; a: number; front: boolean }[] = [];
		for (let i = 0; i < 11; i++) {
			const e0 = 0.5 + i * 0.36,
				q = seg(s, e0, e0 + 1.5);
			if (q <= 0 || q >= 1) continue;
			const Q = rocketPose(e0, shape);
			if (Q.thrust < 0.4) continue;
			const st = bodyPoint(Q.body, box.cx, by + 20 * Q.thrust),
				side = i % 2 ? -1 : 1;
			puffs.push({
				x: st.x + side * (6 + 18 * easeOut(q)) - 5 * q,
				y: st.y - 1 + 4 * easeOut(q),
				r: 2.5 + 6 * easeOut(q),
				a: 0.7 * (1 - q) ** 1.3 * Math.min(1, q * 6),
				front: i % 3 === 1,
			});
		}
		const draw = (front: boolean) => (c: CanvasRenderingContext2D) => {
			for (const p of puffs) if (p.front === front) smokePuff(c, p.x, p.y, p.r, p.a);
		};
		const ignite = bump(s, 0.05, 0.4);
		return {
			body: P.body,
			look: { x: box.cx + 24, y: box.top - 6 },
			lw: P.lift,
			behind: [
				draw(false),
				(c) => {
					c.save();
					applyBody(c, P.body);
					if (ignite > 0)
						glowOf(
							c,
							box.cx,
							by + 4,
							12,
							`rgba(255,236,170,${0.9 * ignite})`,
							`rgba(255,170,60,${0.3 * ignite})`,
						);
					rocketFlame(c, box.cx, by, L, W);
					c.restore();
				},
			],
			front: [draw(true)],
		};
	},
};

const heartbeat: Fx = {
	dur: 6.0,
	run(s, _t, shape) {
		const { box } = shape,
			x0 = box.lef - 26,
			W = box.rig + 26 - x0,
			v = W / 2.6,
			head = x0 + ((s * v) % W),
			y0 = box.cy + 4,
			drawn = s * v,
			fade = 1 - seg(s, 5.0, 6.0);
		const phase = (q: number) => ((q % 1.05) + 1.05) % 1.05;
		return {
			look: { x: head, y: y0 },
			lw: 0.45 * fade * Math.min(1, s * 3),
			behind: [
				(c) => {
					if (fade <= 0) return;
					c.save();
					c.lineCap = "round";
					c.lineJoin = "round";
					c.strokeStyle = "#0f9f78";
					let prev: Point | undefined;
					for (let i = 0; i <= 140; i++) {
						const x = x0 + (i / 140) * W,
							behind = (head - x + W) % W,
							y = y0 - ecg(phase(s - behind / v)) * 2.6,
							shows = behind < drawn && behind > 0.5;
						if (prev && shows) {
							c.globalAlpha = (1 - behind / W) ** 1.4 * fade;
							c.lineWidth = minW(1.9);
							c.beginPath();
							c.moveTo(prev.x, prev.y);
							c.lineTo(x, y);
							c.stroke();
						}
						prev = shows ? { x, y } : undefined;
					}
					c.restore();
					dot(c, head, y0 - ecg(phase(s)) * 2.6, 1.6, "#c9ffe9", "#2ee6b0", fade);
				},
			],
		};
	},
};

const orbit: Fx = {
	dur: 3.4,
	run(s, _t, shape, n) {
		const { box } = shape,
			dir = n % 2 ? -1 : 1,
			start = dir > 0 ? -1.2 : Math.PI + 1.2,
			at = ring(box.cx, box.cy - 2, 60, 17, dir * 0.34),
			p = seg(s, 0.2, 2.6),
			turns = 1.12;
		const head = start + dir * easeOut(p) * TAU * turns,
			len = 2.7 * Math.sin(Math.PI * p),
			tip = at(head),
			on = p > 0 && p < 1;
		const glitter: (Placed & { r: number; a: number; k: number })[] = [];
		for (let k = 0; k < 14; k++) {
			const q = (k + 0.5) / 14,
				born = 0.2 + q * 2.0,
				life = seg(s, born, born + 1.1);
			if (life <= 0 || life >= 1) continue;
			const g = at(start + dir * easeOut(q * 0.85) * TAU * turns);
			glitter.push({
				x: g.x + Math.sin(k * 2.3) * 1.5,
				y: g.y + 7 * life,
				front: g.front,
				r: 2.3 * (1 - life) + 0.5,
				a: 1 - life,
				k,
			});
		}
		const style: Stroke = { width: 2.8, alpha: 1, color: (f) => mix("#f2a91f", "#fff0a8", f) };
		const draw = (front: boolean) => (c: CanvasRenderingContext2D) => {
			for (const g of glitter) if (g.front === front) sparkle(c, g.x, g.y, g.r, g.k, "#f2b63a", g.a);
			if (!on) return;
			c.save();
			glow(c, "#ffc93c", 4);
			path(c, at, head, len, style, front, dir);
			c.restore();
			if (tip.front === front) sparkleGlow(c, tip.x, tip.y, front ? 7 : 5.5, s * 5, "#fff6d2", 1, "#ffc93c");
		};
		return { look: tip, lw: bump(s, 0, 3.0), behind: [draw(false)], front: [draw(true)] };
	},
};

const shower: Fx = {
	dur: 4.4,
	run(s, _t, shape) {
		const { box } = shape,
			u = s + 2.9,
			ground = box.bot + 23;
		return {
			look: { x: box.cx, y: box.bot + 16 },
			lw: 0.6 * ramped(s, 0.2, 4.0, 0.5),
			front: [
				(c) => {
					for (let i = 0; i < 13; i++) {
						const x = lerp(box.lef + 8, box.rig - 8, (i + 0.5) / 13) + (hash(i) - 0.5) * 3,
							per = 0.6 + 0.25 * hash(i * 3),
							off = hash(i * 5) * per,
							ph = ((u + off) % per) / per,
							start = Math.floor((u + off) / per) * per - off;
						const w = ramped(start, 3.2, 6.6, 0.6);
						if (w <= 0) continue;
						const fall = clamp(ph / 0.6),
							y = lerp(box.bot - 2, ground, easeIn(fall) * 0.6 + fall * 0.4);
						c.save();
						if (fall < 1) {
							c.globalAlpha = 0.85 * w;
							const g = c.createLinearGradient(x, y - 7, x, y + 1);
							g.addColorStop(0, "rgba(90,150,230,0)");
							g.addColorStop(1, "#3d7fd6");
							c.strokeStyle = g;
							c.lineCap = "round";
							c.lineWidth = minW(2.1);
							c.beginPath();
							c.moveTo(x, y - 8);
							c.lineTo(x, y);
							c.stroke();
						} else {
							const spread = clamp((ph - 0.6) / 0.4);
							c.globalAlpha = 0.75 * (1 - spread) * w;
							c.strokeStyle = "#3d7fd6";
							c.lineWidth = minW(1);
							c.beginPath();
							c.ellipse(x, ground, 0.8 + 4.5 * spread, 0.4 + 1.2 * spread, 0, 0, TAU);
							c.stroke();
						}
						c.restore();
					}
				},
			],
		};
	},
};

function lightOver(at: Point, r: number, strength: number): Paint {
	return (c) => {
		const g = c.createRadialGradient(at.x, at.y, 0, at.x, at.y, r);
		g.addColorStop(0, `rgba(255,236,150,${strength})`);
		g.addColorStop(1, "rgba(255,220,120,0)");
		c.fillStyle = g;
		c.fillRect(-50, -50, 200, 200);
	};
}
const crackle: Fx = {
	dur: 2.8,
	run(s, _t, shape, n) {
		const hits: [number, number, boolean][] = [
			[0.0, 0.34, false],
			[0.4, 0.3, false],
			[0.75, 0.34, false],
			[1.15, 0.6, true],
			[1.85, 0.36, false],
		];
		const front: Paint[] = [],
			over: Paint[] = [];
		let lookP: Point | undefined;
		hits.forEach(([t0, d, strike], j) => {
			const q = seg(s, t0, t0 + d);
			if (q <= 0 || q >= 1 || Math.floor(q * 16) % 4 === 2) return;
			const seed = n * 11 + j * 3 + Math.floor(s * 18);
			if (strike) {
				const T = shape.low,
					g = shape.box.bot + 21,
					M = { x: T.x - 1, y: T.y + 8 },
					ends = [
						{ x: T.x - 18, y: g },
						{ x: T.x + 2, y: g + 1 },
						{ x: T.x + 17, y: g - 1 },
					];
				lookP = { x: T.x, y: g };
				front.push((c) => {
					boltLine(c, { x: T.x, y: T.y - 1 }, M, seed, 1, 4.4, 3, 1.6);
					for (const [k, e] of ends.entries())
						boltLine(c, M, e, seed + 2 + k * 3, k === 1 ? 1 : 0.9, k === 1 ? 4 : 3, 6, 2.8);
					glowOf(c, T.x, g, 22, "rgba(255,246,200,1)", "rgba(255,194,26,0.4)");
					c.save();
					c.globalAlpha = 0.8 * (1 - q);
					c.strokeStyle = "#ffc21a";
					c.lineWidth = minW(1.5);
					c.beginPath();
					c.ellipse(T.x, g, 8 + 20 * q, 2 + 5 * q, 0, 0, TAU);
					c.stroke();
					c.restore();
					for (let k = 0; k < 6; k++) {
						const an = -Math.PI / 2 + (hash(seed + k) - 0.5) * 2.6,
							reach = 6 + 18 * q;
						dot(
							c,
							T.x + Math.cos(an) * reach,
							g + Math.sin(an) * reach * 0.8 + 16 * q * q,
							1,
							"#fff4c0",
							"#ffb800",
							1 - q,
						);
					}
				});
				over.push(lightOver(T, 75, 0.4));
				return;
			}
			const ang = hash(n * 4.7 + j * 1.31) * TAU,
				A = edgeAt(shape, ang),
				B = edgeAt(shape, ang + 0.7),
				out = ang + (hash(seed) - 0.5) * 0.5,
				reach = 16 + 6 * hash(j + n);
			const E = { x: A.x + Math.cos(out) * reach, y: A.y + Math.sin(out) * reach },
				fork = {
					x: lerp(A.x, E.x, 0.55) + Math.cos(out + 0.9) * 8,
					y: lerp(A.y, E.y, 0.55) + Math.sin(out + 0.9) * 8,
				},
				mid = ang + 0.35,
				M = { x: (A.x + B.x) / 2 + Math.cos(mid) * 9, y: (A.y + B.y) / 2 + Math.sin(mid) * 9 };
			lookP ??= E;
			front.push((c) => {
				boltLine(c, A, E, seed, 1, 3.8, 6, 3);
				boltLine(c, { x: lerp(A.x, E.x, 0.45), y: lerp(A.y, E.y, 0.45) }, fork, seed + 9, 0.9, 2.4, 4, 2.2);
				boltLine(c, A, M, seed + 3, 1, 3, 4, 2.2);
				boltLine(c, M, B, seed + 5, 1, 3, 4, 2.2);
				glowOf(c, A.x, A.y, 12, "rgba(255,246,200,1)", "rgba(255,194,26,0.4)");
				sparkleGlow(c, E.x, E.y, 4.5, seed, "#fffbe6", 1, "#ffb800");
				for (let k = 0; k < 4; k++) {
					const an = out + (hash(seed + k) - 0.5) * 2,
						far = 4 + 14 * q;
					dot(c, A.x + Math.cos(an) * far, A.y + Math.sin(an) * far + 12 * q * q, 1, "#fff4c0", "#ffb800", 1 - q);
				}
			});
			over.push(lightOver(A, 45, 0.5));
		});
		return { look: lookP ?? { x: shape.box.cx, y: shape.box.cy }, lw: lookP ? 0.55 : 0, front, over };
	},
};

const nightStars: Fx = {
	dur: 6.5,
	run(s, _t, shape, n) {
		const { box: B } = shape;
		const P: Point[] = [
			{ x: B.lef - 10, y: B.top + 4 },
			{ x: B.cx + 4, y: B.top - 12 },
			{ x: B.rig + 10, y: B.top + 8 },
			{ x: B.rig + 14, y: B.cy + 12 },
			{ x: B.lef - 14, y: B.cy + 16 },
			{ x: B.lef + 2, y: B.bot + 8 },
		];
		const flares = Math.floor(hash(n) * 6),
			live = ramped(s, 0, 6.5, 0.9);
		return {
			look: P[flares],
			lw: 0.7 * bump(s, 2.6, 4.6),
			behind: [
				(c) =>
					P.forEach((p, i) => {
						const twinkle = (0.5 + 0.5 * Math.sin(s * (1.1 + 0.35 * i) + i * 2)) ** 2,
							f = i === flares ? bump(s, 3.0, 4.2) : 0,
							grow = back(seg(s, i * 0.12, 0.5 + i * 0.12));
						sparkleGlow(
							c,
							p.x,
							p.y,
							(2.6 + 2 * twinkle) * (1 + 1.3 * f) * grow * (0.4 + 0.6 * live),
							(Math.PI / 4) * f,
							"#f2b63a",
							(0.25 + 0.75 * twinkle) * live,
							"#ffd96b",
						);
					}),
			],
		};
	},
};

export const FIGURE_EFFECTS: Readonly<Record<string, readonly Fx[]>> = {
	acorn: [sprout],
	flame: [flare, sparks],
	rocket: [liftoff],
	heart: [heartbeat],
	star: [orbit],
	cloud: [shower],
	bolt: [crackle],
	moon: [nightStars],
};
export const THREAD_SLOT = 3;
const THREAD_ONLY_GAP = 5.6;
const TURN_GAP = 2;

interface Slot {
	length: number;
	gap: number;
	fx?: Fx;
}
function slotsOf(figure: string): Slot[] {
	const effects = FIGURE_EFFECTS[figure] ?? [];
	if (!effects.length) return [{ length: THREAD_SLOT, gap: THREAD_ONLY_GAP }];
	return effects.flatMap((fx) => [
		{ length: THREAD_SLOT, gap: TURN_GAP },
		{ length: fx.dur, gap: TURN_GAP, fx },
	]);
}
export function loopLength(figure: string): number {
	return slotsOf(figure).reduce((sum, slot) => sum + slot.length + slot.gap, 0);
}
export interface Beat {
	kind: "thread" | "effect";
	index: number;
	at: number;
	round: number;
}
export function beatAt(figure: string, t: number): Beat {
	const slots = slotsOf(figure),
		L = loopLength(figure),
		{ u, n } = cycle(t, L);
	let start = 0,
		i = 0;
	for (; i < slots.length - 1; i++) {
		const span = slots[i]!.length + slots[i]!.gap;
		if (u < start + span) break;
		start += span;
	}
	return { kind: slots[i]!.fx ? "effect" : "thread", index: i, at: u - start, round: n * slots.length + i };
}

export function workFrame(
	t: number,
	figure: string,
	shape: Shape,
	color: string,
	seed = 0,
	aligned = false,
): WorkFrame {
	tint = tintOf(color);
	const slots = slotsOf(figure),
		L = loopLength(figure),
		shifted = aligned ? t : t + hash(seed % 9973) * L,
		beat = beatAt(figure, shifted),
		round = Math.floor(shifted / L) + (seed % 89);
	const glance = glances(shifted + (seed % 31));
	let look: Point = { x: 0, y: 0 },
		w = 0,
		body: BodyPose = STILL;
	const behind: Paint[] = [],
		front: Paint[] = [],
		over: Paint[] = [];
	const fx = slots[beat.index]!.fx;
	if (!fx) {
		const pass = threadPass(beat.at, shape, beat.round + (seed % 89) * slots.length);
		behind.push(pass.behind);
		front.push(pass.front);
		look = pass.look;
		w = pass.w;
	} else {
		const r = fx.run(beat.at, shifted, shape, round);
		behind.push(...(r.behind ?? []));
		front.push(...(r.front ?? []));
		over.push(...(r.over ?? []));
		if (r.body) body = r.body;
		if (r.look) {
			w = r.lw ?? 0;
			look = lookToward(shape, r.look, w);
		}
	}
	const x = glance.x * (1 - w) + look.x,
		y = glance.y * (1 - w) + look.y,
		height = lerp(glance.open, 1, clamp(w * 1.5));
	const eye: EyePose = {
		x: x / shape.spacing,
		y: y / shape.eyeHeight,
		width: 1,
		height,
		rotation: 0,
		alpha: 1,
		smile: 0,
	};
	return { body, eyes: [eye, { ...eye }], behind, front, over };
}

export function paintLayers(ctx: CanvasRenderingContext2D, layers: readonly Paint[], scale: number): void {
	unit = scale;
	for (const layer of layers) {
		ctx.save();
		layer(ctx);
		ctx.restore();
	}
}
