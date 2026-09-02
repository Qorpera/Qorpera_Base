"use strict";

/* Vector figures — the build recipe for one character, and its moving parts.
 *
 * A figure is its traced silhouette (from vector-trace.js), the approved
 * colour, and at most one or two structural details drawn as shapes: the
 * planet's ring, the acorn's cap. Everything else is light: a broad form
 * gradient from the upper left, a soft occlusion along the lower-right edge,
 * and one quiet highlight. Eyes are the product's own capsule eyes placed by
 * the motion model's measured geometry.
 *
 * Rendering avoids SVG masks and box-relative gradients on open paths: both
 * render differently across browsers. Rounded forms are built from stacked
 * strokes that follow their curve, which every engine draws the same way.
 *
 * Motion: each figure exposes either `deform(points, seconds, amount)` — a
 * per-frame displacement of the traced silhouette points (flame tongues,
 * ghost hem, crown points, heart lobes, rocket nose) — or `animate(refs,
 * seconds, amount)` for figures whose structure is a separate part (the
 * planet's ring, the acorn's cap). vector-rig.js drives both under the
 * product's body rhythm. */

(() => {
	const model = window.QORPERA_MOTION_MODEL;
	const visuals = window.QORPERA_MOTION_VISUALS;
	const NS = "http://www.w3.org/2000/svg";
	const NEUTRAL = Object.freeze({ x: 0, y: 0, turn: 0, open: 1, width: 1 });
	const TAU = Math.PI * 2;

	function channels(hex) { return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)); }
	function hex(values) { return `#${values.map((value) => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, "0")).join("")}`; }
	function mix(from, to, amount) {
		const a = channels(from), b = channels(to);
		return hex(a.map((value, index) => value + (b[index] - value) * amount));
	}
	function tones(id, color = model.avatarColor(id), { shade = 0.22, deep = 0.42, lightTone = "#ffffff" } = {}) {
		return {
			base: color,
			light: mix(color, lightTone, 0.26),
			glow: mix(color, lightTone, 0.5),
			shade: mix(color, "#000000", shade),
			deep: mix(color, "#000000", deep),
		};
	}
	const element = (name, attributes = {}, children = []) => {
		const node = document.createElementNS(NS, name);
		for (const [key, value] of Object.entries(attributes)) if (value !== undefined && value !== null) node.setAttribute(key, String(value));
		for (const child of children) node.append(child);
		return node;
	};
	const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

	/* Points (100-unit frame) to a smoothed path: Catmull-Rom handles, with
	 * genuinely sharp corners kept sharp. The same routine the tracer uses, so
	 * a baked figure deforms exactly like a live one. */
	function turn(a, b, c) {
		const ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - b[0], vy = c[1] - b[1];
		const cosine = (ux * vx + uy * vy) / ((Math.hypot(ux, uy) * Math.hypot(vx, vy)) || 1e-9);
		return (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI;
	}
	function pathFrom(loops, { tension = 0.5, corner = 72 } = {}) {
		const f = (value) => value.toFixed(2);
		return loops.map((points) => {
			const n = points.length;
			let d = `M${f(points[0][0])} ${f(points[0][1])}`;
			for (let i = 0; i < n; i++) {
				const p0 = points[(i - 1 + n) % n], p1 = points[i], p2 = points[(i + 1) % n], p3 = points[(i + 2) % n];
				const sharp1 = turn(p0, p1, p2) > corner;
				const sharp2 = turn(p1, p2, p3) > corner;
				const c1 = sharp1 ? p1 : [p1[0] + ((p2[0] - p0[0]) * tension) / 3, p1[1] + ((p2[1] - p0[1]) * tension) / 3];
				const c2 = sharp2 ? p2 : [p2[0] - ((p3[0] - p1[0]) * tension) / 3, p2[1] - ((p3[1] - p1[1]) * tension) / 3];
				d += ` C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
			}
			return `${d} Z`;
		}).join(" ");
	}
	/* Blur filters get an absolute region: the default one is relative to the
	 * element's own box, which for a thin arc is too small and cuts the
	 * blurred shadow off with a hard edge. */
	const blur = (id, stdDeviation) => element("filter", { id, filterUnits: "userSpaceOnUse", x: -40, y: -40, width: 180, height: 180 }, [element("feGaussianBlur", { stdDeviation })]);
	const smooth = (edge0, edge1, value) => { const t = clamp((value - edge0) / (edge1 - edge0), 0, 1); return t * t * (3 - 2 * t); };

	/* A rounded tube along a path: stacked strokes, each narrower and lifted a
	 * little, from the dark underside up to a lit crest. Round caps make the
	 * ends read as the ends of a tube. */
	function tubeStrokes(d, width, steps, { transform, lift = 1 } = {}) {
		return steps.map(([fraction, color, offset], index) => element("path", {
			d, fill: "none", stroke: color, "stroke-width": width * fraction, "stroke-linecap": "round", "stroke-linejoin": "round",
			transform: `translate(0 ${(-offset * lift).toFixed(2)}) ${transform ?? ""}`.trim(),
			"data-tube": index,
		}));
	}
	/* Gestures: short signature moves a figure makes now and then, and is
	 * otherwise still. Each returns, for a progress 0..1, a body transform
	 * (with its origin) and/or an eye override. No idle loops. */
	const figures = {
		planet: {
			light: [40, 30],
			shade: 0.18,
			occlusion: 0.45,
			highlight: 0.7,
			highlightSize: 1.5,
			/* Sphere and ring measured from the render (Measure in the room and
			 * brightness profiles down three columns): the band spans 57–70 units
			 * at the left and centre and 52–65 at the right, which a −4.8°
			 * ellipse centred at 52.3 with ry 11.5 and a 12.5-unit tube
			 * reproduces within a unit. The ring is a free part: its own
			 * shapes, unclipped, so it can move. */
			geometry: { sphere: [49.6, 50.2, 35.1], ring: { cx: 49.8, cy: 52.3, rx: 40.65, ry: 11.5, tube: 12.5, rotate: -4.8 } },
			clip(uid) {
				const [cx, cy, r] = this.geometry.sphere;
				return element("circle", { cx, cy, r });
			},
			/* Ring paths are written with the arc command's own rotation and
			 * absolute tip coordinates, so nothing here needs a transform, and
			 * the front half is its own open arc rather than a clipped ellipse.
			 * Clipping the whole ring to a half-plane is exactly what some
			 * browsers get wrong, painting the back half over the sphere. */
			ringPath() {
				const { ring } = this.geometry;
				const angle = (ring.rotate * Math.PI) / 180;
				const tips = (rx) => {
					const dx = rx * Math.cos(angle), dy = rx * Math.sin(angle);
					return { left: [ring.cx - dx, ring.cy - dy], right: [ring.cx + dx, ring.cy + dy] };
				};
				const f = (value) => value.toFixed(2);
				const ellipse = (rx, ry) => {
					const { left, right } = tips(rx);
					return `M${f(left[0])} ${f(left[1])} A${rx} ${ry} ${ring.rotate} 1 0 ${f(right[0])} ${f(right[1])} A${rx} ${ry} ${ring.rotate} 1 0 ${f(left[0])} ${f(left[1])} Z`;
				};
				const front = (rx, ry) => {
					const { left, right } = tips(rx);
					return `M${f(left[0])} ${f(left[1])} A${rx} ${ry} ${ring.rotate} 0 0 ${f(right[0])} ${f(right[1])}`;
				};
				return {
					centre: ellipse(ring.rx, ring.ry),
					front: front(ring.rx, ring.ry),
					outer: ellipse(ring.rx + ring.tube / 2, ring.ry + ring.tube / 2),
					inner: ellipse(ring.rx - ring.tube / 2, Math.max(1, ring.ry - ring.tube / 2)),
				};
			},
			guides() {
				const [cx, cy, r] = this.geometry.sphere;
				const { centre, outer, inner } = this.ringPath();
				return [element("circle", { cx, cy, r }), element("path", { d: centre }), element("path", { d: outer }), element("path", { d: inner })];
			},
			formGradient(t, uid) {
				return element("radialGradient", { id: `${uid}-form`, cx: 0.4, cy: 0.3, r: 0.88 }, [
					element("stop", { offset: 0, "stop-color": t.light }),
					element("stop", { offset: 0.55, "stop-color": t.base }),
					element("stop", { offset: 1, "stop-color": t.shade }),
				]);
			},
			layers(t, uid, refs) {
				const { sphere, ring } = this.geometry;
				const [cx, cy, r] = sphere;
				const { centre, front: frontArc } = this.ringPath();
				/* One gradient in page units lights the whole tube from above: the
				 * far ends mid-toned, the front band lit on top and dark beneath.
				 * A few faint narrow strokes lifted toward the crest soften the
				 * roll without visible steps. */
				const tubeGradient = element("linearGradient", { id: `${uid}-tube`, gradientUnits: "userSpaceOnUse", x1: 0, y1: ring.cy - ring.ry - ring.tube / 2, x2: 0, y2: ring.cy + ring.ry + ring.tube / 2 }, [
					element("stop", { offset: 0, "stop-color": mix(t.base, "#ffffff", 0.14) }),
					element("stop", { offset: 0.5, "stop-color": t.base }),
					element("stop", { offset: 0.78, "stop-color": mix(t.base, "#000000", 0.08) }),
					element("stop", { offset: 1, "stop-color": mix(t.base, "#000000", 0.26) }),
				]);
				const crest = mix(t.base, "#ffffff", 0.32);
				const steps = [
					[1, `url(#${uid}-tube)`, 0],
				];
				const crestStroke = (d) => element("path", {
					d, fill: "none", stroke: crest, "stroke-width": ring.tube * 0.4, "stroke-linecap": "round", opacity: 0.5, transform: "translate(0 -3.2)", filter: `url(#${uid}-crest)`,
				});
				const crestBlur = blur(`${uid}-crest`, 1.6);
				const shadowBlur = blur(`${uid}-shade`, 2.4);
				const sphereClip = element("clipPath", { id: `${uid}-sphere` }, [element("circle", { cx, cy, r })]);
				/* The whole ring goes behind the sphere; only the FRONT ARC is drawn
				 * over it, along with its shadow and crease, so the back of the
				 * ring can never mark the sphere. One plain circular clip, no
				 * transforms inside clip paths, no masks. */
				const back = element("g", { class: "vf-part", "data-part": "ring-back" }, [...tubeStrokes(centre, ring.tube, steps, {}), crestStroke(centre)]);
				const shadowGroup = element("g", { "clip-path": `url(#${uid}-sphere)` }, [
					element("path", { d: frontArc, fill: "none", stroke: t.deep, "stroke-width": ring.tube * 1.1, "stroke-linecap": "round", opacity: 0.5, transform: "translate(0 5.2)", filter: `url(#${uid}-shade)` }),
					element("path", { d: frontArc, fill: "none", stroke: t.deep, "stroke-width": ring.tube + 2.4, "stroke-linecap": "round", opacity: 0.3 }),
				]);
				const front = element("g", { class: "vf-part", "data-part": "ring-front" }, [
					shadowGroup,
					...tubeStrokes(frontArc, ring.tube, steps, {}),
					crestStroke(frontArc),
				]);
				refs.parts = { ringBack: back, ringFront: front };
				return { defs: [tubeGradient, crestBlur, shadowBlur, sphereClip], under: [back], over: [front] };
			},
			/* The ring is a separate body: a slow precession and a slight bob,
			 * nothing that could read as the ring flexing. */
			animate(refs, seconds, amount) {
				const { ring } = this.geometry;
				const turn = 2.4 * amount * Math.sin(seconds * 0.55);
				const lift = 0.8 * amount * Math.sin(seconds * 0.55 + 1.6);
				const transform = `translate(0 ${lift.toFixed(2)}) rotate(${turn.toFixed(2)} ${ring.cx} ${ring.cy})`;
				refs.parts.ringBack.setAttribute("transform", transform);
				refs.parts.ringFront.setAttribute("transform", transform);
			},
		},
		acorn: {
			light: [40, 58],
			shade: 0.12,
			occlusion: 0.26,
			formMid: 0.62,
			highlight: 0.55,
			highlightSize: 1.7,
			lightTone: "#ffefd8",
			/* The cap is a separate part: the silhouette above the rim. Measured
			 * from brightness profiles down the render, the rim crease is an
			 * ARCH — 37 units high in the middle, 47 at the sides — and it is
			 * subtle: cap and nut share one brown, a slight darkening as the
			 * cap turns under, a narrow deep crease, and a short shadow on the
			 * nut. The cap can tip as one piece. */
			geometry: { rim: "M-10 67.7 Q50 6.5 110 67.7", pivot: [50, 30] },
			guides() { return [element("path", { d: this.geometry.rim })]; },
			layers(t, uid, refs, silhouette) {
				const { rim } = this.geometry;
				const above = `${rim} L110 -20 L-10 -20 Z`;
				const capGradient = element("linearGradient", { id: `${uid}-cap`, gradientUnits: "userSpaceOnUse", x1: 30, y1: 4, x2: 60, y2: 48 }, [
					element("stop", { offset: 0, "stop-color": mix(t.base, "#ffefd8", 0.2) }),
					element("stop", { offset: 0.7, "stop-color": t.base }),
					element("stop", { offset: 1, "stop-color": mix(t.base, "#000000", 0.04) }),
				]);
				const turnBlur = blur(`${uid}-turn`, 0.9);
				const shadeBlur = blur(`${uid}-rimshade`, 1.1);
				/* One silhouette clip, nothing nested. */
				const cap = element("g", { class: "vf-part", "data-part": "cap" }, [
					element("g", { "clip-path": `url(#${uid}-clip)` }, [
						element("path", { d: above, fill: `url(#${uid}-cap)` }),
						/* The cap turning under, just above the crease. */
						element("path", { d: rim, fill: "none", stroke: mix(t.base, "#000000", 0.2), "stroke-width": 3, opacity: 0.55, transform: "translate(0 -1.4)", filter: `url(#${uid}-turn)` }),
						/* The crease. */
						element("path", { d: rim, fill: "none", stroke: mix(t.base, "#000000", 0.5), "stroke-width": 1.3, opacity: 0.85 }),
					]),
				]);
				/* The short shadow on the nut, staying with the nut. */
				const nutShadow = element("path", { d: rim, fill: "none", stroke: t.deep, "stroke-width": 3.4, opacity: 0.45, transform: "translate(0 1.8)", filter: `url(#${uid}-rimshade)` });
				refs.parts = { cap };
				return { defs: [capGradient, turnBlur, shadeBlur], inside: [nutShadow], over: [cap] };
			},
			/* An acorn is a rigid object: the cap is a part for shading only and
			 * never moves on its own. The body rhythm (a grounded rock) is all
			 * the motion it gets. */
		},
		flame: {
			light: [46, 52],
			/* A candle flame: the whole shape bends from its base — a smooth
			 * lean that grows with height, no shearing inside the shape — and
			 * the tip breathes taller and shorter. The small side tongue leans
			 * on its own slower beat. The silhouette stays a flame throughout. */
			deform(points, s, a) {
				const baseY = 94;
				const lean = a * (2.2 * Math.sin(s * 1.7) + 0.9 * Math.sin(s * 3.1 + 1.2));
				const breathe = 1 + a * 0.022 * Math.sin(s * 3.9 + 0.4);
				return points.map(([x, y]) => {
					const h = clamp((baseY - y) / 88, 0, 1);
					const side = x < 44 && y < 48 ? clamp((48 - y) / 30, 0, 1) : 0;
					const dx = lean * h * h + side * a * 1.2 * Math.sin(s * 2.3 + 1.9);
					const ny = baseY - (baseY - y) * (1 + (breathe - 1) * h);
					return [x + dx, ny];
				});
			},
		},
		rocket: {
			light: [42, 30],
			/* A rigid object: no part motion, only the body rhythm (lift and hover). */
		},
		crown: {
			light: [40, 52],
			/* A rigid object: no part motion, only the body rhythm (a measured nod). */
		},
		heart: {
			light: [40, 36],
			/* Still between beats; the beat is a gesture. */
		},
		ghost: {
			light: [44, 30],
			/* Cloth: one slow ripple travels along the hem, and the body leans
			 * a little from its base as it drifts. The side bump is part of the
			 * body and moves with it, not on its own. */
			deform(points, s, a) {
				return points.map(([x, y]) => {
					const hem = smooth(70, 92, y);
					const lean = clamp((94 - y) / 84, 0, 1);
					const phase = s * 2.2 - x * 0.055;
					const dx = a * (0.5 * hem * Math.sin(phase + 1.5) + 0.7 * lean * lean * Math.sin(s * 1.1));
					const dy = a * 1.2 * hem * Math.sin(phase);
					return [x + dx, y + dy];
				});
			},
		},
	};

	/* Each figure's own moves. Rigid objects turn; soft ones flare or thump;
	 * the planet turns under its eyes. */
	/* Rigid figures turn in real 3D; the planet turns as a globe with its
	 * ring; soft figures flare, thump or boo. */

	/* Build one figure. Returns the host span with the layered rig inside:
	 *   .vf > .vf-presence > .vf-form > .vf-body > svg, plus .vf-typing
	 * host.vf carries the handles the rig needs. */
	function build(id, trace, { uid = `vf-${id}-${Math.random().toString(36).slice(2, 8)}`, color } = {}) {
		const spec = figures[id];
		const t = tones(id, color, { shade: spec.shade, deep: spec.deep, lightTone: spec.lightTone });
		const silhouette = typeof trace === "string" ? trace : trace.d;
		const refs = { silhouettePaths: [], parts: null };

		const svg = element("svg", { viewBox: "0 0 100 100", xmlns: NS, focusable: "false", "aria-hidden": "true" });
		const defs = element("defs");
		const clipShape = spec.clip ? spec.clip(uid) : element("path", { d: silhouette, "fill-rule": "evenodd" });
		if (!spec.clip) refs.silhouettePaths.push(clipShape);
		defs.append(
			element("clipPath", { id: `${uid}-clip` }, [clipShape]),
			spec.formGradient ? spec.formGradient(t, uid) : element("radialGradient", { id: `${uid}-form`, cx: 0.34, cy: 0.26, r: 0.98 }, [
				element("stop", { offset: 0, "stop-color": t.light }),
				element("stop", { offset: spec.formMid ?? 0.42, "stop-color": t.base }),
				element("stop", { offset: 1, "stop-color": t.shade }),
			]),
			element("radialGradient", { id: `${uid}-hi`, cx: 0.5, cy: 0.5, r: 0.5 }, [
				element("stop", { offset: 0, "stop-color": "#fff", "stop-opacity": Math.min(0.6, 0.34 * (spec.highlight ?? 1)) }),
				element("stop", { offset: 0.5, "stop-color": "#fff", "stop-opacity": Math.min(0.3, 0.12 * (spec.highlight ?? 1)) }),
				element("stop", { offset: 1, "stop-color": "#fff", "stop-opacity": 0 }),
			]),
			/* Occlusion: the part of the shape not covered by its own blurred copy
			 * shifted up-left — a soft band along the lower-right edge. */
			element("filter", { id: `${uid}-occlude`, filterUnits: "userSpaceOnUse", x: -40, y: -40, width: 180, height: 180 }, [
				element("feGaussianBlur", { in: "SourceAlpha", stdDeviation: 3.6, result: "blur" }),
				element("feOffset", { in: "blur", dx: -2.6, dy: -2.8, result: "shifted" }),
				element("feComposite", { in: "SourceAlpha", in2: "shifted", operator: "out", result: "edge" }),
				element("feFlood", { "flood-color": t.deep, "flood-opacity": spec.occlusion ?? 0.55 }),
				element("feComposite", { in2: "edge", operator: "in" }),
			]),
			blur(`${uid}-hiblur`, 1.6),
		);
		const layers = spec.layers ? spec.layers(t, uid, refs, silhouette) : {};
		for (const node of layers.defs ?? []) defs.append(node);
		svg.append(defs);

		for (const node of layers.under ?? []) svg.append(node);

		const inside = element("g", { "clip-path": `url(#${uid}-clip)` });
		inside.append(element("rect", { x: -10, y: -10, width: 120, height: 120, fill: `url(#${uid}-form)` }));
		for (const node of layers.inside ?? []) inside.append(node);
		const occlusionShape = spec.clip ? spec.clip(uid) : element("path", { d: silhouette, "fill-rule": "evenodd" });
		occlusionShape.setAttribute("fill", t.deep);
		occlusionShape.setAttribute("filter", `url(#${uid}-occlude)`);
		if (!spec.clip) refs.silhouettePaths.push(occlusionShape);
		inside.append(occlusionShape);
		const [hx, hy] = spec.light;
		const hs = spec.highlightSize ?? 1;
		inside.append(element("ellipse", { cx: hx, cy: hy, rx: 21 * hs, ry: 14 * hs, fill: `url(#${uid}-hi)`, transform: `rotate(-28 ${hx} ${hy})`, filter: `url(#${uid}-hiblur)` }));
		svg.append(inside);

		for (const node of layers.over ?? []) svg.append(node);

		const face = element("g", { class: "vf-face" });
		const eyes = [0, 1].map((index) => {
			const pose = visuals.eyePose(id, index, NEUTRAL);
			return element("rect", { x: pose.x.toFixed(2), y: pose.y.toFixed(2), width: pose.width.toFixed(2), height: pose.height.toFixed(2), rx: pose.rx.toFixed(2), transform: pose.transform, fill: "#fff" });
		});
		face.append(...eyes);
		svg.append(face);

		const host = document.createElement("span");
		host.className = "vf";
		host.dataset.figure = id;
		const presence = document.createElement("span");
		presence.className = "vf-presence";
		const form = document.createElement("span");
		form.className = "vf-form";
		const body = document.createElement("span");
		body.className = "vf-body";
		body.append(svg);
		form.append(body);
		presence.append(form);
		const typing = element("svg", { class: "vf-typing", viewBox: "0 0 100 100", "aria-hidden": "true" }, [element("circle"), element("circle"), element("circle")]);
		host.append(presence, typing);
		/* A baked trace (path + points + smoothing) works like a live one. */
		const figureTrace = typeof trace === "string" ? null
			: trace.pathFrom ? trace
			: { ...trace, pathFrom: (points) => pathFrom(points, trace.smoothing) };
		host.vf = {
			id, eyes, body, presence, form, typing, dots: [...typing.children],
			spec, refs, svg,
			trace: figureTrace,
			color: t.base,
			/* Real geometry for the turn, built lazily by the rig. */
			solid: undefined,
		};
		return host;
	}

	/* Per-frame motion for a built figure: deform the silhouette or move the
	 * part. `amount` is 0 for a still figure, scaled by the model's amplitude
	 * for small sizes. */
	function motion(host, seconds, amount) {
		const { spec, refs, trace } = host.vf;
		if (spec.deform && trace?.loops && refs.silhouettePaths.length) {
			const d = amount > 0 ? trace.pathFrom(trace.loops.map((loop) => spec.deform(loop, seconds, amount))) : trace.d;
			for (const path of refs.silhouettePaths) path.setAttribute("d", d);
		}
		if (spec.animate && refs.parts) spec.animate(refs, seconds, amount);
	}

	window.QORPERA_VECTOR_FIGURES = Object.freeze({ figures, tones, build, motion, mix, pathFrom });
})();
