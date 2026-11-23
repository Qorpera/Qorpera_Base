import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { StudioBinaryRef } from "@qorpera/contracts";
import { describe, expect, it } from "vitest";
import { SAMPLE_HEADBAND, SAMPLE_HEADBAND_PATH, starterStudioFiles } from "../src/app/surface-local-sandbox.ts";
import {
	APART_DISTANCE,
	apartOffset,
	parseStudioObject,
	pickStudioModel,
	sameStudioModel,
	shortestTurn,
	studioColorHex,
	tintedMaterials,
} from "../src/app/views/surface-studio-model.ts";

const SAMPLE_FILE = new URL(`../public/${SAMPLE_HEADBAND_PATH.slice(2)}`, import.meta.url);

function ref(seed: string, mediaType = "model/gltf-binary"): StudioBinaryRef {
	return {
		manifestSha256: seed.repeat(64).slice(0, 64),
		fileSha256: seed.repeat(64).slice(0, 64),
		bytes: 10,
		mediaType,
	};
}

function glbJson(path: string): {
	readonly nodes: readonly { readonly name: string; readonly mesh: number }[];
	readonly meshes: readonly { readonly primitives: readonly { readonly material: number }[] }[];
	readonly materials: readonly { readonly name: string }[];
} {
	const bytes = readFileSync(path);
	expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
	expect(bytes.readUInt32LE(8)).toBe(bytes.length);
	const length = bytes.readUInt32LE(12);
	return JSON.parse(bytes.subarray(20, 20 + length).toString("utf8"));
}

describe("which model file a studio shows", () => {
	it("follows object.json's model path, relative to object.json", () => {
		const binaries = {
			"product/model.glb": ref("a"),
			"product/models/band.glb": ref("b"),
		};
		const files = {
			"product/object.json": JSON.stringify({
				model: "models/band.glb",
				tint: ["Fabric"],
				parts: [{ node: "Band" }],
			}),
		};
		const picked = pickStudioModel(files, binaries, "product");
		expect(picked?.path).toBe("product/models/band.glb");
		expect(picked?.ref).toBe(binaries["product/models/band.glb"]);
		expect(picked?.object?.tint).toEqual(["Fabric"]);
		expect(picked?.object?.parts).toEqual([{ id: "Band", node: "Band" }]);
	});

	it("falls back to model.glb at the root, then the first .glb, and ignores pictures", () => {
		expect(pickStudioModel({}, { "p/z.glb": ref("a"), "p/model.glb": ref("b") }, "/p/")?.path).toBe("p/model.glb");
		expect(pickStudioModel({}, { "p/b/z.glb": ref("a"), "p/a/y.glb": ref("b") }, "p")?.path).toBe("p/a/y.glb");
		expect(pickStudioModel({}, { "p/front.webp": ref("a", "image/webp") }, "p")).toBeUndefined();
		expect(pickStudioModel({ "p/object.json": '{"model":"gone.glb"}' }, { "p/x.glb": ref("a") }, "p")).toEqual({
			path: "p/x.glb",
			ref: ref("a"),
		});
	});

	it("never leaves the studio folder through object.json's path", () => {
		const files = { "object.json": JSON.stringify({ model: "../secret.glb" }) };
		expect(pickStudioModel(files, { "secret.glb": ref("a"), "model.glb": ref("b") }, "")?.path).toBe("model.glb");
	});

	it("tells a changed model or description from the same one", () => {
		const a = { path: "p/model.glb", ref: ref("a") };
		expect(sameStudioModel(a, { ...a })).toBe(true);
		expect(sameStudioModel(a, { ...a, ref: ref("b") })).toBe(false);
		expect(sameStudioModel(a, { ...a, object: { parts: [], tint: ["X"] } })).toBe(false);
		expect(sameStudioModel(undefined, a)).toBe(false);
	});
});

describe("object.json", () => {
	it("reads parts with a node, an optional pull, the opening view and the tinted materials", () => {
		const object = parseStudioObject(
			JSON.stringify({
				model: "thing.glb",
				view: { yaw: 40, pitch: 80 },
				tint: ["Shell", "Shell", "", 4, "Strap"],
				parts: [
					{ id: "lid", node: "Lid", pull: [0, 0.5, 0] },
					{ id: "nameless" },
					{ node: "Base", pull: [1, "x", 0] },
					{ node: "Far", pull: [9, -9, 0] },
				],
			}),
		);
		expect(object).toEqual({
			model: "thing.glb",
			view: { yaw: 40, pitch: 52 },
			tint: ["Shell", "Strap"],
			parts: [
				{ id: "lid", node: "Lid", pull: [0, 0.5, 0] },
				{ id: "Base", node: "Base" },
				{ id: "Far", node: "Far", pull: [2, -2, 0] },
			],
		});
		expect(parseStudioObject("not json")).toBeUndefined();
		expect(parseStudioObject("[]")).toBeUndefined();
	});

	it("tints only the materials it names", () => {
		const object = parseStudioObject(JSON.stringify({ tint: ["Shell", "Missing"] }));
		expect([...tintedMaterials(["Shell", "Gold", "Shell.001"], object)]).toEqual(["Shell"]);
		expect([...tintedMaterials(["Shell"], undefined)]).toEqual([]);
	});
});

