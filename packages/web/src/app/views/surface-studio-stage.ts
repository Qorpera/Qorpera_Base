import type { StudioBinaryRef } from "@qorpera/contracts";
import { h } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import {
	loadStudioThree,
	type StudioThree,
	type ThreeCamera,
	type ThreeColor,
	type ThreeMaterial,
	type ThreeObject3D,
	type ThreeRenderer,
	type ThreeScene,
	type ThreeTexture,
} from "./studio-three.ts";
import {
	apartOffset,
	easeOutCubic,
	type StudioModelSource,
	type StudioObjectPart,
	type StudioStageBounds,
	type StudioVec3,
	sameStudioModel,
	shortestTurn,
	stageCameraDistance,
	studioColorHex,
	tintedMaterials,
} from "./surface-studio-model.ts";

export type StudioBinaryReader = (ref: StudioBinaryRef, signal: AbortSignal) => Promise<Uint8Array>;

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const OPEN_YAW = 30 * DEG;
const OPEN_PITCH = 14 * DEG;
const APART_YAW = 64 * DEG;
const APART_PITCH = 19 * DEG;
const TILT_MIN = -6 * DEG;
const TILT_MAX = 52 * DEG;
const TURN_SECONDS = 42;
const FOV = 24;
const MODEL_SPAN = 1.9;
const IDLE_AFTER_TOUCH_MS = 1800;
const TINT_SECONDS = 0.5;

interface StageGl {
	readonly three: StudioThree;
	readonly renderer: ThreeRenderer;
	readonly scene: ThreeScene;
	readonly camera: ThreeCamera;
	readonly spin: ThreeObject3D;
	readonly environment: ThreeTexture;
	readonly listeners: AbortController;
}

interface StagePart {
	readonly object: ThreeObject3D;
	readonly home: StudioVec3;
	readonly delta: StudioVec3;
}

interface StageTint {
	readonly material: ThreeMaterial & { color: ThreeColor };
	readonly own: ThreeColor;
	readonly target: ThreeColor;
}

interface StageShown {
	readonly root: ThreeObject3D;
	readonly parts: readonly StagePart[];
	readonly tints: readonly StageTint[];
	readonly whole: StudioStageBounds;
	readonly apart: StudioStageBounds;
}

interface StageMotion {
	readonly from: readonly [number, number];
	readonly to: readonly [number, number];
	readonly start: number;
	readonly duration: number;
}

function lerp(a: number, b: number, k: number): number {
	return a + (b - a) * k;
}

function isTexture(value: unknown): value is ThreeTexture {
	return Boolean(value) && typeof value === "object" && (value as { isTexture?: unknown }).isTexture === true;
}

function materialsOf(object: ThreeObject3D): ThreeMaterial[] {
	if (!object.material) return [];
	return Array.isArray(object.material) ? object.material : [object.material];
}

function freeObject(root: ThreeObject3D): void {
	const materials = new Set<ThreeMaterial>();
	root.traverse((object) => {
		object.geometry?.dispose();
		for (const material of materialsOf(object)) materials.add(material);
	});
	for (const material of materials) {
		for (const value of Object.values(material as unknown as Record<string, unknown>)) {
			if (isTexture(value)) value.dispose();
		}
		material.dispose();
	}
}

function findNamed(root: ThreeObject3D, name: string): ThreeObject3D | undefined {
	const queue = [...root.children];
	for (let index = 0; index < queue.length; index++) {
		const object = queue[index]!;
		if (object.name === name || object.userData.name === name) return object;
		queue.push(...object.children);
	}
	return undefined;
}

function movableParts(
	model: ThreeObject3D,
	parts: readonly StudioObjectPart[],
): { readonly object: ThreeObject3D; readonly pull?: StudioObjectPart["pull"] }[] {
	const found: { readonly object: ThreeObject3D; readonly pull?: StudioObjectPart["pull"] }[] = [];
	for (const part of parts) {
		const object = findNamed(model, part.node);
		if (object && !found.some((item) => item.object === object))
			found.push({ object, ...(part.pull ? { pull: part.pull } : {}) });
	}
	if (found.length > 0) return found;
	let level = model;
	while (level.children.length === 1 && level.children[0]!.children.length > 0) level = level.children[0]!;
	return level.children.map((object) => ({ object }));
}

