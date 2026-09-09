"use strict";

(() => {
	const model = window.QORPERA_MOTION_MODEL;
	const tau = Math.PI * 2;
	const neutral = [0, 0, 0, 1, 1];
	const palette = Object.freeze(model.effectColors.map(({ color }) => color));
	const geometry = {
		planet: [53, 18, -14], acorn: [44, 31, -24], flame: [38, 43, -24],
		rocket: [39, 42, -18], crown: [46, 29, -14],
		heart: [47, 31, -18], ghost: [43, 38, -18],
	};
	const durations = Object.freeze({ creation: 2800 / model.creation.playbackRate, "needs-attention": 1450 });
	// Each lane emits a left/right pair; varied planes keep the short trails distinct.
	const creationLanes = [
		[.92, .88, 8, .42], [1.04, 1.04, -12, .6], [.84, 1.12, 26, .34],
		[1.06, .9, -25, .52], [.96, 1.1, 18, .4], [1.06, .98, -6, .64],
	];
	const creationOrbitSlots = creationLanes.length * 2;
	// Read across two lines, look up to think, react, then settle before reading again.
	// Fixed holds separate the saccades so the eyes never drift continuously.
	const workingGaze = [
		[0, ...neutral], [240, ...neutral],
		[440, -5.9, -1.3, -.75, 1.06, .96], [700, -5.9, -1.3, -.75, 1.06, .96],
		[880, -3.6, 1.6, -.45, .78, 1.04], [1080, -3.6, 1.6, -.45, .78, 1.04],
		[1300, .6, 2, .12, .86, 1.03], [1480, .6, 2, .12, .86, 1.03],
		[1570, .6, 2, .12, .12, 1.08], [1660, .6, 2, .12, .86, 1.03],
		[1840, -5.7, 3.1, -.65, .8, 1.02], [2140, -1.6, 3.1, -.18, .8, 1.02], [2380, -1.6, 3.1, -.18, .8, 1.02],
		[2580, 1.6, -3.2, .4, 1.17, .94], [2850, 1.6, -3.2, .4, 1.17, .94],
		[3130, -1.2, -3.7, -.15, .67, 1.03], [3380, -1.2, -3.7, -.15, .67, 1.03],
		[3570, 1.9, -2.3, .46, 1.2, .96], [4020, 1.9, -2.3, .46, 1.2, .96],
		[4180, .4, -.8, .1, 1.1, 1], [4370, .4, -.8, .1, .12, 1.06], [4490, .4, -.8, .1, 1.05, 1],
		[4610, .4, -.8, .1, .16, 1.05], [4740, .4, -.8, .1, 1.05, 1],
		[5060, ...neutral], [5580, ...neutral],
		[5800, -4.4, .7, -.5, .84, 1.04], [6240, -.7, 1.5, -.08, .84, 1.04], [6640, -.7, 1.5, -.08, .84, 1.04],
		[6880, 1.6, -.7, .34, 1.13, .96], [7320, 1.6, -.7, .34, 1.13, .96],
		[7600, ...neutral], [8400, ...neutral],
	];
	// The large, left-facing crown reads the screen below it. Hold each target
	// before a 650 ms glance; blinking keeps its own natural tempo.
	const screenGaze = [
		[0, 1.8, 8.8, .1, .94, 1], [1700, 1.8, 8.8, .1, .94, 1],
		[2350, 5.4, 10.8, .18, .9, 1], [4700, 5.4, 10.8, .18, .9, 1],
		[5350, 1.6, 9.8, .05, .92, 1], [7300, 1.6, 9.8, .05, .92, 1],
		[7950, -.6, 5.8, -.08, 1, 1], [9300, -.6, 5.8, -.08, 1, 1],
		[9950, 3.4, 9.4, .12, .94, 1], [12200, 3.4, 9.4, .12, .94, 1],
		[12850, 1.8, 8.8, .1, .94, 1], [15000, 1.8, 8.8, .1, .94, 1],
	];
	const hoverPoses = {
		still: [-.2, -2.2, -2.6, 1.045, 1.045],
		idle: [.5, -1.5, 1.8, 1.026, 1.037],
		creation: [0, -1.4, -1, 1.05, 1.04],
		working: [1, -.9, 2.2, 1.03, 1.014],
		writing: [0, 0, 0, 1.01, 1.01],
		"needs-attention": [-.6, -1.3, -3.2, 1.028, 1.04],
		complete: [0, .6, 1.4, 1.045, .99],
	};
	const hoverNotes = Object.freeze({
		still: "A curious lift and lean; fully still again when you leave.",
		idle: "A soft greeting over the quiet idle rhythm.",
		creation: "A small lift without replaying the creation burst.",
		working: "A quick look up while the work continues.",
		writing: "The three dots spread out and their pulse becomes a little more expressive.",
		"needs-attention": "A closer, attentive lean; no repeated alert.",
		complete: "A small bow of acknowledgement, held until you leave.",
	});

	function sample(points, time) {
		if (time <= points[0][0]) return points[0].slice(1);
		for (let index = 1; index < points.length; index++) {
			const right = points[index];
			if (time > right[0]) continue;
			const left = points[index - 1];
			const progress = (time - left[0]) / (right[0] - left[0]);
			const eased = progress * progress * (3 - 2 * progress);
			return left.slice(1).map((value, axis) => value + (right[axis + 1] - value) * eased);
		}
		return points.at(-1).slice(1);
	}

	function face(state, elapsed, size = 144, { gaze } = {}) {
		if (!model.states.some(({ id }) => id === state) || !Number.isFinite(elapsed)) throw new RangeError("Invalid face state or time");
		const amount = .45 + .55 * model.amplitude(size);
		const time = Math.max(0, elapsed) * (state === "creation" ? model.creation.playbackRate : 1);
		let pose = neutral;
		if (gaze === "screen" && (state === "working" || state === "writing" || state === "idle")) {
			pose = sample(screenGaze, time % 15000);
			const [blink] = sample([[0, 1], [5800, 1], [5910, .1], [6060, 1], [8400, 1]], time % 8400);
			pose[3] *= blink;
		} else if (state === "creation") {
			pose = sample([[0, ...neutral], [150, 0, 1, -.2, .14, 1.08], [340, -2.8, -2.4, -.4, 1.18, 1.04], [720, -4.3, -1.1, -.6, 1.06, 1], [1180, -4.3, -1.1, -.6, 1.06, 1], [1660, ...neutral]], time);
		} else if (state === "needs-attention") {
			pose = sample([[0, ...neutral], [110, -.8, .4, -.1, .26, 1], [300, -4.6, -1.6, -.6, 1.13, 1.03], [650, -4.6, -1.6, -.6, 1.13, 1.03], [1120, -3.8, -.7, -.45, 1, 1]], time);
		} else if (state === "working") {
			if (time < 640) pose = sample([[0, ...neutral], [115, 0, .4, 0, .64, 1], [295, -.9, -.6, -.12, 1.06, 1], [640, ...neutral]], time);
			else pose = sample(workingGaze, (time - 640) % 8400);
		} else if (state === "idle") {
			pose = sample([[0, ...neutral], [5800, ...neutral], [5910, 0, 0, 0, .1, 1], [6060, ...neutral], [8400, ...neutral]], time % 8400);
		} else if (state === "complete") {
			pose = sample([[0, ...neutral], [160, 0, .5, 0, .45, 1.08], [380, -1.5, -1.6, -.2, 1.12, 1], [820, ...neutral]], time);
		}
		return { x: pose[0] * amount, y: pose[1] * amount, turn: pose[2] * amount, open: pose[3], width: pose[4] };
	}

	function eyePose(id, index, pose) {
		const eye = model.faces[id]?.[index];
		if (!eye) throw new RangeError("Invalid eye identity or index");
		const perspective = 1 + pose.turn * (index === 0 ? -.13 : .13);
		const width = eye.width * pose.width * perspective;
		const height = eye.height * pose.open * perspective;
		const x = eye.x + pose.x + (index === 0 ? -.4 : .4) * Math.abs(pose.turn);
		const y = eye.y + pose.y;
		return { x: x - width / 2, y: y - height / 2, width, height, rx: Math.min(width, height) / 2, transform: `rotate(${eye.rotation + pose.turn * 3} ${x} ${y})` };
	}

	function strokes(id, state, elapsed, size = 144) {
		if (!geometry[id] || !model.states.some((item) => item.id === state) || !Number.isFinite(elapsed)) throw new RangeError("Invalid stroke identity, state, or time");
		model.amplitude(size);
		const duration = durations[state];
		if (!duration || elapsed <= 0 || elapsed >= duration) return [];
		const attention = state === "needs-attention";
		const time = elapsed * (attention ? 1 : model.creation.playbackRate);
		const count = attention ? size < 32 ? 1 : 2 : size < 24 ? 4 : size < 40 ? 6 : size < 96 ? 8 : creationOrbitSlots;
		const [rx, ry, tilt] = geometry[id];
		const result = [];
		for (let index = 0; index < count; index++) {
			const lane = Math.floor(index / 2);
			const direction = attention || index % 2 === 0 ? 1 : -1;
			const delay = attention ? 150 + index * 150 : 240 + lane * 90;
			const span = attention ? 1100 - index * 90 : 2020 - lane * 4;
			const progress = (time - delay) / span;
			if (progress <= 0 || progress >= 1) continue;
			const envelope = Math.sin(Math.PI * progress);
			const origin = attention ? 4.8 : (index % 2 === 0 ? Math.PI - .18 : .18) + direction * lane * .16;
			const head = origin + direction * (attention ? .57 : 1.8 + lane * .13) * tau * (1 - (1 - progress) ** (attention ? 1.55 : 1.45));
			const length = (attention ? .74 : creationLanes[lane][3]) * envelope ** (attention ? .7 : .55);
			const angle = (tilt + (attention ? index * 8 : direction * creationLanes[lane][2])) * Math.PI / 180;
			const expansion = attention ? 1 : progress < .18 ? .78 + .25 * (1 - (1 - progress / .18) ** 3) : 1 + .03 * (1 - (progress - .18) / .82) ** 2;
			const radiusX = (attention ? rx + index * 2 - 2 : rx * creationLanes[lane][0]) * expansion;
			const radiusY = (attention ? ry + index * 2.8 : ry * creationLanes[lane][1]) * expansion;
			const points = [];
			for (let step = 0; step <= 40; step++) {
				const theta = head - direction * length * (1 - step / 40);
				const x = Math.cos(theta) * radiusX;
				const y = Math.sin(theta) * radiusY;
				points.push({ x: 50 + x * Math.cos(angle) - y * Math.sin(angle), y: 53 - (attention ? 0 : 4 * progress) + x * Math.sin(angle) + y * Math.cos(angle), z: Math.sin(theta) });
			}
			const paths = { front: "", back: "" };
			let previous = points[0];
			let side = previous.z >= 0 ? "front" : "back";
			paths[side] = `M${previous.x.toFixed(3)} ${previous.y.toFixed(3)}`;
			for (const point of points.slice(1)) {
				const nextSide = point.z >= 0 ? "front" : "back";
				if (nextSide !== side) {
					const fraction = previous.z / (previous.z - point.z);
					const crossing = `${(previous.x + (point.x - previous.x) * fraction).toFixed(3)} ${(previous.y + (point.y - previous.y) * fraction).toFixed(3)}`;
					paths[side] += `L${crossing}`;
					paths[nextSide] += `M${crossing}`;
					side = nextSide;
				}
				paths[side] += `L${point.x.toFixed(3)} ${point.y.toFixed(3)}`;
				previous = point;
			}
			const minimumWidth = attention && size < 32 ? .55 : .7;
			result.push({ index, ...paths, color: palette[attention ? index : (lane + index % 2) % palette.length], width: Math.max(minimumWidth, size / 100 * (attention ? 1.25 : 2.15 - lane % 3 * .18)) * 100 / size * Math.min(1, envelope * (attention ? 5 : 8)) });
		}
		// Strokes gather behind the figure, then release in front at the spring.
		// Both phases reuse the same slots and erase from the tail, without fading.
		if (!attention && size >= 32) {
			const directions = size < 96 ? [-2.45, -.69, 2.7, .44] : [-2.45, -.69, 2.7, .44, -3, -.14, 2.18, .96];
			for (const [index, angle] of directions.entries()) {
				const pair = Math.floor(index / 2);
				const gathered = (time - 30 - pair * 18) / 240;
				const gathering = gathered > 0 && gathered < 1;
				const progress = gathering ? gathered : (time - 320 - pair * 30) / 520;
				if (progress <= 0 || progress >= 1) continue;
				const head = 1 - (1 - progress) ** 2.8;
				const tail = progress ** 1.5;
				let path = "";
				for (let step = 0; step <= 12; step++) {
					const position = tail + (head - tail) * step / 12;
					const bend = Math.sin(Math.PI * position) * 4;
					const x = 50 + Math.cos(angle) * (gathering ? 61 - position * 18 : 43 + position * 19) - Math.sin(angle) * bend;
					const y = 50 + Math.sin(angle) * (gathering ? 59 - position * 16 : 43 + position * 17) + Math.cos(angle) * bend;
					path += `${step ? "L" : "M"}${x.toFixed(3)} ${y.toFixed(3)}`;
				}
				result.push({ index: index + creationOrbitSlots, front: gathering ? "" : path, back: gathering ? path : "", color: palette[index % palette.length], width: Math.max(.65, size / 100 * (gathering ? 1.4 : 1.8)) * 100 / size * Math.min(1, Math.sin(Math.PI * progress) * 5) });
			}
		}
		if (!attention) for (const stroke of result) stroke.width *= model.creation.strokeScale;
		return result;
	}

	function typing(id, progress, elapsed, size = 144, { reduced = false, hover = 0, surface = "light", color: selectedColor, transitionDuration = 620 } = {}) {
		if (!Number.isFinite(progress) || progress < 0 || progress > 1 || !Number.isFinite(elapsed) || !Number.isFinite(hover) || hover < 0 || hover > 1) throw new RangeError("Invalid typing progress, time, or hover");
		const color = model.avatarColor(id, surface, selectedColor);
		const channels = [1, 3, 5].map((start) => Number.parseInt(color.slice(start, start + 2), 16));
		const amount = model.amplitude(size);
		const [y, sx, sy] = sample([[0, 0, 1, 1], [.2, 2, 1.04, .84], [.48, 0, .135, .135], [.6, 0, 0, 0], [1, 0, 0, 0]], progress);
		const [radiusScale, spread, sideScale] = sample([[0, 0, 0, 0], [.32, 0, 0, 0], [.48, 1.24, 0, 0], [.6, 1.12, 0, 1], [.86, 1, 1.08, 1], [1, 1, 1, 1]], progress);
		const radius = size >= 96 ? 7.5 : size >= 40 ? 8.2 : 8.8;
		const pulseAmount = Math.max(0, Math.min(1, (progress - .65) / .35));
		const dots = [0, 1, 2].map((index) => {
			const time = Math.max(0, elapsed - transitionDuration);
			const phase = ((time - index * 180) % 1440 + 1440) % 1440;
			const wave = reduced ? index === 1 ? .8 : .1 : phase < 600 ? Math.sin(Math.PI * phase / 600) ** 2 : 0;
			const pulse = .78 + .36 * wave + hover * .06 * wave;
			const tint = .32 * (1 - wave) * pulseAmount;
			return {
				cx: 50 + (index - 1) * 24 * spread * (1 + hover * .12),
				cy: 50 - (reduced ? 0 : 3.2 * amount * wave * pulseAmount * (1 + hover * .5)),
				r: radius * radiusScale * (index === 1 ? 1 : sideScale) * (1 + (pulse - 1) * pulseAmount),
				fill: `#${channels.map((channel) => Math.round(channel + (255 - channel) * tint).toString(16).padStart(2, "0")).join("")}`,
			};
		});
		return { transform: `translate(0%, ${y.toFixed(4)}%) scale(${sx.toFixed(5)}, ${sy.toFixed(5)})`, dots };
	}

	function hover(state, progress, size = 144) {
		if (!hoverPoses[state] || !Number.isFinite(progress) || progress < 0 || progress > 1) throw new RangeError("Invalid hover state or progress");
		const amount = progress * model.amplitude(size);
		const [x, y, turn, sx, sy] = hoverPoses[state];
		return {
			transform: `translate(${(x * amount).toFixed(4)}%, ${(y * amount).toFixed(4)}%) rotate(${(turn * amount).toFixed(4)}deg) scale(${(1 + (sx - 1) * amount).toFixed(5)}, ${(1 + (sy - 1) * amount).toFixed(5)})`,
			look: { x: -1.8 * amount, y: -.5 * amount, turn: -.12 * amount },
		};
	}

	window.QORPERA_MOTION_VISUALS = Object.freeze({ durations, face, eyePose, strokes, palette, typing, hover, hoverNotes, typingDuration: 620, strokeSlots: creationOrbitSlots + 8 });
})();
