// Cloud viewer adapted from codex/step3-remaining-ops. The host supplies the
// existing member-authorized IPC adapters; no cloud capability enters the DOM.
import RFB from "./vendor/novnc-rfb.js";

const bindingKeys = [
	"companyId", "environmentId", "companyComputerId", "logicalComputerId",
	"computerGeneration", "screenId", "screenOrdinal", "screenGeneration", "staffAgentId",
];

function openScreenViewer({ binding, title, requestConnection, releaseConnection, onClosed }) {
	const expected = Object.freeze({ ...binding });
	const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
	if (bindingKeys.some((key) => key.endsWith("Id") ? !uuid.test(expected[key]) : !Number.isSafeInteger(expected[key]) || expected[key] < 1) ||
		expected.screenOrdinal > 32 || typeof requestConnection !== "function" || typeof releaseConnection !== "function") {
		throw new Error("INVALID_VIEW_BINDING");
	}
	const stop = new AbortController();
	const previous = document.activeElement;
	const overlay = document.createElement("div");
	overlay.className = "screen-viewer-overlay";
	overlay.setAttribute("role", "dialog");
	overlay.setAttribute("aria-modal", "true");
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
	headingWrap.append(heading, hint);
	const controls = document.createElement("div");
	controls.className = "screen-viewer-controls";
	const takeover = document.createElement("button");
	takeover.type = "button";
	takeover.textContent = "Take control";
	takeover.disabled = true;
	const reconnect = document.createElement("button");
	reconnect.type = "button";
	reconnect.textContent = "Reconnect";
	reconnect.hidden = true;
	const closeButton = document.createElement("button");
	closeButton.type = "button";
	closeButton.className = "screen-viewer-close";
	closeButton.setAttribute("aria-label", "Close screen viewer");
	closeButton.textContent = "×";
	controls.append(takeover, reconnect, closeButton);
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
	overlay.appendChild(frame);
	document.body.appendChild(overlay);
	closeButton.focus();

	let closed = false;
	let busy = false;
	let current;
	let epoch = 0;
	const released = new Set();
	const usedUrls = new Set();
	const release = async (connection) => {
		if (!connection || released.has(connection.connectionId)) return;
		released.add(connection.connectionId);
		// Cleanup is exact-connection scoped and must still work after the UI's signal is cancelled.
		await releaseConnection({ connectionId: connection.connectionId });
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
		takeover.disabled = true;
		takeover.textContent = "Take control";
		reconnect.hidden = false;
		reconnect.disabled = false;
		status.hidden = false;
		status.classList.add("is-error");
		statusCopy.textContent = "Cloud screen unavailable. Reconnect to check access again.";
		hint.textContent = "Disconnected";
	};
	const finish = async () => {
		if (closed) return;
		closed = true;
		epoch++;
		stop.abort();
		overlay.remove();
		previous?.focus();
		try { await detach(); } finally { onClosed?.(); }
	};
	const connect = async (mode) => {
		if (closed || busy) return;
		busy = true;
		const attempt = ++epoch;
		takeover.disabled = true;
		reconnect.disabled = true;
		status.hidden = false;
		status.classList.remove("is-error");
		statusCopy.textContent = mode === "control" ? "Waiting for the cloud screen to release agent control" : "Connecting to cloud desktop";
		hint.textContent = "Connecting";
		let connection;
		try {
			await detach();
			if (closed) return;
			connection = await requestConnection({ binding: expected, mode, signal: stop.signal });
			if (closed || attempt !== epoch) { await release(connection); return; }
			// A reconnect cannot silently change agent, company, physical generation or control mode.
			if (!connection || typeof connection.connectionId !== "string" || !connection.connectionId || released.has(connection.connectionId) ||
				connection.mode !== mode || !connection.binding || bindingKeys.some((key) => connection.binding[key] !== expected[key]) ||
				typeof connection.url !== "string" || usedUrls.has(connection.url) || !/^ws:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/[A-Za-z0-9_-]{43}$/.test(connection.url) ||
				Number(new URL(connection.url).port) > 65535) {
				throw new Error("VIEW_BINDING_CHANGED");
			}
			canvasHost.replaceChildren();
			usedUrls.add(connection.url);
			const rfb = new RFB(canvasHost, connection.url, { shared: true });
			rfb.viewOnly = true;
			rfb.scaleViewport = true;
			rfb.resizeSession = false;
			rfb.background = "transparent";
			current = { rfb, connection };
			rfb.addEventListener("connect", () => {
				if (closed || current?.rfb !== rfb) return;
				// This flag only controls UI input; the cloud gateway independently fences every input packet.
				rfb.viewOnly = mode !== "control";
				status.hidden = true;
				reconnect.hidden = true;
				takeover.disabled = false;
				takeover.textContent = mode === "control" ? "Release control" : "Take control";
				hint.textContent = mode === "control" ? "You control this cloud screen" : "Watching only";
				if (mode === "control") rfb.focus();
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
			fail();
		} finally { busy = false; }
	};
	takeover.onclick = () => { void connect(current?.connection.mode === "control" ? "watch" : "control"); };
	// Never regain control automatically after a network loss or expired grant.
	reconnect.onclick = () => { void connect("watch"); };
	closeButton.onclick = () => { void finish().catch(() => undefined); };
	void connect("watch");
	return { close: finish, get closed() { return closed; } };
}

window.qorperaScreenViewer = { open: openScreenViewer };
