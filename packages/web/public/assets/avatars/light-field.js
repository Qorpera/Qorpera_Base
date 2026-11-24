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
	// The same arithmetic, in the same order, as the first version (9 Nov 2026), so the same Float32 field, in a
	// shape Safari's JavaScript engine runs well: it took 1.5-1.7 s per 512px plate in Safari 18.6 on a Mac (about
	// 40 ms in Chromium), and 54 ms like this. Neighbours are checked through one mask made once, the centre value
	// and the loop bounds are worked out once per pixel, and the passes swap two buffers.
	function lightField(pixels, coverage, eyes, width, height) {
		const count = width * height;
		let stops = new Float32Array(count);
		for (let index = 0; index < count; index++) {
			const offset = index * 4;
			const light = linearChannels[pixels[offset]] * .2126 + linearChannels[pixels[offset + 1]] * .7152 + linearChannels[pixels[offset + 2]] * .0722;
			stops[index] = Math.log2(Math.max(.0001, light));
		}
		const scale = width / 512;
		const radius = Math.round(9 * scale);
		const spatial = Float32Array.from({ length: radius * 2 + 1 }, (_, index) => Math.exp(-.5 * ((index - radius) / (4.5 * scale)) ** 2));
		// A neighbour counts when it is at least half covered and not an eye.
		const counts = new Uint8Array(count);
		for (let index = 0; index < count; index++) counts[index] = coverage[index] < .5 || (eyes && eyes[index]) ? 0 : 1;
		let output = new Float32Array(count);
		for (let pass = 0; pass < 3; pass++) {
			for (let direction = 0; direction < 2; direction++) {
				const vertical = direction === 1;
				const limit = vertical ? height : width;
				const stride = vertical ? width : 1;
				for (let y = 0; y < height; y++) {
					for (let x = 0; x < width; x++) {
						const index = y * width + x;
						const centre = stops[index];
						output[index] = centre;
						if (!coverage[index]) continue;
						const position = vertical ? y : x;
						const from = position < radius ? -position : -radius;
						const last = limit - position - 1;
						const to = last < radius ? last : radius;
						let sum = 0;
						let total = 0;
						let neighbor = index + from * stride;
						for (let distance = from; distance <= to; distance++, neighbor += stride) {
							if (counts[neighbor] === 0) continue;
							const value = stops[neighbor];
							const difference = Math.round(Math.abs(value - centre) / lightRange * 256);
							if (difference > 1024) continue;
							const weight = spatial[distance + radius] * rangeWeights[difference] * coverage[neighbor];
							sum += value * weight;
							total += weight;
						}
						if (total) output[index] = sum / total;
					}
				}
				const previous = stops;
				stops = output;
				output = previous;
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
		const fallbackInput = [pixels, coverage, eyes, width, height];
		const pixelsCopy = pixels.slice();
		const coverageCopy = coverage.slice();
		const eyesCopy = eyes ? eyes.slice() : null;
		const transfer = eyesCopy
			? [pixelsCopy.buffer, coverageCopy.buffer, eyesCopy.buffer]
			: [pixelsCopy.buffer, coverageCopy.buffer];
		return new Promise((resolve) => {
			let target;
			try {
				target = worker();
			} catch {
				broken = true;
				resolve(lightField(...fallbackInput));
				return;
			}
			const job = ++jobCount;
			jobs.set(job, { resolve, input: fallbackInput, worker: target });
			target.postMessage({ job, pixels: pixelsCopy, coverage: coverageCopy, eyes: eyesCopy, width, height }, transfer);
		});
	}

	window.QORPERA_LIGHT_FIELD = Object.freeze({ lightField, compute });
})();
