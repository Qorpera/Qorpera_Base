import type { StudioBinaryRef } from "@qorpera/contracts";

export interface StudioObjectPart {
	readonly id: string;
	readonly node: string;
	readonly pull?: readonly [number, number, number];
}

export interface StudioObjectSpec {
	readonly model?: string;
	readonly view?: { readonly yaw: number; readonly pitch: number };
	readonly parts: readonly StudioObjectPart[];
	readonly tint: readonly string[];
}

export interface StudioModelSource {
	readonly path: string;
	readonly ref: StudioBinaryRef;
	readonly object?: StudioObjectSpec;
}

export interface StudioVec3 {
	readonly x: number;
	readonly y: number;
	readonly z: number;
}

const MAX_PARTS = 12;
const MAX_TINT = 12;
export const APART_DISTANCE = 0.32;
const GLB_FILE = /\.glb$/i;
const OBJECT_FILE = /(?:^|\/)object\.json$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pullOf(value: unknown): readonly [number, number, number] | undefined {
	if (!Array.isArray(value) || value.length !== 3) return undefined;
	const [x, y, z] = value.map(finite);
	if (x === undefined || y === undefined || z === undefined) return undefined;
	const clamp = (v: number) => Math.max(-2, Math.min(2, v));
	return [clamp(x), clamp(y), clamp(z)];
}

function namesOf(value: unknown, limit: number): string[] {
	if (!Array.isArray(value)) return [];
	const names = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
	return [...new Set(names.map((name) => name.trim()))].slice(0, limit);
}

export function parseStudioObject(text: string | undefined): StudioObjectSpec | undefined {
	if (!text?.trim()) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;
	const parts: StudioObjectPart[] = [];
	if (Array.isArray(parsed.parts)) {
		for (const raw of parsed.parts) {
			if (parts.length >= MAX_PARTS) break;
			if (!isRecord(raw) || typeof raw.node !== "string" || !raw.node.trim()) continue;
			const node = raw.node.trim();
			const pull = pullOf(raw.pull);
			parts.push({ id: typeof raw.id === "string" && raw.id ? raw.id : node, node, ...(pull ? { pull } : {}) });
		}
	}
	const view = isRecord(parsed.view) ? parsed.view : undefined;
	const yaw = finite(view?.yaw);
	const pitch = finite(view?.pitch);
	return {
		...(typeof parsed.model === "string" && parsed.model.trim() ? { model: parsed.model.trim() } : {}),
		...(yaw !== undefined && pitch !== undefined ? { view: { yaw, pitch: Math.max(-6, Math.min(52, pitch)) } } : {}),
		parts,
		tint: namesOf(parsed.tint, MAX_TINT),
	};
}

function folderOf(path: string): string {
	const index = path.lastIndexOf("/");
	return index < 0 ? "" : path.slice(0, index);
}

function joinStudioPath(folder: string, relative: string): string | undefined {
	const parts = folder ? folder.split("/") : [];
	for (const part of relative.replace(/^\.\//, "").split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (parts.length === 0) return undefined;
			parts.pop();
			continue;
		}
		parts.push(part);
	}
	return parts.length ? parts.join("/") : undefined;
}

export function pickStudioModel(
	files: Readonly<Record<string, string>>,
	binaries: Readonly<Record<string, StudioBinaryRef>>,
	folderRoot: string | null | undefined,
): StudioModelSource | undefined {
	const root = folderRoot?.replace(/^\/+|\/+$/g, "") ?? "";
	const inRoot = (name: string) => (root ? `${root}/${name}` : name);
	const glbs = Object.keys(binaries)
		.filter((path) => GLB_FILE.test(path))
		.sort();
	if (glbs.length === 0) return undefined;
	const objectPaths = Object.keys(files)
		.filter((path) => OBJECT_FILE.test(path))
		.sort((a, b) => Number(b === inRoot("object.json")) - Number(a === inRoot("object.json")) || a.localeCompare(b));
	for (const objectPath of objectPaths) {
		const object = parseStudioObject(files[objectPath]);
		if (!object?.model || !GLB_FILE.test(object.model)) continue;
		const path = joinStudioPath(folderOf(objectPath), object.model);
		const ref = path ? binaries[path] : undefined;
		if (path && ref) return { path, ref, object };
	}
	const fallback = binaries[inRoot("model.glb")] ? inRoot("model.glb") : glbs[0]!;
	return { path: fallback, ref: binaries[fallback]! };
}

export function sameStudioModel(a: StudioModelSource | undefined, b: StudioModelSource | undefined): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return (
		a.path === b.path &&
		a.ref.fileSha256 === b.ref.fileSha256 &&
		a.ref.manifestSha256 === b.ref.manifestSha256 &&
		JSON.stringify(a.object ?? null) === JSON.stringify(b.object ?? null)
	);
}

export interface StudioBox {
	readonly min: StudioVec3;
	readonly max: StudioVec3;
}

function holds(box: StudioBox, point: StudioVec3): boolean {
	return (
		point.x >= box.min.x &&
		point.x <= box.max.x &&
		point.y >= box.min.y &&
		point.y <= box.max.y &&
		point.z >= box.min.z &&
		point.z <= box.max.z
	);
}

