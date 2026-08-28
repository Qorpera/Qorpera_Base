import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { STAFF_CHARACTER_IDS } from "../src/staff-characters.ts";

const directory = join(import.meta.dirname, "../userland/avatars");
const modules = ["motion-model.js", "motion-visuals.js", "avatar-state.js", "avatar-appearance.js"]
	.map((file) => readFileSync(join(directory, file), "utf8"))
	.join("\n");

function evaluate<T>(code: string, bindings: Record<string, unknown> = {}): T {
	return runInNewContext(`${modules}\n${code}`, { window: {}, ...bindings }) as T;
}

interface Raster {
	naturalWidth: number;
	naturalHeight: number;
	pixels: Uint8ClampedArray;
	src: string;
}

// Decode the checked-in, non-interlaced RGBA masters without a native test dependency.
function readMaster(id: string): Raster {
	const png = readFileSync(join(directory, `${id}.png`));
	expect(png.subarray(1, 4).toString()).toBe("PNG");
	expect([...png.subarray(24, 29)]).toEqual([8, 6, 0, 0, 0]);
	const width = png.readUInt32BE(16),
		height = png.readUInt32BE(20);
	const chunks: Buffer[] = [];
	for (let offset = 8; offset < png.length; ) {
		const length = png.readUInt32BE(offset);
		if (png.toString("ascii", offset + 4, offset + 8) === "IDAT")
			chunks.push(png.subarray(offset + 8, offset + 8 + length));
		offset += length + 12;
	}
	const raw = inflateSync(Buffer.concat(chunks));
	const stride = width * 4;
	const pixels = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		for (let x = 0; x < stride; x++) {
			const index = y * stride + x;
			const left = x >= 4 ? pixels[index - 4] : 0;
			const up = y ? pixels[index - stride] : 0;
			const diagonal = y && x >= 4 ? pixels[index - stride - 4] : 0;
			const p = left + up - diagonal;
			const a = Math.abs(p - left),
				b = Math.abs(p - up),
				c = Math.abs(p - diagonal);
			const predictor = [0, left, up, Math.floor((left + up) / 2), a <= b && a <= c ? left : b <= c ? up : diagonal][
				filter
			];
			pixels[index] = (raw[y * (stride + 1) + x + 1] + predictor) & 255;
		}
	}
	return { naturalWidth: width, naturalHeight: height, pixels, src: `${id}.png` };
}

function pixelCanvas() {
	let data: Uint8ClampedArray = new Uint8ClampedArray(0);
	const context = {
		drawImage(image: Raster) {
			data = new Uint8ClampedArray(image.pixels);
		},
		getImageData() {
			return { data: new Uint8ClampedArray(data) };
		},
		createImageData(width: number, height: number) {
			return { data: new Uint8ClampedArray(width * height * 4) };
		},
		putImageData(image: { data: Uint8ClampedArray }) {
			data = image.data;
		},
	};
	return {
		width: 0,
		height: 0,
		get pixels() {
			return data;
		},
		getContext: () => context,
		toDataURL: () => "data:image/png;test",
	};
}

