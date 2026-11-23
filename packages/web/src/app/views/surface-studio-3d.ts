import { h } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";

export interface Studio3DColorway {
	readonly name: string;
	readonly hex: string;
}

export interface Studio3DConfig {
	readonly kind: "headband" | "device";
	readonly title: string;
	readonly dimensions: string;
	readonly colorways: readonly Studio3DColorway[];
	readonly layers: readonly string[];
	readonly changed?: boolean;
}

interface Vec3 {
	readonly x: number;
	readonly y: number;
	readonly z: number;
}

interface Poly {
	readonly points: readonly Vec3[];
	readonly color: [number, number, number];
	readonly specular: number;
	readonly alpha: number;
	readonly stroke?: string;
}

function hexToRgb(hex: string): [number, number, number] {
	const clean = hex.replace("#", "").trim();
	const full =
		clean.length === 3
			? clean
					.split("")
					.map((ch) => ch + ch)
					.join("")
			: clean.slice(0, 6);
	const num = Number.parseInt(full, 16);
	if (!Number.isFinite(num)) return [196, 190, 224];
	return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function rotatePoint(p: Vec3, yaw: number, pitch: number): Vec3 {
	const cy = Math.cos(yaw);
	const sy = Math.sin(yaw);
	const x1 = p.x * cy + p.z * sy;
	const z1 = -p.x * sy + p.z * cy;
	const cp = Math.cos(pitch);
	const sp = Math.sin(pitch);
	const y2 = p.y * cp - z1 * sp;
	const z2 = p.y * sp + z1 * cp;
	return { x: x1, y: y2, z: z2 };
}

function sub(a: Vec3, b: Vec3): Vec3 {
	return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function cross(a: Vec3, b: Vec3): Vec3 {
	return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function normalize(v: Vec3): Vec3 {
	const len = Math.hypot(v.x, v.y, v.z) || 1;
	return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function dot(a: Vec3, b: Vec3): number {
	return a.x * b.x + a.y * b.y + a.z * b.z;
}

function pushBox(
	out: Poly[],
	center: Vec3,
	size: Vec3,
	color: [number, number, number],
	specular = 0.25,
	alpha = 1,
): void {
	const hx = size.x / 2;
	const hy = size.y / 2;
	const hz = size.z / 2;
	const v: Vec3[] = [
		{ x: center.x - hx, y: center.y - hy, z: center.z - hz },
		{ x: center.x + hx, y: center.y - hy, z: center.z - hz },
		{ x: center.x + hx, y: center.y + hy, z: center.z - hz },
		{ x: center.x - hx, y: center.y + hy, z: center.z - hz },
		{ x: center.x - hx, y: center.y - hy, z: center.z + hz },
		{ x: center.x + hx, y: center.y - hy, z: center.z + hz },
		{ x: center.x + hx, y: center.y + hy, z: center.z + hz },
		{ x: center.x - hx, y: center.y + hy, z: center.z + hz },
	];
	const faces: readonly [number, number, number, number][] = [
		[4, 5, 6, 7],
		[1, 0, 3, 2],
		[5, 1, 2, 6],
		[0, 4, 7, 3],
		[3, 7, 6, 2],
		[0, 1, 5, 4],
	];
	for (const [a, b, c, d] of faces) {
		out.push({ points: [v[a]!, v[b]!, v[c]!, v[d]!], color, specular, alpha });
	}
}

function buildHeadbandScene(shellRgb: [number, number, number], explode: number): Poly[] {
	const polys: Poly[] = [];
	const segments = 36;
	const rxOuter = 1.48;
	const rzOuter = 1.72;
	const rxInner = 1.32;
	const rzInner = 1.56;
	const bandLift = explode * 0.52;
	const innerRgb: [number, number, number] = [
		Math.max(20, Math.round(shellRgb[0] * 0.72)),
		Math.max(20, Math.round(shellRgb[1] * 0.72)),
		Math.max(20, Math.round(shellRgb[2] * 0.72)),
	];
	const bandHeight = (angle: number) => 0.34 + 0.14 * Math.max(0, Math.cos(angle));
	for (let i = 0; i < segments; i++) {
		const a0 = (i / segments) * Math.PI * 2;
		const a1 = ((i + 1) / segments) * Math.PI * 2;
		const h0 = bandHeight(a0);
		const h1 = bandHeight(a1);
		const o0t: Vec3 = { x: Math.sin(a0) * rxOuter, y: h0 + bandLift, z: Math.cos(a0) * rzOuter };
		const o1t: Vec3 = { x: Math.sin(a1) * rxOuter, y: h1 + bandLift, z: Math.cos(a1) * rzOuter };
		const o1b: Vec3 = { x: Math.sin(a1) * rxOuter, y: -h1 + bandLift, z: Math.cos(a1) * rzOuter };
		const o0b: Vec3 = { x: Math.sin(a0) * rxOuter, y: -h0 + bandLift, z: Math.cos(a0) * rzOuter };
		const i0t: Vec3 = { x: Math.sin(a0) * rxInner, y: h0 + bandLift, z: Math.cos(a0) * rzInner };
		const i1t: Vec3 = { x: Math.sin(a1) * rxInner, y: h1 + bandLift, z: Math.cos(a1) * rzInner };
		const i1b: Vec3 = { x: Math.sin(a1) * rxInner, y: -h1 + bandLift, z: Math.cos(a1) * rzInner };
		const i0b: Vec3 = { x: Math.sin(a0) * rxInner, y: -h0 + bandLift, z: Math.cos(a0) * rzInner };
		polys.push({ points: [o0t, o1t, o1b, o0b], color: shellRgb, specular: 0.18, alpha: 1 });
		polys.push({ points: [i1t, i0t, i0b, i1b], color: innerRgb, specular: 0.08, alpha: 1 });
		polys.push({ points: [i0t, i1t, o1t, o0t], color: shellRgb, specular: 0.22, alpha: 1 });
		polys.push({ points: [o0b, o1b, i1b, i0b], color: innerRgb, specular: 0.08, alpha: 1 });
	}

	const pcbDrop = -explode * 0.18;
	const pcbOffset = explode * 0.42;
	pushBox(polys, { x: 1.44 + pcbOffset, y: pcbDrop, z: 0.35 }, { x: 0.14, y: 0.32, z: 0.86 }, [42, 118, 92], 0.35);
	pushBox(polys, { x: 1.52 + pcbOffset, y: pcbDrop, z: 0.35 }, { x: 0.06, y: 0.24, z: 0.56 }, [64, 72, 84], 0.6);
	pushBox(polys, { x: -1.44 - pcbOffset, y: pcbDrop, z: 0.2 }, { x: 0.14, y: 0.28, z: 0.74 }, [78, 86, 98], 0.45);

	const electrodeDrop = -explode * 0.62;
	const electrodeAngles = [-0.62, -0.22, 0.22, 0.62];
	for (const angle of electrodeAngles) {
		const cx = Math.sin(angle) * (rxInner - 0.06);
		const cz = Math.cos(angle) * (rzInner - 0.06);
		pushBox(polys, { x: cx, y: electrodeDrop, z: cz }, { x: 0.18, y: 0.18, z: 0.08 }, [218, 176, 86], 0.72);
	}
	return polys;
}

function buildDeviceScene(shellRgb: [number, number, number], explode: number): Poly[] {
	const polys: Poly[] = [];
	pushBox(polys, { x: 0, y: 0.35 + explode * 0.55, z: 0 }, { x: 2.2, y: 0.26, z: 1.4 }, shellRgb, 0.32);
	pushBox(polys, { x: 0, y: 0, z: 0 }, { x: 1.9, y: 0.12, z: 1.15 }, [42, 118, 92], 0.35);
	pushBox(polys, { x: 0, y: -0.35 - explode * 0.55, z: 0 }, { x: 2.2, y: 0.24, z: 1.4 }, [68, 72, 80], 0.45);
	return polys;
}

const HOME_YAW = -0.52;
const HOME_PITCH = 0.34;

export class Studio3DViewer {
	readonly el: HTMLElement;
	readonly #canvas: HTMLCanvasElement;
	readonly #controls: HTMLElement;
	readonly #callouts: HTMLElement;
	readonly #signal: AbortSignal;
	#config: Studio3DConfig;
	#yaw = HOME_YAW;
	#pitch = HOME_PITCH;
	#exploded = false;
	#explodeProgress = 0;
	#activeColorIndex = 0;
	#dragging = false;
	#lastX = 0;
	#lastY = 0;
	#raf: number | undefined;

	constructor(config: Studio3DConfig, signal: AbortSignal) {
		this.#config = config;
		this.#signal = signal;
		this.#canvas = h("canvas", {
			class: "studio-3d-canvas",
			width: "760",
			height: "360",
			"aria-label": t("Interactive 3D model — drag to rotate"),
		});
		this.#callouts = h("div", { class: "studio-3d-callouts", hidden: true });
		this.#controls = h("div", { class: "studio-3d-view", role: "radiogroup", "aria-label": t("View") });
		this.el = h(
			"div",
			{ class: `studio-3d${config.changed ? " is-changed" : ""}` },
			this.#canvas,
			this.#callouts,
			this.#controls,
		);
		this.#bindPointer();
		this.#drawControls();
		this.#scheduleRender();
		signal.addEventListener(
			"abort",
			() => {
				if (this.#raf !== undefined) cancelAnimationFrame(this.#raf);
			},
			{ once: true },
		);
	}

	get colorwayIndex(): number {
		return this.#activeColorIndex;
	}

	setColorway(index: number): void {
		if (index < 0 || index >= this.#config.colorways.length || index === this.#activeColorIndex) return;
		this.#activeColorIndex = index;
		this.#scheduleRender();
	}

	#scheduleRender(): void {
		if (this.#signal.aborted) return;
		if (typeof requestAnimationFrame !== "function") {
			this.#render();
			return;
		}
		if (this.#raf !== undefined) return;
		this.#raf = requestAnimationFrame(() => {
			this.#raf = undefined;
			if (!this.#signal.aborted) this.#render();
		});
	}

	update(config: Studio3DConfig): void {
		this.#config = config;
		if (this.#activeColorIndex >= config.colorways.length) this.#activeColorIndex = 0;
		this.el.classList.toggle("is-changed", config.changed === true);
		this.#drawControls();
		this.#scheduleRender();
	}

	#bindPointer(): void {
		const canvas = this.#canvas;
		canvas.addEventListener(
			"pointerdown",
			(event) => {
				this.#dragging = true;
				this.#lastX = event.clientX;
				this.#lastY = event.clientY;
				if (typeof canvas.setPointerCapture === "function") canvas.setPointerCapture(event.pointerId);
			},
			{ signal: this.#signal },
		);
		canvas.addEventListener(
			"pointermove",
			(event) => {
				if (!this.#dragging) return;
				const dx = event.clientX - this.#lastX;
				const dy = event.clientY - this.#lastY;
				this.#lastX = event.clientX;
				this.#lastY = event.clientY;
				this.#yaw += dx * 0.011;
				this.#pitch = Math.max(-1.1, Math.min(1.1, this.#pitch + dy * 0.01));
				this.#scheduleRender();
			},
			{ signal: this.#signal },
		);
		const end = () => {
			this.#dragging = false;
		};
		canvas.addEventListener("pointerup", end, { signal: this.#signal });
		canvas.addEventListener("pointercancel", end, { signal: this.#signal });
		canvas.addEventListener(
			"dblclick",
			() => {
				this.#yaw = HOME_YAW;
				this.#pitch = HOME_PITCH;
				this.#scheduleRender();
			},
			{ signal: this.#signal },
		);
	}

	#animateExplode(): void {
		if (this.#raf !== undefined) cancelAnimationFrame(this.#raf);
		const target = this.#exploded ? 1 : 0;
		const step = () => {
			if (this.#signal.aborted) return;
			const diff = target - this.#explodeProgress;
			if (Math.abs(diff) < 0.015) {
				this.#explodeProgress = target;
				this.#raf = undefined;
				this.#render();
				return;
			}
			this.#explodeProgress += diff * 0.22;
			this.#render();
			this.#raf = requestAnimationFrame(step);
		};
		if (typeof requestAnimationFrame === "function") this.#raf = requestAnimationFrame(step);
		else {
			this.#explodeProgress = target;
			this.#render();
		}
	}

	#drawControls(): void {
		const option = (exploded: boolean, label: string) =>
			h(
				"button",
				{
					type: "button",
					role: "radio",
					class: `studio-3d-view-btn${this.#exploded === exploded ? " is-on" : ""}`,
					"aria-checked": String(this.#exploded === exploded),
					"data-view": exploded ? "apart" : "whole",
					onclick: () => {
						if (this.#exploded === exploded) return;
						this.#exploded = exploded;
						this.#drawControls();
						this.#animateExplode();
					},
				},
				label,
			);
		this.#controls.replaceChildren(option(false, t("Whole")), option(true, t("Apart")));
		this.#callouts.hidden = !this.#exploded;
		if (this.#exploded) {
			this.#callouts.replaceChildren(
				...this.#config.layers.map((layer, index) =>
					h("span", { class: "studio-3d-callout" }, h("b", null, `0${index + 1}`), layer),
				),
			);
		}
	}

	#render(): void {
		// WHY: jsdom logs a stderr warning if getContext("2d") is called without node-canvas; skip drawing cleanly there.
		if (typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent)) return;
		const ctx = this.#canvas.getContext("2d");
		if (!ctx) return;
		const width = this.#canvas.width;
		const height = this.#canvas.height;
		ctx.clearRect(0, 0, width, height);

		ctx.save();
		ctx.fillStyle = "rgba(18, 18, 22, 0.09)";
		ctx.beginPath();
		ctx.ellipse(width / 2, height * 0.78, 148, 24, 0, 0, Math.PI * 2);
		ctx.fill();
		ctx.restore();

		const activeHex = this.#config.colorways[this.#activeColorIndex]?.hex ?? "#c8c2e8";
		const shellRgb = hexToRgb(activeHex);
		const polys =
			this.#config.kind === "headband"
				? buildHeadbandScene(shellRgb, this.#explodeProgress)
				: buildDeviceScene(shellRgb, this.#explodeProgress);

		const light = normalize({ x: -0.45, y: 0.78, z: 0.55 });
		const fov = 420;
		const cameraZ = 5.4;

		const projected = polys
			.map((poly) => {
				const rotated = poly.points.map((pt) => rotatePoint(pt, this.#yaw, this.#pitch));
				const avgZ = rotated.reduce((sum, pt) => sum + pt.z, 0) / rotated.length;
				const edge1 = sub(rotated[1]!, rotated[0]!);
				const edge2 = sub(rotated[2]!, rotated[0]!);
				const normal = normalize(cross(edge1, edge2));
				const diffuse = Math.max(0, Math.abs(dot(normal, light)));
				const shade = 0.42 + diffuse * 0.58;
				const spec = diffuse ** 12 * poly.specular * 90;
				const r = Math.min(255, Math.round(poly.color[0] * shade + spec));
				const g = Math.min(255, Math.round(poly.color[1] * shade + spec));
				const b = Math.min(255, Math.round(poly.color[2] * shade + spec));
				const screen = rotated.map((pt) => {
					const scale = fov / Math.max(1.2, cameraZ - pt.z);
					return { x: width / 2 + pt.x * scale, y: height * 0.47 - pt.y * scale };
				});
				return { avgZ, screen, fill: `rgba(${r},${g},${b},${poly.alpha})` };
			})
			.sort((a, b) => a.avgZ - b.avgZ);

		for (const item of projected) {
			ctx.beginPath();
			const first = item.screen[0]!;
			ctx.moveTo(first.x, first.y);
			for (let i = 1; i < item.screen.length; i++) ctx.lineTo(item.screen[i]!.x, item.screen[i]!.y);
			ctx.closePath();
			ctx.fillStyle = item.fill;
			ctx.fill();
			ctx.strokeStyle = "rgba(20, 20, 24, 0.08)";
			ctx.lineWidth = 0.6;
			ctx.stroke();
		}
	}
}