export function apartOffset(
	part: StudioBox,
	modelCentre: StudioVec3,
	modelSize: number,
	pull?: readonly [number, number, number],
): StudioVec3 {
	const size = Number.isFinite(modelSize) && modelSize > 0 ? modelSize : 0;
	if (pull) return { x: pull[0] * size, y: pull[1] * size, z: pull[2] * size };
	if (holds(part, modelCentre)) return { x: 0, y: 0, z: 0 };
	const dx = (part.min.x + part.max.x) / 2 - modelCentre.x;
	const dy = (part.min.y + part.max.y) / 2 - modelCentre.y;
	const dz = (part.min.z + part.max.z) / 2 - modelCentre.z;
	const length = Math.hypot(dx, dy, dz);
	if (length === 0) return { x: 0, y: 0, z: 0 };
	const reach = (APART_DISTANCE * size) / length;
	return { x: dx * reach, y: dy * reach, z: dz * reach };
}

export function tintedMaterials(materialNames: readonly string[], object: StudioObjectSpec | undefined): Set<string> {
	const wanted = new Set(object?.tint ?? []);
	return new Set(materialNames.filter((name) => wanted.has(name)));
}

export function easeOutCubic(t: number): number {
	const k = Math.max(0, Math.min(1, t));
	return 1 - (1 - k) ** 3;
}

export function shortestTurn(from: number, to: number): number {
	const turn = Math.PI * 2;
	let delta = (to - from) % turn;
	if (delta > Math.PI) delta -= turn;
	if (delta < -Math.PI) delta += turn;
	return from + delta;
}

function channelHex(value: number): string {
	return Math.round(Math.max(0, Math.min(1, value)) * 255)
		.toString(16)
		.padStart(2, "0");
}

function linearToSrgb(value: number): number {
	const v = Math.max(0, Math.min(1, value));
	return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

function hueDegrees(token: string): number | undefined {
	const match = /^(-?[\d.]+(?:e-?\d+)?)(deg|rad|grad|turn)?$/i.exec(token);
	if (!match) return token.toLowerCase() === "none" ? 0 : undefined;
	const value = Number(match[1]);
	if (!Number.isFinite(value)) return undefined;
	const unit = match[2]?.toLowerCase();
	const degrees =
		unit === "rad" ? (value * 180) / Math.PI : unit === "grad" ? value * 0.9 : unit === "turn" ? value * 360 : value;
	return ((degrees % 360) + 360) % 360;
}

function amount(token: string, whole: number): number | undefined {
	if (token.toLowerCase() === "none") return 0;
	const match = /^(-?[\d.]+(?:e-?\d+)?)(%)?$/.exec(token);
	if (!match) return undefined;
	const value = Number(match[1]);
	if (!Number.isFinite(value)) return undefined;
	return match[2] ? (value / 100) * whole : value;
}

function hslToRgb(h: number, s: number, l: number): readonly [number, number, number] {
	const k = (n: number) => (n + h / 30) % 12;
	const a = s * Math.min(l, 1 - l);
	const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
	return [f(0), f(8), f(4)];
}

function oklchToRgb(l: number, c: number, h: number): readonly [number, number, number] {
	const a = c * Math.cos((h * Math.PI) / 180);
	const b = c * Math.sin((h * Math.PI) / 180);
	const lms = [
		(l + 0.3963377774 * a + 0.2158037573 * b) ** 3,
		(l - 0.1055613458 * a - 0.0638541728 * b) ** 3,
		(l - 0.0894841775 * a - 1.291485548 * b) ** 3,
	] as const;
	return [
		linearToSrgb(4.0767416621 * lms[0] - 3.3077115913 * lms[1] + 0.2309699292 * lms[2]),
		linearToSrgb(-1.2684380046 * lms[0] + 2.6097574011 * lms[1] - 0.3413193965 * lms[2]),
		linearToSrgb(-0.0041960863 * lms[0] - 0.7034186147 * lms[1] + 1.707614701 * lms[2]),
	];
}

export function studioColorHex(value: string | undefined): string | undefined {
	const text = value?.trim().toLowerCase() ?? "";
	const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text)?.[1];
	if (hex) {
		const full = hex.length <= 4 ? [...hex.slice(0, 3)].map((digit) => digit + digit).join("") : hex.slice(0, 6);
		return `#${full}`;
	}
	const call = /^(rgba?|hsla?|oklch)\(\s*([^)]*)\)$/.exec(text);
	if (!call) return undefined;
	const tokens = call[2]!
		.split("/")[0]!
		.trim()
		.split(/[\s,]+/)
		.filter(Boolean);
	if (tokens.length !== 3) return undefined;
	const [first, second, third] = tokens as [string, string, string];
	let rgb: readonly [number, number, number] | undefined;
	if (call[1]!.startsWith("rgb")) {
		const parts = [amount(first, 255), amount(second, 255), amount(third, 255)];
		if (parts.every((part): part is number => part !== undefined))
			rgb = [parts[0]! / 255, parts[1]! / 255, parts[2]! / 255];
	} else if (call[1]!.startsWith("hsl")) {
		const h = hueDegrees(first);
		const s = amount(second.endsWith("%") ? second : `${second}%`, 1);
		const l = amount(third.endsWith("%") ? third : `${third}%`, 1);
		if (h !== undefined && s !== undefined && l !== undefined)
			rgb = hslToRgb(h, Math.max(0, Math.min(1, s)), Math.max(0, Math.min(1, l)));
	} else {
		const l = amount(first, 1);
		const c = amount(second, 0.4);
		const h = hueDegrees(third);
		if (l !== undefined && c !== undefined && h !== undefined) rgb = oklchToRgb(l, Math.max(0, c), h);
	}
	return rgb ? `#${rgb.map(channelHex).join("")}` : undefined;
}
