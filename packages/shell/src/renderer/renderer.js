/* Renderer chrome. Static by design — everything company-specific arrives
 * from the folder via the backend (surfaces/state/inbox) or the RPC pipe. */
const $ = (id) => document.getElementById(id);
let backendUrl = "";
let state = { surfaces: [], inbox: [], sessions: [] };
let currentSurface = null;
let currentSession = null; // trail file of the open chat (null = fresh/unsaved)
let assistantEl = null;
let thinkingEl = null;
let poller = null;
let currentModelKey = "";
let currentEffort = "";

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
	currentSession = null;
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
	hydrateAgentState(false);
	await refreshState();
	if (poller) clearInterval(poller);
	poller = setInterval(refreshState, 2000);
}

// ---- chatbar: model + effort ------------------------------------------------

function fillSelect(el, options, currentValue) {
	el.innerHTML = "";
	for (const option of options) {
		const node = document.createElement("option");
		node.value = option.value;
		node.textContent = option.label;
		if (option.value === currentValue) node.selected = true;
		el.appendChild(node);
	}
}

$("modelSel").addEventListener("change", () => {
	const [provider, modelId] = $("modelSel").value.split("::");
	window.qorpera.rpcSend({ type: "set_model", provider, modelId });
});
$("effortSel").addEventListener("change", () => {
	window.qorpera.rpcSend({ type: "set_thinking_level", level: $("effortSel").value });
});

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

/** After (re)spawning the agent, ask for everything the chatbar needs. */
function hydrateAgentState(withHistory) {
	setTimeout(() => {
		if (withHistory) window.qorpera.rpcSend({ type: "get_messages" });
		window.qorpera.rpcSend({ type: "get_state" });
		window.qorpera.rpcSend({ type: "get_available_models" });
		window.qorpera.rpcSend({ type: "get_available_thinking_levels" });
	}, 900);
}

async function openSession(file) {
	currentSession = file;
	await window.qorpera.openChat(file);
	$("messages").innerHTML = "";
	show("chat");
	renderCompanyNavSafe();
	hydrateAgentState(true);
}

async function newChat() {
	currentSession = null;
	await window.qorpera.openChat(null);
	$("messages").innerHTML = "";
	show("chat");
	renderCompanyNavSafe();
	hydrateAgentState(false);
}