describe("taking a model apart", () => {
	const centre = { x: 0, y: 0, z: 0 };
	const around = (x: number, y: number, z: number, half = 0.1) => ({
		min: { x: x - half, y: y - half, z: z - half },
		max: { x: x + half, y: y + half, z: z + half },
	});

	it("moves a part straight out from the middle by a share of the model's size", () => {
		const offset = apartOffset(around(0, 0, -2), centre, 10);
		expect(offset.x).toBeCloseTo(0);
		expect(offset.y).toBeCloseTo(0);
		expect(offset.z).toBeCloseTo(-APART_DISTANCE * 10);
		const diagonal = apartOffset(around(3, 4, 0), centre, 1);
		expect(Math.hypot(diagonal.x, diagonal.y, diagonal.z)).toBeCloseTo(APART_DISTANCE);
		expect(diagonal.x / diagonal.y).toBeCloseTo(3 / 4);
	});

	it("keeps a part around the middle where it is, and follows a pull before the direction", () => {
		const band = { min: { x: -1, y: -0.2, z: -1 }, max: { x: 1, y: 0.2, z: 0.9 } };
		expect(apartOffset(band, { x: 0, y: 0.01, z: -0.06 }, 2)).toEqual({ x: 0, y: 0, z: 0 });
		expect(apartOffset(around(5, 0, 0), centre, 2, [0, -0.5, 0.25])).toEqual({ x: 0, y: -1, z: 0.5 });
		expect(apartOffset(around(5, 0, 0), centre, Number.NaN)).toEqual({ x: 0, y: 0, z: 0 });
	});

	it("turns the short way round", () => {
		expect(shortestTurn(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2);
		expect(shortestTurn(Math.PI * 1.9, 0.1)).toBeCloseTo(Math.PI * 2 + 0.1);
		expect(shortestTurn(0.1, Math.PI * 1.9)).toBeCloseTo(-Math.PI * 0.1);
	});
});

describe("a colour dot's value as the colour a model takes", () => {
	it("reads every hex form, dropping alpha", () => {
		expect(studioColorHex("#C3BBEA")).toBe("#c3bbea");
		expect(studioColorHex("#abc")).toBe("#aabbcc");
		expect(studioColorHex("#abcd")).toBe("#aabbcc");
		expect(studioColorHex(" #c3bbea80 ")).toBe("#c3bbea");
	});

	it("reads rgb and hsl in their comma, space and percentage forms", () => {
		expect(studioColorHex("rgb(195, 187, 234)")).toBe("#c3bbea");
		expect(studioColorHex("rgba(195 187 234 / 0.5)")).toBe("#c3bbea");
		expect(studioColorHex("rgb(100% 0% 50%)")).toBe("#ff0080");
		expect(studioColorHex("hsl(120, 100%, 25%)")).toBe("#008000");
		expect(studioColorHex("hsla(0.5turn 100% 50% / 40%)")).toBe("#00ffff");
	});

	it("reads oklch, clipping to what a screen can show", () => {
		expect(studioColorHex("oklch(100% 0 0)")).toBe("#ffffff");
		expect(studioColorHex("oklch(0 0 0)")).toBe("#000000");
		expect(studioColorHex("oklch(62.8% 0.2577 29.23)")).toBe("#ff0000");
		expect(studioColorHex("oklch(0.7 0.1 290 / 0.5)")).toBe("#9d94d9");
		expect(studioColorHex("oklch(70% 0.4 none)")).toMatch(/^#[0-9a-f]{6}$/);
	});

	it("gives nothing for a value it cannot read", () => {
		for (const value of [
			undefined,
			"",
			"lavender",
			"#12",
			"rgb(nope)",
			"rgb(1, 2)",
			"oklch(70% 0.1)",
			"lab(50 20 30)",
		])
			expect(studioColorHex(value), String(value)).toBeUndefined();
	});
});

describe("the sample headband", () => {
	it("names in its object.json the nodes and materials its model holds", () => {
		const gltf = glbJson(SAMPLE_FILE.pathname);
		const files = starterStudioFiles(
			{ slug: "product", title: "Product", folderRoot: "product" },
			"Thetaband",
			"product",
		);
		const object = parseStudioObject(files["product/object.json"]);
		expect(object?.model).toBe("headband.glb");
		const nodes = gltf.nodes.map((node) => node.name);
		expect(nodes).toEqual(["Strap", "Shell", "Liner", "Sensors_Front", "Sensors_Temple", "Battery"]);
		expect(object?.parts.map((part) => part.node)).toEqual(nodes);
		const materials = gltf.materials.map((material) => material.name);
		expect(materials).toEqual(["BandFabric", "Shell", "SensorPad", "Contact", "BatteryMetal"]);
		const used = new Set(
			gltf.nodes.flatMap((node) => gltf.meshes[node.mesh]!.primitives.map((primitive) => primitive.material)),
		);
		expect(used.size).toBe(materials.length);
		expect([...tintedMaterials(materials, object)]).toEqual(["BandFabric", "Shell"]);
		expect(readFileSync(SAMPLE_FILE).byteLength).toBeLessThan(120 * 1024);
	});

	it("is referenced by the size and hash of the web app's own file", () => {
		const bytes = readFileSync(SAMPLE_FILE);
		expect(SAMPLE_HEADBAND.bytes).toBe(bytes.byteLength);
		expect(SAMPLE_HEADBAND.fileSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
		expect(SAMPLE_HEADBAND.mediaType).toBe("model/gltf-binary");
	});
});
