import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// public/assets/avatars/light-field.js, run as the page runs it (a classic script defining a global) and as the
// worker it starts (the same file in a worker scope), each in its own sandbox.
const source = readFileSync(new URL("../public/assets/avatars/light-field.js", import.meta.url), "utf8");

interface LightField {
	lightField(
		pixels: Uint8ClampedArray,
		coverage: Float32Array,
		eyes: Float32Array | null,
		width: number,
		height: number,
	): Float32Array;
	compute(
		pixels: Uint8ClampedArray,
		coverage: Float32Array,
		eyes: Float32Array | null,
		width: number,
		height: number,
	): Promise<Float32Array>;
}

class WorkerScope {
	onmessage: ((event: { data: unknown }) => void) | null = null;
	posted: unknown[] = [];
	postMessage(data: unknown): void {
		this.posted.push(data);
	}
}

function run(globals: Record<string, unknown>): void {
	const names = Object.keys(globals);
	new Function(...names, source)(...names.map((name) => globals[name]));
}

/** The script as a page loads it: `Worker` is what `new Worker(url)` builds, if anything. */
function page(
	Worker?: unknown,
	url: string | undefined = "https://app.example/assets/avatars/light-field.js?v=0123456789ab",
): LightField {
	const window: { QORPERA_LIGHT_FIELD?: LightField } = {};
	run({
		window,
		self: window,
		document: { currentScript: url ? { src: url } : null },
		navigator: { hardwareConcurrency: 4 },
		Worker,
		WorkerGlobalScope: undefined,
	});
	return window.QORPERA_LIGHT_FIELD!;
}

/** A small plate: a lit disc with a crease, its coverage, and one eye. */
function plate(): [Uint8ClampedArray, Float32Array, Float32Array, number, number] {
	const width = 48,
		height = 40;
	const pixels = new Uint8ClampedArray(width * height * 4);
	const coverage = new Float32Array(width * height);
	const eyes = new Float32Array(width * height);
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) {
			const index = y * width + x;
			const inside = (x - 24) ** 2 + (y - 20) ** 2 < 18 ** 2;
			const shade = 60 + ((x * 7 + y * 3) % 40) + (y > 22 ? 90 : 0);
			pixels.set([shade, shade + 10, shade - 20, inside ? 255 : 0], index * 4);
			coverage[index] = inside ? 1 : 0;
			if ((x - 30) ** 2 + (y - 15) ** 2 < 9) eyes[index] = 1;
		}
	return [pixels, coverage, eyes, width, height];
}

/** lightField as first written (avatar-appearance.js before 9 Nov 2026): the reference the shipped one must match
 * bit for bit. */
function referenceLightField(
	pixels: Uint8ClampedArray,
	coverage: Float32Array,
	eyes: Float32Array | null,
	width: number,
	height: number,
): Float32Array {
	const linearChannels = Array.from({ length: 256 }, (_, index) => {
		const channel = index / 255;
		return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
	});
	const lightRange = 0.16;
	const rangeWeights = Float32Array.from({ length: 1025 }, (_, index) => Math.exp(-0.5 * (index / 256) ** 2));
	let stops = new Float32Array(width * height);
	for (let index = 0; index < stops.length; index++) {
		const offset = index * 4;
		const light =
			linearChannels[pixels[offset]!]! * 0.2126 +
			linearChannels[pixels[offset + 1]!]! * 0.7152 +
			linearChannels[pixels[offset + 2]!]! * 0.0722;
		stops[index] = Math.log2(Math.max(0.0001, light));
	}
	const scale = width / 512;
	const radius = Math.round(9 * scale);
	const spatial = Float32Array.from({ length: radius * 2 + 1 }, (_, index) =>
		Math.exp(-0.5 * ((index - radius) / (4.5 * scale)) ** 2),
	);
	for (let pass = 0; pass < 3; pass++) {
		for (const vertical of [false, true]) {
			const output = new Float32Array(stops.length);
			const limit = vertical ? height : width;
			const stride = vertical ? width : 1;
			for (let y = 0; y < height; y++) {
				for (let x = 0; x < width; x++) {
					const index = y * width + x;
					output[index] = stops[index]!;
					if (!coverage[index]) continue;
					const position = vertical ? y : x;
					let sum = 0;
					let total = 0;
					for (
						let distance = Math.max(-radius, -position);
						distance <= Math.min(radius, limit - position - 1);
						distance++
					) {
						const neighbor = index + distance * stride;
						if (coverage[neighbor]! < 0.5 || eyes?.[neighbor]) continue;
						const difference = Math.round((Math.abs(stops[neighbor]! - stops[index]!) / lightRange) * 256);
						if (difference > 1024) continue;
						const weight = spatial[distance + radius]! * rangeWeights[difference]! * coverage[neighbor]!;
						sum += stops[neighbor]! * weight;
						total += weight;
					}
					if (total) output[index] = sum / total;
				}
			}
			stops = output;
		}
	}
	return stops;
}

