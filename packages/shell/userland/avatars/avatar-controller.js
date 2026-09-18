"use strict";

(() => {
	const model = window.QORPERA_MOTION_MODEL;
	const appearance = window.QORPERA_AVATAR_APPEARANCE;
	const visuals = window.QORPERA_MOTION_VISUALS;
	const motionState = window.QORPERA_AVATAR_STATE;
	const clock = model.createClock(() => performance.now());
	const store = motionState.createActors(clock, visuals.typingDuration);
	const media = window.matchMedia("(prefers-reduced-motion: reduce)");
	const rigs = new Map();
	const groups = new Map();
	const loading = new Map();
	const ready = new Set();
	const masks = new Map();
	const hovered = new Set();
	let frame = null;
	let sequence = 0;
	let paused = document.hidden;
	let cleanupQueued = false;
	if (paused) clock.pause();

	function artwork(figure) { return `./avatars/${figure}.png`; }
	function ensureArtwork(figure) {
		if (!loading.has(figure)) {
			loading.set(figure, (async () => {
				const body = new Image();
				body.src = artwork(figure);
				await body.decode();
				appearance.prepare(figure, body);
				const face = new Image();
				face.src = `./avatars/${figure}-face-plate.png`;
				await face.decode();
				appearance.prepare(`${figure}-face`, face);
				ready.add(figure);
			})().catch((error) => {
				// Leave the original silhouette visible if optional motion layers fail.
				console.warn(`Avatar layers unavailable for ${figure}`, error);
			}));
		}
		return loading.get(figure);
	}

	function image(figure, color) {
		const node = document.createElement("img");
		node.className = "avatar-artwork";
		node.alt = "";
		node.draggable = false;
		node.src = ready.has(figure) ? appearance.source(figure, color) : artwork(figure);
		void ensureArtwork(figure).then(() => {
			if (ready.has(figure)) node.src = appearance.source(figure, color);
		});
		return node;
	}

	function svg(tag, attributes = {}) {
		const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
		for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
		return node;
	}

	function cancelRig(rig) {
		for (const animation of rig.animations) animation.cancel();
		rig.animations.clear();
	}

	function startRig(rig, preserve = false) {
		const actor = store.ensure(rig.key);
		const spec = model.motion(rig.figure, actor.state, rig.size);
		const current = preserve ? getComputedStyle(rig.body).transform : spec.entry.frames[0].transform;
		rig.faceFrom = preserve && actor.state !== "still" ? rig.facePose : null;
		rig.visualDuration = spec.loop || actor.state === "writing" ? Infinity : Math.max(spec.entry.duration, visuals.durations[actor.state] ?? 0);
		rig.rest = spec.rest;
		rig.revision = actor.revision;
		cancelRig(rig);
		rig.frame.dataset.state = actor.state;
		rig.body.style.transformOrigin = spec.origin;
		rig.body.style.transform = actor.state === "writing" && preserve ? current : spec.rest;
		if (media.matches || !rig.visible) return;
		const elapsed = clock.now() - actor.startedAt;
		const timelineStart = (document.timeline.currentTime ?? performance.now()) - elapsed;
		if (spec.entry.duration > 0 && elapsed < spec.entry.duration) {
			const frames = spec.entry.frames.map((entry, index) => index === 0 ? { ...entry, transform: current } : entry);
			const animation = rig.body.animate(frames, { duration: spec.entry.duration, fill: "both" });
			rig.animations.add(animation);
			animation.onfinish = () => { animation.cancel(); rig.animations.delete(animation); };
			animation.currentTime = elapsed;
			if (paused) animation.pause(); else animation.startTime = timelineStart;
		}
		if (spec.loop) {
			const animation = rig.body.animate(spec.loop.frames, { duration: spec.loop.duration, delay: spec.entry.duration, iterations: Infinity, fill: "none" });
			rig.animations.add(animation);
			animation.currentTime = elapsed;
			if (paused) animation.pause(); else animation.startTime = timelineStart;
		}
	}

	function syncImages(rig) {
		const actor = store.ensure(rig.key);
		if (!ready.has(rig.figure)) return;
		if (rig.color !== actor.color || !rig.prepared) {
			rig.color = actor.color;
			rig.image.src = appearance.source(rig.figure, rig.color);
			rig.facePlate.setAttribute("href", appearance.source(`${rig.figure}-face`, rig.color));
			rig.prepared = true;
		}
	}

	function draw() {
		const now = clock.now();
		let moving = false;
		for (const rig of rigs.values()) {
			if (!rig.host.isConnected || !rig.visible) continue;
			const actor = store.update(rig.key, {}, media.matches);
			if (rig.revision !== actor.revision) startRig(rig, true);
			syncImages(rig);
			const elapsed = Math.max(0, now - actor.startedAt);
			moving ||= elapsed < rig.visualDuration || now < actor.createdUntil;
			moving ||= now < actor.form.startedAt + actor.form.frames.at(-1)[0] || now < actor.hover.startedAt + actor.hover.frames.at(-1)[0];
			const form = media.matches ? (actor.state === "writing" ? 1 : 0) : motionState.transitionValue(actor.form, now);
			const hover = media.matches || !rig.hoverMotion ? 0 : motionState.transitionValue(actor.hover, now);
			const reaction = visuals.hover(actor.state, hover, rig.size);
			const dark = document.documentElement.dataset.theme === "dark";
			const typing = visuals.typing(rig.figure, form, now - actor.typingStartedAt, rig.size, { reduced: media.matches, hover, surface: dark ? "dark" : "light", color: actor.color });
			rig.presence.style.transform = reaction.transform;
			rig.form.style.transform = typing.transform;
			rig.frame.dataset.form = form === 1 ? "typing" : form === 0 ? "avatar" : "gathering";
			if (actor.state === "writing" && form >= .6) rig.body.style.transform = rig.rest;
			for (const [index, dot] of rig.dots.entries()) {
				for (const [key, value] of Object.entries(typing.dots[index])) dot.setAttribute(key, String(value));
			}
			rig.overlay.style.visibility = rig.prepared && (actor.state !== "still" || hover > 0) ? "visible" : "hidden";
			const pose = media.matches ? visuals.face("idle", 0, rig.size) : visuals.face(actor.state, elapsed, rig.size);
			if (!media.matches && rig.faceFrom && elapsed < 180) {
				const progress = elapsed / 180;
				const eased = progress * progress * (3 - 2 * progress);
				for (const key of Object.keys(pose)) pose[key] = rig.faceFrom[key] + (pose[key] - rig.faceFrom[key]) * eased;
			}
			rig.facePose = pose;
			const looking = { ...pose, x: pose.x + reaction.look.x, y: pose.y + reaction.look.y, turn: pose.turn + reaction.look.turn };
			for (const [index, eye] of rig.eyes.entries()) {
				for (const [key, value] of Object.entries(visuals.eyePose(rig.figure, index, looking))) eye.setAttribute(key, String(value));
			}
			const strokes = media.matches ? [] : visuals.strokes(rig.figure, actor.state, elapsed, rig.size);
			for (const [index, pair] of rig.strokes.entries()) {
				const stroke = strokes.find((item) => item.index === index);
				for (const side of ["front", "back"]) {
					pair[side].setAttribute("d", stroke?.[side] ?? "");
					if (stroke) {
						pair[side].setAttribute("stroke", stroke.color);
						pair[side].setAttribute("stroke-width", String(stroke.width));
					}
				}
			}
		}
		return moving;
	}

	function schedule() {
		if (frame !== null) return;
		frame = requestAnimationFrame(function tick() {
			frame = null;
			if (draw() && !paused && !media.matches) frame = requestAnimationFrame(tick);
		});
	}

	function update(key, info) {
		const actor = store.update(key, info, media.matches);
		for (const rig of [...rigs.values()]) {
			if (rig.key !== key) continue;
			if (rig.figure !== actor.figure) {
				mount(rig.host, { key, ...info, figure: actor.figure, color: actor.color }, { hover: rig.hoverMotion });
			} else if (rig.revision !== actor.revision) startRig(rig, true);
		}
		schedule();
		return actor;
	}

	function syncHover() {
		const keys = new Set([...hovered].map((host) => rigs.get(host)?.key).filter(Boolean));
		for (const key of store.actors.keys()) store.hover(key, keys.has(key));
		schedule();
	}

	function dispose(host) {
		const rig = rigs.get(host);
		if (!rig) return;
		cancelRig(rig);
		rig.unbind();
		resize.unobserve(host);
		visibility.unobserve(host);
		hovered.delete(host);
		rigs.delete(host);
	}

	function mount(host, config, options = {}) {
		const existing = rigs.get(host);
		if (existing?.key === config.key && existing.figure === config.figure) {
			update(config.key, { figure: config.figure, color: config.color, name: config.name });
			return;
		}
		dispose(host);
		const actor = store.ensure(config.key);
		Object.assign(actor, { figure: config.figure, color: config.color, name: config.name });
		const id = config.figure;
		const prefix = `agent-figure-${++sequence}`;
		const frameNode = document.createElement("span");
		frameNode.className = "motion-rig";
		frameNode.setAttribute("aria-hidden", "true");
		const presence = document.createElement("span");
		presence.className = "motion-presence";
		const form = document.createElement("span");
		form.className = "motion-form";
		const body = document.createElement("span");
		body.className = "motion-body";
		const back = svg("svg", { viewBox: "-12 -12 124 124", class: "motion-strokes" });
		const front = svg("svg", { viewBox: "-12 -12 124 124", class: "motion-strokes" });
		const strokes = Array.from({ length: visuals.strokeSlots }, () => {
			const pair = { back: svg("path", { fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" }), front: svg("path", { fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" }) };
			back.append(pair.back); front.append(pair.front);
			return pair;
		});
		const picture = image(id, config.color);
		body.append(picture);
		const overlay = svg("svg", { viewBox: "0 0 100 100", class: "motion-face" });
		overlay.style.visibility = "hidden";
		const definitions = svg("defs");
		const feather = svg("filter", { id: `${prefix}-feather`, x: "-30%", y: "-30%", width: "160%", height: "160%" });
		feather.append(svg("feGaussianBlur", { stdDeviation: ".3" }));
		const patch = svg("mask", { id: `${prefix}-patch`, maskUnits: "userSpaceOnUse", x: 0, y: 0, width: 100, height: 100, style: "mask-type:alpha" });
		for (const eye of model.faces[id]) patch.append(svg("rect", { x: eye.x - eye.width / 2 - 1.6, y: eye.y - eye.height / 2 - 1.6, width: eye.width + 3.2, height: eye.height + 3.2, rx: eye.width / 2 + 1.6, fill: "white", transform: `rotate(${eye.rotation} ${eye.x} ${eye.y})`, filter: `url(#${prefix}-feather)` }));
		const silhouette = svg("mask", { id: `${prefix}-silhouette`, maskUnits: "userSpaceOnUse", x: 0, y: 0, width: 100, height: 100, style: "mask-type:alpha" });
		silhouette.append(svg("image", { href: artwork(id), width: 100, height: 100 }));
		definitions.append(feather, patch, silhouette);
		const face = svg("g", { mask: `url(#${prefix}-silhouette)` });
		const facePlate = svg("image", { width: 100, height: 100, mask: `url(#${prefix}-patch)` });
		const eyes = model.faces[id].map(() => svg("rect", { fill: "#fcffff" }));
		face.append(facePlate, ...eyes);
		overlay.append(definitions, face);
		body.append(overlay);
		const typing = svg("svg", { viewBox: "0 0 100 100", class: "motion-typing" });
		const dots = [0, 1, 2].map(() => svg("circle", { cx: 50, cy: 50, r: 0, fill: config.color }));
		typing.append(...dots);
		form.append(body);
		presence.append(back, form, front, typing);
		frameNode.append(presence);
		host.replaceChildren(frameNode);
		const onEnter = (event) => { if (event.pointerType !== "touch") { hovered.add(host); syncHover(); } };
		const onLeave = () => { hovered.delete(host); syncHover(); };
		const hoverMotion = options.hover !== false;
		if (hoverMotion) {
			host.addEventListener("pointerenter", onEnter);
			host.addEventListener("pointerleave", onLeave);
			host.addEventListener("focusin", onEnter);
			host.addEventListener("focusout", onLeave);
		}
		const rig = {
			key: config.key, figure: id, host, frame: frameNode, presence, form, body, image: picture, overlay, facePlate, eyes, dots, strokes,
			size: host.clientWidth || 26, visible: true, prepared: false, hoverMotion,
			facePose: visuals.face("idle", 0, 26), faceFrom: null, animations: new Set(),
			unbind() {
				host.removeEventListener("pointerenter", onEnter); host.removeEventListener("pointerleave", onLeave);
				host.removeEventListener("focusin", onEnter); host.removeEventListener("focusout", onLeave);
			},
		};
		rigs.set(host, rig);
		resize.observe(host);
		visibility.observe(host);
		startRig(rig);
		void ensureArtwork(id).then(schedule);
		schedule();
	}

	function groupLayout(count) {
		if (count <= 1) return [[2, 0, 44]];
		if (count === 2) return [[4, 2, 27], [17, 15, 27]];
		if (count === 3) return [[12.5, 2, 23], [5, 17, 23], [20, 17, 23]];
		return [[5.5, 3, 23], [20.5, 3, 23], [5.5, 18, 23], [20.5, 18, 23]];
	}

	function knockoutMask(figure, side, radius) {
		const key = `${figure}:${side}:${radius}`;
		if (masks.has(key)) return masks.get(key);
		const margin = Math.ceil(radius) + 1;
		const canvas = document.createElement("canvas");
		canvas.width = canvas.height = side + margin * 2;
		const ctx = canvas.getContext("2d", { willReadFrequently: true });
		ctx.drawImage(appearance.drawable(figure, model.avatars.find(({ id }) => id === figure).color), margin, margin, side, side);
		const source = ctx.getImageData(0, 0, canvas.width, canvas.height);
		const target = ctx.createImageData(canvas.width, canvas.height);
		const offsets = [];
		for (let y = -Math.ceil(radius); y <= Math.ceil(radius); y++) {
			for (let x = -Math.ceil(radius); x <= Math.ceil(radius); x++) if (x * x + y * y <= radius * radius) offsets.push([x, y]);
		}
		for (let y = 0; y < canvas.height; y++) {
			for (let x = 0; x < canvas.width; x++) {
				let alpha = 0;
				for (const [dx, dy] of offsets) {
					const xx = x + dx, yy = y + dy;
					if (xx >= 0 && yy >= 0 && xx < canvas.width && yy < canvas.height) alpha = Math.max(alpha, source.data[(yy * canvas.width + xx) * 4 + 3]);
				}
				target.data[(y * canvas.width + x) * 4 + 3] = alpha;
			}
		}
		ctx.putImageData(target, 0, 0);
		const mask = { canvas, margin };
		if (masks.size > 96) masks.delete(masks.keys().next().value);
		masks.set(key, mask);
		return mask;
	}

	function drawGroup(canvas) {
		const config = groups.get(canvas);
		if (!config || config.members.some(({ figure }) => !ready.has(figure))) return;
		const ratio = Math.min(3, Math.max(2, window.devicePixelRatio || 1));
		const width = Math.max(1, Math.round((canvas.clientWidth || 50) * ratio));
		const height = Math.max(1, Math.round((canvas.clientHeight || 50) * ratio));
		canvas.width = width; canvas.height = height;
		const context = canvas.getContext("2d");
		const scale = Math.min(width / 48, height / 44);
		const offsetX = (width - 48 * scale) / 2, offsetY = (height - 44 * scale) / 2;
		const count = config.members.length;
		const layout = groupLayout(count);
		const shown = count > 4 ? config.members.slice(0, 3) : config.members;
		for (const [index, member] of shown.entries()) {
			const [x, y, size] = layout[index];
			const side = Math.round(size * scale);
			const left = Math.round(x * scale + offsetX), top = Math.round(y * scale + offsetY);
			if (index > 0) {
				const mask = knockoutMask(member.figure, side, 1.2 * scale);
				context.globalCompositeOperation = "destination-out";
				context.drawImage(mask.canvas, left - mask.margin, top - mask.margin);
			}
			context.globalCompositeOperation = "source-over";
			context.drawImage(appearance.drawable(member.figure, member.color), left, top, side, side);
		}
		if (count > 4) {
			context.font = `600 ${(count > 12 ? 12 : 13) * scale}px system-ui, sans-serif`;
			context.textAlign = "center"; context.textBaseline = "middle";
			context.fillStyle = config.selected ? "#ffffff" : "#777773";
			context.fillText(`+${count - 3}`, offsetX + 32.5 * scale, offsetY + 30.7 * scale);
		}
	}

	function group(canvas, members, selected = false) {
		const signature = JSON.stringify([members, selected]);
		if (groups.get(canvas)?.signature === signature) return;
		groups.set(canvas, { members, selected, signature });
		resize.observe(canvas);
		void Promise.all(members.map(({ figure }) => ensureArtwork(figure))).then(() => drawGroup(canvas));
	}

	const resize = new ResizeObserver((entries) => {
		for (const entry of entries) {
			const rig = rigs.get(entry.target);
			if (rig && entry.contentRect.width > 0 && rig.size !== entry.contentRect.width) {
				rig.size = entry.contentRect.width; startRig(rig);
			} else if (groups.has(entry.target)) drawGroup(entry.target);
		}
		schedule();
	});
	const visibility = new IntersectionObserver((entries) => {
		for (const entry of entries) {
			const rig = rigs.get(entry.target);
			if (!rig || rig.visible === entry.isIntersecting) continue;
			rig.visible = entry.isIntersecting;
			if (rig.visible) startRig(rig); else cancelRig(rig);
		}
		schedule();
	});
	new MutationObserver((records) => {
		if (cleanupQueued || !records.some((record) => record.removedNodes.length)) return;
		cleanupQueued = true;
		queueMicrotask(() => {
			cleanupQueued = false;
			for (const host of rigs.keys()) if (!host.isConnected) dispose(host);
			for (const canvas of groups.keys()) if (!canvas.isConnected) { resize.unobserve(canvas); groups.delete(canvas); }
			syncHover();
		});
	}).observe(document.body, { childList: true, subtree: true });

	document.addEventListener("visibilitychange", () => {
		paused = document.hidden;
		if (paused) clock.pause(); else clock.resume();
		document.documentElement.dataset.avatarPaused = String(paused);
		for (const rig of rigs.values()) for (const animation of rig.animations) {
			if (paused) animation.pause(); else if (animation.playState === "paused") animation.play();
		}
		if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
		schedule();
	});
	media.addEventListener("change", () => {
		for (const actor of store.actors.values()) if (media.matches) {
			actor.form = { startedAt: clock.now(), frames: [[0, actor.state === "writing" ? 1 : 0]] };
			actor.startedAt = Math.min(actor.startedAt, clock.now());
		}
		for (const rig of rigs.values()) startRig(rig);
		schedule();
	});

	window.QORPERA_AVATARS = Object.freeze({
		image, mount, update, dispose, group, groupLayout,
		celebrate(key) { store.ensure(key).createdUntil = clock.now() + visuals.durations.creation; update(key, {}); },
		refresh: schedule,
	});
})();
