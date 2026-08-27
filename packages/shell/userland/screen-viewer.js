// Company Computer live screen viewer: owns the overlay and the noVNC RFB
// session against the loopback WebSocket bridge the main process serves.
// Watching and driving are the same session — input flows as soon as the
// canvas has focus. Loaded as a module (vendored noVNC is ESM) and exposed
// on window for the classic renderer script.
import RFB from "./vendor/novnc-rfb.js";

function viewerSvg(path) {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "1.8");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("aria-hidden", "true");
	svg.innerHTML = path;
	return svg;
}

function openScreenViewer({ url, title, onClosed }) {
	const overlay = document.createElement("div");
	overlay.className = "screen-viewer-overlay";
	const frame = document.createElement("div");
	frame.className = "screen-viewer-frame";
	const titlebar = document.createElement("div");
	titlebar.className = "screen-viewer-titlebar";
	const heading = document.createElement("span");
	heading.textContent = title;
	const hint = document.createElement("small");
	hint.textContent = "Starting desktop";
	const close = document.createElement("button");
	close.type = "button";
	close.className = "screen-viewer-close";
	close.setAttribute("aria-label", "Close screen");
	close.textContent = "×";
	const headingWrap = document.createElement("span");
	headingWrap.className = "screen-viewer-heading";
	headingWrap.append(heading, document.createTextNode("  "), hint);
	titlebar.append(headingWrap, close);
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
	statusCopy.textContent = "Starting desktop";
	const progress = document.createElement("div");
	progress.className = "screen-viewer-progress";
	progress.setAttribute("role", "progressbar");
	progress.setAttribute("aria-label", "Starting desktop");
	progress.appendChild(document.createElement("span"));
	statusContent.append(statusCopy, progress);
	status.appendChild(statusContent);
	stage.append(canvasHost, status);
	frame.append(titlebar, stage);
	overlay.appendChild(frame);
	document.body.appendChild(overlay);

	let closed = false;
	let rfb;
	let sessionLive = false;
	let finishTimer;
	const finish = () => {
		if (closed) return;
		closed = true;
		clearTimeout(finishTimer);
		document.removeEventListener("keydown", onKeydown, true);
		if (sessionLive) {
			sessionLive = false;
			try {
				rfb?.disconnect();
			} catch {
				/* already gone */
			}
		}
		overlay.remove();
		onClosed?.();
	};
	const onKeydown = (event) => {
		// Escape leaves the screen (overlay convention); every other key
		// belongs to the live session.
		if (event.key === "Escape") {
			event.stopPropagation();
			finish();
		}
	};
	close.onclick = finish;
	document.addEventListener("keydown", onKeydown, true);

	const showFailure = (message) => {
		if (closed) return;
		status.hidden = false;
		status.classList.add("is-error");
		statusCopy.textContent = message;
		finishTimer = setTimeout(finish, 1800);
	};
	const connect = (nextUrl) => {
		if (closed || rfb) return false;
		try {
			rfb = new RFB(canvasHost, nextUrl, { shared: true });
			rfb.scaleViewport = true;
			rfb.resizeSession = false;
			rfb.background = "transparent";
			sessionLive = true;
			rfb.addEventListener("connect", () => {
				if (closed) return;
				status.hidden = true;
				hint.textContent = "Live · you can take over at any time";
				rfb.focus();
			});
			rfb.addEventListener("disconnect", (event) => {
				sessionLive = false;
				showFailure(event?.detail?.clean ? "Screen closed" : "Screen connection lost");
			});
			return true;
		} catch (error) {
			showFailure(`Screen viewer failed: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	};
	if (url) connect(url);
	return {
		close: finish,
		connect,
		fail: showFailure,
		get closed() {
			return closed;
		},
	};
}

window.qorperaScreenViewer = { open: openScreenViewer, expandSvg: viewerSvg };