export class StudioModelStage {
	readonly el: HTMLElement;
	readonly #box: HTMLElement;
	readonly #floor: HTMLElement;
	readonly #controls: HTMLElement;
	readonly #read: StudioBinaryReader;
	readonly #signal: AbortSignal;
	readonly #reduced: MediaQueryList | undefined;
	#model: StudioModelSource | undefined;
	#loadAbort: AbortController | undefined;
	#gl: StageGl | undefined;
	#shown: StageShown | undefined;
	#failed = false;
	#lost = false;
	#tintHex: string | undefined;
	#tintLeft = 0;
	#yaw = OPEN_YAW;
	#pitch = OPEN_PITCH;
	#velocity = 0;
	#apart = 0;
	#apartTo = 0;
	#auto = true;
	#touched = 0;
	#motion: StageMotion | undefined;
	#drag:
		| {
				readonly id: number;
				readonly x0: number;
				readonly y0: number;
				readonly yaw0: number;
				readonly pitch0: number;
				lx: number;
				lt: number;
				v: number;
		  }
		| undefined;
	#raf = 0;
	#last = 0;
	#width = 0;
	#height = 0;
	#resize: ResizeObserver | undefined;

	constructor(read: StudioBinaryReader, signal: AbortSignal) {
		this.#read = read;
		this.#signal = signal;
		this.#reduced = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : undefined;
		this.#floor = h("div", { class: "studio-stage-floor", "aria-hidden": "true" });
		this.#box = h("div", { class: "studio-model-box" }, this.#floor);
		this.#controls = h("div", {
			class: "studio-3d-view",
			role: "radiogroup",
			"aria-label": t("Model view"),
			hidden: true,
		});
		this.el = h("div", { class: "studio-model" }, this.#box, this.#controls);
		this.#drawControls();
		signal.addEventListener("abort", () => this.#teardown(), { once: true });
	}

	get model(): StudioModelSource | undefined {
		return this.#model;
	}

	update(model: StudioModelSource): void {
		if (this.#signal.aborted) return;
		if (this.#lost) {
			this.#model = model;
			this.#rebuild();
			return;
		}
		if (sameStudioModel(this.#model, model)) {
			this.#kick();
			return;
		}
		this.#model = model;
		this.#loadAbort?.abort();
		this.#clearShown();
		const open = this.#openPose();
		this.#yaw = open[0];
		this.#pitch = open[1];
		this.#apart = 0;
		this.#apartTo = 0;
		this.#auto = true;
		this.#motion = undefined;
		this.#drawControls();
		void this.#load(model);
	}

	setColorway(value: string | undefined): void {
		const hex = studioColorHex(value) ?? "";
		if (hex === this.#tintHex) return;
		const instant = this.#tintHex === undefined;
		this.#tintHex = hex;
		if (hex) this.el.dataset.tint = hex;
		else delete this.el.dataset.tint;
		if (!this.#shown) return;
		for (const tint of this.#shown.tints) {
			if (hex) tint.target.set(hex);
			else tint.target.copy(tint.own);
			if (instant || this.#reducedMotion()) tint.material.color.copy(tint.target);
		}
		this.#tintLeft = instant || this.#reducedMotion() ? 0 : TINT_SECONDS;
		this.#kick();
	}

	#openPose(): readonly [number, number] {
		const view = this.#model?.object?.view;
		return view ? [view.yaw * DEG, view.pitch * DEG] : [OPEN_YAW, OPEN_PITCH];
	}

	#reducedMotion(): boolean {
		return this.#reduced?.matches === true;
	}

	async #load(model: StudioModelSource): Promise<void> {
		const abort = new AbortController();
		this.#loadAbort = abort;
		const signal = AbortSignal.any([abort.signal, this.#signal]);
		try {
			const three = await loadStudioThree();
			if (signal.aborted || !three || this.#failed) return;
			const gl = this.#ensureGl(three);
			if (!gl) return;
			const bytes = await this.#read(model.ref, signal);
			if (signal.aborted) return;
			const data =
				bytes.buffer instanceof ArrayBuffer &&
				bytes.byteOffset === 0 &&
				bytes.byteLength === bytes.buffer.byteLength
					? bytes.buffer
					: bytes.slice().buffer;
			const gltf = await new Promise<{ readonly scene: ThreeObject3D }>((resolve, reject) => {
				try {
					new three.GLTFLoader().parse(data, "", resolve, reject);
				} catch (error) {
					reject(error);
				}
			});
			if (signal.aborted || this.#gl !== gl) {
				freeObject(gltf.scene);
				return;
			}
			this.#show(gl, gltf.scene, model);
		} catch {
			return;
		}
	}

	#ensureGl(three: StudioThree): StageGl | undefined {
		if (this.#gl) return this.#gl;
		const canvas = h("canvas", {
			class: "studio-model-canvas",
			"aria-label": t("Interactive 3D model — drag to rotate"),
		});
		let renderer: ThreeRenderer;
		try {
			renderer = new three.WebGLRenderer({ canvas, alpha: true, antialias: true });
		} catch {
			this.#failed = true;
			return undefined;
		}
		renderer.setClearColor(0x000000, 0);
		renderer.outputColorSpace = three.SRGBColorSpace;
		renderer.toneMapping = three.AgXToneMapping;
		renderer.toneMappingExposure = 1.05;
		const scene = new three.Scene();
		const pmrem = new three.PMREMGenerator(renderer);
		const room = new three.RoomEnvironment();
		const environment = pmrem.fromScene(room, 0.04).texture;
		room.dispose();
		pmrem.dispose();
		scene.environment = environment;
		const camera = new three.PerspectiveCamera(FOV, 1, 0.05, 60);
		const spin = new three.Group();
		scene.add(spin);
		const listeners = new AbortController();
		const signal = AbortSignal.any([this.#signal, listeners.signal]);
		this.#gl = { three, renderer, scene, camera, spin, environment, listeners };
		const current = () => canvas === this.#gl?.renderer.domElement;
		canvas.addEventListener(
			"webglcontextlost",
			(event) => {
				if (!current()) return;
				event.preventDefault();
				this.#lost = true;
				if (this.#raf) cancelAnimationFrame(this.#raf);
				this.#raf = 0;
			},
			{ signal },
		);
		canvas.addEventListener(
			"webglcontextrestored",
			() => {
				if (current()) this.#rebuild();
			},
			{ signal },
		);
		this.#bindPointer(canvas, signal);
		this.#box.append(canvas);
		if (typeof ResizeObserver === "function") {
			this.#resize = new ResizeObserver(() => this.#measure());
			this.#resize.observe(this.#box);
		}
		this.#measure();
		return this.#gl;
	}

	#show(gl: StageGl, model: ThreeObject3D, source: StudioModelSource): void {
		const { three } = gl;
		model.updateMatrixWorld(true);
		const box = new three.Box3().setFromObject(model);
		if (box.isEmpty()) {
			freeObject(model);
			return;
		}
		const centre = box.getCenter(new three.Vector3());
		const extent = box.getSize(new three.Vector3());
		const span = Math.max(extent.x, extent.y, extent.z, 1e-6);
		const parts: StagePart[] = [];
		const apartMin = { x: box.min.x, y: box.min.y, z: box.min.z };
		const apartMax = { x: box.max.x, y: box.max.y, z: box.max.z };
		for (const { object, pull } of movableParts(model, source.object?.parts ?? [])) {
			const parent = object.parent;
			if (!parent) continue;
			const partBox = new three.Box3().setFromObject(object);
			if (partBox.isEmpty()) continue;
			const offset = apartOffset(partBox, centre, span, pull);
			apartMin.x = Math.min(apartMin.x, partBox.min.x + offset.x);
			apartMin.y = Math.min(apartMin.y, partBox.min.y + offset.y);
			apartMin.z = Math.min(apartMin.z, partBox.min.z + offset.z);
			apartMax.x = Math.max(apartMax.x, partBox.max.x + offset.x);
			apartMax.y = Math.max(apartMax.y, partBox.max.y + offset.y);
			apartMax.z = Math.max(apartMax.z, partBox.max.z + offset.z);
			const origin = object.getWorldPosition(new three.Vector3());
			const target = parent.worldToLocal(
				new three.Vector3(origin.x + offset.x, origin.y + offset.y, origin.z + offset.z),
			);
			const home = { x: object.position.x, y: object.position.y, z: object.position.z };
			const delta = { x: target.x - home.x, y: target.y - home.y, z: target.z - home.z };
			if (Math.hypot(delta.x, delta.y, delta.z) > 0) parts.push({ object, home, delta });
		}
		const materials = new Map<string, ThreeMaterial[]>();
		model.traverse((object) => {
			for (const material of materialsOf(object)) {
				const list = materials.get(material.name) ?? [];
				if (!list.includes(material)) list.push(material);
				materials.set(material.name, list);
			}
		});
		const tints: StageTint[] = [];
		for (const name of tintedMaterials([...materials.keys()], source.object)) {
			for (const material of materials.get(name) ?? []) {
				const color = material.color;
				if (!color) continue;
				const own = new three.Color();
				own.copy(color);
				const target = new three.Color();
				target.copy(color);
				if (this.#tintHex) {
					target.set(this.#tintHex);
					color.copy(target);
				}
				tints.push({ material: material as ThreeMaterial & { color: ThreeColor }, own, target });
			}
		}
		const scale = MODEL_SPAN / span;
		const whole: StudioStageBounds = {
			half: { x: (extent.x * scale) / 2, y: (extent.y * scale) / 2, z: (extent.z * scale) / 2 },
			centerY: 0,
		};
		const apartMinY = (apartMin.y - centre.y) * scale;
		const apartMaxY = (apartMax.y - centre.y) * scale;
		const apart: StudioStageBounds = {
			half: {
				x: Math.max(Math.abs(apartMin.x - centre.x), Math.abs(apartMax.x - centre.x)) * scale,
				y: (apartMaxY - apartMinY) / 2,
				z: Math.max(Math.abs(apartMin.z - centre.z), Math.abs(apartMax.z - centre.z)) * scale,
			},
			centerY: (apartMinY + apartMaxY) / 2,
		};
		const holder = new three.Group();
		holder.add(model);
		holder.scale.set(scale, scale, scale);
		holder.position.set(-centre.x * scale, -centre.y * scale, -centre.z * scale);
		gl.spin.add(holder);
		this.#shown = { root: holder, parts, tints, whole, apart };
		this.#drawControls();
		this.el.classList.add("is-ready");
		if (!this.#reducedMotion()) {
			const open = this.#openPose();
			this.#yaw = open[0] - 0.9;
			this.#animateTo([open[0], open[1]], 1300);
		}
		this.#kick();
	}

	#rebuild(): void {
		const model = this.#model;
		this.#lost = false;
		this.#teardown();
		this.#model = undefined;
		if (model) this.update(model);
	}

	#clearShown(): void {
		const shown = this.#shown;
		this.#shown = undefined;
		this.el.classList.remove("is-ready");
		if (!shown) return;
		this.#gl?.spin.remove(shown.root);
		freeObject(shown.root);
	}

	#teardown(): void {
		this.#loadAbort?.abort();
		if (this.#raf) cancelAnimationFrame(this.#raf);
		this.#raf = 0;
		this.#resize?.disconnect();
		this.#resize = undefined;
		this.#width = 0;
		this.#height = 0;
		this.#drag = undefined;
		this.#clearShown();
		const gl = this.#gl;
		this.#gl = undefined;
		if (!gl) return;
		gl.listeners.abort();
		gl.environment.dispose();
		gl.renderer.dispose();
		gl.renderer.forceContextLoss();
		gl.renderer.domElement.remove();
		this.#drawControls();
	}

	#drawControls(): void {
		const movable = (this.#shown?.parts.length ?? 0) >= 2;
		this.#controls.hidden = !movable;
		const apart = this.#apartTo === 1;
		const option = (on: boolean, label: string) =>
			h(
				"button",
				{
					type: "button",
					role: "radio",
					class: `studio-3d-view-btn${apart === on ? " is-on" : ""}`,
					"aria-checked": String(apart === on),
					"data-view": on ? "apart" : "whole",
					onclick: () => this.#setApart(on),
				},
				label,
			);
		this.#controls.replaceChildren(option(false, t("Whole")), option(true, t("Apart")));
	}

	#setApart(on: boolean): void {
		if ((this.#apartTo === 1) === on) return;
		this.#apartTo = on ? 1 : 0;
		if (this.#reducedMotion()) this.#apart = this.#apartTo;
		if (on) {
			this.#auto = false;
			this.#animateTo([shortestTurn(this.#yaw, APART_YAW), APART_PITCH], 900);
		} else {
			this.#auto = true;
			this.#touched = 0;
			this.#animateTo([this.#yaw, this.#openPose()[1]], 800);
		}
		this.#drawControls();
		this.#kick();
	}

	#resetView(): void {
		const pose: readonly [number, number] = this.#apartTo === 1 ? [APART_YAW, APART_PITCH] : this.#openPose();
		this.#animateTo([shortestTurn(this.#yaw, pose[0]), pose[1]], 700);
	}

	#animateTo(to: readonly [number, number], duration: number): void {
		this.#velocity = 0;
		if (this.#reducedMotion()) {
			this.#yaw = to[0];
			this.#pitch = to[1];
			this.#motion = undefined;
		} else {
			this.#motion = { from: [this.#yaw, this.#pitch], to, start: performance.now(), duration };
		}
		this.#kick();
	}

	#bindPointer(canvas: HTMLCanvasElement, signal: AbortSignal): void {
		canvas.addEventListener(
			"pointerdown",
			(event) => {
				if (!this.#shown) return;
				if (typeof canvas.setPointerCapture === "function") canvas.setPointerCapture(event.pointerId);
				this.#drag = {
					id: event.pointerId,
					x0: event.clientX,
					y0: event.clientY,
					yaw0: this.#yaw,
					pitch0: this.#pitch,
					lx: event.clientX,
					lt: event.timeStamp,
					v: 0,
				};
				this.#motion = undefined;
				this.#velocity = 0;
				this.#touched = performance.now();
				this.#kick();
			},
			{ signal },
		);
		canvas.addEventListener(
			"pointermove",
			(event) => {
				const drag = this.#drag;
				if (!drag || drag.id !== event.pointerId) return;
				const k = 3.4 / Math.max(240, this.#width);
				this.#yaw = drag.yaw0 + (event.clientX - drag.x0) * k * 1.6;
				this.#pitch = Math.max(TILT_MIN, Math.min(TILT_MAX, drag.pitch0 + (event.clientY - drag.y0) * k * 1.1));
				const elapsed = Math.max(1, event.timeStamp - drag.lt);
				drag.v = ((event.clientX - drag.lx) * k * 1.6) / (elapsed / 1000);
				drag.lx = event.clientX;
				drag.lt = event.timeStamp;
				this.#touched = performance.now();
				this.#kick();
			},
			{ signal },
		);
		const end = (event: PointerEvent) => {
			const drag = this.#drag;
			if (!drag || drag.id !== event.pointerId) return;
			this.#drag = undefined;
			this.#velocity = this.#reducedMotion() ? 0 : Math.max(-6, Math.min(6, drag.v));
			this.#touched = performance.now();
			this.#kick();
		};
		canvas.addEventListener("pointerup", end, { signal });
		canvas.addEventListener("pointercancel", end, { signal });
		canvas.addEventListener("dblclick", () => this.#resetView(), { signal });
	}

	#measure(): void {
		const gl = this.#gl;
		if (!gl) return;
		const rect = this.#box.getBoundingClientRect();
		const width = Math.max(1, Math.round(rect.width));
		const height = Math.max(1, Math.round(rect.height));
		if (width === this.#width && height === this.#height) return;
		this.#width = width;
		this.#height = height;
		gl.renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));
		gl.renderer.setSize(width, height, false);
		gl.camera.aspect = width / height;
		gl.camera.updateProjectionMatrix();
		this.#kick();
	}

	#kick(): void {
		if (this.#raf || this.#lost || !this.#gl || !this.#shown || this.#signal.aborted) return;
		if (typeof requestAnimationFrame !== "function") return;
		this.#raf = requestAnimationFrame((now) => this.#frame(now));
	}

	#frame(now: number): void {
		this.#raf = 0;
		const gl = this.#gl;
		const shown = this.#shown;
		if (!gl || !shown || this.#signal.aborted) return;
		if (!this.el.isConnected) {
			this.#last = 0;
			return;
		}
		const dt = Math.min(0.05, this.#last ? (now - this.#last) / 1000 : 0);
		this.#last = now;
		let moving = false;
		const motion = this.#motion;
		if (motion) {
			const k = (now - motion.start) / motion.duration;
			const e = easeOutCubic(k);
			this.#yaw = lerp(motion.from[0], motion.to[0], e);
			this.#pitch = lerp(motion.from[1], motion.to[1], e);
			if (k >= 1) this.#motion = undefined;
			moving = true;
		} else if (!this.#drag) {
			if (Math.abs(this.#velocity) > 0.02) {
				this.#yaw += this.#velocity * dt;
				this.#velocity *= 0.94;
				moving = true;
			} else if (this.#auto && !this.#reducedMotion() && now - this.#touched > IDLE_AFTER_TOUCH_MS) {
				this.#yaw = (this.#yaw + (TAU / TURN_SECONDS) * dt) % TAU;
				moving = true;
			}
		}
		if (Math.abs(this.#apart - this.#apartTo) > 0.0015) {
			this.#apart += (this.#apartTo - this.#apart) * (1 - Math.exp(-dt * 6.5));
			moving = true;
		} else {
			this.#apart = this.#apartTo;
		}
		if (this.#tintLeft > 0) {
			this.#tintLeft -= dt;
			for (const tint of shown.tints) {
				if (this.#tintLeft > 0) tint.material.color.lerp(tint.target, Math.min(1, dt * 7));
				else tint.material.color.copy(tint.target);
			}
			moving = true;
		}
		for (const part of shown.parts) {
			part.object.position.set(
				part.home.x + part.delta.x * this.#apart,
				part.home.y + part.delta.y * this.#apart,
				part.home.z + part.delta.z * this.#apart,
			);
		}
		this.#floor.style.transform = `scale(${(1 + this.#apart * 0.5).toFixed(3)})`;
		gl.spin.rotation.y = this.#yaw;
		this.#place(gl.camera);
		gl.renderer.render(gl.scene, gl.camera);
		if (moving || this.#drag) this.#kick();
	}

	#place(camera: ThreeCamera): void {
		const aspect = this.#width / Math.max(1, this.#height);
		const shown = this.#shown;
		const whole = shown?.whole ?? { half: { x: MODEL_SPAN / 2, y: MODEL_SPAN / 2, z: MODEL_SPAN / 2 }, centerY: 0 };
		const apart = shown?.apart ?? whole;
		const wholeDistance = stageCameraDistance(whole.half, aspect, this.#pitch, FOV);
		const apartDistance = stageCameraDistance(apart.half, aspect, this.#pitch, FOV, 1.2);
		const distance = lerp(wholeDistance, apartDistance, this.#apart);
		const targetY = lerp(whole.centerY, apart.centerY, this.#apart);
		camera.position.set(0, targetY + distance * Math.sin(this.#pitch), distance * Math.cos(this.#pitch));
		camera.lookAt(0, targetY, 0);
	}
}
