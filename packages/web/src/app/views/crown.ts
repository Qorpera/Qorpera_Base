/* The Co-Founder crown as a living vector character.
 *
 * Geometry and rhythm come from the approved motion model on qorpera.com
 * (Qorpera_Website landing/public/avatars/motion-model.js, motion-visuals.js):
 * the V24 crown contour, the eye placement measured from the 512px source in
 * the shared 100-unit frame, the "small, measured nod" loop, the entry spring
 * and the screen-gaze sequence with its blink tempo. On top of that the
 * character hops now and then, follows the pointer with its eyes, glances at
 * the form when a field takes focus, and lifts on hover. Eyes are holes: the
 * surface shows through them.
 *
 * Everything is drawn with DOM and SVG APIs and animated through the CSSOM and
 * SVG attributes, so the strict Content Security Policy (no inline style
 * attributes, no inline scripts) holds. */

const SVG = "http://www.w3.org/2000/svg";

// Approved V24 crown contour (512 viewBox), from crown-hero-contour.svg.
const CROWN_PATH =
	"M302.519 467.55 C261.078 468.461 218.971 467.781 177.468 466.93 C157.496 466.52 137.664 466.07 117.494 463.257 C108.934 462.063 100.313 460.443 93.361 455.884 C87.355 451.945 82.594 445.811 79.214 439.277 C70.749 422.914 70.938 404.037 69.877 385.503 C68.777 366.289 66.334 347.444 63.354 328.678 C57.853 294.037 50.522 259.666 41.606 225.492 C37.029 207.949 32.034 190.458 31.954 172.578 C31.914 163.646 33.101 154.616 37.22 146.48 C40.675 139.655 46.194 133.459 52.625 129.379 C67.062 120.221 86.096 121.731 100.397 130.596 C112.892 138.342 121.774 151.703 131.349 162.808 C136.225 168.463 141.281 173.534 146.525 179.407 C149.037 182.221 151.593 185.219 154.743 186.908 C158.397 188.868 162.851 189.065 166.424 187.691 C173.207 185.082 176.812 176.805 179.776 168.94 C182.739 161.081 185.062 153.634 187.707 146.267 C193.143 131.127 199.939 116.329 205.353 100.645 C210.516 85.689 214.423 69.927 225.007 58.536 C236.189 46.5 254.825 39.343 269.927 43.173 C284.231 46.8 295.366 60.281 302.505 74.623 C310.07 89.821 313.149 105.986 317.87 121.6 C322.581 137.179 328.926 152.209 334.433 168.69 C337.084 176.623 339.541 184.892 346.114 187.456 C349.644 188.833 354.36 188.565 358.217 186.596 C361.585 184.878 364.297 181.863 366.862 178.898 C376.956 167.227 384.774 156.308 395.129 145.589 C406.512 133.806 420.96 122.265 436.317 122.42 C451.346 122.571 467.246 133.923 474.361 147.721 C482.659 163.811 479.01 183.228 474.835 201.571 C470.928 218.737 466.559 234.961 462.47 251.491 C453.968 285.863 446.674 321.555 442.64 357.032 C440.472 376.095 439.246 395.096 437.049 414.494 C436.055 423.265 434.864 432.117 430.752 439.671 C427.203 446.19 421.481 451.743 415.144 455.691 C399.831 465.229 380.931 465.394 362.485 465.829 C342.181 466.308 322.427 467.113 302.519 467.55 Z";

// Eye placement in the shared 100-unit frame (x, y, width, height, rotation).
const EYES = [
	{ x: 56.74, y: 55.25, width: 5.96, height: 14.79, rotation: -10.81 },
	{ x: 69.44, y: 53.79, width: 5.92, height: 14.59, rotation: -10.85 },
] as const;

type Pose = [number, number, number, number, number]; // x%, y%, rotation, scaleX, scaleY
type Keyframe = [number, ...Pose]; // time (ms or 0..1 offset), pose
const NEUTRAL: Pose = [0, 0, 0, 1, 1];

