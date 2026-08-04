/* Renderer chrome. Static by design — everything company-specific arrives
 * from the folder via the backend (surfaces/state/inbox) or the RPC pipe. */
const $ = (id) => document.getElementById(id);
let backendUrl = "";
let state = { surfaces: [], inbox: [] };
let currentSurface = null;
let assistantEl = null;
let thinkingEl = null;
let poller = null;

// ---- hub -------------------------------------------------------------------

async function renderHub() {
	const companies = await window.qorpera.listCompanies();
	const box = $("companies");
	box.innerHTML = companies.length ? "" : '<div class="empty" style="padding:6px">no companies yet</div>';
	for (const company of companies) {
		const b = document.createElement("button");
		b.className = "hubbtn";
		b.textContent = company.name;
		b.title = company.root;
		b.onclick = () => openCompany(company.root, company.name);
		box.appendChild(b);
	}
}

async function newCompanyPrompt() {
	const dir = prompt("Directory for the new company (e.g. C:\\Companies\\my-co):");
	if (!dir) return;
	const root = await window.qorpera.newCompany(dir);
	await openCompany(root, dir.split(/[\\/]/).pop());
}

function backToHub() {
	window.qorpera.closeCompany();
	if (poller) clearInterval(poller);
	$("conav").style.display = "none";
	$("hubnav").style.display = "";
	$("title").firstChild.textContent = "Qorpera Base";
	$("subtitle").textContent = "the foundation";
	$("messages").innerHTML = "";
	show(null);
	renderHub();
}

// ---- company ---------------------------------------------------------------

async function openCompany(root, name) {
	const opened = await window.qorpera.openCompany(root);
	backendUrl = opened.backendUrl;
	$("hubnav").style.display = "none";
	$("conav").style.display = "";
	$("title").firstChild.textContent = name || root;
	$("subtitle").textContent = "Controller — Qorpera Base";
	$("messages").innerHTML = "";
	if (opened.kickoff) {
		addMsg("tool", "· conception started — the controller is studying the company…");
	}
	show("chat");
	await refreshState();
	if (poller) clearInterval(poller);
	poller = setInterval(refreshState, 2000);
}

async function refreshState() {
	try {
		const next = await (await fetch(`${backendUrl}/api/state`)).json();
		if (JSON.stringify(next) !== JSON.stringify(state)) {
			state = next;
			renderCompanyNav();
		}
	} catch {
		/* backend briefly unavailable */
	}
}

function renderCompanyNav() {
	const nav = $("surfaces");
	nav.innerHTML = state.surfaces.length ? "" : '<div class="empty" style="padding:6px">none built yet</div>';
	for (const surface of state.surfaces) {
		const b = document.createElement("button");
		b.textContent = surface.name;
		if (currentSurface === surface.entry) b.className = "active";
		b.onclick = () => showSurface(surface);
		nav.appendChild(b);
	}
	const pending = state.inbox.filter((g) => g.status === "pending").length;
	$("inboxBadge").innerHTML = pending ? `<span class="badge">${pending}</span>` : "";
	if (currentView === "inbox") renderInbox();
}

// ---- views -----------------------------------------------------------------

let currentView = null;
function show(view) {
	currentView = view;
	$("view-chat").style.display = view === "chat" ? "flex" : "none";
	$("view-surface").style.display = view === "surface" ? "block" : "none";
	$("view-panel").style.display = view === "inbox" ? "block" : "none";
	$("chatBtn").className = view === "chat" ? "active" : "";
	$("inboxBtn").className = view === "inbox" ? "active" : "";
	if (view === "inbox") renderInbox();
	if (view !== "surface") currentSurface = null;
	renderCompanyNavSafe();
}
function renderCompanyNavSafe() {
	try {
		renderCompanyNav();
	} catch {
		/* pre-open */
	}
}

