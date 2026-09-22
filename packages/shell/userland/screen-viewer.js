// Cloud viewer adapted from codex/step3-remaining-ops. The host supplies an
// authenticated SDK raw channel or an exact local IPC bridge. No ticket enters
// a DOM attribute, URL, noVNC option or error message.
import RFB from "./vendor/novnc-rfb.js";

const bindingKeys = [
	"companyId", "environmentId", "companyComputerId", "logicalComputerId",
	"computerGeneration", "screenId", "screenOrdinal", "screenGeneration", "staffAgentId",
];

function openScreenViewer({ binding, title, requestConnection, releaseConnection, onClosed, canControl = true, privateSignIn = false, sharedControl = false, mount, autofocus = true, onExpandedChange }) {
	const expected = Object.freeze({ ...binding });
	const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
	if (bindingKeys.some((key) => key.endsWith("Id") ? !uuid.test(expected[key]) : !Number.isSafeInteger(expected[key]) || expected[key] < 1) ||
		expected.screenOrdinal > 32 || typeof requestConnection !== "function" || typeof releaseConnection !== "function") {
		throw new Error("INVALID_VIEW_BINDING");
	}
	const stop = new AbortController();
	const previous = document.activeElement;
	const overlay = document.createElement("div");
	overlay.className = mount ? "screen-viewer-overlay screen-viewer-embedded" : "screen-viewer-overlay";
	if (mount) overlay.tabIndex = -1;
	overlay.setAttribute("role", mount ? "region" : "dialog");
	if (!mount) overlay.setAttribute("aria-modal", "true");
	overlay.setAttribute("aria-label", title);
	const frame = document.createElement("div");
	frame.className = "screen-viewer-frame";
	const titlebar = document.createElement("div");
	titlebar.className = "screen-viewer-titlebar";
	const heading = document.createElement("span");
	heading.textContent = title;
	const hint = document.createElement("small");
	hint.textContent = "Connecting to cloud desktop";
	const headingWrap = document.createElement("span");
	headingWrap.className = "screen-viewer-heading";
	// Embedded only: says when the browser refused full screen, so the entered frame is not mistaken for it.
	// It stays in the tree, empty, so the live region exists before its text changes and is announced.
	const note = mount ? document.createElement("small") : undefined;
	if (note) {
		note.className = "screen-viewer-note";
		note.setAttribute("role", "status");
		note.setAttribute("aria-live", "polite");
	}
	headingWrap.append(heading, hint, ...(note ? [note] : []));
	const controls = document.createElement("div");
	controls.className = "screen-viewer-controls";
	const labelButton = (button, text, label = text) => {
		button.textContent = text;
		button.setAttribute("aria-label", label);
		button.setAttribute("title", label);
	};
	const takeover = document.createElement("button");
	takeover.type = "button";
	takeover.className = "screen-viewer-takeover";
	labelButton(takeover, "Take control");
	takeover.disabled = true;
	takeover.hidden = !canControl || privateSignIn || sharedControl;
	takeover.setAttribute("aria-pressed", "false");
	const reconnect = document.createElement("button");
	reconnect.type = "button";
	reconnect.className = "screen-viewer-reconnect";
	labelButton(reconnect, "Reconnect");
	reconnect.hidden = true;
	const closeButton = document.createElement("button");
	closeButton.type = "button";
	closeButton.className = "screen-viewer-close";
	labelButton(closeButton, "×", "Close screen viewer");
	const supportsFullscreen = Boolean(mount) && document.fullscreenEnabled !== false && typeof overlay.requestFullscreen === "function" && typeof document.exitFullscreen === "function";
	const enter = mount ? document.createElement("button") : undefined;
	const back = mount ? document.createElement("button") : undefined;
	if (enter && back) {
		enter.type = "button";
		enter.className = "screen-viewer-enter";
		labelButton(enter, "Enter");
		enter.disabled = true;
		back.type = "button";
		back.className = "screen-viewer-back";
		labelButton(back, "Back to thread");
		back.hidden = true;
		takeover.hidden = true;
		closeButton.hidden = true;
	}
	controls.append(takeover, reconnect, ...(back ? [back] : []), closeButton);
	titlebar.append(headingWrap, controls);
	const stage = document.createElement("div");
	stage.className = "screen-viewer-stage";
	const canvasHost = document.createElement("div");
	const status = document.createElement("div");
	status.className = "screen-viewer-status";
	status.setAttribute("role", "status");
	status.setAttribute("aria-live", "polite");
	const statusContent = document.createElement("div");
	statusContent.className = "screen-viewer-status-content";
	const statusCopy = document.createElement("span");
	statusCopy.textContent = hint.textContent;
	const progress = document.createElement("div");
	progress.className = "screen-viewer-progress";
	progress.setAttribute("role", "progressbar");
	progress.setAttribute("aria-label", "Connecting to cloud desktop");
	progress.appendChild(document.createElement("span"));
	statusContent.append(statusCopy, progress);
	status.appendChild(statusContent);
	stage.append(canvasHost, status);
	frame.append(titlebar, stage);
	if (enter) frame.appendChild(enter);
	overlay.appendChild(frame);
	(mount ?? document.body).appendChild(overlay);
	if (autofocus) closeButton.focus();

	let closed = false;
	let busy = false;
	let current;
	let epoch = 0;
	let entered = false;
	let connected = false;
	let fullscreenAttempt = 0;
	let ownedFullscreen = false;
	let admission;
	let admissionMode;
	let queuedWatch = false;
	const syncEmbedded = () => {
		if (!enter || !back) return;
		enter.hidden = entered || !connected;
		enter.disabled = !connected || busy;
		back.hidden = !entered;
		takeover.hidden = !entered || !canControl || privateSignIn || sharedControl;
		closeButton.hidden = !entered;
	};
	const hideNote = () => {
		if (note) note.textContent = "";
	};
	const showNote = () => {
		if (!closed && entered && note) note.textContent = "Full screen unavailable";
	};
	const setEntered = (value) => {
		if (!mount || entered === value) return;
		entered = value;
		if (value) overlay.classList.add("screen-viewer-entered");
		else overlay.classList.remove("screen-viewer-entered");
		if (!value) hideNote();
		syncEmbedded();
		onExpandedChange?.(value);
	};
	const released = new Set();
	const usedUrls = new Set();
	const usedChannels = new WeakSet();
	const release = async (connection) => {
		if (!connection || released.has(connection.connectionId)) return;
		released.add(connection.connectionId);
		// Cleanup is exact-connection scoped and must still work after the UI's signal is cancelled.
		try { connection.channel?.close(); } finally { await releaseConnection({ connectionId: connection.connectionId }); }
	};
	const detach = async () => {
		const active = current;
		current = undefined;
		if (!active) return;
		active.rfb.viewOnly = true;
		try { active.rfb.disconnect(); } finally { await release(active.connection); }
	};
	const fail = () => {
		if (closed) return;
		connected = false;
		takeover.disabled = true;
		labelButton(takeover, "Take control");
		takeover.setAttribute("aria-pressed", "false");
		reconnect.hidden = false;
		reconnect.disabled = false;
		status.hidden = false;
		status.classList.add("is-error");
		statusCopy.textContent = "Cloud screen unavailable. Reconnect to check access again.";
		hint.textContent = "Disconnected";
		syncEmbedded();
	};
	const finish = async () => {
		if (closed) return;
		closed = true;
		setEntered(false);
		epoch++;
		stop.abort();
		// Removing the overlay also exits fullscreen if the browser rejects an explicit exit.
		const exiting = mount && document.fullscreenElement === overlay
			? document.exitFullscreen().catch(() => undefined) : Promise.resolve();
		overlay.remove();
		if (previous?.isConnected) previous.focus();
		try { await Promise.all([detach(), exiting]); } finally { onClosed?.(); }
	};
	const connect = async (mode) => {
		if (closed || busy) return;
		if (mode !== "watch" && !canControl && !privateSignIn) return;
		if (mode !== "watch" && mount && (!entered || !canControl || privateSignIn)) return;
		busy = true;
		connected = false;
		const attempt = ++epoch;
		const attemptStop = new AbortController();
		admission = attemptStop;
		admissionMode = mode;
		takeover.disabled = true;
		labelButton(takeover, "Take control");
		takeover.setAttribute("aria-pressed", "false");
		reconnect.disabled = true;
		status.hidden = false;
		status.classList.remove("is-error");
		statusCopy.textContent = privateSignIn ? "Checking your private sign-in access" : mode === "control" ? "Waiting for the cloud screen to release agent control" : "Starting the screen and connecting…";
		hint.textContent = "Connecting";
		syncEmbedded();
		let connection;
		try {
			await detach();
			if (closed || attempt !== epoch) return;
			connection = await requestConnection({ binding: expected, mode, signal: AbortSignal.any([stop.signal, attemptStop.signal]) });
			if (closed || attempt !== epoch) { await release(connection); return; }
			// A reconnect cannot silently change agent, company, physical generation or control mode.
			if (!connection || typeof connection.connectionId !== "string" || !connection.connectionId || released.has(connection.connectionId) ||
				connection.mode !== mode || !connection.binding || bindingKeys.some((key) => connection.binding[key] !== expected[key])) {
				throw new Error("VIEW_BINDING_CHANGED");
			}
			if (connection.channel) {
				if (connection.url !== undefined || typeof connection.channel !== "object" || usedChannels.has(connection.channel) ||
					connection.channel.readyState !== 1 || typeof connection.channel.send !== "function" || typeof connection.channel.close !== "function") {
					throw new Error("INVALID_VIEW_CHANNEL");
				}
				usedChannels.add(connection.channel);
			} else {
				if (typeof connection.url !== "string" || usedUrls.has(connection.url) || !/^ws:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/[A-Za-z0-9_-]{43}$/.test(connection.url) ||
					Number(new URL(connection.url).port) > 65535) throw new Error("INVALID_VIEW_URL");
				usedUrls.add(connection.url);
			}
			canvasHost.replaceChildren();
			const rfb = new RFB(canvasHost, connection.channel ?? connection.url, { shared: true });
			rfb.viewOnly = true;
			rfb.scaleViewport = true;
			rfb.resizeSession = false;
			rfb.background = "transparent";
			current = { rfb, connection };
			rfb.addEventListener("connect", () => {
				if (closed || current?.rfb !== rfb) return;
				if (mount && mode !== "watch" && !entered) return;
				connected = true;
				// This flag only controls UI input; the cloud gateway independently fences every input packet.
				rfb.viewOnly = mode === "watch";
				status.hidden = true;
				reconnect.hidden = true;
				takeover.disabled = false;
				labelButton(takeover, mode === "control" ? "Release control" : "Take control");
				takeover.setAttribute("aria-pressed", String(mode === "control"));
				hint.textContent = privateSignIn ? "Private sign-in · Closing this view leaves the office private" : mode === "shared" ? "Shared with the agent" : mode === "control" ? "You control this cloud screen" : "Watching only";
				if (mode !== "watch") rfb.focus();
				syncEmbedded();
			});
			rfb.addEventListener("disconnect", () => {
				if (current?.rfb !== rfb) return;
				rfb.viewOnly = true;
				current = undefined;
				void release(connection).catch(() => undefined);
				fail();
			});
		} catch {
			if (connection) await release(connection).catch(() => undefined);
			if (attempt === epoch) fail();
		} finally {
			busy = false;
			admission = undefined;
			admissionMode = undefined;
			syncEmbedded();
			if (queuedWatch && !closed) {
				queuedWatch = false;
				void connect("watch");
			}
		}
	};
	const returnToMini = () => {
		if (closed || !entered) return;
		const restoreFocus = overlay.contains(document.activeElement);
		// A request the host never answered must not speak for a newer one: its late answer, refusal and timer are ignored.
		fullscreenAttempt++;
		setEntered(false);
		if (restoreFocus) overlay.focus();
		if ((current && current.connection.mode !== "watch") || (admissionMode && admissionMode !== "watch")) {
			if (current) current.rfb.viewOnly = true;
			epoch++;
			admission?.abort();
			if (busy) queuedWatch = true;
			else void connect("watch");
		}
		if (document.fullscreenElement === overlay) void document.exitFullscreen().catch(() => undefined);
	};
	if (enter && back) {
		// Entering takes the browser full screen, with the host's frame around the
		// screen. "Back to thread" is the one way out; leaving full screen by any
		// other route (Escape, the system) also returns to the mini. If the browser
		// refuses full screen, the entered frame stays inside the host.
		const syncFullscreen = () => {
			const active = document.fullscreenElement === overlay;
			if (active) hideNote();
			if (ownedFullscreen && !active) returnToMini();
			ownedFullscreen = active;
		};
		const enterFullscreen = async () => {
			if (closed || !entered || !supportsFullscreen || document.fullscreenElement === overlay) return;
			// Enter reaches here only from the mini, so one attempt is live at a time; the counter fences late answers.
			const attempt = ++fullscreenAttempt;
			// Some hosts never answer the request; after a moment the frame says so and stays inside the host.
			const slow = setTimeout(() => { if (attempt === fullscreenAttempt && document.fullscreenElement !== overlay) showNote(); }, 2000);
			try {
				await overlay.requestFullscreen();
				if ((closed || !entered) && document.fullscreenElement === overlay) await document.exitFullscreen();
				if (!closed) syncFullscreen();
			} catch {
				// Full screen refused: the entered frame remains in the host and says so. Back, then Enter, asks again.
				// A beat later, so assistive tech has seen the empty live region before its text changes.
				setTimeout(() => { if (attempt === fullscreenAttempt) showNote(); }, 0);
			} finally {
				clearTimeout(slow);
			}
		};
		if (supportsFullscreen) document.addEventListener("fullscreenchange", syncFullscreen, { signal: stop.signal });
		enter.onclick = () => {
			if (closed || enter.disabled || entered) return;
			setEntered(true);
			back.focus();
			// Invoke before any await so native fullscreen retains the click's user activation.
			void enterFullscreen();
			if (canControl && !privateSignIn) void connect(sharedControl ? "shared" : "control");
		};
		back.onclick = returnToMini;
	}
	takeover.onclick = () => { if (!privateSignIn && !sharedControl && (!mount || entered)) void connect(current?.connection.mode === "control" ? "watch" : "control"); };
	// Each explicit reconnect obtains fresh authority; mini previews stay watch-only.
	const initialMode = !mount && privateSignIn ? "control" : !mount && sharedControl && canControl ? "shared" : "watch";
	reconnect.onclick = () => { void connect(mount && entered && sharedControl && canControl && !privateSignIn ? "shared" : initialMode); };
	closeButton.onclick = () => { void finish().catch(() => undefined); };
	void connect(initialMode);
	return { close: finish, get closed() { return closed; } };
}

window.qorperaScreenViewer = { open: openScreenViewer };