// Approved crown loop: "A small, measured nod." (4400 ms, origin 50% 85%).
const NOD: Keyframe[] = [
	[0, 0, 0, 0, 1, 1],
	[0.2, 0.3, 0.6, 1.7, 1.012, 0.985],
	[0.4, 0, -0.8, -0.8, 0.995, 1.009],
	[0.6, 0, 0, 0.25, 1, 1],
	[1, 0, 0, 0, 1, 1],
];
const NOD_DURATION = 4400;

// Approved entry spring (640 ms).
const ENTRY: Keyframe[] = [
	[0, 0, 0, 0, 1, 1],
	[0.18, 0, 1.2, -0.7, 1.075, 0.9],
	[0.46, 0, -4.5, 1.4, 0.958, 1.065],
	[0.76, 0, 0.4, -0.4, 1.019, 0.985],
	[1, 0, 0, 0, 1, 1],
];
const ENTRY_DURATION = 640;

// A hop: anticipation, launch with stretch, hang, landing squash, settle.
const HOP: Keyframe[] = [
	[0, 0, 0, 0, 1, 1],
	[0.16, 0, 2.6, 0.6, 1.09, 0.88],
	[0.34, 0, -13, -1.6, 0.93, 1.1],
	[0.5, 0, -15.5, -0.4, 0.98, 1.03],
	[0.66, 0, -6, 1.2, 1.01, 0.99],
	[0.76, 0, 0.8, 0.4, 1.12, 0.86],
	[0.88, 0, -1.2, -0.2, 0.97, 1.03],
	[1, 0, 0, 0, 1, 1],
];
const HOP_DURATION = 900;

// Approved screen-gaze sequence (x, y, turn, open, width) for the large crown.
const SCREEN_GAZE: [number, number, number, number, number, number][] = [
	[0, 1.8, 8.8, 0.1, 0.94, 1],
	[1700, 1.8, 8.8, 0.1, 0.94, 1],
	[2350, 5.4, 10.8, 0.18, 0.9, 1],
	[4700, 5.4, 10.8, 0.18, 0.9, 1],
	[5350, 1.6, 9.8, 0.05, 0.92, 1],
	[7300, 1.6, 9.8, 0.05, 0.92, 1],
	[7950, -0.6, 5.8, -0.08, 1, 1],
	[9300, -0.6, 5.8, -0.08, 1, 1],
	[9950, 3.4, 9.4, 0.12, 0.94, 1],
	[12200, 3.4, 9.4, 0.12, 0.94, 1],
	[12850, 1.8, 8.8, 0.1, 0.94, 1],
	[15000, 1.8, 8.8, 0.1, 0.94, 1],
];
const GAZE_PERIOD = 15000;

function smooth(progress: number): number {
	const p = Math.min(1, Math.max(0, progress));
	return p * p * (3 - 2 * p);
}

function sample(points: readonly (readonly number[])[], time: number): number[] {
	const first = points[0];
	const last = points[points.length - 1];
	if (!first || !last) return [];
	if (time <= first[0]!) return first.slice(1);
	for (let index = 1; index < points.length; index++) {
		const right = points[index]!;
		if (time > right[0]!) continue;
		const left = points[index - 1]!;
		const eased = smooth((time - left[0]!) / (right[0]! - left[0]!));
		return left.slice(1).map((value, axis) => value + (right[axis + 1]! - value) * eased);
	}
	return last.slice(1);
}

function samplePose(frames: readonly Keyframe[], duration: number, elapsed: number): Pose {
	const [x = 0, y = 0, rotation = 0, sx = 1, sy = 1] = sample(frames, Math.min(1, Math.max(0, elapsed / duration)));
	return [x, y, rotation, sx, sy];
}

