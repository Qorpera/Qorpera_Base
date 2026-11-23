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
