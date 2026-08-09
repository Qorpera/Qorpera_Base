/* Renderer chrome. Static by design — everything company-specific arrives
 * from the folder via the backend (surfaces/state/inbox) or the RPC pipe. */
const $ = (id) => document.getElementById(id);
let backendUrl = "";
let backendToken = "";
let state = { surfaces: [], inbox: [], sessions: [], departments: [] };
const sessionCache = {}; // session file -> rendered messages HTML
let chatsCollapsed = false;

function authHeaders(extra) {
	return { "x-qorpera-token": backendToken, ...(extra ?? {}) };
}

function toggleChats() {
	chatsCollapsed = !chatsCollapsed;
	$("sessions").style.display = chatsCollapsed ? "none" : "";
	$("chatsCaret").textContent = chatsCollapsed ? "▸" : "▾";
}
let currentSurface = null;
let currentSession = null; // trail file of the open chat (null = fresh/unsaved)
let currentDepartment = null; // product department of the open chat (null = company controller)
let currentWorktree = null; // kernel-assigned product worktree, when applicable
let currentDepartmentPage = null; // { path, tab } for built-in department pages
let sidechatOpen = false; // the surface view's docked chat panel
let sidechatSurface = null; // surface entry the live session is attached to
let sidechatPending = null; // surface awaiting its context preamble (fresh session)
let assistantEl = null;
let thinkingEl = null;
let poller = null;
let currentModelKey = "";
let currentEffort = "";
let currentSpeed = "standard";
let speedAsserted = false; // one re-assert of the remembered speed per child spawn

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
		b.onclick = () => openCompany(company.root);
		box.appendChild(b);
	}
}

async function newCompanyPrompt() {
	const dir = prompt("Directory for the new company (e.g. C:\\Companies\\my-co):");
	if (!dir) return;
	const root = await window.qorpera.newCompany(dir);
	await openCompany(root);
}

async function integrateCompanyPrompt() {
	const dir = prompt("Directory for the new company (e.g. C:\\Companies\\my-co):");
	if (!dir) return;
	const from = prompt("Existing repo to integrate (path or git URL):");
	if (!from) return;
	const result = await window.qorpera.integrateCompany(dir, from);
	if (!result.ok) {
		alert("Could not clone the repo — check the path/URL. The company folder and product department were created.");
	}
	await openCompany(result.root);
}

// ---- company ---------------------------------------------------------------

async function openCompany(root) {
	// The kernel forks/loads the company's own userland and reloads this
	// window into it; this page's job ends here.
	await window.qorpera.openCompany(root);
}

/** Boot into an already-open company (called after the kernel loads us). */
async function enterCompany(active) {
	backendUrl = active.backendUrl;
	backendToken = active.backendToken ?? "";
	$("hubnav").style.display = "none";
	$("conav").style.display = "";
	$("messages").innerHTML = "";
	resetWorkGroup();
	if (active.usingBaseFallback) {
		addMsg("log", "your evolved app failed to load — running the base chrome (kernel fallback)");
	}
	if (active.kickoff) {
		addMsg("tool", "· conception started — the controller is studying the company…");
	}
	if (active.mergePrompt) {
		// The merge runs as a kernel-spawned autonomous session — clicking
		// never sends into the founder's chat, and a second click while one
		// is running is refused by the kernel.
		const b = document.createElement("button");
		b.id = "mergeBtn";
		const staged = active.userland.stagedVersion;
		const markRunning = () => {
			b.textContent = `Merging app update v${staged}…`;
			b.disabled = true;
			$("status").textContent = "userland merge running as an autonomous session…";
		};
		b.textContent = `Merge app update → v${staged}`;
		b.onclick = async () => {
			const result = await window.qorpera.mergeUserland();
			if (result?.ok || result?.reason === "already-running") markRunning();
		};
		if (active.mergeRunning) markRunning();
		$("conav").insertBefore(b, $("conav").firstChild);
	}
	show("chat");
	// With history: the chat child survives window reloads (dev-lane rebuilds
	// reload the chrome), so the live thread must come back with it. A fresh
	// child answers with an empty history — harmless.
	hydrateAgentState(true);
	await refreshState();
	document.title = `${state.name || "Company"} Controller`;
	$("wordmark").textContent = document.title;
	if (poller) clearInterval(poller);
	poller = setInterval(refreshState, 2000);
}

// ---- composer chips: model + effort ------------------------------------------
// Custom menus, not <select>: the native popup ignores page styling entirely
// and renders unreadable in the dark theme.

/** The one chip menu allowed open at a time (closing it is idempotent). */
let openChipMenu = null;

function closeOpenChipMenu() {
	if (!openChipMenu) return;
	openChipMenu.menu.classList.remove("open");
	openChipMenu.button.setAttribute("aria-expanded", "false");
	openChipMenu = null;
}
document.addEventListener("click", (event) => {
	if (openChipMenu && !openChipMenu.menu.contains(event.target) && !openChipMenu.button.contains(event.target)) {
		closeOpenChipMenu();
	}
});
document.addEventListener("keydown", (event) => {
	if (event.key === "Escape") closeOpenChipMenu();
});
window.addEventListener("resize", closeOpenChipMenu);

function createChipSelect(buttonId, menuId, onPick) {
	const button = $(buttonId);
	const menu = $(menuId);
	// The menu must escape the composer shell (overflow:hidden + backdrop
	// filter clip and distort it there) — it lives on <body> in a fixed layer.
	document.body.appendChild(menu);
	let value = "";
	let options = [];
	// Options may carry an `icon` (trusted chrome-authored SVG markup); labels
	// are always text nodes — company/product names never parse as HTML.
	const fillOption = (el, option) => {
		el.textContent = "";
		if (option?.icon) el.insertAdjacentHTML("afterbegin", option.icon);
		el.appendChild(document.createTextNode(option ? option.label : "…"));
	};
	const renderLabel = () => {
		fillOption(button, options.find((o) => o.value === value));
	};
	const open = () => {
		closeOpenChipMenu();
		menu.innerHTML = "";
		for (const option of options) {
			const item = document.createElement("button");
			item.className = option.value === value ? "selected" : "";
			fillOption(item, option);
			item.onclick = () => {
				value = option.value;
				renderLabel();
				closeOpenChipMenu();
				onPick(option.value);
			};
			menu.appendChild(item);
		}
		// Anchor above the button, right-aligned, clamped to the viewport.
		const rect = button.getBoundingClientRect();
		menu.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
		menu.style.bottom = `${window.innerHeight - rect.top + 8}px`;
		menu.classList.add("open");
		button.setAttribute("aria-expanded", "true");
		openChipMenu = { menu, button };
	};
	button.onclick = () => {
		// The document listener sees this click too and closes anything open;
		// toggling means: open unless THIS menu was the one just closed.
		if (menu.classList.contains("open")) closeOpenChipMenu();
		else open();
	};
	return {
		setOptions(list, current) {
			options = list;
			if (current !== undefined && current !== "") value = current;
			renderLabel();
		},
		get value() {
			return value;
		},
		set value(next) {
			value = next;
			renderLabel();
		},
	};
}