describe("approved avatar system", () => {
	it("shares all seven identities and eleven independent colors with the production validator", () => {
		const catalog = evaluate<{ ids: string[]; colors: string[] }>(
			`({ ids: window.QORPERA_MOTION_MODEL.avatars.map(a => a.id), colors: window.QORPERA_AVATAR_APPEARANCE.palette.map(c => c.color) })`,
		);
		expect(catalog.ids).toEqual(STAFF_CHARACTER_IDS);
		expect(catalog.colors).toEqual([
			"#312f2d",
			"#87674c",
			"#ff365e",
			"#f96e2d",
			"#fcb51b",
			"#00c878",
			"#00bfb3",
			"#2047bd",
			"#b83ff5",
			"#ff2994",
			"#7c7c7a",
		]);
		const main = readFileSync(join(directory, "../../src/main.ts"), "utf8");
		const validation = main.slice(
			main.indexOf("const STAFF_AVATAR_COLORS ="),
			main.indexOf("const STAFF_AVATAR_SHAPES ="),
		);
		for (const color of catalog.colors) expect(validation.includes(color), color).toBe(true);
	});

	it("uses the approved logo in the app and the installer", () => {
		const logo = readFileSync(join(directory, "qorpera.png"));
		expect(createHash("sha256").update(logo).digest("hex")).toBe(
			"32cb535aa801453ec1baa4ad0e50c45c65b92c03dece1d00f0a2490d41f0050f",
		);
		expect(readFileSync(join(directory, "../../assets/qorpera.png"))).toEqual(logo);
	});

	it.each(STAFF_CHARACTER_IDS)("gives %s expressive working eyes, quiet rest, and finite attention", (id) => {
		const result = evaluate<{ still: unknown; end: unknown; poses: string[]; strokes: unknown[]; loop: unknown }>(
			`
			const model = window.QORPERA_MOTION_MODEL, visual = window.QORPERA_MOTION_VISUALS;
			({ still: visual.face('still', 0), end: visual.face('still', 100000),
				poses: [0, 1080, 2200, 3260, 4200].map(t => JSON.stringify(visual.eyePose(id, 0, visual.face('working', t, 26)))),
				strokes: visual.strokes(id, 'needs-attention', 1500), loop: model.motion(id, 'needs-attention').loop });
		`,
			{ id },
		);
		expect(result.still).toEqual(result.end);
		expect(new Set(result.poses).size).toBeGreaterThan(3);
		expect(result.strokes).toEqual([]);
		expect(result.loop).toBeNull();
	});

	it("creates paired, thick neon trails that scale down for small placements", () => {
		const result = evaluate<{ counts: number[]; colors: string[]; width: number; end: unknown[]; duration: number }>(`
			const v = window.QORPERA_MOTION_VISUALS;
			({ counts: [144, 64, 26, 20].map(size => v.strokes('planet', 'creation', 1300, size).length),
				colors: [...new Set(v.strokes('planet', 'creation', 1300).map(s => s.color))],
				width: v.strokes('planet', 'creation', 1300)[0].width,
				end: v.strokes('planet', 'creation', 3500), duration: v.durations.creation });
		`);
		expect(result.counts).toEqual([12, 8, 6, 4]);
		expect(new Set(result.colors)).toEqual(new Set(["#62ff2f", "#ff2d9a", "#ff791b"]));
		expect(result.width).toBeGreaterThan(3);
		expect(result.duration).toBe(3500);
		expect(result.end).toEqual([]);
	});

	it("uses a single geometric typing transition and agent-colored dots, without opacity swaps", () => {
		const results = evaluate<Array<{ dots: unknown; start: string; end: string; serialized: string }>>(`
			const v = window.QORPERA_MOTION_VISUALS;
			window.QORPERA_MOTION_MODEL.avatars.map(a => ({
				dots: v.typing(a.id, 1, 920, 26, { color: '#2047bd' }).dots,
				start: v.typing(a.id, 0, 0, 26).transform,
				end: v.typing(a.id, 1, 920, 26).transform,
				serialized: JSON.stringify(v.typing(a.id, .5, 310, 26))
			}));
		`);
		for (const result of results) {
			expect(result.dots).toEqual(results[0].dots);
			expect(result.start).toContain("scale(1.00000, 1.00000)");
			expect(result.end).toContain("scale(0.00000, 0.00000)");
			expect(result.serialized).not.toContain("opacity");
		}
		expect(results[0].dots).toEqual(expect.arrayContaining([expect.objectContaining({ fill: "#2047bd" })]));
	});

	it("keeps one clock per agent and reverses an interrupted typing transition continuously", () => {
		const result = evaluate<{
			same: boolean;
			independent: string;
			before: number;
			after: number;
			revision: number;
			sameRevision: number;
			held: number;
			resumed: number;
			complete: string;
		}>(`
			let time = 0;
			const clock = window.QORPERA_MOTION_MODEL.createClock(() => time);
			const state = window.QORPERA_AVATAR_STATE, store = state.createActors(clock);
			const a = store.update('a', { figure: 'planet', color: '#2047bd', requestedState: 'working' });
			const b = store.update('b', { figure: 'planet', color: '#ff2994', requestedState: 'still' });
			const same = a === store.ensure('a');
			const revision = a.revision;
			store.update('a', { color: '#00c878' });
			const sameRevision = a.revision;
			store.update('a', { requestedState: 'writing' });
			time = 270;
			const before = state.transitionValue(a.form, clock.now());
			store.update('a', { requestedState: 'working' });
			const after = state.transitionValue(a.form, clock.now());
			clock.pause(); time = 10000; const held = clock.now(); clock.resume(); const resumed = clock.now();
			time += 1000;
			store.update('a', { requestedState: 'complete' });
			({ same, independent: b.state, before, after, revision, sameRevision, held, resumed, complete: a.state });
		`);
		expect(result.same).toBe(true);
		expect(result.independent).toBe("still");
		expect(result.before).toBeGreaterThan(0);
		expect(result.after).toBe(result.before);
		expect(result.sameRevision).toBe(result.revision);
		expect(result.held).toBe(270);
		expect(result.resumed).toBe(270);
		expect(result.complete).toBe("complete");
	});

	it("holds creation through incoming work, then resumes work without replaying it", () => {
		const result = evaluate<string[]>(`
			let time = 0; const store = window.QORPERA_AVATAR_STATE.createActors({ now: () => time });
			const a = store.ensure('a'); a.createdUntil = 3500;
			const states = [store.update('a', { requestedState: 'working' }).state];
			time = 1500; states.push(store.update('a', { requestedState: 'writing' }).state);
			time = 3501; states.push(store.update('a', {}).state);
			time = 4500; states.push(store.update('a', { color: '#ff2994' }).state);
			states;
		`);
		expect(result).toEqual(["creation", "creation", "writing", "writing"]);
	});

	it("prioritizes unresolved needs over work and unread messages, with one computer badge", () => {
		const result = evaluate<Array<{ kind: string; text: string; badge: string; computer: boolean }>>(`
			const s = window.QORPERA_AVATAR_STATE, active = s.activity('browser_click');
			[s.sidebar({ needsYou: true, active, unread: true }), s.sidebar({ active, unread: true }),
			 s.sidebar({ unread: true }), s.sidebar({ lastMessage: 'All done.' })];
		`);
		expect(result.map((s) => s.text)).toEqual(["Needs you", "Using computer", "New", "All done."]);
		expect(result.map((s) => s.badge)).toEqual(["unread", "active", "unread", ""]);
		expect(result.map((s) => s.computer)).toEqual([true, true, false, false]);
	});

	it("persists per-message receipts without clearing outstanding obligations", () => {
		const result = evaluate<boolean[]>(`
			const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
			const s = window.QORPERA_AVATAR_STATE, receipts = s.readReceipts(storage, 'company-a');
			const result = [receipts.unread('a', 'session:reply-1')];
			receipts.seen('a', 'session:reply-1');
			result.push(receipts.unread('a', 'session:reply-1'), receipts.unread('a', 'session:reply-2'));
			result.push(s.readReceipts(storage, 'company-a').unread('a', 'session:reply-1'));
			result.push(s.readReceipts(storage, 'company-b').unread('a', 'session:reply-1'));
			result.push(s.sidebar({ needsYou: true, unread: receipts.unread('a', 'session:reply-1') }).text === 'Needs you');
			result;
		`);
		expect(result).toEqual([true, false, true, false, true, true]);
	});

	it.each(STAFF_CHARACTER_IDS)(
		"preserves %s alpha, white eyes, native pixels, and broad depth through every palette color",
		(id) => {
			const master = readMaster(id);
			const result = evaluate<{
				native: boolean;
				variants: Array<{ alphaErrors: number; whiteErrors: number; range: number; changed: number }>;
			}>(
				`
			const a = window.QORPERA_AVATAR_APPEARANCE;
			a.prepare(id, master);
			const native = a.drawable(id, window.QORPERA_MOTION_MODEL.avatars.find(a => a.id === id).color) === master;
			const variants = a.palette.map(({color}) => {
				const tinted = a.drawable(id, color).pixels;
				let alphaErrors = 0, whiteErrors = 0, changed = 0; const lights = [];
				for (let i = 0; i < tinted.length; i += 4) {
					if (tinted[i+3] !== master.pixels[i+3]) alphaErrors++;
					if (master.pixels[i] === 255 && master.pixels[i+1] === 255 && master.pixels[i+2] === 255 && (tinted[i] !== 255 || tinted[i+1] !== 255 || tinted[i+2] !== 255)) whiteErrors++;
					if (tinted[i+3] !== 255 || Math.min(master.pixels[i], master.pixels[i+1], master.pixels[i+2]) >= 220) continue;
					if (tinted[i] !== master.pixels[i] || tinted[i+1] !== master.pixels[i+1] || tinted[i+2] !== master.pixels[i+2]) changed++;
					lights.push(tinted[i]*.2126 + tinted[i+1]*.7152 + tinted[i+2]*.0722);
				}
				lights.sort((a,b) => a-b);
				return { alphaErrors, whiteErrors, changed, range: lights[Math.floor(lights.length*.95)] - lights[Math.floor(lights.length*.05)] };
			}); ({native, variants});
		`,
				{ id, master, document: { createElement: pixelCanvas } },
			);
			expect(result.native).toBe(true);
			for (const variant of result.variants) {
				expect(variant.alphaErrors).toBe(0);
				expect(variant.whiteErrors).toBe(0);
				expect(variant.range).toBeGreaterThan(5);
			}
			expect(result.variants.filter((v) => v.changed > 10000).length).toBeGreaterThanOrEqual(10);
		},
	);
});