function renderHistory(messages) {
	$("messages").innerHTML = "";
	for (const message of messages ?? []) {
		if (message.role === "user") {
			const text = (message.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n");
			if (text) addMsg("user", text);
		} else if (message.role === "assistant") {
			for (const part of message.content ?? []) {
				if (part.type === "text" && part.text) renderMarkdown(addMsg("assistant", ""), part.text);
				if (part.type === "toolCall") addMsg("tool", `▸ ${part.name} ${summarizeArgs(part.arguments)}`);
			}
		}
	}
	$("messages").scrollTop = $("messages").scrollHeight;
}

function renderCompanyNav() {
	const chats = $("sessions");
	chats.innerHTML = "";
	for (const session of state.sessions ?? []) {
		const b = document.createElement("button");
		b.textContent = session.title;
		b.title = session.file;
		if (currentSession === session.file) b.className = "active";
		b.onclick = () => openSession(session.file);
		chats.appendChild(b);
	}
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
	$("view-panel").style.display = view === "inbox" || view === "activity" ? "block" : "none";
	$("inboxBtn").className = view === "inbox" ? "active" : "";
	$("activityBtn").className = view === "activity" ? "active" : "";
	if (view === "inbox") renderInbox();
	if (view === "activity") renderActivity();
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

/** The controller's work, visible: every trail session, newest first. */
function renderActivity() {
	const panel = $("view-panel");
	const sessions = state.sessions ?? [];
	panel.innerHTML = sessions.length ? "" : '<div class="empty">No sessions recorded yet</div>';
	for (const session of sessions) {
		const d = document.createElement("div");
		d.className = "gate";
		d.innerHTML = '<div class="t"></div><div class="s sess-meta"></div>';
		d.querySelector(".t").textContent = session.title;
		d.querySelector(".s").textContent = `${new Date(session.mtimeMs).toLocaleString()} · ${session.file}`;
		const open = document.createElement("button");
		open.textContent = "Open";
		open.onclick = () => openSession(session.file);
		d.appendChild(open);
		panel.appendChild(d);
	}
}

function renderInbox() {
	const panel = $("view-panel");
	const items = [...state.inbox].sort((a, b) => (a.status === "pending" ? -1 : 1) - (b.status === "pending" ? -1 : 1));
	panel.innerHTML = items.length ? "" : '<div class="empty">Inbox is empty</div>';
	for (const item of items) {
		const d = document.createElement("div");
		d.className = "gate";
		d.innerHTML = '<div class="t"></div><div class="s"></div><div class="body"></div>';
		d.querySelector(".t").textContent = item.title;
		d.querySelector(".s").textContent = `${item.kind} · ${item.file}${item.status ? ` · ${item.status}` : ""}`;

		if (item.kind === "gate" && item.status === "pending") {
			for (const [label, action, cls] of [["Approve", "approved", "ok"], ["Deny", "denied", "no"]]) {
				const b = document.createElement("button");
				b.textContent = label;
				b.className = cls;
				b.onclick = async () => {
					await fetch(`${backendUrl}/api/gate`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ file: item.file, action }),
					});
					await refreshState();
					renderInbox();
				};
				d.appendChild(b);
			}
		}

		if (item.kind === "message" || item.kind === "note") {
			// Controller↔founder item: render the body, offer a reply.
			fetch(`${backendUrl}/api/inbox/${encodeURIComponent(item.file)}`)
				.then((res) => res.text())
				.then((body) => renderMarkdown(d.querySelector(".body"), body.replace(/^---[\s\S]*?---/, "")));
			const reply = document.createElement("textarea");
			reply.placeholder = "Respond to the controller…";
			const sendBtn = document.createElement("button");
			sendBtn.textContent = "Send response";
			sendBtn.className = "ok";
			sendBtn.onclick = async () => {
				if (!reply.value.trim()) return;
				await fetch(`${backendUrl}/api/inbox/respond`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ file: item.file, response: reply.value }),
				});
				await refreshState();
				renderInbox();
			};
			d.appendChild(reply);
			d.appendChild(sendBtn);
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
			if (frame.command === "get_messages" && frame.success) renderHistory(frame.data?.messages ?? frame.data);
			else if (frame.command === "get_available_models" && frame.success) {
				const models = frame.data?.models ?? frame.data ?? [];
				fillSelect(
					$("modelSel"),
					models.map((m) => ({ value: `${m.provider}::${m.id}`, label: `${m.name ?? m.id} (${m.provider})` })),
					currentModelKey,
				);
			} else if (frame.command === "get_available_thinking_levels" && frame.success) {
				const levels = frame.data?.levels ?? [];
				fillSelect(
					$("effortSel"),
					levels.map((level) => ({ value: level, label: `effort: ${level}` })),
					currentEffort,
				);
			} else if (frame.command === "get_state" && frame.success) {
				const model = frame.data?.model;
				if (model?.id) {
					currentModelKey = `${model.provider}::${model.id}`;
					if ($("modelSel").options.length) $("modelSel").value = currentModelKey;
				}
				if (frame.data?.thinkingLevel) {
					currentEffort = frame.data.thinkingLevel;
					if ($("effortSel").options.length) $("effortSel").value = currentEffort;
				}
			} else if (frame.command === "set_model" && frame.success && frame.data?.id) {
				currentModelKey = `${frame.data.provider}::${frame.data.id}`;
			} else if (frame.success === false) addMsg("log", `error: ${frame.error ?? frame.command}`);
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

// ---- foundation updates -----------------------------------------------------

function checkUpdates() {
	$("status").textContent = "checking for updates…";
	window.qorpera.updateCheck();
}
window.qorpera.onUpdateStatus((text) => {
	$("status").textContent = text;
});
window.qorpera.onUpdateReady((version) => {
	for (const id of ["updateBtn", "updateBtnHub"]) {
		const b = $(id);
		if (!b) continue;
		b.textContent = `Restart to update → v${version}`;
		b.onclick = () => window.qorpera.updateInstall();
	}
	$("status").textContent = `v${version} downloaded — restart to apply`;
});
window.qorpera.onOpenCompany((root) => openCompany(root, root.split(/[\\/]/).pop()));

(async () => {
	const info = await window.qorpera.appInfo();
	$("subtitle").textContent = `the foundation · v${info.version}`;
	if (info.pendingCompany) {
		await openCompany(info.pendingCompany, info.pendingCompany.split(/[\\/]/).pop());
	} else {
		await renderHub();
	}
})();
