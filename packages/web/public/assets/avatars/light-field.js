"use strict";

// The figures' light field (avatar-appearance.js prepare), shared by the page and
// a worker. Loaded as a classic script it defines QORPERA_LIGHT_FIELD; started as
// a worker (this same file, same version) it answers compute requests. The field
// for one 512px plate is about 30 million weighted samples, so a page with seven
// figures spent about half a second on it before the rail could draw (9 Nov
// 2026); workers take it off the main thread and run the plates side by side.
// Both run this one function, so a field is the same wherever it is computed.
(() => {
	const linearChannels = Array.from({ length: 256 }, (_, index) => {
		const channel = index / 255;
		return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
	});
	// Range weights for the light smoothing, indexed by a difference in stops
	// over its range (4 ranges at most) at 256 steps per range.
	const lightRange = .16;
	const rangeWeights = Float32Array.from({ length: 1025 }, (_, index) => Math.exp(-.5 * (index / 256) ** 2));

	// One smooth light field per plate, in stops. The source renders carry a
	// paper grain; neighbors across a real crease (Planet's ring, Acorn's cap)
	// differ by far more than the grain does, so the edge-aware passes melt
	// the grain and keep the creases. Eyes and transparent pixels never count
	// as neighbors, so neither brightens nor darkens the rim around them.
	function lightField(pixels, coverage, eyes, width, height) {
		let stops = new Float32Array(width * height);
		for (let index = 0; index < stops.length; index++) {
			const offset = index * 4;
			const light = linearChannels[pixels[offset]] * .2126 + linearChannels[pixels[offset + 1]] * .7152 + linearChannels[pixels[offset + 2]] * .0722;
			stops[index] = Math.log2(Math.max(.0001, light));
		}
		const scale = width / 512;
		const radius = Math.round(9 * scale);
		const spatial = Float32Array.from({ length: radius * 2 + 1 }, (_, index) => Math.exp(-.5 * ((index - radius) / (4.5 * scale)) ** 2));
		for (let pass = 0; pass < 3; pass++) {
			for (const vertical of [false, true]) {
				const output = new Float32Array(stops.length);
				const limit = vertical ? height : width;
				const stride = vertical ? width : 1;
				for (let y = 0; y < height; y++) {
					for (let x = 0; x < width; x++) {
						const index = y * width + x;
						output[index] = stops[index];
						if (!coverage[index]) continue;
						const position = vertical ? y : x;
						let sum = 0;
						let total = 0;
						for (let distance = Math.max(-radius, -position); distance <= Math.min(radius, limit - position - 1); distance++) {
							const neighbor = index + distance * stride;
							if (coverage[neighbor] < .5 || (eyes && eyes[neighbor])) continue;
							const difference = Math.round(Math.abs(stops[neighbor] - stops[index]) / lightRange * 256);
							if (difference > 1024) continue;
							const weight = spatial[distance + radius] * rangeWeights[difference] * coverage[neighbor];
							sum += stops[neighbor] * weight;
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

	if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
		self.onmessage = ({ data }) => {
			const stops = lightField(data.pixels, data.coverage, data.eyes, data.width, data.height);
			self.postMessage({ job: data.job, stops }, [stops.buffer]);
		};
		return;
	}

	// The worker is this file at the version the page loaded.
	const url = document.currentScript?.src;
	const pool = [];
	const jobs = new Map();
	let next = 0;
	let jobCount = 0;
	let broken = !url || typeof Worker !== "function";

	function worker() {
		const size = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
		if (pool.length < size) {
			const created = new Worker(url);
			created.onmessage = ({ data }) => {
				const job = jobs.get(data.job);
				jobs.delete(data.job);
				job?.resolve(data.stops);
			};
			// A worker that cannot start or fails hands its jobs back to the page.
			created.onerror = (event) => {
				event.preventDefault?.();
				broken = true;
				for (const [key, job] of jobs) if (job.worker === created) {
					jobs.delete(key);
					job.resolve(lightField(...job.input));
				}
			};
			pool.push(created);
			return created;
		}
		return pool[next++ % pool.length];
	}

	// The field off the main thread when a worker can run, on it otherwise.
	// The arrays are copied, so the caller keeps its own.
	function compute(pixels, coverage, eyes, width, height) {
		if (broken) return Promise.resolve(lightField(pixels, coverage, eyes, width, height));
		const input = [pixels.slice(), coverage.slice(), eyes ? eyes.slice() : null, width, height];
		return new Promise((resolve) => {
			let target;
			try {
				target = worker();
			} catch {
				broken = true;
				resolve(lightField(...input));
				return;
			}
			const job = ++jobCount;
			jobs.set(job, { resolve, input, worker: target });
			target.postMessage({ job, pixels: input[0], coverage: input[1], eyes: input[2], width, height });
		});
	}

	window.QORPERA_LIGHT_FIELD = Object.freeze({ lightField, compute });
})();