/** A larger plate with a soft edge (partial coverage), a crease and an eye, at 1/4 of the 512px scale. */
function softPlate(): [Uint8ClampedArray, Float32Array, Float32Array, number, number] {
	const width = 128,
		height = 112;
	const pixels = new Uint8ClampedArray(width * height * 4);
	const coverage = new Float32Array(width * height);
	const eyes = new Float32Array(width * height);
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) {
			const index = y * width + x;
			const edge = 50 - Math.hypot(x - 64, y - 56);
			const shade = 40 + ((x * 13 + y * 7) % 60) + (y > 60 ? 120 : 0);
			pixels.set([shade, Math.min(255, shade + 25), Math.max(0, shade - 30), edge > 0 ? 255 : 0], index * 4);
			coverage[index] = Math.max(0, Math.min(1, edge / 3));
			if ((x - 80) ** 2 + (y - 40) ** 2 < 36) eyes[index] = 0.25 + ((x + y) % 4) / 4;
		}
	return [pixels, coverage, eyes, width, height];
}

describe("the figures' light field (light-field.js)", () => {
	it("matches the first version bit for bit, faster in Safari", () => {
		const light = page(undefined);
		for (const input of [plate(), softPlate()]) {
			const shipped = light.lightField(...input);
			const reference = referenceLightField(...input);
			expect(new Uint32Array(shipped.buffer)).toEqual(new Uint32Array(reference.buffer));
		}
		const [pixels, coverage] = plate();
		expect(Array.from(light.lightField(pixels, coverage, null, 48, 40))).toEqual(
			Array.from(referenceLightField(pixels, coverage, null, 48, 40)),
		);
	});

	it("computes on the page when no worker can run, the same field as the function itself", async () => {
		const light = page(undefined);
		const input = plate();
		const direct = light.lightField(...input);
		expect(Array.from(await light.compute(...input))).toEqual(Array.from(direct));
		// The caller keeps its own arrays.
		expect(input[0][3]).toBe(0);
	});

	it("hands a plate to a worker running this same file, and gets the same field back", async () => {
		const started: string[] = [];
		class FakeWorker {
			onmessage: ((event: { data: unknown }) => void) | null = null;
			onerror: ((event: unknown) => void) | null = null;
			readonly scope = new WorkerScope();
			constructor(url: string) {
				started.push(url);
				run({
					self: this.scope,
					WorkerGlobalScope: WorkerScope,
					window: undefined,
					document: undefined,
					navigator: undefined,
					Worker: undefined,
				});
			}
			postMessage(data: unknown): void {
				this.scope.onmessage!({ data });
				const answer = this.scope.posted.pop();
				queueMicrotask(() => this.onmessage!({ data: answer }));
			}
		}
		const light = page(FakeWorker);
		const input = plate();
		const fields = await Promise.all([light.compute(...input), light.compute(...input)]);
		const direct = light.lightField(...input);
		for (const field of fields) expect(Array.from(field)).toEqual(Array.from(direct));
		expect(started).toEqual([
			"https://app.example/assets/avatars/light-field.js?v=0123456789ab",
			"https://app.example/assets/avatars/light-field.js?v=0123456789ab",
		]);
	});

	it("computes on the page after a worker fails, and for every plate after it", async () => {
		const workers: { onerror: ((event: unknown) => void) | null }[] = [];
		class FailingWorker {
			onmessage = null;
			onerror: ((event: unknown) => void) | null = null;
			constructor() {
				workers.push(this);
			}
			postMessage(): void {
				queueMicrotask(() => this.onerror!({ preventDefault() {} }));
			}
		}
		const light = page(FailingWorker);
		const input = plate();
		const direct = Array.from(light.lightField(...input));
		expect(Array.from(await light.compute(...input))).toEqual(direct);
		expect(Array.from(await light.compute(...input))).toEqual(direct);
		expect(workers).toHaveLength(1);
	});
});
