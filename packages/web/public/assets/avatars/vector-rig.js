"use strict";

/* Vector rig — drives a built vector figure.
 *
 * The body is still. There are no idle loops, nods, hovers, rocking or
 * turns: a figure stands, and the life is in its eyes. Where it looks is
 * drawn fresh every time — a target, a flick to reach it, a hold of its own
 * length, now and then a wider look or a long stare, with a slow drift
 * underneath and blinks on their own irregular clock. Nothing follows the
 * pointer. Soft figures keep their shape-preserving part motion (the flame's
 * lean, the ghost's ripple, the planet's ring). The writing form (the figure
 * gathers into three dots) comes from the product's motion visuals.
 * Everything pauses offscreen, in hidden tabs, and under reduced motion. */

(() => {
	const model = window.QORPERA_MOTION_MODEL;
	const visuals = window.QORPERA_MOTION_VISUALS;
	const figures = window.QORPERA_VECTOR_FIGURES;
	const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
	const media = window.matchMedia("(prefers-reduced-motion: reduce)");
	const rand = (low, high) => low + Math.random() * (high - low);
	const TAU = Math.PI * 2;
	const BLINK = 118;

	function mount(host, { state = "working", size = 144, interactive = false, motion = 1, gaze: gazeMode = undefined, reduced = () => media.matches } = {}) {
		const parts = host.vf;
		if (!parts) throw new Error("mount needs a host built by QORPERA_VECTOR_FIGURES.build");
		const { id, eyes, body, presence, form, typing, dots } = parts;
		let current = { state, size, interactive, motion, gaze: gazeMode };

		let frame = 0;
		let running = false;
		let visible = true;
		let started = performance.now();
		const formState = { value: 0, from: 0, target: 0, startedAt: performance.now() };

		const still = () => reduced();
		const alive = () => !still() && current.state !== "still";

		/* Where the eyes are, where they are going, and when they will move
		 * again. Every number here is drawn when it is needed, so the figure
		 * never plays the same short look twice. */
		const look = {
			at: { x: 0, y: 0 },
			from: { x: 0, y: 0 },
			to: { x: 0, y: 0 },
			movedAt: 0,
			arriveAt: 0,
			holdUntil: 0,
			phase: [Math.random() * TAU, Math.random() * TAU],
			rate: [rand(0.11, 0.19), rand(0.08, 0.15)],
			blinkAt: performance.now() + rand(900, 3400),
			blinkFrom: 0,
			again: false,
		};

		/* A resting bias, not a target that is tracked: the hero's crown keeps
		 * its eyes down on the workspace below it. */
		const biasOf = () => (current.gaze === "screen" ? { x: -1.1, y: 2.3 } : { x: 0, y: 0 });

		function chooseLook(now) {
			const writing = current.state === "writing";
			const bias = biasOf();
			const reach = writing ? 2.6 : 6.3;
			const roll = Math.random();
			let x, y;
			if (roll < 0.14) { x = 0; y = 0; }
			else if (roll < 0.74) { x = rand(-reach * 0.5, reach * 0.5); y = rand(-reach * 0.34, reach * 0.44); }
			else { x = rand(-reach, reach); y = rand(-reach * 0.6, reach * 0.72); }
			x += bias.x;
			y += bias.y;
			/* Keep the look inside the eye's range rather than clipping it flat. */
			const far = Math.hypot(x / 7.2, y / 5);
			if (far > 1) { x /= far; y /= far; }
			const distance = Math.hypot(x - look.at.x, y - look.at.y);
			look.from = { ...look.at };
			look.to = { x, y };
			look.movedAt = now;
			look.arriveAt = now + 50 + distance * 7.5;
			const hold = writing ? rand(950, 2700) : current.state === "working" ? rand(340, 1650) : rand(700, 2900);
			/* Now and then the figure settles on something and stays with it. */
			look.holdUntil = look.arriveAt + hold + (Math.random() < 0.12 ? rand(900, 2300) : 0);
		}

		function eyePose(now) {
			if (!alive()) return { x: 0, y: 0, turn: 0, open: 1, width: 1 };
			if (now >= look.holdUntil) chooseLook(now);
			const span = Math.max(1, look.arriveAt - look.movedAt);
			const t = clamp((now - look.movedAt) / span, 0, 1);
			const eased = 1 - (1 - t) ** 3;
			look.at.x = look.from.x + (look.to.x - look.from.x) * eased;
			look.at.y = look.from.y + (look.to.y - look.from.y) * eased;

			/* Blinks: their own clock, and sometimes two in quick succession. */
			let open = 1;
			if (look.blinkFrom) {
				const p = (now - look.blinkFrom) / BLINK;
				if (p >= 1) {
					look.blinkFrom = 0;
					if (look.again) { look.again = false; look.blinkAt = now + rand(130, 210); }
					else { look.blinkAt = now + rand(1900, 6400); look.again = Math.random() < 0.16; }
				} else open = 1 - Math.sin(Math.PI * p) * 0.94;
			} else if (now >= look.blinkAt) look.blinkFrom = now;

			/* A slow drift under the look, so a held gaze is never frozen. */
			const seconds = now / 1000;
			const driftX = Math.sin(seconds * look.rate[0] * TAU + look.phase[0]) * 0.4;
			const driftY = Math.sin(seconds * look.rate[1] * TAU + look.phase[1]) * 0.28;
			const amount = model.amplitude(current.size);
			return {
				x: clamp((look.at.x + driftX) * amount, -7.5, 7.5),
				y: clamp((look.at.y + driftY) * amount, -5.5, 5.5),
				turn: clamp(look.at.x * 0.05, -0.55, 0.55),
				open,
				width: 1,
			};
		}

		function paint(now) {
			/* Continuous part motion for soft figures. */
			const amount = !alive() ? 0 : model.amplitude(current.size) * current.motion;
			figures.motion(host, now / 1000, amount);

			presence.style.transform = "none";
			const pose = eyePose(now);
			eyes.forEach((eye, index) => {
				const e = visuals.eyePose(id, index, pose);
				eye.setAttribute("x", e.x.toFixed(2));
				eye.setAttribute("y", e.y.toFixed(2));
				eye.setAttribute("width", Math.max(0.1, e.width).toFixed(2));
				eye.setAttribute("height", Math.max(0.1, e.height).toFixed(2));
				eye.setAttribute("rx", Math.max(0.05, e.rx).toFixed(2));
				eye.setAttribute("transform", e.transform);
			});

			/* Writing: the figure gathers into one dot and splits into three. */
			const t = still() ? 1 : clamp((now - formState.startedAt) / visuals.typingDuration, 0, 1);
			const eased = t * t * (3 - 2 * t);
			formState.value = formState.from + (formState.target - formState.from) * eased;
			if (formState.value > 0 || formState.from > 0) {
				const typingPose = visuals.typing(id, clamp(formState.value, 0, 1), now - formState.startedAt + (formState.from > 0 && formState.target === 1 ? visuals.typingDuration : 0), current.size, { reduced: still(), hover: 0, surface: document.documentElement.dataset.surface === "dark" ? "dark" : "light" });
				form.style.transform = typingPose.transform;
				typing.style.visibility = formState.value > 0.02 ? "visible" : "hidden";
				typingPose.dots.forEach((dot, index) => {
					const el = dots[index];
					el.setAttribute("cx", dot.cx.toFixed(2));
					el.setAttribute("cy", dot.cy.toFixed(2));
					el.setAttribute("r", Math.max(0, dot.r).toFixed(2));
					el.setAttribute("fill", dot.fill);
				});
			} else {
				form.style.transform = "none";
				typing.style.visibility = "hidden";
			}
		}

		/* Hidden, disposed or reduced motion: the silhouette goes back to rest. */
		const rest = () => { figures.motion(host, 0, 0); body.style.transform = "none"; };
		/* A still figure, or one at rest, needs one frame and no loop. */
		const loops = () => alive();
		function tick(now) {
			paint(now);
			if (running && loops()) frame = window.requestAnimationFrame(tick);
		}
		function start() {
			if (running) return;
			running = true;
			host.removeAttribute("data-paused");
			frame = window.requestAnimationFrame(tick);
		}
		function stop() {
			running = false;
			window.cancelAnimationFrame(frame);
			host.setAttribute("data-paused", "");
		}
		function sync() { if (visible && !document.hidden) start(); else stop(); }

		const seen = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); }, { rootMargin: "12% 0px" });
		seen.observe(host);
		document.addEventListener("visibilitychange", sync);

		body.style.transform = "none";
		chooseLook(performance.now());
		paint(performance.now());
		sync();

		/* Reachable from the element, for review tools and tests. */
		host.vfRig = {
			update(next) {
				current = { ...current, ...next };
				if (next.state !== undefined) {
					started = performance.now();
					formState.from = formState.value;
					formState.target = current.state === "writing" ? 1 : 0;
					formState.startedAt = performance.now();
					chooseLook(performance.now());
				}
				if (running) { window.cancelAnimationFrame(frame); frame = window.requestAnimationFrame(tick); }
				else paint(performance.now());
			},
			replay() { started = performance.now(); chooseLook(performance.now()); },
			dispose() {
				stop();
				rest();
				seen.disconnect();
				document.removeEventListener("visibilitychange", sync);
				presence.style.transform = "";
				form.style.transform = "";
				typing.style.visibility = "hidden";
				host.removeAttribute("data-paused");
				delete host.vfRig;
			},
		};
		return host.vfRig;
	}

	window.QORPERA_VECTOR_RIG = Object.freeze({ mount });
})();
