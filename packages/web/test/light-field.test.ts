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

describe("the figures' light field (light-field.js)", () => {
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
