"use strict";

(() => {
	function transitionValue(transition, now) {
		const elapsed = Math.max(0, now - transition.startedAt);
		for (let index = 1; index < transition.frames.length; index++) {
			const [end, to] = transition.frames[index];
			if (elapsed > end) continue;
			const [start, from] = transition.frames[index - 1];
			const progress = (elapsed - start) / (end - start);
			return from + (to - from) * progress * progress * (3 - 2 * progress);
		}
		return transition.frames.at(-1)[1];
	}

	// Identity, not figure, owns time and appearance. Two planets can work
	// independently; the same agent's sidebar/header/thread share one actor.
	function createActors(clock, typingDuration = 620) {
		const actors = new Map();
		function ensure(key) {
			if (!actors.has(key)) {
				const now = clock.now();
				actors.set(key, {
					key, state: "still", requestedState: "still", startedAt: now,
					typingStartedAt: now, createdUntil: 0, revision: 0,
					form: { startedAt: now, frames: [[0, 0]] },
					hover: { startedAt: now, frames: [[0, 0]] },
				});
			}
			return actors.get(key);
		}
		function update(key, info, reduced = false) {
			const actor = ensure(key);
			Object.assign(actor, info);
			const now = clock.now();
			const next = now < actor.createdUntil ? "creation" : actor.requestedState;
			if (actor.state === next) return actor;
			const from = transitionValue(actor.form, now);
			const to = next === "writing" ? 1 : 0;
			const duration = reduced ? 0 : Math.abs(to - from) * typingDuration;
			actor.form = { startedAt: now, frames: duration ? [[0, from], [duration, to]] : [[0, to]] };
			if (to === 1 && from === 0) actor.typingStartedAt = now;
			actor.state = next;
			actor.startedAt = now + (to === 0 ? duration : 0);
			actor.revision += 1;
			return actor;
		}
		function hover(key, active) {
			const actor = ensure(key);
			const to = active ? 1 : 0;
			if (actor.hover.frames.at(-1)[1] === to) return;
			const now = clock.now();
			actor.hover = { startedAt: now, frames: [[0, transitionValue(actor.hover, now)], [active ? 190 : 240, to]] };
		}
		return { actors, ensure, update, hover };
	}

	function activity(tool = "", phase = "working") {
		if (phase === "writing") return { state: "writing", text: "Writing", detail: " is writing", computer: false };
		if (phase === "starting" || phase === "waiting") return { state: "working", text: "Getting ready", detail: " is getting ready", computer: false };
		const name = String(tool).slice(0, 80);
		if (/(?:computer|browser|chrome|playwright|puppeteer|terminal|exec_command|bash)/i.test(name)) {
			return { state: "working", text: "Using computer", detail: " is using the computer", computer: true };
		}
		if (/(?:search|web)/i.test(name)) return { state: "working", text: "Searching the web", detail: " is searching the web", computer: false };
		if (/(?:connect|authorize|login)/i.test(name)) return { state: "working", text: "Connecting", detail: " is connecting", computer: false };
		return { state: "working", text: "Working", detail: " is working", computer: false };
	}

	function sidebar({ needsYou = false, active = null, unread = false, lastMessage = "" } = {}) {
		if (needsYou) return { kind: "attention", text: "Needs you", badge: "unread", computer: Boolean(active?.computer) };
		if (active) return { kind: "working", text: active.text, badge: "active", computer: Boolean(active.computer) };
		if (unread) return { kind: "new", text: "New", badge: "unread", computer: false };
		return { kind: "quiet", text: lastMessage, badge: "", computer: false };
	}

	function readReceipts(storage, namespace) {
		let receipts = {};
		try {
			const parsed = JSON.parse(storage.getItem(namespace) || "{}");
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) receipts = parsed;
		} catch { /* Storage is optional; session-local read state still works. */ }
		return {
			unread(key, messageId) { return Boolean(messageId && receipts[key] !== messageId); },
			seen(key, messageId) {
				if (!messageId || receipts[key] === messageId) return;
				receipts[key] = messageId;
				try { storage.setItem(namespace, JSON.stringify(receipts)); } catch { /* Private/storage-full mode. */ }
			},
		};
	}

	window.QORPERA_AVATAR_STATE = Object.freeze({ transitionValue, createActors, activity, sidebar, readReceipts });
})();
