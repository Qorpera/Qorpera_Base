"use strict";

(() => {
	// Poses are x%, y%, rotation degrees, horizontal scale, vertical scale.
	const neutral = [0, 0, 0, 1, 1];
	const creation = Object.freeze({ playbackRate: .8, strokeScale: 1.725 });
	// Measured from each approved 512 px source, in the shared 100-unit frame.
	// Planet retains its approved rig; the others retain their own eye placement.
	const faces = Object.freeze(Object.fromEntries(Object.entries({
		planet: [[56.5, 39.7, 6.25, 14.75, -17], [69.2, 38.1, 6.25, 14.75, -17]],
		acorn: [[54.32, 58.08, 6.21, 15.35, -16.36], [67.32, 56.55, 6.12, 15.29, -16.61]],
		flame: [[53.94, 64.09, 5.81, 14.6, -14.82], [66.32, 62.78, 5.81, 14.52, -15.25]],
		rocket: [[50.03, 44.68, 5.61, 13.64, -11], [61.96, 43.1, 5.6, 13.56, -11.11]],
		crown: [[56.74, 55.25, 5.96, 14.79, -10.81], [69.44, 53.79, 5.92, 14.59, -10.85]],
		heart: [[65.35, 45.45, 6.56, 16.86, -9.49], [78.89, 45.43, 6.41, 16.86, -9.99]],
		ghost: [[59.75, 36.05, 6.79, 13.54, -2.98], [72.42, 35.96, 6.39, 13.39, -3.53]],
	}).map(([id, eyes]) => [id, Object.freeze(eyes.map(([x, y, width, height, rotation]) => Object.freeze({ x, y, width, height, rotation })))])));
	const avatars = [
		{ id: "planet", name: "Planet", color: "#5ec0b5", origin: "50% 50%", rhythm: "The eyes lead a glance. The body follows, then holds.", duration: 8400, poses: [
			[0, 0, -.4, -.6, 1, 1], [.09, 0, -.4, -.6, 1, 1], [.16, -.6, -1.1, -2.4, 1.006, .996], [.36, -.6, -1.1, -2.4, 1.006, .996], [.45, .7, -1.4, 1.9, .997, 1.009], [.54, .2, -.4, .3, 1, 1], [.91, .2, -.4, .3, 1, 1], [1, 0, -.4, -.6, 1, 1],
		] },
		{ id: "acorn", name: "Acorn", color: "#87674c", origin: "50% 88%", rhythm: "A grounded, deliberate rock.", duration: 3600, poses: [
			[0, 0, 0, 0, 1, 1], [.24, -.4, .4, -3, 1.018, .985], [.54, .5, -.6, 2.4, .993, 1.012], [.76, 0, .2, -.7, 1.006, .997], [1, 0, 0, 0, 1, 1],
		] },
		{ id: "flame", name: "Flame", color: "#fa752e", origin: "50% 86%", rhythm: "A soft, irregular flicker.", duration: 2600, poses: [
			[0, 0, 0, 0, 1, 1], [.22, .4, -1.3, 3.5, .98, 1.025], [.47, -.6, .5, -2.6, 1.02, .985], [.73, .2, -.7, 1.3, .992, 1.012], [1, 0, 0, 0, 1, 1],
		] },
		{ id: "rocket", name: "Rocket", color: "#f96e2d", origin: "50% 65%", rhythm: "A light lift with a steady hover.", duration: 3200, poses: [
			[0, 0, -2.5, -.6, 1, 1], [.23, .4, -5.2, .7, .986, 1.022], [.51, -.3, -3.7, -.4, 1.005, .996], [.77, .2, -4.4, .5, .997, 1.008], [1, 0, -2.5, -.6, 1, 1],
		] },
		{ id: "crown", name: "Crown", color: "#fcb51b", origin: "50% 85%", rhythm: "A small, measured nod.", duration: 4400, poses: [
			[0, 0, 0, 0, 1, 1], [.2, .3, .6, 1.7, 1.012, .985], [.4, 0, -.8, -.8, .995, 1.009], [.6, 0, 0, .25, 1, 1], [1, 0, 0, 0, 1, 1],
		] },
		{ id: "heart", name: "Heart", color: "#fb672a", origin: "50% 55%", rhythm: "A quiet double heartbeat.", duration: 3000, poses: [
			[0, 0, 0, 0, 1, 1], [.08, 0, -.3, 0, 1.052, 1.045], [.16, 0, 0, 0, .997, .997], [.26, 0, -.2, .3, 1.036, 1.03], [.38, 0, 0, 0, 1, 1], [1, 0, 0, 0, 1, 1],
		] },
		{ id: "ghost", name: "Ghost", color: "#312f2d", colorOnDark: "#a29d97", origin: "50% 55%", rhythm: "An unhurried floating drift.", duration: 6400, poses: [
			[0, -.6, -1.2, -1, 1, 1], [.3, 1.5, -4.7, 1.7, .996, 1.013], [.65, .7, -2.6, .6, 1.009, .995], [1, -.6, -1.2, -1, 1, 1],
		] },
	];
	const states = [
		{ id: "still", label: "Stand still", activity: "" },
		{ id: "idle", label: "Idle", activity: "" },
		{ id: "creation", label: "Creation", activity: "A new agent, ready to begin." },
		{ id: "working", label: "Working", activity: "Working through the latest notes." },
		{ id: "writing", label: "Writing", activity: "Putting the response together." },
		{ id: "needs-attention", label: "Needs attention", activity: "Waiting for your input." },
		{ id: "complete", label: "Complete", activity: "The work is ready." },
	];
	const effectColors = Object.freeze([
		{ name: "Neon green", color: "#62ff2f" },
		{ name: "Hot pink", color: "#ff2d9a" },
		{ name: "Bright orange", color: "#ff791b" },
	]);
	const workingActions = Object.freeze([
		{ id: "working", label: "General work" },
		{ id: "searching", label: "Web search" },
		{ id: "connecting", label: "Tool connection" },
		{ id: "computer", label: "Computer use" },
	]);
	const routineStates = Object.freeze(["working", "writing", "needs-attention"]);

	function avatarColor(id, surface = "light", selectedColor) {
		const avatar = avatars.find((item) => item.id === id);
		if (!avatar || !["light", "dark", "checker"].includes(surface)) throw new RangeError("Invalid avatar or surface");
		if (selectedColor !== undefined) {
			if (!/^#[\da-f]{6}$/.test(selectedColor)) throw new RangeError("Invalid avatar color");
			if (surface === "dark" && selectedColor === "#312f2d") return "#a29d97";
			return selectedColor;
		}
		return surface === "dark" ? avatar.colorOnDark ?? avatar.color : avatar.color;
	}

	function statusMessage(id, state, action = "working", tool = "Cursor", routineActive = false) {
		const avatar = avatars.find((item) => item.id === id);
		if (!avatar || !states.some((item) => item.id === state) || !workingActions.some((item) => item.id === action) || typeof routineActive !== "boolean") throw new RangeError("Invalid status identity, state, or action");
		if (state === "still" || state === "idle") return { lead: "", detail: "" };
		if (state === "working" && action === "searching") return { lead: "Searching", detail: " the web" };
		if (state === "working" && action === "connecting") return { lead: "Connecting to", detail: ` ${tool.trim().slice(0, 48) || "your tools"}` };
		if (state === "working" && action === "computer") return { lead: avatar.name, detail: " is using its computer" };
		if (state === "working" && routineActive) return { lead: avatar.name, detail: " is running a routine" };
		const detail = {
			creation: " is getting ready",
			working: " is working", writing: " is writing",
			"needs-attention": " needs your input", complete: " has finished",
		};
		return { lead: avatar.name, detail: detail[state] };
	}

	function sidebarStatus(state, { action = "working", tool = "Cursor", routineActive = false, unread = false, needsYou = false } = {}) {
		if (!states.some((item) => item.id === state) || !workingActions.some((item) => item.id === action) || typeof tool !== "string" || [routineActive, unread, needsYou].some((value) => typeof value !== "boolean")) throw new RangeError("Invalid sidebar state or activity");
		const live = ["creation", "working", "writing"].includes(state);
		// A request is an obligation, not a read receipt. It stays ahead of work
		// and unseen results until the user explicitly resolves it.
		const kind = needsYou || state === "needs-attention" ? "attention" : live ? "working" : unread ? "new" : "quiet";
		let text = kind === "attention" ? "Needs you" : kind === "new" ? "New" : "";
		if (kind === "working") {
			if (state === "creation") text = "Getting ready";
			else if (state === "writing") text = "Writing";
			else if (action === "searching") text = "Searching the web";
			else if (action === "connecting") text = `Connecting to ${tool.trim().slice(0, 48) || "your tools"}`;
			else if (action === "computer") text = "Using computer";
			else text = routineActive ? "Running a routine" : "Working";
		}
		const badges = [];
		if (kind !== "quiet") badges.push({ id: "active", tone: kind === "working" ? "green" : "blue" });
		if (state === "working" && action === "computer") badges.push({ id: "computer", label: "Using computer" });
		return { kind, text, badges };
	}

	function amplitude(size) {
		if (!Number.isFinite(size) || size <= 0) throw new RangeError("Invalid avatar size");
		return size >= 96 ? 1 : size >= 40 ? .66 : size >= 24 ? .42 : .32;
	}

	function transform(pose, amount) {
		const [x, y, rotation, sx, sy] = pose;
		return `translate(${(x * amount).toFixed(3)}%, ${(y * amount).toFixed(3)}%) rotate(${(rotation * amount).toFixed(3)}deg) scale(${(1 + (sx - 1) * amount).toFixed(4)}, ${(1 + (sy - 1) * amount).toFixed(4)})`;
	}

	function motion(id, state, size = 144) {
		const avatar = avatars.find((item) => item.id === id);
		if (!avatar || !states.some((item) => item.id === state)) throw new RangeError("Unknown avatar or motion state");
		const index = avatars.indexOf(avatar);
		const amount = amplitude(size);
		let poses = null;
		let duration = 0;
		let rest = neutral;
		let entryDuration = 640;
		let entry = [
			[0, ...neutral], [.18, 0, 1.2, -.7, 1.075, .9], [.46, 0, -4.5, 1.4, .958, 1.065], [.76, 0, .4, -.4, 1.019, .985],
		];
		let description = avatar.rhythm;
		if (state === "still") {
			entryDuration = 0;
			entry = [[0, ...neutral]];
			description = "The starting pose. No breathing, blinking, or effects until an activity is chosen.";
		} else if (state === "working") {
			poses = avatar.poses;
			duration = avatar.duration;
			rest = poses[0].slice(1);
			description = `${avatar.rhythm} The eyes read, look up, and react, with short quiet holds.`;
		} else if (state === "creation") {
			entryDuration = 880 / creation.playbackRate;
			entry = [[0, ...neutral], [.17, 0, 3.5, -2.6, 1.11, .84], [.38, 0, -9.5, 3.6, .92, 1.1], [.6, 0, 1, -1.2, 1.036, .97], [.8, 0, -1.2, .4, .992, 1.016]];
			description = "Color gathers in, then a spring releases two counter-spinning streams of neon streaks.";
		} else if (state === "idle") {
			entryDuration = 400;
			entry = [[0, ...neutral], [.7, 0, .2, -.15, 1.004, .997]];
			duration = 8400 + index * 419;
			poses = [[0, ...neutral], [.72, ...neutral], [.82, 0, -.2, .18, 1.001, 1.004], [.92, ...neutral], [1, ...neutral]];
			description = "Almost still, with a small breath and a long rest.";
		} else if (state === "writing") {
			entryDuration = 0;
			entry = [[0, ...neutral]];
			description = "Gather into one dot, then split into three. One shared typing rhythm for every figure.";
		} else if (state === "needs-attention") {
			entryDuration = 740;
			rest = [0, 0, -2, 1, 1];
			entry = [[0, ...neutral], [.18, 0, 1, .5, 1.045, .955], [.5, 0, -4.2, -2.8, .98, 1.035], [.79, 0, .2, -1.5, 1.009, .995]];
			description = "A glance and a short curved cue, then a quiet waiting pose.";
		} else {
			entryDuration = 820;
			entry = [[0, ...neutral], [.2, 0, 1.2, -.4, 1.07, .91], [.49, 0, -6, 1.4, .96, 1.065], [.74, 0, .5, -.5, 1.022, .981], [.9, 0, -.5, .2, .997, 1.003]];
			description = "A single spring of acknowledgement, then back to rest.";
		}
		entry.push([1, ...rest]);
		const keyframes = (points) => points.map(([offset, ...pose]) => ({ offset, transform: transform(pose, amount), easing: "cubic-bezier(.42, 0, .3, 1)" }));
		const entryFrames = keyframes(entry);
		if (state === "creation") {
			entryFrames[0].easing = "cubic-bezier(.5, 0, .72, .3)";
			entryFrames[1].easing = "cubic-bezier(.12, .82, .24, 1)";
		}
		return {
			origin: avatar.origin,
			description,
			rest: transform(rest, amount),
			entry: { duration: entryDuration, frames: entryFrames },
			loop: poses ? { duration, frames: keyframes(poses) } : null,
		};
	}

	function createClock(readTime) {
		let heldAt = null;
		let offset = 0;
		return {
			now: () => (heldAt ?? readTime()) - offset,
			pause() { if (heldAt === null) heldAt = readTime(); },
			resume() { if (heldAt !== null) { offset += readTime() - heldAt; heldAt = null; } },
		};
	}

	window.QORPERA_MOTION_MODEL = Object.freeze({ avatars, faces, states, creation, effectColors, workingActions, routineStates, avatarColor, statusMessage, sidebarStatus, motion, amplitude, createClock });
})();
