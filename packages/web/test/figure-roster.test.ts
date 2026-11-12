import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { RETIRED_STAFF_CHARACTERS, STAFF_CHARACTER_IDS } from "@qorpera/cloud-client/staff-characters";
import { describe, expect, it } from "vitest";
import { DANISH } from "../src/ui/danish/index.ts";

/* The figures an agent can be given are named once, in cloud-client's
 * staff-characters (the runtime's hiring tool and the database's check follow
 * it). The web draws them from vendored scripts and artwork, which name them
 * again: these checks keep the two from drifting apart. */

const AVATARS = new URL("../public/assets/avatars/", import.meta.url);
const ARTWORK = new URL("status-2d-v1/", AVATARS);

interface Model {
	avatars: { id: string; name: string; color: string }[];
	faces: Record<string, { x: number; y: number; width: number; height: number; rotation: number }[]>;
}

function model(): Model {
	const scope: { QORPERA_MOTION_MODEL?: Model } = {};
	runInNewContext(readFileSync(new URL("motion-model.js", AVATARS), "utf8"), { window: scope });
	return scope.QORPERA_MOTION_MODEL!;
}

describe("the figures the web draws", () => {
	it("are the figures on offer, in the shared order", () => {
		expect(model().avatars.map(({ id }) => id)).toEqual([...STAFF_CHARACTER_IDS]);
		// A retired figure is drawn as its replacement, so it needs no entry of its own.
		for (const [retired, drawn] of Object.entries(RETIRED_STAFF_CHARACTERS)) {
			expect(STAFF_CHARACTER_IDS).not.toContain(retired);
			expect(STAFF_CHARACTER_IDS).toContain(drawn);
		}
	});

	it("each have a name with its Danish, an own shade, and two eyes inside the frame", () => {
		const { avatars, faces } = model();
		expect(Object.keys(faces)).toEqual([...STAFF_CHARACTER_IDS]);
		for (const { id, name, color } of avatars) {
			expect(name, id).toBe(id[0]!.toUpperCase() + id.slice(1));
			expect(Object.hasOwn(DANISH, id), id).toBe(true);
			expect(color, id).toMatch(/^#[\da-f]{6}$/);
			expect(faces[id], id).toHaveLength(2);
			for (const eye of faces[id]!) {
				for (const value of Object.values(eye)) expect(Number.isFinite(value), id).toBe(true);
				expect(eye.x - eye.height / 2, id).toBeGreaterThan(0);
				expect(eye.x + eye.height / 2, id).toBeLessThan(100);
				expect(eye.y - eye.height / 2, id).toBeGreaterThan(0);
				expect(eye.y + eye.height / 2, id).toBeLessThan(100);
			}
		}
	});

	it("each have a white-eye threshold in the painting", () => {
		// Without one the eyes' whiteness is not a number, and the body paints over them.
		const source = readFileSync(new URL("avatar-appearance.js", AVATARS), "utf8");
		const starts = /const eyeStarts = Object\.freeze\(\{([^}]*)\}\);/.exec(source)?.[1] ?? "";
		const named = [...starts.matchAll(/(\w+): (\d+)/g)].map(([, id, start]) => [id, Number(start)] as const);
		expect(named.map(([id]) => id)).toEqual([...STAFF_CHARACTER_IDS]);
		for (const [id, start] of named) {
			expect(start, id).toBeGreaterThan(0);
			expect(start, id).toBeLessThan(255);
		}
	});

	it("each ship a body and a face plate, and the manifest names exactly those files", () => {
		const wanted = STAFF_CHARACTER_IDS.flatMap((id) => [`${id}.webp`, `${id}-face.webp`]).sort();
		const shipped = readdirSync(ARTWORK)
			.filter((file) => file.endsWith(".webp") && !/-reference-\d+\.webp$/.test(file))
			.sort();
		expect(shipped).toEqual(wanted);
		const manifest = JSON.parse(readFileSync(new URL("artwork-manifest.json", ARTWORK), "utf8")) as {
			file: string;
			sha256: string;
			bytes: number;
		}[];
		expect(manifest.map(({ file }) => file).sort()).toEqual(wanted);
		for (const { file, sha256, bytes } of manifest) {
			const data = readFileSync(new URL(file, ARTWORK));
			expect(data.length, file).toBe(bytes);
			expect(createHash("sha256").update(data).digest("hex"), file).toBe(sha256);
			// The simple lossless form, as every plate is: no extended header, no colour profile.
			expect(data.toString("latin1", 0, 4) + data.toString("latin1", 8, 16), file).toBe("RIFFWEBPVP8L");
		}
	});
});