function showSurface(surface) {
	currentSurface = surface.entry;
	$("view-surface").src = `${backendUrl}/surface/${encodeURIComponent(surface.entry)}?v=${surface.version}`;
	show("surface");
	currentSurface = surface.entry;
	renderCompanyNavSafe();
}

function renderInbox() {
	const panel = $("view-panel");
	panel.innerHTML = state.inbox.length ? "" : '<div class="empty">Inbox is empty</div>';
	for (const gate of state.inbox) {
		const d = document.createElement("div");
		d.className = "gate";
		d.innerHTML = '<div class="t"></div><div class="s"></div>';
		d.querySelector(".t").textContent = gate.title;
		d.querySelector(".s").textContent = `${gate.file} — status: ${gate.status}`;
		if (gate.status === "pending") {
			for (const [label, action, cls] of [["Approve", "approved", "ok"], ["Deny", "denied", "no"]]) {
				const b = document.createElement("button");
				b.textContent = label;
				b.className = cls;
				b.onclick = async () => {
					await fetch(`${backendUrl}/api/gate`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ file: gate.file, action }),
					});
					await refreshState();
					renderInbox();
				};
				d.appendChild(b);
			}
		}
		panel.appendChild(d);
	}
}

// ---- chat over the RPC pipe --------------------------------------------------

function addMsg(cls, text) {
	const div = document.createElement("div");
	div.className = `msg ${cls}`;
	div.textContent = text;
	$("messages").appendChild(div);
	$("messages").scrollTop = $("messages").scrollHeight;
	return div;
}

function sendPrompt() {
	const input = $("input");
	const text = input.value.trim();
	if (!text) return;
	input.value = "";
	addMsg("user", text);
	window.qorpera.rpcSend({ type: "prompt", message: text });
}

$("input").addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		sendPrompt();
	}
});

/* Markdown for assistant prose. The source is HTML-escaped BEFORE parsing so
 * raw HTML in model output renders as text — formatting without injection. */
function renderMarkdown(el, source) {
	const escaped = source.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	el.innerHTML = window.marked.parse(escaped, { breaks: true });
}

window.qorpera.onRpcEvent((frame) => {
	switch (frame.type) {
		case "message_update": {
			const delta = frame.assistantMessageEvent;
			if (!delta) break;
			if (delta.type === "text_start") {
				assistantEl = addMsg("assistant", "");
				assistantEl.dataset.source = "";
			}
			if (delta.type === "text_delta" && assistantEl) {
				assistantEl.dataset.source += delta.delta;
				renderMarkdown(assistantEl, assistantEl.dataset.source);
				$("messages").scrollTop = $("messages").scrollHeight;
			}
			if (delta.type === "thinking_start") thinkingEl = addMsg("thinking", "");
			if (delta.type === "thinking_delta" && thinkingEl) thinkingEl.textContent += delta.delta;
			if (delta.type === "thinking_end") thinkingEl = null;
			if (delta.type === "text_end") assistantEl = null;
			break;
		}
		case "tool_execution_start":
			addMsg("tool", `▸ ${frame.toolName} ${summarizeArgs(frame.args)}`);
			break;
		case "tool_execution_end": {
			const error = frame.isError ? " ✗" : "";
			addMsg("tool", `✓ ${frame.toolName}${error}`);
			refreshState();
			break;
		}
		case "agent_settled":
			$("status").textContent = "idle";
			refreshState();
			break;
		case "agent_start":
			$("status").textContent = "working…";
			break;
		case "response":
			if (frame.success === false) addMsg("log", `error: ${frame.error ?? frame.command}`);
			break;
		default:
			break;
	}
});
window.qorpera.onRpcLog((line) => {
	$("status").textContent = line.slice(0, 160);
});
window.qorpera.onRpcExit((code) => addMsg("log", `agent exited (${code})`));

function summarizeArgs(args) {
	if (!args) return "";
	if (typeof args.command === "string") return args.command.slice(0, 120);
	if (typeof args.path === "string") return args.path;
	return "";
}

renderHub();