// ---- the model control: effort slider + model dropdown + speed toggle -------
// One panel in the Desktop style. The slider drives set_thinking_level live,
// the dropdown drives set_model, and the speed toggle drives
// set_response_speed — enabled exactly when the active model's API has a
// priority lane (openai-codex-responses today), disabled with a note
// otherwise.
const modelCtl = (() => {
	const button = $("modelCtlBtn");
	const menu = $("modelCtlMenu");
	// Same escape hatch as the chip menus: the composer shell would clip it.
	document.body.appendChild(menu);
	const slider = $("mcEffort");
	const drop = $("mcModelDrop");
	const modelLabel = $("mcModelLabel");
	const list = $("mcModelList");
	const speed = $("mcSpeed");
	let models = []; // { value: "provider::id", name, fastCapable }
	let levels = [];
	// The catalog barely changes between sessions (it moves when the founder
	// connects or drops a provider), so the picker paints instantly from the
	// last run's cache and the live child corrects it in the background —
	// best-effort per machine, never a source of truth.
	const CACHE_KEY = "qorpera.modelCatalog";
	try {
		const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null");
		if (Array.isArray(cached?.models) && cached.models.length) models = cached.models;
		if (Array.isArray(cached?.levels) && cached.levels.length) levels = cached.levels;
		if (!currentModelKey && typeof cached?.modelKey === "string") currentModelKey = cached.modelKey;
		if (!currentEffort && typeof cached?.effort === "string") currentEffort = cached.effort;
		if (cached?.speed === "fast" || cached?.speed === "standard") currentSpeed = cached.speed;
	} catch {
		// unreadable cache: start empty, the live child fills it in
	}
	const persist = () => {
		try {
			localStorage.setItem(
				CACHE_KEY,
				JSON.stringify({ models, levels, modelKey: currentModelKey, effort: currentEffort, speed: currentSpeed }),
			);
		} catch {
			// storage unavailable — the cache is a nicety, never load-bearing
		}
	};
	const EFFORT_LABELS = { off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra High" };
	const effortLabel = (level) => EFFORT_LABELS[level] ?? level;
	const currentModel = () => models.find((m) => m.value === currentModelKey);
	const fastOn = () => Boolean(currentModel()?.fastCapable) && currentSpeed === "fast";
	// The chip reads "⚡ <Model> <Effort>" — bolt only while fast, effort in
	// the accent tone (the Desktop trigger). Built from DOM nodes, never HTML.
	const renderChip = () => {
		button.textContent = "";
		if (fastOn()) {
			button.insertAdjacentHTML(
				"afterbegin",
				'<svg class="mc-chipbolt" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 2 3.5 14H10l-1 8L18.5 10H12l1-8z"/></svg>',
			);
		}
		button.appendChild(document.createTextNode(currentModel()?.name ?? "model"));
		if (currentEffort) {
			const eff = document.createElement("span");
			eff.className = "mc-eff";
			eff.textContent = effortLabel(currentEffort);
			button.appendChild(eff);
		}
	};
	// The track is painted by hand: accent fill up to the knob, a faint dot
	// per stop (the Desktop look — accent-color can't draw ticks).
	const paintTrack = () => {
		const max = Math.max(Number(slider.max), 1);
		const fill = (Number(slider.value) / max) * 100;
		const layers = [];
		for (let i = 0; i <= max; i++) {
			const at = 4 + (i / max) * 92;
			layers.push(`radial-gradient(circle at ${at}% 50%, rgba(255, 255, 255, 0.35) 2px, transparent 2.5px)`);
		}
		layers.push(`linear-gradient(to right, var(--primary) ${fill}%, rgba(255, 255, 255, 0.1) ${fill}%)`);
		slider.style.setProperty("--mc-track", layers.join(", "));
	};
	const sync = () => {
		persist();
		renderChip();
		slider.max = String(Math.max(levels.length - 1, 0));
		const index = levels.indexOf(currentEffort);
		if (index >= 0) slider.value = String(index);
		slider.title = currentEffort ? `Effort: ${effortLabel(currentEffort)}` : "Effort";
		paintTrack();
		modelLabel.textContent = currentModel()?.name ?? "…";
		const fastCapable = Boolean(currentModel()?.fastCapable);
		speed.disabled = !fastCapable;
		speed.setAttribute("aria-checked", fastOn() ? "true" : "false");
		speed.title = fastCapable
			? fastOn()
				? "Fast responses on (priority lane)"
				: "Fast responses"
			: "This model's API has no priority lane — fast responses ride OpenAI subscription models";
		list.innerHTML = "";
		for (const model of models) {
			const item = document.createElement("button");
			item.type = "button";
			item.className = model.value === currentModelKey ? "selected" : "";
			item.textContent = model.name;
			item.onclick = () => {
				currentModelKey = model.value;
				const [provider, modelId] = model.value.split("::");
				window.qorpera.rpcSend({ type: "set_model", provider, modelId });
				list.classList.remove("open");
				sync();
			};
			list.appendChild(item);
		}
	};
	slider.oninput = () => {
		const level = levels[Number(slider.value)];
		if (!level) return;
		currentEffort = level;
		slider.title = `Effort: ${effortLabel(level)}`;
		renderChip();
		paintTrack();
		window.qorpera.rpcSend({ type: "set_thinking_level", level });
	};
	speed.onclick = () => {
		if (speed.disabled) return;
		currentSpeed = currentSpeed === "fast" ? "standard" : "fast";
		window.qorpera.rpcSend({ type: "set_response_speed", speed: currentSpeed });
		sync();
	};
	// An empty list is a dark sliver, not a menu — don't open until models exist.
	drop.onclick = () => {
		if (models.length) list.classList.toggle("open");
	};
	button.onclick = () => {
		if (menu.classList.contains("open")) {
			closeOpenChipMenu();
			return;
		}
		closeOpenChipMenu();
		sync();
		list.classList.remove("open");
		const rect = button.getBoundingClientRect();
		menu.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
		menu.style.bottom = `${window.innerHeight - rect.top + 8}px`;
		menu.classList.add("open");
		button.setAttribute("aria-expanded", "true");
		openChipMenu = { menu, button };
	};
	return {
		setModels(next) {
			models = next;
			sync();
		},
		setLevels(next) {
			levels = next;
			sync();
		},
		sync,
	};
})();
// First paint from the cache — the live child's answers replace it within
// moments of the spawn.
modelCtl.sync();

// ---- company controller vs product-worker (the role selector) ---------------

function departmentName(path) {
	const parts = String(path).replace(/\\/g, "/").split("/").filter(Boolean);
	return (parts[parts.length - 1] || String(path)).replace(/-development$/, "");
}

// A company controller and a product-worker are different organizational roles.
const COMPANY_ICON =
	'<svg class="chipicon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 21h18M5 21V5.5L12 3l7 2.5V21M9.5 9h.01M14.5 9h.01M9.5 13h.01M14.5 13h.01M10 21v-3.5h4V21"/></svg>';
const PRODUCT_ICON =
	'<svg class="chipicon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8.2v7.6l-9 4.7-9-4.7V8.2L12 3.5l9 4.7Z"/><path d="M3.3 8.2 12 12.7l8.7-4.5M12 12.7V20"/></svg>';

function syncScopeChrome() {
	// The company entry names the controller — same identity as the window
	// title ("<Name> Controller"), distinct from the bare product names below.
	const options = [{ value: "", label: state.name ? `${state.name} Controller` : "Company", icon: COMPANY_ICON }];
	for (const department of state.departments ?? []) {
		if (!department.repositoryExists) continue;
		options.push({ value: department.path, label: `${department.name} Development`, icon: PRODUCT_ICON });
	}
	scopeChip.setOptions(options, currentDepartment ?? "");
	scopeChip.value = currentDepartment ?? "";
	// A docked sidechat speaks about its surface; otherwise the scope names
	// what the session steers.
	const sidechatOwner =
		sidechatOpen && sidechatSurface ? (state.surfaces ?? []).find((s) => s.entry === sidechatSurface) : undefined;
	$("input").placeholder = sidechatOwner
		? `Ask about ${sidechatOwner.name}… (Enter to send, Shift+Enter for newline)`
		: currentDepartment
			? `Work on ${departmentName(currentDepartment)}… (Enter to send, Shift+Enter for newline)`
			: "Steer the company… (Enter to send, Shift+Enter for newline)";
}

const scopeChip = createChipSelect("scopeBtn", "scopeMenu", async (picked) => {
	const next = picked || null;
	if (next === currentDepartment) return;
	cacheCurrentSession();
	const result = await window.qorpera.openChat(null, next ?? undefined);
	if (!result?.ok) {
		scopeChip.value = currentDepartment ?? "";
		return;
	}
	currentSession = null;
	currentDepartment = result.department ?? null;
	currentWorktree = result.worktree ?? null;
	currentDepartmentPage = null;
	sidechatSurface = null;
	sidechatPending = null;
	$("messages").innerHTML = "";
	resetWorkGroup();
	show("chat");
	syncScopeChrome();
	renderCompanyNavSafe();
	hydrateAgentState(false);
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

/** After (re)spawning the agent, ask for everything the chatbar needs.
 * Immediately — the child's stdin is buffered, so it answers the moment it
 * boots — and once more after startup as a belt for dropped early input
 * (history is only asked once; a double render would flash). */
function hydrateAgentState(withHistory) {
	speedAsserted = false;
	if (withHistory) window.qorpera.rpcSend({ type: "get_messages" });
	const askState = () => {
		window.qorpera.rpcSend({ type: "get_state" });
		window.qorpera.rpcSend({ type: "get_available_models" });
		window.qorpera.rpcSend({ type: "get_available_thinking_levels" });
	};
	askState();
	setTimeout(askState, 900);
}

function cacheCurrentSession() {
	if (currentSession) sessionCache[currentSession] = $("messages").innerHTML;
}

async function openSession(file) {
	cacheCurrentSession();
	// Product chats restore the exact department/worktree role capability
	// recorded in their append-only session name.
	const summary = (state.sessions ?? []).find((s) => s.file === file);
	const result = await window.qorpera.openChat(file, summary?.department, summary?.worktree);
	if (!result?.ok) return;
	currentSession = file;
	currentDepartment = result.department ?? null;
	currentWorktree = result.worktree ?? null;
	currentDepartmentPage = null;
	sidechatSurface = null;
	sidechatPending = null;
	// Cached pages show instantly; fresh ones get a proper loading state.
	// Either way the live child re-hydrates and replaces once ready.
	$("messages").innerHTML = sessionCache[file] ?? '<div class="loading">loading session…</div>';
	resetWorkGroup();
	show("chat");
	syncScopeChrome();
	renderCompanyNavSafe();
	hydrateAgentState(true);
}

async function newChat() {
	cacheCurrentSession();
	// "+" keeps an existing product worktree. The department Chat row starts
	// a separate task in a fresh worktree.
	const result = await window.qorpera.openChat(
		null,
		currentDepartment ?? undefined,
		currentWorktree ?? undefined,
	);
	if (!result?.ok) return;
	currentSession = null;
	currentDepartment = result.department ?? null;
	currentWorktree = result.worktree ?? null;
	currentDepartmentPage = null;
	sidechatSurface = null;
	sidechatPending = null;
	$("messages").innerHTML = "";
	resetWorkGroup();
	show("chat");
	syncScopeChrome();
	renderCompanyNavSafe();
	hydrateAgentState(false);
}

function renderHistory(messages) {
	$("messages").innerHTML = "";
	resetWorkGroup();
	// Consecutive tool calls fold into one collapsed "Worked" group, same as
	// live streaming does (durations aren't recorded, so the label is count-only).
	let group = null;
	const groupLine = (text) => {
		if (!group) {
			group = makeWorkGroup(false);
			$("messages").appendChild(group.el);
		}
		group.steps += 1;
		group.summary.textContent = `Worked · ${group.steps} step${group.steps === 1 ? "" : "s"}`;
		const div = document.createElement("div");
		div.className = "msg tool";
		div.textContent = text;
		group.body.appendChild(div);
	};
	for (const message of messages ?? []) {
		if (message.role === "user") {
			const parts = message.content ?? [];
			const raw = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
			// The sidechat context preamble is plumbing, not something the
			// founder typed — show the message as they wrote it.
			const text = raw.replace(/^\[Sidechat context:[^\]]*\]\s*/, "");
			const imageUrls = parts
				.filter((p) => p.type === "image" && p.data)
				.map((p) => `data:${p.mimeType};base64,${p.data}`);
			if (text || imageUrls.length) {
				group = null;
				appendMsgImages(addMsg("user", text), imageUrls);
			}
		} else if (message.role === "assistant") {
			for (const part of message.content ?? []) {
				if (part.type === "text" && part.text) {
					group = null;
					renderMarkdown(addMsg("assistant", ""), part.text);
				}
				if (part.type === "toolCall") groupLine(`✓ ${part.name} ${summarizeArgs(part.arguments)}`);
			}
		}
	}
	$("messages").scrollTop = $("messages").scrollHeight;
}

function renderCompanyNav() {
	const chats = $("sessions");
	chats.innerHTML = "";
	// Chats = work the founder brings; autonomous sessions live in Activity.
	for (const session of (state.sessions ?? []).filter((s) => s.kind !== "autonomous")) {
		const b = document.createElement("button");
		b.textContent = session.title;
		b.title = session.department ? `${session.file} · ${session.department} · ${session.worktree}` : session.file;
		if (session.department || session.scope) {
			const tag = document.createElement("span");
			tag.className = "scopetag";
			const department = (state.departments ?? []).find((entry) => entry.path === session.department);
			tag.textContent = department?.name ?? departmentName(session.department ?? session.scope);
			b.appendChild(tag);
		}
		if (session.surface) {
			// Sidechat sessions name the surface they were docked to.
			const tag = document.createElement("span");
			tag.className = "surfacetag";
			const owner = (state.surfaces ?? []).find((s) => s.entry === session.surface);
			tag.textContent = owner?.name ?? session.surface;
			b.title = `${session.file} · sidechat on ${owner?.name ?? session.surface}`;
			b.appendChild(tag);
		}
		if (currentSession === session.file) b.className = "active";
		b.onclick = () => openSession(session.file);
		chats.appendChild(b);
	}
	const departments = $("departments");
	departments.innerHTML = state.departments?.length
		? ""
		: '<div class="empty" style="padding:6px">none built yet</div>';
	for (const department of state.departments ?? []) {
		const group = document.createElement("div");
		group.className = "department-group";
		const title = document.createElement("div");
		title.className = "department-title";
		title.textContent = `${department.name} Development`;
		group.appendChild(title);
		for (const [tab, label] of [
			["chat", "Chat"],
			["pull-requests", "Pull Requests"],
			["architecture", "Architecture"],
		]) {
			const row = document.createElement("button");
			row.textContent = label;
			if (tab === "architecture") {
				row.disabled = true;
				row.title = "Placeholder — the architecture model will be defined later";
			} else if (tab === "chat") {
				row.disabled = !department.repositoryExists;
				row.title = department.repositoryExists
					? "Start a product-worker in a fresh worktree"
					: "Connect the product repository before starting product work";
				row.onclick = () => openDepartmentChat(department);
			} else {
				row.classList.toggle(
					"active",
					currentDepartmentPage?.path === department.path && currentDepartmentPage?.tab === tab,
				);
				row.onclick = () => showPullRequests(department);
			}
			group.appendChild(row);
		}
		departments.appendChild(group);
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
	syncScopeChrome();
	const pending = state.inbox.filter((g) => g.status === "pending").length;
	$("inboxBadge").innerHTML = pending ? `<span class="badge">${pending}</span>` : "";
	if (currentView === "inbox") renderInbox();
}

async function openDepartmentChat(department) {
	cacheCurrentSession();
	const result = await window.qorpera.openChat(null, department.path);
	if (!result?.ok) {
		$("status").textContent = result?.error ?? "could not start product worktree";
		return;
	}
	currentSession = null;
	currentDepartment = result.department ?? null;
	currentWorktree = result.worktree ?? null;
	currentDepartmentPage = null;
	sidechatSurface = null;
	sidechatPending = null;
	$("messages").innerHTML = "";
	resetWorkGroup();
	show("chat");
	syncScopeChrome();
	hydrateAgentState(false);
}

function showPullRequests(department) {
	currentDepartmentPage = { path: department.path, tab: "pull-requests" };
	const panel = $("view-panel");
	panel.innerHTML = "";
	const heading = document.createElement("h1");
	heading.textContent = `${department.name} · Pull Requests`;
	panel.appendChild(heading);
	const records = department.pullRequests ?? [];
	if (!records.length) {
		const empty = document.createElement("div");
		empty.className = "empty";
		empty.textContent = "No synchronized pull-request records yet.";
		panel.appendChild(empty);
	} else {
		for (const record of records) {
			const card = document.createElement("div");
			card.className = "card";
			const head = document.createElement("div");
			head.className = "card-head";
			const title = document.createElement(record.url ? "a" : "div");
			title.className = "card-title";
			title.textContent = `${record.number ? `#${record.number} ` : ""}${record.title}`;
			if (record.url) {
				title.href = record.url;
				title.target = "_blank";
				title.rel = "noreferrer";
			}
			const status = document.createElement("span");
			status.className = "kchip";
			status.textContent = record.status;
			head.appendChild(title);
			head.appendChild(status);
			card.appendChild(head);
			const meta = document.createElement("div");
			meta.className = "card-meta";
			meta.textContent = [record.branch, record.updatedAt, record.file].filter(Boolean).join(" · ");
			card.appendChild(meta);
			panel.appendChild(card);
		}
	}
	show("department");
}

// ---- views -----------------------------------------------------------------

let currentView = null;

/** The one chat machinery (#view-chat: thread + composer) lives either in
 * <main> (the full Chat view) or inside the surface view's dock. Moving the
 * DOM node keeps streaming, work groups, and the chips working unchanged. */
function dockChat(docked) {
	const chat = $("view-chat");
	if (docked && chat.parentElement !== $("sidechat")) $("sidechat").appendChild(chat);
	else if (!docked && chat.parentElement === $("sidechat")) {
		document.querySelector("main").insertBefore(chat, $("view-surfacewrap"));
	}
}

function show(view) {
	currentView = view;
	const docked = view === "surface" && sidechatOpen;
	dockChat(docked);
	$("view-chat").style.display = view === "chat" || docked ? "flex" : "none";
	$("view-surfacewrap").style.display = view === "surface" ? "flex" : "none";
	$("view-surfacewrap").classList.toggle("chat-open", sidechatOpen);
	$("view-panel").style.display = view === "inbox" || view === "activity" || view === "department" ? "block" : "none";
	$("inboxBtn").className = view === "inbox" ? "active" : "";
	$("activityBtn").className = view === "activity" ? "active" : "";
	if (view === "inbox") renderInbox();
	if (view === "activity") renderActivity();
	if (view !== "department") currentDepartmentPage = null;
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
	// An open sidechat follows the surface: switching surfaces re-attaches the
	// dock to the new surface's conversation.
	if (sidechatOpen && sidechatSurface !== surface.entry) void attachSidechat(surface);
	$("sidechat-title").textContent = `Chat — ${surface.name}`;
	show("surface");
	renderCompanyNavSafe();
}

// ---- the sidechat: a session docked to the surface the founder is viewing ----
// Universal by construction: the chrome renders it for every surface, present
// and future. The session is tagged `surface — <entry>` in the trail (the
// scope convention's sibling) so surface-anchored conversations stay minable,
// and a fresh one opens with a context preamble naming what the founder sees.

function surfaceSessions(entry) {
	// state.sessions arrive newest-first from the backend.
	return (state.sessions ?? []).filter((s) => s.kind !== "autonomous" && s.surface === entry);
}

/** Attach the dock to this surface: resume its latest tagged session, or
 * (fresh = true, or none yet) open a new one tagged to it. */
async function attachSidechat(surface, fresh) {
	const latest = fresh ? undefined : surfaceSessions(surface.entry)[0];
	cacheCurrentSession();
	const result = await window.qorpera.openChat(latest ? latest.file : null);
	if (!result?.ok) return;
	currentSession = latest ? latest.file : null;
	currentDepartment = null;
	currentWorktree = null;
	currentDepartmentPage = null;
	sidechatSurface = surface.entry;
	sidechatPending = null;
	if (latest) {
		$("messages").innerHTML = sessionCache[latest.file] ?? '<div class="loading">loading session…</div>';
	} else {
		$("messages").innerHTML = "";
		// Tag the trail session with its surface NOW, before any prompt — the
		// append-only trail can't be retro-tagged.
		window.qorpera.rpcSend({ type: "set_session_name", name: `surface — ${surface.entry}` });
		sidechatPending = surface;
	}
	resetWorkGroup();
	syncScopeChrome();
	renderCompanyNavSafe();
	hydrateAgentState(Boolean(latest));
}

function toggleSidechat(open) {
	sidechatOpen = open;
	const surface = (state.surfaces ?? []).find((s) => s.entry === currentSurface);
	if (open && surface && sidechatSurface !== surface.entry) void attachSidechat(surface);
	if (surface) $("sidechat-title").textContent = `Chat — ${surface.name}`;
	show("surface");
}

function newSidechat() {
	const surface = (state.surfaces ?? []).find((s) => s.entry === currentSurface);
	if (!surface) return;
	void attachSidechat(surface, true).then(() => {
		// A fresh chat over an already-empty thread looks like a no-op —
		// say what happened and put the cursor where the founder types next.
		$("status").textContent = `new chat on ${surface.name} — earlier conversations stay under Chats`;
		$("input").focus();
	});
}

/** The controller's own work: autonomous sessions only (chats live in the nav). */
async function renderActivity() {
	const panel = $("view-panel");
	const sessions = (state.sessions ?? []).filter((s) => s.kind === "autonomous");
	// Resuming a session that a live kernel-spawned child (the merge) is
	// still writing would put two writers on one trail file — hold Open
	// until it finishes.
	let mergeRunning = false;
	try {
		mergeRunning = Boolean((await window.qorpera.appInfo())?.activeCompany?.mergeRunning);
	} catch {
		// bridge unavailable mid-reload: leave Open enabled
	}
	panel.innerHTML = sessions.length
		? ""
		: '<div class="empty">No autonomous controller sessions yet — conception, routines, and merges will appear here.</div>';
	for (const session of sessions) {
		const d = document.createElement("div");
		d.className = "gate";
		d.innerHTML = '<div class="t"></div><div class="s sess-meta"></div>';
		d.querySelector(".t").textContent = session.title;
		d.querySelector(".s").textContent = `${new Date(session.mtimeMs).toLocaleString()} · ${session.file}`;
		const open = document.createElement("button");
		open.textContent = mergeRunning ? "Running…" : "Open";
		open.disabled = mergeRunning;
		if (mergeRunning) open.title = "An autonomous merge session is running — resume is held so two agents never write one trail file.";
		open.onclick = () => openSession(session.file);
		d.appendChild(open);
		panel.appendChild(d);
	}
}

// ---- inbox: decisions, questions, notifications ------------------------------
// A gate is a DECISION (Approve/Deny, the exact action shown up front). A
// message is a QUESTION or a NOTIFICATION — the founder can always Respond,
// but a change that only needed telling is one click to Settle. Bodies are
// clamped to a preview; Details expands.

const inboxBodyCache = {}; // file -> raw markdown (refetched when status changes)

function timeAgo(ms) {
	if (!ms) return "";
	const minutes = Math.round((Date.now() - ms) / 60000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
	return `${Math.round(minutes / 1440)}d ago`;
}

function inboxAction(label, cls, handler) {
	const b = document.createElement("button");
	b.textContent = label;
	b.className = cls;
	b.onclick = handler;
	return b;
}

async function inboxBody(item) {
	const key = `${item.file}::${item.status}::${item.mtimeMs ?? 0}`;
	if (inboxBodyCache[key] !== undefined) return inboxBodyCache[key];
	const res = await fetch(`${backendUrl}/api/inbox/${encodeURIComponent(item.file)}`);
	const body = await res.text();
	inboxBodyCache[key] = body;
	return body;
}

function renderInboxCard(item, settled) {
	const card = document.createElement("div");
	card.className = settled ? "card settled" : "card";

	const head = document.createElement("div");
	head.className = "card-head";
	const titles = document.createElement("div");
	titles.style.flex = "1";
	titles.style.minWidth = "0";
	const title = document.createElement("div");
	title.className = "card-title";
	title.textContent = item.title;
	const meta = document.createElement("div");
	meta.className = "card-meta";
	const dot =
		item.status === "pending"
			? '<span class="dot-pending">●</span> needs you'
			: item.status
				? `<span class="${item.status === "denied" ? "dot-denied" : "dot-ok"}">●</span> ${item.status}`
				: "note";
	// Mechanics live here, not in the title: tool + effect class for gates.
	const tech = item.kind === "gate" && item.gateTool ? ` · ${item.gateTool}${item.gateClass ? ` (${item.gateClass})` : ""}` : "";
	meta.innerHTML = `${dot} · ${timeAgo(item.mtimeMs)}${tech} · ${item.file}`;
	titles.appendChild(title);
	titles.appendChild(meta);
	const kind = document.createElement("span");
	kind.className = item.kind === "gate" ? "kchip gate" : "kchip";
	kind.textContent = item.kind === "gate" ? "gate" : item.kind;
	head.appendChild(titles);
	head.appendChild(kind);
	card.appendChild(head);

	// Gate with agent-supplied intent: the OUTCOME is the headline; the
	// mechanical command stays inspectable behind Details.
	if (item.intent) {
		const intent = document.createElement("div");
		intent.className = "card-intent";
		intent.textContent = item.intent;
		card.appendChild(intent);
	}

	const what = document.createElement("div"); // gate: the action itself
	what.className = "card-what";
	what.style.display = "none";
	card.appendChild(what);

	const body = document.createElement("div");
	body.className = "card-body";
	card.appendChild(body);

	const actions = document.createElement("div");
	actions.className = "card-actions";
	card.appendChild(actions);

	const finish = async () => {
		await refreshState();
		renderInbox();
	};

	if (item.kind === "gate" && item.status === "pending") {
		actions.appendChild(
			inboxAction("Approve", "ok", async () => {
				await fetch(`${backendUrl}/api/gate`, {
					method: "POST",
					headers: authHeaders({ "content-type": "application/json" }),
					body: JSON.stringify({ file: item.file, action: "approved" }),
				});
				await finish();
			}),
		);
		actions.appendChild(
			inboxAction("Deny", "no", async () => {
				await fetch(`${backendUrl}/api/gate`, {
					method: "POST",
					headers: authHeaders({ "content-type": "application/json" }),
					body: JSON.stringify({ file: item.file, action: "denied" }),
				});
				await finish();
			}),
		);
	}

	if (item.kind === "message" && item.status === "pending") {
		// Settle: acknowledged, nothing to add — the controller reads the
		// acknowledgement next wake, same lane as a written response.
		actions.appendChild(
			inboxAction("Settle", "ok", async () => {
				await fetch(`${backendUrl}/api/inbox/respond`, {
					method: "POST",
					headers: authHeaders({ "content-type": "application/json" }),
					body: JSON.stringify({ file: item.file, response: "Acknowledged — settled from the inbox." }),
				});
				await finish();
			}),
		);
		const reply = document.createElement("div");
		reply.className = "card-reply";
		reply.style.display = "none";
		const text = document.createElement("textarea");
		text.placeholder = "Respond to the controller…";
		reply.appendChild(text);
		reply.appendChild(
			inboxAction("Send response", "ok", async () => {
				if (!text.value.trim()) return;
				await fetch(`${backendUrl}/api/inbox/respond`, {
					method: "POST",
					headers: authHeaders({ "content-type": "application/json" }),
					body: JSON.stringify({ file: item.file, response: text.value }),
				});
				await finish();
			}),
		);
		actions.appendChild(
			inboxAction("Respond…", "ghost", () => {
				reply.style.display = reply.style.display === "none" ? "" : "none";
				if (reply.style.display === "") text.focus();
			}),
		);
		card.insertBefore(reply, actions);
	}

	// Body: gates lead with the exact action; everything else gets a clamped
	// preview with Details. Fetched once per file+status.
	void inboxBody(item).then((raw) => {
		let substance = raw.replace(/^---[\s\S]*?---/, "").replace(/^\s*# .*$/m, "");
		if (item.kind === "gate") {
			const action = substance.match(/\*\*What:\*\*\s*(?:run\s*)?(.+)$/m)?.[1];
			substance = substance.replace(/To resolve, edit[\s\S]*$/, "");
			if (action && !item.intent) {
				// No intent supplied (older agents): the command is the headline.
				what.textContent = action.replace(/^`|`$/g, "");
				what.style.display = "";
				substance = substance.replace(/^\*\*What:\*\*.*$/m, "");
			}
		}
		renderMarkdown(body, substance.trim());
		// Fully hidden detail: settled cards, and gates that lead with intent
		// (their body is the technical record). Otherwise clamp long bodies.
		const hiddenDetail = settled || (item.kind === "gate" && Boolean(item.intent));
		if (hiddenDetail) {
			body.style.display = "none";
			const toggle = inboxAction("Details", "ghost", () => {
				const hidden = body.style.display === "none";
				body.style.display = hidden ? "" : "none";
				toggle.textContent = hidden ? "Hide" : "Details";
			});
			actions.appendChild(toggle);
		} else if (body.scrollHeight > 140) {
			body.classList.add("clamped");
			const toggle = inboxAction("Details ▾", "ghost", () => {
				const clamped = body.classList.toggle("clamped");
				toggle.textContent = clamped ? "Details ▾" : "Hide ▴";
			});
			actions.appendChild(toggle);
		}
	});

	return card;
}

function renderInbox() {
	const panel = $("view-panel");
	// Never stomp the founder's work: the 2s poll re-renders on any state
	// change (trail mtimes tick constantly while agents work), which would
	// destroy a reply mid-typing or collapse an expansion they're reading.
	if (panel.contains(document.activeElement) && document.activeElement.tagName === "TEXTAREA") return;
	if ([...panel.querySelectorAll("textarea")].some((t) => t.value.trim())) return;
	panel.innerHTML = "<h1>Inbox</h1>";
	if (!state.inbox.length) {
		panel.insertAdjacentHTML("beforeend", '<div class="empty">Inbox is empty</div>');
		return;
	}
	const newestFirst = (a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0);
	const needsYou = state.inbox.filter((i) => i.status === "pending").sort(newestFirst);
	const rest = state.inbox.filter((i) => i.status !== "pending").sort(newestFirst);
	if (needsYou.length) {
		panel.insertAdjacentHTML("beforeend", `<div class="inbox-section">Needs you · ${needsYou.length}</div>`);
		for (const item of needsYou) panel.appendChild(renderInboxCard(item, false));
	} else {
		panel.insertAdjacentHTML("beforeend", '<div class="empty" style="padding:14px 0; text-align:left">Nothing needs you right now.</div>');
	}
	if (rest.length) {
		panel.insertAdjacentHTML("beforeend", `<div class="inbox-section">Settled · ${rest.length}</div>`);
		for (const item of rest) panel.appendChild(renderInboxCard(item, true));
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

// ---- image attachments: paste or drop into the composer ----------------------
let pendingImages = []; // { mimeType, dataUrl }

function renderAttachStrip() {
	const strip = $("attachStrip");
	strip.innerHTML = "";
	strip.classList.toggle("has", pendingImages.length > 0);
	pendingImages.forEach((image, index) => {
		const thumb = document.createElement("div");
		thumb.className = "attach-thumb";
		const img = document.createElement("img");
		img.src = image.dataUrl;
		img.alt = "attached image";
		const remove = document.createElement("button");
		remove.className = "attach-remove";
		remove.title = "Remove";
		remove.textContent = "×";
		remove.onclick = () => {
			pendingImages.splice(index, 1);
			renderAttachStrip();
			syncComposer();
		};
		thumb.appendChild(img);
		thumb.appendChild(remove);
		strip.appendChild(thumb);
	});
}

function attachImageFile(file) {
	if (!file || !file.type.startsWith("image/")) return;
	const reader = new FileReader();
	reader.onload = () => {
		pendingImages.push({ mimeType: file.type, dataUrl: String(reader.result) });
		renderAttachStrip();
		syncComposer();
	};
	reader.readAsDataURL(file);
}

$("input").addEventListener("paste", (event) => {
	const files = [...(event.clipboardData?.items ?? [])]
		.filter((item) => item.kind === "file" && item.type.startsWith("image/"))
		.map((item) => item.getAsFile());
	if (!files.length) return;
	event.preventDefault();
	files.forEach(attachImageFile);
});
// Dropping onto the composer attaches too — same lane as paste.
{
	const shell = document.querySelector(".composer-shell");
	shell.addEventListener("dragover", (event) => event.preventDefault());
	shell.addEventListener("drop", (event) => {
		event.preventDefault();
		[...(event.dataTransfer?.files ?? [])].forEach(attachImageFile);
	});
}

/** Thumbnails inside a message; click opens the full image in a lightbox. */
function appendMsgImages(div, dataUrls) {
	if (!dataUrls.length) return;
	const wrap = document.createElement("div");
	wrap.className = "msg-imgs";
	for (const url of dataUrls) {
		const img = document.createElement("img");
		img.src = url;
		img.alt = "attached image";
		img.onclick = () => {
			const box = document.createElement("div");
			box.className = "lightbox";
			const full = document.createElement("img");
			full.src = url;
			box.appendChild(full);
			box.onclick = () => box.remove();
			document.body.appendChild(box);
		};
		wrap.appendChild(img);
	}
	div.appendChild(wrap);
	$("messages").scrollTop = $("messages").scrollHeight;
}

function sendPrompt() {
	const input = $("input");
	const text = input.value.trim();
	const images = pendingImages;
	if (!text && !images.length) return;
	input.value = "";
	pendingImages = [];
	renderAttachStrip();
	syncComposer();
	appendMsgImages(addMsg("user", text), images.map((image) => image.dataUrl));
	let message = text;
	if (sidechatPending) {
		// First prompt of a fresh sidechat: tell the controller what the founder
		// is looking at. Square brackets are stripped from the interpolations so
		// the block stays cleanly parseable (chrome and backend both strip it
		// from display; see renderHistory / listTrailSessions).
		const name = String(sidechatPending.name ?? sidechatPending.entry).replace(/[[\]]/g, ")");
		const entry = String(sidechatPending.entry).replace(/[[\]]/g, ")");
		message = `[Sidechat context: this chat is docked to the surface "${name}" — app/surfaces/${entry}. The founder is looking at it right now; orient from that file before answering.]\n\n${text}`;
		sidechatPending = null;
	}
	const frame = { type: "prompt", message };
	if (images.length) {
		frame.images = images.map((image) => ({
			type: "image",
			data: image.dataUrl.slice(image.dataUrl.indexOf(",") + 1),
			mimeType: image.mimeType,
		}));
	}
	window.qorpera.rpcSend(frame);
}

/** Grow the textarea with its content and light the send button up. */
function syncComposer() {
	const input = $("input");
	input.style.height = "auto";
	input.style.height = `${Math.min(input.scrollHeight, 270)}px`;
	$("sendBtn").dataset.active = input.value.trim() || pendingImages.length ? "true" : "false";
}

$("input").addEventListener("input", syncComposer);
$("input").addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		sendPrompt();
	}
});

// ---- work groups: the agent's tool calls + thinking fold under a
// ---- collapsible "Worked for …" row, like the Codex thread ------------------

let workGroup = null; // { el, summary, body, start, steps }
let pendingToolLines = []; // tool lines awaiting their execution_end

function makeWorkGroup(open) {
	const el = document.createElement("details");
	el.className = "work";
	el.open = open;
	const summary = document.createElement("summary");
	summary.textContent = "Working…";
	const body = document.createElement("div");
	body.className = "workbody";
	el.appendChild(summary);
	el.appendChild(body);
	return { el, summary, body, start: Date.now(), steps: 0 };
}

function ensureWorkGroup() {
	if (workGroup) return workGroup;
	workGroup = makeWorkGroup(true);
	$("messages").appendChild(workGroup.el);
	$("messages").scrollTop = $("messages").scrollHeight;
	return workGroup;
}

/** Append a tool/thinking line inside the current work group. */
function workMsg(cls, text) {
	const group = ensureWorkGroup();
	const div = document.createElement("div");
	div.className = `msg ${cls}`;
	div.textContent = text;
	group.body.appendChild(div);
	$("messages").scrollTop = $("messages").scrollHeight;
	return div;
}

function formatDuration(ms) {
	const seconds = Math.max(1, Math.round(ms / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Stamp the summary with the elapsed time and collapse the group. */
function closeWorkGroup() {
	if (!workGroup) return;
	workGroup.summary.textContent = `Worked for ${formatDuration(Date.now() - workGroup.start)} · ${workGroup.steps} step${workGroup.steps === 1 ? "" : "s"}`;
	workGroup.el.open = false;
	workGroup = null;
	pendingToolLines = [];
}

/** Forget the group without touching the DOM (thread was replaced). */
function resetWorkGroup() {
	workGroup = null;
	pendingToolLines = [];
}

// ---- resizable panes: the sidebar and the sidechat -------------------------
// Drag the seam; widths persist per machine (localStorage — chrome
// preference, not company state). Pointer capture keeps the drag alive over
// the surface iframe, which additionally has its pointer events parked so it
// can never swallow the gesture.

function makePaneResizer(handleId, cssVar, storageKey, opts) {
	const handle = $(handleId);
	if (!handle) return;
	const apply = (px) => {
		const clamped = Math.min(opts.max, Math.max(opts.min, px));
		document.documentElement.style.setProperty(cssVar, `${clamped}px`);
	};
	const saved = Number(localStorage.getItem(storageKey));
	if (saved) apply(saved);
	handle.addEventListener("pointerdown", (event) => {
		event.preventDefault();
		handle.setPointerCapture(event.pointerId);
		handle.dataset.dragging = "true";
		$("view-surface").style.pointerEvents = "none";
		const startX = event.clientX;
		const startWidth = opts.el().getBoundingClientRect().width;
		const move = (ev) => apply(startWidth + (ev.clientX - startX) * opts.direction);
		const up = () => {
			handle.removeEventListener("pointermove", move);
			handle.removeEventListener("pointerup", up);
			delete handle.dataset.dragging;
			$("view-surface").style.pointerEvents = "";
			localStorage.setItem(storageKey, String(Math.round(opts.el().getBoundingClientRect().width)));
		};
		handle.addEventListener("pointermove", move);
		handle.addEventListener("pointerup", up);
	});
}

makePaneResizer("navHandle", "--nav-width", "qorpera.navWidth", {
	el: () => document.querySelector("#shell > nav"),
	min: 190,
	max: 420,
	direction: 1,
});
makePaneResizer("sidechatHandle", "--sidechat-width", "qorpera.sidechatWidth", {
	el: () => $("sidechat"),
	min: 300,
	max: 720,
	direction: -1,
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
				// The answer starts: fold the run's work away first.
				closeWorkGroup();
				assistantEl = addMsg("assistant", "");
				assistantEl.dataset.source = "";
			}
			if (delta.type === "text_delta" && assistantEl) {
				assistantEl.dataset.source += delta.delta;
				renderMarkdown(assistantEl, assistantEl.dataset.source);
				$("messages").scrollTop = $("messages").scrollHeight;
			}
			if (delta.type === "thinking_start") thinkingEl = workMsg("thinking", "");
			if (delta.type === "thinking_delta" && thinkingEl) thinkingEl.textContent += delta.delta;
			if (delta.type === "thinking_end") thinkingEl = null;
			if (delta.type === "text_end") assistantEl = null;
			break;
		}
		case "tool_execution_start": {
			const group = ensureWorkGroup();
			group.steps += 1;
			const line = workMsg("tool", `▸ ${frame.toolName} ${summarizeArgs(frame.args)}`);
			pendingToolLines.push({ toolName: frame.toolName, line });
			break;
		}
		case "tool_execution_end": {
			// Finish the matching in-flight line in place instead of adding a
			// second row per call.
			const index = pendingToolLines.findIndex((p) => p.toolName === frame.toolName);
			const entry = index >= 0 ? pendingToolLines.splice(index, 1)[0] : null;
			if (entry) entry.line.textContent = `${frame.isError ? "✗" : "✓"}${entry.line.textContent.slice(1)}`;
			else workMsg("tool", `${frame.isError ? "✗" : "✓"} ${frame.toolName}`);
			refreshState();
			break;
		}
		case "agent_settled":
			closeWorkGroup();
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
				modelCtl.setModels(
					models.map((m) => ({
						value: `${m.provider}::${m.id}`,
						name: m.name ?? m.id,
						fastCapable: m.api === "openai-codex-responses",
					})),
				);
			} else if (frame.command === "get_available_thinking_levels" && frame.success) {
				modelCtl.setLevels(frame.data?.levels ?? []);
			} else if (frame.command === "get_state" && frame.success) {
				const model = frame.data?.model;
				if (model?.id) currentModelKey = `${model.provider}::${model.id}`;
				if (frame.data?.thinkingLevel) currentEffort = frame.data.thinkingLevel;
				const reported = frame.data?.responseSpeed;
				if (reported) {
					// Speed is session-local in the runtime; the chrome carries the
					// machine's preference across spawns and re-asserts it once.
					if (!speedAsserted && currentSpeed === "fast" && reported === "standard") {
						window.qorpera.rpcSend({ type: "set_response_speed", speed: "fast" });
					} else {
						currentSpeed = reported;
					}
					speedAsserted = true;
				}
				modelCtl.sync();
			} else if (frame.command === "set_model" && frame.success && frame.data?.id) {
				currentModelKey = `${frame.data.provider}::${frame.data.id}`;
				modelCtl.sync();
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

// ---- the settings page (own sidebar of tabs, Codex-app shape) ---------------

let settingsTab = "general";
let versionsView = "newest"; // newest | oldest | last-used | favorites
let updateReadyVersion = null;

function openSettings(tab) {
	settingsTab = tab || "general";
	$("settingsView").classList.add("open");
	for (const b of document.querySelectorAll("#settingsView .stab")) {
		b.classList.toggle("active", b.dataset.tab === settingsTab);
	}
	renderSettingsTab();
}
function closeSettings() {
	$("settingsView").classList.remove("open");
}

function setHeading(content, text) {
	const h = document.createElement("h1");
	h.textContent = text;
	content.appendChild(h);
}
function setRow(content, label, small, control) {
	const row = document.createElement("div");
	row.className = "setrow";
	const lab = document.createElement("label");
	lab.textContent = label;
	if (small) {
		const s = document.createElement("small");
		s.textContent = small;
		lab.appendChild(s);
	}
	row.appendChild(lab);
	if (control) row.appendChild(control);
	content.appendChild(row);
	return row;
}
function modeSelect(value) {
	const sel = document.createElement("select");
	for (const mode of ["auto", "notify", "gate"]) {
		const o = document.createElement("option");
		o.value = mode;
		o.textContent = mode;
		if (mode === value) o.selected = true;
		sel.appendChild(o);
	}
	return sel;
}

async function renderSettingsTab() {
	const content = $("settingsContent");
	content.innerHTML = "";

	if (settingsTab === "general") {
		const info = await window.qorpera.settingsInfo();
		setHeading(content, "General");
		setRow(content, `Qorpera Base v${info.version}`, info.packaged ? "installed — auto-updates from the release channel" : "dev tree — updates by rebuilding the repo");
		const upd = document.createElement("button");
		upd.className = "save";
		if (updateReadyVersion) {
			upd.textContent = `Restart to update → v${updateReadyVersion}`;
			upd.onclick = () => window.qorpera.updateInstall();
		} else {
			upd.textContent = "Check for updates";
			upd.onclick = () => checkUpdates();
		}
		setRow(content, "Updates", "foundation only — your app's userland merges separately", upd);
		return;
	}

	if (settingsTab === "app") {
		setHeading(content, "App — this company's fork");
		const info = await window.qorpera.appInfo();
		const co = info.activeCompany;
		if (!co) {
			content.insertAdjacentHTML("beforeend", '<div class="sess-meta">Open a company — its app is a fork of the base, managed here.</div>');
			return;
		}
		setRow(
			content,
			`Fork of Qorpera Base v${co.userland.baseVersion}`,
			co.evolved ? "evolved — the controller has changed this app" : "pristine — identical to the base",
		);
		if (co.userland.stagedVersion) {
			setRow(
				content,
				`Base v${co.userland.stagedVersion} staged`,
				"waiting for the controller's merge session — the merge button lives on the chat view",
			);
		}
		const sw = document.createElement("button");
		sw.className = "save";
		sw.style.marginTop = "0";
		sw.textContent = co.activeApp === "base" ? "Run this company's app" : "Run the base app";
		sw.onclick = () => window.qorpera.setActiveApp(co.activeApp === "base" ? "fork" : "base");
		setRow(
			content,
			"Base app",
			co.activeApp === "base"
				? `running the base app (always current — v${info.version}) over this company; the fork is untouched`
				: `always installed, always current (v${info.version}) — switch any time without touching the fork`,
			sw,
		);
		const iconBtn = document.createElement("button");
		iconBtn.className = "save";
		iconBtn.style.marginTop = "0";
		iconBtn.textContent = "Choose image…";
		const iconNote = document.createElement("span");
		iconNote.className = "sess-meta";
		iconBtn.onclick = async () => {
			const result = await window.qorpera.chooseIcon();
			iconNote.textContent = result?.ok ? "icon set" : "";
		};
		const iconRow = setRow(
			content,
			"Window icon",
			"defaults to the Qorpera mark; stored in the company's app/ folder — your controller can manage it too",
			iconBtn,
		);
		iconRow.appendChild(iconNote);
		setHeading(content, "Versions");
		content.insertAdjacentHTML(
			"beforeend",
			'<div class="sess-meta">Saved automatically whenever the app has changed at open. Restore switches to any of them — the state before a rollback is itself saved, and a restored version that is behind rejoins the current base through a controller merge.</div>',
		);
		const sortRow = document.createElement("div");
		sortRow.style.cssText = "display:flex;align-items:center;gap:8px;margin:12px 0 2px;";
		const sortLab = document.createElement("span");
		sortLab.className = "sess-meta";
		sortLab.textContent = "Show";
		const sortSel = document.createElement("select");
		sortSel.style.cssText = "width:auto;padding:5px 10px;";
		for (const [value, text] of [
			["newest", "Newest first"],
			["oldest", "Oldest first"],
			["last-used", "Last used"],
			["favorites", "Favorites"],
		]) {
			const o = document.createElement("option");
			o.value = value;
			o.textContent = text;
			if (value === versionsView) o.selected = true;
			sortSel.appendChild(o);
		}
		sortSel.onchange = () => {
			versionsView = sortSel.value;
			renderSettingsTab();
		};
		sortRow.appendChild(sortLab);
		sortRow.appendChild(sortSel);
		content.appendChild(sortRow);

		let versions = co.versions.slice(); // arrives newest first
		if (versionsView === "favorites") versions = versions.filter((v) => v.favorite);
		if (versionsView === "oldest") versions.reverse();
		// Stable sort: restored versions first by recency, the rest stay newest-first.
		if (versionsView === "last-used") versions.sort((a, b) => (b.lastUsedAt || "").localeCompare(a.lastUsedAt || ""));
		if (!versions.length) {
			const note = versionsView === "favorites" ? "No favorites yet — star a version to keep it handy." : "No saved versions yet.";
			content.insertAdjacentHTML("beforeend", `<div class="sess-meta" style="margin-top:12px">${note}</div>`);
		}
		for (const v of versions) {
			const actions = document.createElement("div");
			actions.style.cssText = "display:flex;align-items:center;gap:8px;";
			const star = document.createElement("button");
			star.style.cssText = "width:auto;padding:5px 10px;";
			star.textContent = v.favorite ? "★" : "☆";
			star.title = v.favorite ? "Remove from favorites" : "Add to favorites";
			star.onclick = async () => {
				star.disabled = true;
				await window.qorpera.favoriteVersion(v.id, !v.favorite);
				renderSettingsTab();
			};
			const btn = document.createElement("button");
			btn.className = "save";
			btn.style.marginTop = "0";
			btn.textContent = "Restore";
			btn.onclick = async () => {
				btn.disabled = true;
				await window.qorpera.restoreVersion(v.id);
				renderSettingsTab();
			};
			actions.appendChild(star);
			actions.appendChild(btn);
			const [d, t] = v.savedAt.split("T");
			const [hh, mm] = (t || "").split("-");
			const when = `${d} ${hh || ""}:${mm || ""}`.trim();
			const name = `v${v.seq}${v.label === "pre-restore" ? " · before rollback" : v.label ? ` · ${v.label}` : ""}`;
			const facts = [v.description, when, v.baseVersion && `built on base v${v.baseVersion}`];
			if (v.lastUsedAt) facts.push(`last used ${v.lastUsedAt.slice(0, 16).replace("T", " ")}`);
			setRow(content, name, facts.filter(Boolean).join(" · "), actions);
		}
		return;
	}

	if (settingsTab === "authority") {
		setHeading(content, "Authority — the gates");
		if (!backendUrl) {
			content.insertAdjacentHTML("beforeend", '<div class="sess-meta">Open a company to edit its gates.</div>');
			return;
		}
		const cfg = await (await fetch(`${backendUrl}/api/authority/config`)).json();
		const note = document.createElement("div");
		note.className = "sess-meta";

		const money = modeSelect(cfg.classes.money.mode);
		const limit = document.createElement("input");
		limit.type = "number";
		limit.value = cfg.classes.money.limitUsd ?? 50;
		const moneyRow = setRow(content, "Money", "spending and financial commitments", money);
		moneyRow.appendChild(limit);
		moneyRow.appendChild(document.createTextNode("USD notify-limit"));

		const identity = modeSelect(cfg.classes.identity.mode);
		setRow(content, "Identity", "acting AS the company externally: sending, posting, signing", identity);
		const irreversible = modeSelect(cfg.classes.irreversible.mode);
		setRow(content, "Irreversible", "prod deploys, deletions, legal commitments", irreversible);
		setRow(
			content,
			"Product code",
			"controllers are always read-only; product-workers can modify only their assigned worktree — not configurable",
		);

		setRow(content, "Authority itself", "editing gates, kernel files, or the inbox — always gated, not configurable");

		const save = document.createElement("button");
		save.className = "save";
		save.textContent = "Save gates";
		save.onclick = async () => {
			const res = await fetch(`${backendUrl}/api/authority/config`, {
				method: "POST",
				headers: authHeaders({ "content-type": "application/json" }),
				body: JSON.stringify({
					classes: {
						money: { mode: money.value, limitUsd: Number(limit.value) || 50 },
						identity: { mode: identity.value },
						irreversible: { mode: irreversible.value },
					},
				}),
			});
			const result = await res.json().catch(() => ({ ok: false }));
			note.textContent = result.ok ? "saved — gates apply immediately" : `rejected: ${result.error ?? "error"}`;
		};
		content.appendChild(save);
		content.appendChild(note);
		return;
	}

	if (settingsTab === "connections") {
		const info = await window.qorpera.settingsInfo();
		setHeading(content, "Connections");
		if (info.providers.length) {
			for (const p of info.providers) setRow(content, p, "model subscription — connected");
		} else {
			setRow(content, "No model subscriptions connected");
		}
		content.insertAdjacentHTML(
			"beforeend",
			`<div class="sess-meta" style="margin-top:12px">To connect one, run <code>qorpera</code> in a terminal and use <code>/login</code> — a GUI flow is coming. Credentials live in ${info.agentDir}, never in company folders.</div>`,
		);
		return;
	}

	if (settingsTab === "profile") {
		setHeading(content, "Profile");
		content.insertAdjacentHTML(
			"beforeend",
			'<div class="sess-meta">Founder profile and per-company preferences land here as the platform grows; your controller can extend this plane in its own userland.</div>',
		);
		return;
	}

	if (settingsTab === "cloud") {
		setHeading(content, "Cloud");
		content.insertAdjacentHTML(
			"beforeend",
			'<div class="sess-meta">Sync, community, and compliance — not built yet.</div>',
		);
		return;
	}

	if (settingsTab === "advanced") {
		setHeading(content, "Advanced — raw authority.toml");
		if (!backendUrl) {
			content.insertAdjacentHTML("beforeend", '<div class="sess-meta">Open a company first.</div>');
			return;
		}
		const editor = document.createElement("textarea");
		editor.value = "loading…";
		fetch(`${backendUrl}/api/authority`).then((r) => r.text()).then((text) => {
			editor.value = text;
		});
		const save = document.createElement("button");
		save.className = "save";
		save.textContent = "Save authority.toml";
		const note = document.createElement("div");
		note.className = "sess-meta";
		save.onclick = async () => {
			const res = await fetch(`${backendUrl}/api/authority`, {
				method: "POST",
				headers: authHeaders({ "content-type": "application/json" }),
				body: JSON.stringify({ content: editor.value }),
			});
			const result = await res.json().catch(() => ({ ok: false, error: "unexpected response" }));
			note.textContent = result.ok ? "saved — gates apply immediately" : `rejected: ${result.error ?? "invalid TOML"}`;
		};
		content.appendChild(editor);
		content.appendChild(save);
		content.appendChild(note);
	}
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
	updateReadyVersion = version;
	$("status").textContent = `v${version} downloaded — restart to apply (Settings → General)`;
	if ($("settingsView").classList.contains("open") && settingsTab === "general") renderSettingsTab();
});
window.qorpera.onOpenCompany((root) => openCompany(root));
window.qorpera.onMergeDone((result) => {
	const b = document.getElementById("mergeBtn");
	if (result?.ok) {
		$("status").textContent = "userland merge finished — reload to run the updated app";
		if (b) {
			b.textContent = "App updated — reload";
			b.disabled = false;
			b.onclick = () => location.reload();
		}
	} else {
		$("status").textContent = "merge session ended without completing — see Inbox and Activity";
		if (b) {
			b.textContent = "Merge incomplete — check Inbox";
			b.disabled = false;
			b.onclick = () => show("inbox");
		}
	}
});

(async () => {
	const info = await window.qorpera.appInfo();
	$("hubVersion").textContent = `the foundation · v${info.version}`;
	if (info.activeCompany) {
		await enterCompany(info.activeCompany);
	} else if (info.pendingCompany) {
		await openCompany(info.pendingCompany);
	} else {
		await renderHub();
	}
})();
