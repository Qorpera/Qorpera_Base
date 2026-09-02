"use strict";

(() => {
	const model = window.QORPERA_MOTION_MODEL;
	// Native Ghost, Acorn, Rocket, and Crown shades remain shared choices.
	// Choosing one on its original figure leaves that artwork untouched.
	const palette = Object.freeze([
		{ name: "Charcoal", color: "#312f2d" },
		{ name: "Brown", color: "#87674c" },
		{ name: "Coral", color: "#ff365e" },
		{ name: "Orange", color: "#f96e2d" },
		{ name: "Gold", color: "#fcb51b" },
		{ name: "Green", color: "#00c878" },
		{ name: "Teal", color: "#00bfb3" },
		{ name: "Blue", color: "#2047bd" },
		{ name: "Purple", color: "#b83ff5" },
		{ name: "Pink", color: "#ff2994" },
		{ name: "Gray", color: "#7c7c7a" },
	].map(Object.freeze));
	const selected = new Map();
	const transforms = new Map();
	const originals = new Map();
	const rendered = new Map();
	const materialLights = new Map();
	// White-eye thresholds in each source's least-colored channel. Lighting is
	// independent of this mask: preserve the original shadow/highlight field.
	const eyeStarts = Object.freeze({ planet: 125, acorn: 100, flame: 72, rocket: 100, crown: 75, heart: 95, ghost: 95 });
	const linearChannels = Array.from({ length: 256 }, (_, index) => {
		const channel = index / 255;
		return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
	});
	const toneSteps = 4095;
	const rangeWeights = Float32Array.from({ length: 1025 }, (_, index) => Math.exp(-.5 * (index / 1024 / .22) ** 2));

	function smoothLighting(id, pixels, width, height) {
		const source = [1, 3, 5].map((start) => Number.parseInt(avatar(id).color.slice(start, start + 2), 16));
		const eyeChannel = source.indexOf(Math.min(...source));
		const lights = new Float32Array(width * height);
		const weights = new Float32Array(lights.length);
		let count = 0;
		for (let index = 0; index < lights.length; index++) {
			const offset = index * 4;
			lights[index] = linearChannels[pixels[offset]] * .2126 + linearChannels[pixels[offset + 1]] * .7152 + linearChannels[pixels[offset + 2]] * .0722;
			// Keep the silhouette and white eyes out of the lighting filter.
			// Their original alpha and antialiased edge pixels are never blurred.
			if (!pixels[offset + 3] || pixels[offset + eyeChannel] > eyeStarts[id]) continue;
			weights[index] = pixels[offset + 3] / 255;
			count++;
		}
		if (!count) return lights;
		const radius = Math.max(2, Math.round(Math.min(width, height) / 85));
		const spatial = Float32Array.from({ length: radius * 2 + 1 }, (_, index) => Math.exp(-.5 * ((index - radius) / (radius / 2)) ** 2));
		// Two edge-aware passes remove fine source grain, not broad form or the
		// ring/fold shadows. Log-light differences adapt to both dark and light
		// originals, so Ghost's texture is not magnified by a bright recolor.
		let filtered = lights;
		for (const vertical of [false, true]) {
			const output = new Float32Array(lights.length);
			const guide = Float32Array.from(filtered, (light) => Math.log2(Math.max(.0001, light)));
			for (let y = 0; y < height; y++) {
				for (let x = 0; x < width; x++) {
					const index = y * width + x;
					if (!weights[index]) { output[index] = filtered[index]; continue; }
					let sum = 0;
					let total = 0;
					const position = vertical ? y : x;
					const limit = vertical ? height : width;
					const stride = vertical ? width : 1;
					for (let distance = Math.max(-radius, -position); distance <= Math.min(radius, limit - position - 1); distance++) {
						const neighbor = index + distance * stride;
						if (!weights[neighbor]) continue;
						const difference = Math.round(Math.abs(guide[index] - guide[neighbor]) * 1024);
						if (difference > 1024) continue;
						const weight = spatial[distance + radius] * rangeWeights[difference] * weights[neighbor];
						sum += filtered[neighbor] * weight;
						total += weight;
					}
					output[index] = sum / total;
				}
			}
			filtered = output;
		}
		// Preserve some native grain at portrait scale without amplifying it
		// into harsh chromatic noise. Broad lighting and silhouette stay intact.
		return id === "ghost" ? filtered : Float32Array.from(filtered, (light, index) => light * .65 + lights[index] * .35);
	}

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

	function hueSaturationValue(channels) {
		const high = Math.max(...channels), low = Math.min(...channels);
		const range = high - low;
		const [red, green, blue] = channels;
		const hue = range === 0 ? 0 : high === red ? ((green - blue) / range + 6) % 6 : high === green ? (blue - red) / range + 2 : (red - green) / range + 4;
		return [hue, high ? range / high : 0, high];
	}

	function transform(id, value) {
		const source = avatar(id).color;
		if (!/^#[\da-f]{6}$/.test(value)) throw new RangeError("Invalid avatar color");
		if (source === value) return null;
		const key = id + value;
		if (transforms.has(key)) return transforms.get(key);
		const from = [1, 3, 5].map((start) => linearChannels[Number.parseInt(source.slice(start, start + 2), 16)]);
		const to = [1, 3, 5].map((start) => linearChannels[Number.parseInt(value.slice(start, start + 2), 16)]);
		const baseLight = materialLights.get(id) ?? from[0] * .2126 + from[1] * .7152 + from[2] * .0722;
		const eyeStart = eyeStarts[id] / 255;
		// Transfer diffuse shade and highlight energy in linear light, anchored
		// to the chosen color. No percentile clamp or flattened material range.
		// A lookup table keeps recoloring responsive and preserves dark detail.
		const tables = to.map((channel) => Array.from({ length: toneSteps + 1 }, (_, index) => {
			const level = index / toneSteps;
			const lit = level <= baseLight ? channel * level / baseLight : channel + (1 - channel) * (level - baseLight) / (1 - baseLight);
			return lit <= .0031308 ? lit * 12.92 : 1.055 * lit ** (1 / 2.4) - .055;
		}));
		// Bright blue/green material is not a white eye. Preserve the eyes with
		// their own channel mask rather than treating body brightness as white.
		const eyeChannel = from.indexOf(Math.min(...from));
		const eyeTable = Array.from({ length: 256 }, (_, index) => Math.max(0, (index / 255 - eyeStart) / (1 - eyeStart)));
		const fromHsv = hueSaturationValue([1, 3, 5].map((start) => Number.parseInt(source.slice(start, start + 2), 16) / 255));
		const toHsv = hueSaturationValue([1, 3, 5].map((start) => Number.parseInt(value.slice(start, start + 2), 16) / 255));
		const result = { tables, eyeChannel, eyeTable, hueShift: toHsv[0] - fromHsv[0], saturationGain: (toHsv[1] / fromHsv[1]) ** .8, valueGain: toHsv[2] / fromHsv[2] };
		transforms.set(key, result);
		return result;
	}

	function tintPixels(id, value, pixels, lighting = null, width = 512, hasEyes = true) {
		const spec = transform(id, value);
		if (!spec) return pixels;
		const height = pixels.length / 4 / width;
		const eyes = model.faces[id].map((eye) => ({ ...eye, cosine: Math.cos(eye.rotation * Math.PI / 180), sine: Math.sin(eye.rotation * Math.PI / 180) }));
		for (let index = 0; index < pixels.length; index += 4) {
			if (pixels[index + 3] === 0) continue;
			if (pixels[index] === 255 && pixels[index + 1] === 255 && pixels[index + 2] === 255) continue;
			if (id === "planet" || id === "flame") {
				// These saturated portraits retain the source's value, pigment
				// texture and highlight rolloff. A single luminance ramp created
				// visible contour bands where the teal's red channel reached zero.
				const original = hueSaturationValue([pixels[index], pixels[index + 1], pixels[index + 2]].map((channel) => channel / 255));
				const hue = (original[0] + spec.hueShift + 6) % 6;
				const saturation = Math.min(.98, original[1] * spec.saturationGain);
				const value = Math.min(1, original[2] * spec.valueGain);
				const chroma = value * saturation;
				const secondary = chroma * (1 - Math.abs(hue % 2 - 1));
				const shade = value - chroma;
				const channels = [[chroma, secondary, 0], [secondary, chroma, 0], [0, chroma, secondary], [0, secondary, chroma], [secondary, 0, chroma], [chroma, 0, secondary]][Math.floor(hue)];
				for (let channel = 0; channel < 3; channel++) pixels[index + channel] = Math.round((channels[channel] + shade) * 255);
				continue;
			}
			const r = linearChannels[pixels[index]];
			const g = linearChannels[pixels[index + 1]];
			const b = linearChannels[pixels[index + 2]];
			const level = (lighting ? lighting[index / 4] : r * .2126 + g * .7152 + b * .0722) * toneSteps;
			const lower = Math.floor(level);
			const upper = Math.min(toneSteps, lower + 1);
			const x = ((index / 4) % width + .5) / width * 100;
			const y = (Math.floor(index / 4 / width) + .5) / height * 100;
			// White-eye protection belongs only to the measured eyes. Applying
			// it across the body bleaches highlights and flattens teal and pink.
			const inEye = hasEyes && eyes.some((eye) => {
				const dx = x - eye.x, dy = y - eye.y;
				const u = dx * eye.cosine + dy * eye.sine;
				const v = -dx * eye.sine + dy * eye.cosine;
				return Math.hypot(u, Math.max(0, Math.abs(v) - (eye.height - eye.width) / 2)) <= eye.width / 2 + 1;
			});
			const eye = inEye ? spec.eyeTable[pixels[index + spec.eyeChannel]] : 0;
			for (let channel = 0; channel < 3; channel++) {
				const table = spec.tables[channel];
				const material = table[lower] + (table[upper] - table[lower]) * (level - lower);
				const output = material + (1 - material) * eye;
				pixels[index + channel] = Math.round(Math.max(0, Math.min(1, output)) * 255);
			}
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

	function prepare(id, image) {
		const isFace = id.endsWith("-face");
		const figure = isFace ? id.slice(0, -5) : id;
		avatar(figure);
		if (originals.has(id)) return;
		const body = isFace ? originals.get(figure) : null;
		const width = body && figure !== "planet" ? body.width : image.naturalWidth;
		const height = body && figure !== "planet" ? body.height : image.naturalHeight;
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
		const lighting = smoothLighting(figure, pixels.data, width, height);
		if (!isFace) {
			// Anchor the material to its measured median light, not the luminance
			// of three independently sampled channel medians. That small offset
			// otherwise adds an unwanted pale tint to saturated green and teal.
			const histogram = new Uint32Array(toneSteps + 1);
			let count = 0;
			for (let index = 0; index < pixels.data.length; index += 4) {
				const data = pixels.data;
				if (data[index + 3] !== 255 || Math.min(data[index], data[index + 1], data[index + 2]) >= 220) continue;
				const light = lighting[index / 4];
				histogram[Math.round(light * toneSteps)]++;
				count++;
			}
			if (count > 0) {
				let cumulative = 0;
				for (let level = 0; level <= toneSteps; level++) {
					cumulative += histogram[level];
					if (cumulative <= count / 2) continue;
					if (level > 0 && level < toneSteps) materialLights.set(id, level / toneSteps);
					break;
				}
				for (const key of transforms.keys()) if (key.startsWith(id + "#")) transforms.delete(key);
			}
		}
		originals.set(id, { image, pixels, lighting, width, height });
	}

	function variant(id, value) {
		const original = originals.get(id);
		if (!original) throw new Error(`Avatar artwork not prepared: ${id}`);
		const isFace = id.endsWith("-face");
		const figure = isFace ? id.slice(0, -5) : id;
		if (!isFace && value === avatar(figure).color) return { image: original.image, url: original.image.src };
		const key = id + value;
		if (rendered.has(key)) return rendered.get(key);
		const canvas = document.createElement("canvas");
		canvas.width = original.width;
		canvas.height = original.height;
		const context = canvas.getContext("2d", { colorSpace: "srgb" });
		const pixels = context.createImageData(original.width, original.height);
		pixels.data.set(original.pixels.data);
		tintPixels(figure, value, pixels.data, original.lighting, original.width, !isFace);
		context.putImageData(pixels, 0, 0);
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

	window.QORPERA_AVATAR_APPEARANCE = Object.freeze({ palette, color, setColor, transform, tintPixels, prepare, source, drawable });
})();
