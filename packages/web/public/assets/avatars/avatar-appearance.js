"use strict";

(() => {
	const model = window.QORPERA_MOTION_MODEL;
	// Eleven colours, spaced so that no two read alike on a figure (November 10,
	// 2026: Red, Sky and Slate took the places of Coral, Teal and Gray; Green,
	// Purple and Pink moved apart). Every figure's own shade but the Planet's,
	// the Flame's and the Heart's is one of them.
	const palette = Object.freeze([
		{ name: "Charcoal", color: "#312f2d" },
		{ name: "Brown", color: "#87674c" },
		{ name: "Red", color: "#e22538" },
		{ name: "Orange", color: "#f96e2d" },
		{ name: "Gold", color: "#fcb51b" },
		{ name: "Green", color: "#0fbd59" },
		{ name: "Sky", color: "#3faff3" },
		{ name: "Blue", color: "#2047bd" },
		{ name: "Purple", color: "#a145f7" },
		{ name: "Pink", color: "#fa59ac" },
		{ name: "Slate", color: "#6c839b" },
	].map(Object.freeze));
	const selected = new Map();
	const originals = new Map();
	const rendered = new Map();
	const materials = new Map();
	// White-eye thresholds in each source's least-colored channel.
	const eyeStarts = Object.freeze({ planet: 125, acorn: 100, flame: 72, rocket: 100, crown: 75, heart: 95, star: 41, cloud: 79, bolt: 84, mushroom: 56, moon: 51, puzzle: 32 });
	const linearChannels = Array.from({ length: 256 }, (_, index) => {
		const channel = index / 255;
		return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
	});
	const encode = (channel) => Math.round(Math.max(0, Math.min(1, channel <= .0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - .055)) * 255);
	// The material's tone ramp, sampled per 1/256 stop over the stops it reaches.
	const toneLow = -1.6, toneHigh = .8, toneSamples = 615;
	// The source renders' silhouettes fade over about 6 px at 512; their
	// coverage is steepened around its middle so a figure's edge is crisp.
	const edgeGain = 2;

	function toOklab([red, green, blue]) {
		const l = Math.cbrt(.4122214708 * red + .5363325363 * green + .0514459929 * blue);
		const m = Math.cbrt(.2119034982 * red + .6806995451 * green + .1073969566 * blue);
		const s = Math.cbrt(.0883024619 * red + .2817188376 * green + .6299787005 * blue);
		return [.2104542553 * l + .793617785 * m - .0040720468 * s, 1.9779984951 * l - 2.428592205 * m + .4505937099 * s, .0259040371 * l + .7827717662 * m - .808675766 * s];
	}

	function fromOklch(lightness, chroma, hue) {
		const a = chroma * Math.cos(hue), b = chroma * Math.sin(hue);
		const l = (lightness + .3963377774 * a + .2158037573 * b) ** 3;
		const m = (lightness - .1055613458 * a - .0638541728 * b) ** 3;
		const s = (lightness - .0894841775 * a - 1.291485548 * b) ** 3;
		return [4.0767416621 * l - 3.3077115913 * m + .2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - .3413193965 * s, -.0041960863 * l - .7034186147 * m + 1.707614701 * s];
	}

	// The strongest chroma below `limit` that stays inside sRGB at this
	// lightness and hue.
	function gamutChroma(lightness, hue, limit) {
		const inside = (chroma) => fromOklch(lightness, chroma, hue).every((channel) => channel >= -.0005 && channel <= 1.0005);
		if (inside(limit)) return limit;
		let low = 0, high = limit;
		for (let step = 0; step < 18; step++) {
			const middle = (low + high) / 2;
			if (inside(middle)) low = middle;
			else high = middle;
		}
		return low;
	}

	// One smooth light field per plate, in stops: light-field.js, which runs it
	// in a worker where it can, so preparing artwork leaves the page free to draw.
	const light = window.QORPERA_LIGHT_FIELD;

	function avatar(id) {
		const item = model.avatars.find((entry) => entry.id === id);
		if (!item) throw new RangeError("Unknown avatar");
		return item;
	}

	function color(id) {
		return selected.get(id) ?? avatar(id).color;
	}

	function setColor(id, value) {
		const original = avatar(id).color;
		if (value !== original && !palette.some((item) => item.color === value)) throw new RangeError("Unknown avatar color");
		if (value === original) selected.delete(id);
		else selected.set(id, value);
	}

	// The chosen color as one smooth, saturated material: a tone ramp from
	// stops of light (around the figure's median) to sRGB. Shade keeps its
	// color instead of turning gray, light thins it only a little, and the
	// color itself moves part of the way to the strongest sRGB chroma at its
	// lightness and hue. Grays stay gray, muted colors (Brown) move less, and
	// strong ones (Blue) are capped so they never turn electric.
	function material(value) {
		if (!/^#[\da-f]{6}$/.test(value)) throw new RangeError("Invalid avatar color");
		if (materials.has(value)) return materials.get(value);
		const [lightness, a, b] = toOklab([1, 3, 5].map((start) => linearChannels[Number.parseInt(value.slice(start, start + 2), 16)]));
		const hue = Math.atan2(b, a), chroma = Math.hypot(a, b);
		const vivid = chroma < .03 ? chroma : chroma + Math.min(.045, chroma * .25, (gamutChroma(lightness, hue, .4) - chroma) * .85 * Math.min(1, chroma / .1));
		// Charcoal reads its form through a wider lift, not through depth.
		const dark = lightness < .4;
		const ramp = new Uint8ClampedArray(toneSamples * 3);
		for (let sample = 0; sample < toneSamples; sample++) {
			const tone = toneLow + (toneHigh - toneLow) * sample / (toneSamples - 1);
			const shade = tone < 0;
			const level = Math.min(.97, Math.max(.12, lightness + .01 + tone * (dark ? (shade ? .16 : .09) : shade ? .16 : .12)));
			const strength = vivid * (shade ? 1 + Math.min(.18, -tone * .15) : 1 - Math.min(.06, tone * .1));
			const channels = fromOklch(level, gamutChroma(level, hue, strength), hue);
			for (let channel = 0; channel < 3; channel++) ramp[sample * 3 + channel] = encode(channels[channel]);
		}
		materials.set(value, ramp);
		return ramp;
	}

	function paint(id, value, original) {
		const figure = id.endsWith("-face") ? id.slice(0, -5) : id;
		const ramp = material(value);
		const median = originals.get(figure)?.median ?? original.median;
		const { width, height, stops, eyes } = original;
		const pixels = new ImageData(new Uint8ClampedArray(original.pixels.data), width, height);
		const data = pixels.data;
		for (let index = 0; index < stops.length; index++) {
			const offset = index * 4;
			if (!data[offset + 3]) continue;
			const tone = Math.max(toneLow, Math.min(toneHigh, stops[index] - median));
			const sample = Math.round((tone - toneLow) / (toneHigh - toneLow) * (toneSamples - 1)) * 3;
			const eye = eyes ? eyes[index] : 0;
			for (let channel = 0; channel < 3; channel++) data[offset + channel] = ramp[sample + channel] + (255 - ramp[sample + channel]) * eye;
			data[offset + 3] = (data[offset + 3] - 127.5) * edgeGain + 127.5;
		}
		return pixels;
	}

	function matchFaceLighting(id, plate, body, width, height) {
		// Fit a gentle RGB correction from the intact material surrounding each
		// eye. This keeps generated clean plates seamless in native and recolored
		// figures without replacing any of the approved body or silhouette.
		const corrections = model.faces[id].map((eye) => {
			const matrix = Array.from({ length: 3 }, () => Array(6).fill(0));
			const angle = eye.rotation * Math.PI / 180;
			const cosine = Math.cos(angle), sine = Math.sin(angle);
			const radius = eye.height / 2 + 6;
			const left = Math.max(0, Math.floor((eye.x - radius) / 100 * width));
			const right = Math.min(width, Math.ceil((eye.x + radius) / 100 * width));
			const top = Math.max(0, Math.floor((eye.y - radius) / 100 * height));
			const bottom = Math.min(height, Math.ceil((eye.y + radius) / 100 * height));
			for (let y = top; y < bottom; y += 2) {
				for (let x = left; x < right; x += 2) {
					const dx = (x + .5) / width * 100 - eye.x;
					const dy = (y + .5) / height * 100 - eye.y;
					const u = dx * cosine + dy * sine;
					const v = -dx * sine + dy * cosine;
					const distance = Math.hypot(u, Math.max(0, Math.abs(v) - (eye.height - eye.width) / 2)) - eye.width / 2;
					if (distance < 2.5 || distance > 5) continue;
					const offset = (y * width + x) * 4;
					if (body[offset + 3] !== 255 || plate[offset + 3] !== 255 || Math.min(body[offset], body[offset + 1], body[offset + 2]) >= 220) continue;
					const basis = [1, dx / 10, dy / 10];
					for (let row = 0; row < 3; row++) {
						for (let column = 0; column < 3; column++) matrix[row][column] += basis[row] * basis[column];
						for (let channel = 0; channel < 3; channel++) matrix[row][channel + 3] += basis[row] * (body[offset + channel] - plate[offset + channel]);
					}
				}
			}
			if (matrix[0][0] < 12) return { eye, coefficients: Array.from({ length: 3 }, () => [0, 0, 0]) };
			for (let pivot = 0; pivot < 3; pivot++) {
				let largest = pivot;
				for (let row = pivot + 1; row < 3; row++) if (Math.abs(matrix[row][pivot]) > Math.abs(matrix[largest][pivot])) largest = row;
				[matrix[pivot], matrix[largest]] = [matrix[largest], matrix[pivot]];
				const divisor = matrix[pivot][pivot];
				if (Math.abs(divisor) < .000001) return { eye, coefficients: Array.from({ length: 3 }, () => [0, 0, 0]) };
				for (let column = 0; column < 6; column++) matrix[pivot][column] /= divisor;
				for (let row = 0; row < 3; row++) {
					if (row === pivot) continue;
					const amount = matrix[row][pivot];
					for (let column = 0; column < 6; column++) matrix[row][column] -= amount * matrix[pivot][column];
				}
			}
			return { eye, coefficients: matrix.map((row) => row.slice(3)) };
		});
		if (corrections.every(({ coefficients }) => coefficients.every((row) => row.every((value) => value === 0)))) return;
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const px = (x + .5) / width * 100, py = (y + .5) / height * 100;
				const correction = corrections.reduce((closest, item) => Math.hypot(px - item.eye.x, py - item.eye.y) < Math.hypot(px - closest.eye.x, py - closest.eye.y) ? item : closest);
				const basis = [1, (px - correction.eye.x) / 10, (py - correction.eye.y) / 10];
				const offset = (y * width + x) * 4;
				for (let channel = 0; channel < 3; channel++) {
					plate[offset + channel] += basis.reduce((sum, value, row) => sum + value * correction.coefficients[row][channel], 0);
				}
			}
		}
	}

	// How white each pixel of a body is as part of an eye: the measured eye
	// shapes, then the source's white in its least-colored channel.
	function eyeCover(id, pixels, width, height) {
		const source = [1, 3, 5].map((start) => Number.parseInt(avatar(id).color.slice(start, start + 2), 16));
		const eyeChannel = source.indexOf(Math.min(...source));
		const eyeStart = eyeStarts[id] / 255;
		const eyes = model.faces[id].map((eye) => ({ ...eye, cosine: Math.cos(eye.rotation * Math.PI / 180), sine: Math.sin(eye.rotation * Math.PI / 180) }));
		const cover = new Float32Array(width * height);
		for (let index = 0; index < cover.length; index++) {
			const offset = index * 4;
			if (!pixels[offset + 3]) continue;
			const x = (index % width + .5) / width * 100;
			const y = (Math.floor(index / width) + .5) / height * 100;
			const inEye = eyes.some((eye) => {
				const dx = x - eye.x, dy = y - eye.y;
				const u = dx * eye.cosine + dy * eye.sine;
				const v = -dx * eye.sine + dy * eye.cosine;
				return Math.hypot(u, Math.max(0, Math.abs(v) - (eye.height - eye.width) / 2)) <= eye.width / 2 + 1;
			});
			if (inEye) cover[index] = Math.max(0, (pixels[offset + eyeChannel] / 255 - eyeStart) / (1 - eyeStart));
		}
		return cover;
	}

	// Prepares one plate; resolves once it can be drawn. A face plate waits for
	// its body when the body is still being prepared.
	const preparing = new Map();
	function prepare(id, image) {
		const isFace = id.endsWith("-face");
		const figure = isFace ? id.slice(0, -5) : id;
		avatar(figure);
		if (originals.has(id)) return Promise.resolve();
		if (preparing.has(id)) return preparing.get(id);
		const run = (async () => {
			if (isFace && preparing.has(figure)) await preparing.get(figure);
			await prepareNow(id, image, isFace, figure);
		})().finally(() => preparing.delete(id));
		preparing.set(id, run);
		return run;
	}

	async function prepareNow(id, image, isFace, figure) {
		const body = isFace ? originals.get(figure) : null;
		// A face plate is read at its body's size; the Planet plate's larger
		// source is resampled here, as the other six plates were when exported.
		const width = body ? body.width : image.naturalWidth;
		const height = body ? body.height : image.naturalHeight;
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		// Decode once into an explicit sRGB buffer. CSS/SVG filter pipelines can
		// reinterpret source channels on wide-gamut displays and wash out cyan.
		const context = canvas.getContext("2d", { colorSpace: "srgb", willReadFrequently: true });
		context.drawImage(image, 0, 0, width, height);
		const pixels = context.getImageData(0, 0, width, height);
		if (id === "planet-face") {
			// Match the blank face plate to the original body before recoloring.
			const offsets = [-.03259, -.00343, -.01889];
			for (let index = 0; index < pixels.data.length; index += 4) {
				for (let channel = 0; channel < 3; channel++) pixels.data[index + channel] += offsets[channel] * 255;
			}
		} else if (isFace && body) {
			matchFaceLighting(figure, pixels.data, body.pixels.data, width, height);
		}
		// The body's alpha is the silhouette: the Planet plate is opaque, and
		// drawing clips every plate to its body.
		const silhouette = body ? body.pixels.data : pixels.data;
		const coverage = Float32Array.from({ length: width * height }, (_, index) => silhouette[index * 4 + 3] / 255);
		const eyes = isFace ? null : eyeCover(figure, pixels.data, width, height);
		const stops = light ? await light.compute(pixels.data, coverage, eyes, width, height) : null;
		if (!stops) throw new Error("Avatar light field unavailable");
		// Anchor the ramp to the body's median light, so a body and its plate
		// meet without a seam.
		const lights = [];
		for (let index = 0; index < stops.length; index++) if (coverage[index] === 1 && !(eyes && eyes[index])) lights.push(stops[index]);
		lights.sort((first, second) => first - second);
		const median = lights.length ? lights[lights.length >> 1] : 0;
		originals.set(id, { image, pixels, stops, eyes, median, width, height });
	}

	function variant(id, value) {
		const original = originals.get(id);
		if (!original) throw new Error(`Avatar artwork not prepared: ${id}`);
		const key = id + value;
		if (rendered.has(key)) return rendered.get(key);
		const canvas = document.createElement("canvas");
		canvas.width = original.width;
		canvas.height = original.height;
		canvas.getContext("2d", { colorSpace: "srgb" }).putImageData(paint(id, value, original), 0, 0);
		const result = { image: canvas, url: canvas.toDataURL("image/png") };
		rendered.set(key, result);
		return result;
	}

	function source(id, value = color(id.endsWith("-face") ? id.slice(0, -5) : id)) {
		return variant(id, value).url;
	}

	function drawable(id, value = color(id)) {
		return variant(id, value).image;
	}

	window.QORPERA_AVATAR_APPEARANCE = Object.freeze({ palette, color, setColor, prepare, source, drawable });
})();