function combine(...poses: Pose[]): Pose {
	return poses.reduce<Pose>(
		(sum, [x, y, r, sx, sy]) => [sum[0] + x, sum[1] + y, sum[2] + r, sum[3] * sx, sum[4] * sy],
		[0, 0, 0, 1, 1],
	);
}

function transform([x, y, rotation, sx, sy]: Pose): string {
	return `translate(${x.toFixed(3)}%, ${y.toFixed(3)}%) rotate(${rotation.toFixed(3)}deg) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
}

function svg<K extends keyof SVGElementTagNameMap>(
	tag: K,
	attributes: Record<string, string | number>,
): SVGElementTagNameMap[K] {
	const node = document.createElementNS(SVG, tag);
	for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
	return node;
}

export interface CrownHandle {
	dispose(): void;
}

export interface CrownOptions {
	/** Elements whose focus makes the crown glance toward them. */
	watch?: () => Iterable<Element>;
}

export function mountCrown(host: HTMLElement, options: CrownOptions = {}): CrownHandle {
	const uid = `crown-${Math.random().toString(36).slice(2, 8)}`;
	const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

	// Layers: wrap (flip + hover lift) > body (pose) > svg.
	const wrap = document.createElement("div");
	wrap.className = "crown-wrap";
	const body = document.createElement("div");
	body.className = "crown-body";
	const shadow = document.createElement("div");
	shadow.className = "crown-shadow";
	const picture = svg("svg", { viewBox: "0 0 512 512", class: "crown-svg", "aria-hidden": "true" });

	const defs = svg("defs", {});
	const fill = svg("linearGradient", { id: `${uid}-fill`, x1: 0, y1: 0, x2: 0.3, y2: 1 });
	for (const [offset, color] of [
		[0, "#ffd75a"],
		[0.42, "#fcb51b"],
		[1, "#e8940a"],
	] as const) {
		fill.append(svg("stop", { offset, "stop-color": color }));
	}
	const rim = svg("radialGradient", { id: `${uid}-rim`, cx: 0.4, cy: 0.28, r: 0.78 });
	rim.append(svg("stop", { offset: 0.45, "stop-color": "#7a3d00", "stop-opacity": 0 }));
	rim.append(svg("stop", { offset: 1, "stop-color": "#7a3d00", "stop-opacity": 0.3 }));
	const clip = svg("clipPath", { id: `${uid}-clip` });
	clip.append(svg("path", { d: CROWN_PATH }));
	const blur = svg("filter", { id: `${uid}-blur`, x: "-40%", y: "-40%", width: "180%", height: "180%" });
	blur.append(svg("feGaussianBlur", { stdDeviation: 18 }));
	const mask = svg("mask", { id: `${uid}-eyes`, maskUnits: "userSpaceOnUse", x: 0, y: 0, width: 512, height: 512 });
	mask.setAttribute("mask-type", "luminance");
	mask.append(svg("path", { d: CROWN_PATH, fill: "#fff" }));
	const eyeRects = EYES.map(() => svg("rect", { fill: "#000" }));
	mask.append(...eyeRects);
	defs.append(fill, rim, clip, blur, mask);

	const figure = svg("g", { mask: `url(#${uid}-eyes)` });
	figure.append(svg("path", { d: CROWN_PATH, fill: `url(#${uid}-fill)` }));
	figure.append(svg("path", { d: CROWN_PATH, fill: `url(#${uid}-rim)` }));
	const highlight = svg("g", { "clip-path": `url(#${uid}-clip)`, filter: `url(#${uid}-blur)` });
	highlight.append(svg("ellipse", { cx: 190, cy: 150, rx: 92, ry: 46, fill: "#fff", opacity: 0.42 }));
	highlight.append(svg("ellipse", { cx: 330, cy: 420, rx: 150, ry: 34, fill: "#7a3d00", opacity: 0.16 }));
	figure.append(highlight);
	picture.append(defs, figure);
	body.append(picture);
	wrap.append(shadow, body);
	host.replaceChildren(wrap);

	// Animation state.
	const startedAt = performance.now();
	let hopAt = startedAt + 2600 + Math.random() * 3000;
	let nextBlinkAt = startedAt + 1800 + Math.random() * 2500;
	let blinkStartedAt = -1;
	let hover = 0;
	let hoverTarget = 0;
	let pointer: { x: number; y: number } | null = null;
	let focused: DOMRect | null = null;
	let frame = 0;
	let disposed = false;
	let lastFrameAt = startedAt;

	const setEyes = (pose: { x: number; y: number; turn: number; open: number; width: number }) => {
		for (const [index, eye] of EYES.entries()) {
			const rect = eyeRects[index];
			if (!rect) continue;
			const perspective = 1 + pose.turn * (index === 0 ? -0.13 : 0.13);
			const width = eye.width * pose.width * perspective * 5.12;
			const height = Math.max(0.6, eye.height * pose.open * perspective) * 5.12;
			const x = (eye.x + pose.x + (index === 0 ? -0.4 : 0.4) * Math.abs(pose.turn)) * 5.12;
			const y = (eye.y + pose.y) * 5.12;
			rect.setAttribute("x", (x - width / 2).toFixed(2));
			rect.setAttribute("y", (y - height / 2).toFixed(2));
			rect.setAttribute("width", width.toFixed(2));
			rect.setAttribute("height", height.toFixed(2));
			rect.setAttribute("rx", (Math.min(width, height) / 2).toFixed(2));
			rect.setAttribute(
				"transform",
				`rotate(${(eye.rotation + pose.turn * 3).toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)})`,
			);
		}
	};

	const gazeToward = (targetX: number, targetY: number): { x: number; y: number; turn: number } => {
		const box = wrap.getBoundingClientRect();
		if (!box.width) return { x: 0, y: 0, turn: 0 };
		// The wrap is mirrored, so screen-left is the character's right.
		const dx = -(targetX - (box.left + box.width / 2)) / box.width;
		const dy = (targetY - (box.top + box.height * 0.55)) / box.height;
		const reach = Math.min(1, Math.hypot(dx, dy));
		const angle = Math.atan2(dy, dx);
		return { x: Math.cos(angle) * reach * 7, y: Math.sin(angle) * reach * 6, turn: Math.cos(angle) * reach * 0.25 };
	};

	const still = () => {
		body.style.transform = transform(NEUTRAL);
		shadow.style.transform = "scale(1)";
		shadow.style.opacity = "0.5";
		setEyes({ x: 1.8, y: 8.8, turn: 0.1, open: 0.94, width: 1 });
	};

	const tick = (now: number) => {
		frame = 0;
		if (disposed) return;
		if (!host.isConnected) {
			dispose();
			return;
		}
		const elapsed = now - startedAt;
		const delta = Math.min(64, now - lastFrameAt);
		lastFrameAt = now;
		if (reduced.matches) {
			still();
			return;
		}
		// Body: entry spring, then the nod loop, plus an occasional hop.
		const entry = elapsed < ENTRY_DURATION ? samplePose(ENTRY, ENTRY_DURATION, elapsed) : NEUTRAL;
		const loopTime = Math.max(0, elapsed - ENTRY_DURATION) % NOD_DURATION;
		const nod = elapsed < ENTRY_DURATION ? NEUTRAL : samplePose(NOD, NOD_DURATION, loopTime);
		let hop: Pose = NEUTRAL;
		if (now >= hopAt) {
			const hopElapsed = now - hopAt;
			if (hopElapsed <= HOP_DURATION) hop = samplePose(HOP, HOP_DURATION, hopElapsed);
			else hopAt = now + 6000 + Math.random() * 6000;
		}
		hover += (hoverTarget - hover) * Math.min(1, delta / 160);
		const lift: Pose = [0, -2.2 * hover, -1.4 * hover, 1 + 0.04 * hover, 1 + 0.045 * hover];
		const pose = combine(entry, nod, hop, lift);
		body.style.transform = transform(pose);
		const height = Math.max(0, -pose[1]);
		shadow.style.transform = `scale(${(1 - height / 40).toFixed(3)})`;
		shadow.style.opacity = (0.5 - height / 60).toFixed(3);

		// Eyes: approved gaze sequence, blended toward the pointer or a focused
		// field, blinking on their own tempo; a hop closes them at the launch.
		const [gx = 0, gy = 0, gturn = 0, gopen = 1, gwidth = 1] = sample(SCREEN_GAZE, elapsed % GAZE_PERIOD);
		let look = { x: gx, y: gy, turn: gturn };
		if (focused) {
			const toward = gazeToward(focused.left + focused.width / 2, focused.top + focused.height / 2);
			look = { x: toward.x, y: toward.y, turn: toward.turn };
		} else if (pointer) {
			const toward = gazeToward(pointer.x, pointer.y);
			look = { x: gx * 0.3 + toward.x, y: gy * 0.3 + toward.y, turn: gturn * 0.3 + toward.turn };
		}
		let open = gopen;
		if (blinkStartedAt < 0 && now >= nextBlinkAt) blinkStartedAt = now;
		if (blinkStartedAt >= 0) {
			const blink = now - blinkStartedAt;
			const [factor = 1] = sample(
				[
					[0, 1],
					[110, 0.08],
					[260, 1],
				],
				blink,
			);
			open *= factor;
			if (blink > 260) {
				blinkStartedAt = -1;
				nextBlinkAt = now + 2600 + Math.random() * 3600;
			}
		}
		const hopPhase = now >= hopAt && now - hopAt <= HOP_DURATION ? (now - hopAt) / HOP_DURATION : -1;
		if (hopPhase >= 0.28 && hopPhase <= 0.42) open *= 0.35;
		setEyes({ x: look.x, y: look.y, turn: look.turn, open, width: gwidth + hover * 0.06 });
		if (!document.hidden) frame = requestAnimationFrame(tick);
	};

	const schedule = () => {
		if (!frame && !disposed) frame = requestAnimationFrame(tick);
	};
	const onPointerMove = (event: PointerEvent) => {
		pointer = { x: event.clientX, y: event.clientY };
	};
	const onPointerLeave = () => {
		pointer = null;
	};
	const onFocusIn = () => {
		const watched = options.watch ? [...options.watch()] : [];
		const active = document.activeElement;
		focused = active && watched.includes(active) ? active.getBoundingClientRect() : null;
	};
	const onEnter = () => {
		hoverTarget = 1;
	};
	const onLeave = () => {
		hoverTarget = 0;
	};
	const onVisibility = () => {
		if (!document.hidden) {
			lastFrameAt = performance.now();
			schedule();
		}
	};
	window.addEventListener("pointermove", onPointerMove, { passive: true });
	document.documentElement.addEventListener("pointerleave", onPointerLeave);
	document.addEventListener("focusin", onFocusIn);
	document.addEventListener("focusout", onFocusIn);
	host.addEventListener("pointerenter", onEnter);
	host.addEventListener("pointerleave", onLeave);
	document.addEventListener("visibilitychange", onVisibility);
	reduced.addEventListener("change", schedule);

	function dispose(): void {
		if (disposed) return;
		disposed = true;
		if (frame) cancelAnimationFrame(frame);
		window.removeEventListener("pointermove", onPointerMove);
		document.documentElement.removeEventListener("pointerleave", onPointerLeave);
		document.removeEventListener("focusin", onFocusIn);
		document.removeEventListener("focusout", onFocusIn);
		host.removeEventListener("pointerenter", onEnter);
		host.removeEventListener("pointerleave", onLeave);
		document.removeEventListener("visibilitychange", onVisibility);
		reduced.removeEventListener("change", schedule);
	}

	still();
	schedule();
	return { dispose };
}
