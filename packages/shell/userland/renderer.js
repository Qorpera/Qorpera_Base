/* Renderer chrome. Static by design — everything company-specific arrives
 * from the folder via the backend (surfaces/state/inbox) or the RPC pipe. */
const $ = (id) => document.getElementById(id);
let backendUrl = "";
let state = {
	projection: { schema: "qorpera.projection/v1", default: "q:chats", navigation: [], nodes: [], diagnostics: [] },
	inbox: [],
	sessions: [],
	departments: [],
};
const sessionCache = {}; // session file -> rendered messages HTML

async function authorizedPost(path, body) {
	const response = await window.qorpera.authorizedBackendPost(path, body);
	return {
		ok: Boolean(response?.ok),
		status: response?.status ?? 500,
		json: async () => JSON.parse(response?.text ?? "{}"),
		text: async () => response?.text ?? "",
	};
}

let currentNodeId = null;
let currentSession = null; // trail file of the open chat (null = fresh/unsaved)
let currentDepartment = null; // product department of the open chat (null = company controller)
let currentWorktree = null; // kernel-assigned product worktree, when applicable
let sidechatOpen = false; // the surface view's docked chat panel
let sidechatPageId = null; // stable page ID the live session is attached to
let sidechatPending = null; // page awaiting its context preamble (fresh session)
let assistantEl = null;
let thinkingEl = null;
let poller = null;
let currentModelKey = "";
let currentEffort = "";
let currentSpeed = "standard";
let speedAsserted = false; // one re-assert of the remembered speed per child spawn
let hiddenNavigation = new Set();
let archivedNavigation = new Set(); // frontend preview only; durable archive remains unbound
let focusedDepartmentId = null;
let navContextTarget = null;
let navContextTrigger = null;
let navContextPoint = { x: 0, y: 0 };
let archiveTarget = null;
let toastTimeout = null;
let departmentWizard = {
	step: 1,
	type: null,
	name: "",
	template: "blank",
	repoMode: "local",
	repoPath: "",
	repoUrl: "",
	clonePath: "",
};

const SIDEBAR_COLLAPSED_KEY = "qorpera.sidebar-collapsed";

function applySidebarCollapsed(collapsed) {
	document.body.classList.toggle("sidebar-collapsed", collapsed);
	const button = $("toggleSidebarButton");
	button.setAttribute("aria-expanded", String(!collapsed));
	button.setAttribute("aria-label", collapsed ? "Show navigation panel" : "Hide navigation panel");
	button.title = collapsed ? "Show navigation panel" : "Hide navigation panel";
}

function setupSidebarToggle() {
	applySidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true");
	$("toggleSidebarButton").onclick = () => {
		const collapsed = !document.body.classList.contains("sidebar-collapsed");
		localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
		applySidebarCollapsed(collapsed);
	};
}

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
	try {
		await window.qorpera.openCompany(root);
	} catch (error) {
		alert(`Could not open the company:\n${(error && error.message) || error}`);
	}
}

/** Boot into an already-open company (called after the kernel loads us). */
async function enterCompany(active) {
	backendUrl = active.backendUrl;
	hiddenNavigation = new Set(readStoredArray("nav-hidden"));
	archivedNavigation = new Set();
	focusedDepartmentId = null;
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
	const options = [{ value: "", label: state.name ? `${state.name} Controller` : "Company", icon: COMPANY_ICON }];
	if (currentDepartment) {
		const department = (state.departments ?? []).find((entry) => entry.path === currentDepartment);
		options.push({
			value: currentDepartment,
			label: `${department?.name ?? departmentName(currentDepartment)} Product Worker`,
			icon: PRODUCT_ICON,
		});
	}
	scopeChip.setOptions(options, currentDepartment ?? "");
	scopeChip.value = currentDepartment ?? "";
	const sidechatOwner = sidechatOpen && sidechatPageId ? projectionNode(sidechatPageId) : undefined;
	$("input").placeholder = sidechatOwner
		? `Ask about ${sidechatOwner.label}… (Enter to send, Shift+Enter for newline)`
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
	sidechatPageId = null;
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
			if (currentNodeId && !projectionNode(currentNodeId)) currentNodeId = null;
			if (!currentNodeId) {
				const routed = location.hash.match(/^#\/p\/(.+)$/)?.[1];
				let routedId;
				try {
					routedId = routed ? decodeURIComponent(routed) : undefined;
				} catch {
					routedId = undefined;
				}
				const target = projectionNode(routedId) ? routedId : state.projection?.default;
				if (target) void openProjectionNode(target);
			} else if (currentView === "panel" || currentView === "surface") {
				// Refresh the open read model without disturbing a live chat. A
				// product Chat page is now inert until its explicit create action.
				void openProjectionNode(currentNodeId, false);
			}
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

async function openSession(file, pageId = "q:chats") {
	cacheCurrentSession();
	// Product chats restore the exact department/worktree role capability
	// recorded in their append-only session name.
	const summary = (state.sessions ?? []).find((s) => s.file === file);
	const result = await window.qorpera.openChat(file, summary?.department, summary?.worktree);
	if (!result?.ok) return;
	currentSession = file;
	currentNodeId = pageId;
	setProjectionRoute(pageId);
	currentDepartment = result.department ?? null;
	currentWorktree = result.worktree ?? null;
	sidechatPageId = null;
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

async function newCompanyChat() {
	cacheCurrentSession();
	const result = await window.qorpera.openChat(null);
	if (!result?.ok) return;
	currentSession = null;
	currentDepartment = null;
	currentWorktree = null;
	currentNodeId = "q:chats";
	setProjectionRoute("q:chats");
	sidechatPageId = null;
	sidechatPending = null;
	$("messages").innerHTML = "";
	resetWorkGroup();
	show("chat");
	syncScopeChrome();
	renderCompanyNavSafe();
	hydrateAgentState(false);
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
	sidechatPageId = null;
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

function projectionNode(id) {
	return (state.projection?.nodes ?? []).find((node) => node.id === id);
}

function navStorageKey(name) {
	return `qorpera:${backendUrl || "base"}:${name}`;
}

function readStoredObject(name, fallback) {
	try {
		const parsed = JSON.parse(localStorage.getItem(navStorageKey(name)) ?? "null");
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
	} catch {
		return fallback;
	}
}

function readStoredArray(name) {
	try {
		const parsed = JSON.parse(localStorage.getItem(navStorageKey(name)) ?? "null");
		return Array.isArray(parsed) && parsed.every((value) => typeof value === "string") ? parsed : [];
	} catch {
		return [];
	}
}

function storeNavigationSet(name, values) {
	localStorage.setItem(navStorageKey(name), JSON.stringify([...values]));
}

function navAppearance() {
	return {
		pageHue: "#3b82f6",
		categoryHue: "#8b5cf6",
		showKinds: true,
		...readStoredObject("nav-appearance", {}),
	};
}

function applyNavAppearance() {
	const appearance = navAppearance();
	document.documentElement.style.setProperty("--page-hue", appearance.pageHue);
	document.documentElement.style.setProperty("--category-hue", appearance.categoryHue);
	document.body.classList.toggle("hues-hidden", !appearance.showKinds);
}

function applyNavMetrics(element, node, focused = false) {
	const heights = readStoredObject("nav-heights", {});
	const offset = Math.max(-12, Math.min(12, Number(heights[node.id]) || 0));
	const baseHeight = node.kind === "department" ? 27 : focused ? 58 : 30;
	const scale = 1 + offset / 60;
	element.style.setProperty("--nav-item-height", `${baseHeight + offset}px`);
	element.style.setProperty(
		"--nav-font-size",
		`${(node.kind === "department" ? 13 : focused ? 13.5 : 12.5) * scale}px`,
	);
	element.style.setProperty("--nav-padding-inline", `${(node.kind === "department" ? 3 : 8) * scale}px`);
	if (node.kind === "department") {
		element.style.setProperty("--nav-padding-top", `${Math.max(0, 1 + offset * 0.08)}px`);
		element.style.setProperty("--nav-padding-bottom", `${Math.max(2, 5 + offset * 0.22)}px`);
	} else {
		element.style.setProperty("--nav-padding-block", `${Math.max(1.5, (focused ? 9 : 4) + offset * 0.15)}px`);
		element.style.setProperty("--nav-radius", `${(focused ? 7 : 5) * scale}px`);
		element.style.setProperty("--nav-hue-width", `${54 * scale}px`);
		element.style.setProperty("--nav-meta-size", `${9.5 * scale}px`);
		element.style.setProperty("--nav-arrow-size", `${15 * scale}px`);
	}
	const appearance = navAppearance();
	if (appearance.showKinds && node.kind !== "department") {
		element.style.setProperty("--nav-kind-hue", node.kind === "page" ? appearance.pageHue : appearance.categoryHue);
	}
}

function navigationDepartments() {
	return (state.projection?.navigation ?? [])
		.map(projectionNode)
		.filter((node) => node?.kind === "department");
}

function departmentForProjectionNode(id) {
	return navigationDepartments().find((department) =>
		department.items.some((childId) => {
			if (childId === id) return true;
			const child = projectionNode(childId);
			return child?.kind === "category" && child.items.includes(id);
		}),
	);
}

function nodeIsVisible(id) {
	return !hiddenNavigation.has(id) && !archivedNavigation.has(id);
}

function visibleCategoryPages(category) {
	return category.items.map(projectionNode).filter((node) => node?.kind === "page" && nodeIsVisible(node.id));
}

function hiddenItemsForDepartment(department) {
	const hidden = [];
	for (const childId of department.items) {
		const child = projectionNode(childId);
		if (!child) continue;
		if (hiddenNavigation.has(child.id)) {
			hidden.push({ id: child.id, label: child.label, detail: child.kind === "category" ? "Category" : "Page" });
		}
		if (child.kind !== "category") continue;
		for (const pageId of child.items) {
			const page = projectionNode(pageId);
			if (page?.kind === "page" && hiddenNavigation.has(page.id)) {
				hidden.push({ id: page.id, label: page.label, detail: `${child.label} / Page` });
			}
		}
	}
	return hidden;
}

function placeFloatingMenu(menu) {
	const margin = 8;
	const bounds = menu.getBoundingClientRect();
	menu.style.left = `${Math.max(margin, Math.min(navContextPoint.x, window.innerWidth - bounds.width - margin))}px`;
	menu.style.top = `${Math.max(margin, Math.min(navContextPoint.y, window.innerHeight - bounds.height - margin))}px`;
}

function closeNavContext() {
	$("navContext").hidden = true;
	navContextTarget = null;
}

function closePanelContext() {
	$("panelContextMenu").hidden = true;
}

function openNavContext(event, node, placement) {
	event.preventDefault();
	event.stopPropagation();
	closePanelContext();
	navContextTarget = { node, placement };
	navContextTrigger = event.currentTarget;
	navContextPoint = { x: event.clientX, y: event.clientY };
	$("contextTitle").textContent = `${node.kind} / ${node.label}`;
	$("contextActions").hidden = false;
	$("heightEditor").hidden = true;
	const canAdjust = placement !== "collection";
	$("adjustHeightButton").hidden = !canAdjust;
	$("focusDepartmentItem").hidden = node.kind !== "department";
	$("contextHeightSeparator").hidden = !canAdjust && node.kind !== "department";
	$("focusDepartmentItem").querySelector("span").textContent = focusedDepartmentId === node.id ? "Exit focus" : "Focus department";
	$("focusDepartmentItem").querySelector("small").textContent =
		focusedDepartmentId === node.id ? "Restore the complete panel" : "Show only this department";
	$("navContext").hidden = false;
	placeFloatingMenu($("navContext"));
	(canAdjust ? $("adjustHeightButton") : $("hideNavigationItem")).focus();
}

function updateHeightEditor() {
	if (!navContextTarget) return;
	const heights = readStoredObject("nav-heights", {});
	const offset = Math.max(-12, Math.min(12, Number(heights[navContextTarget.node.id]) || 0));
	$("heightSlider").value = String(offset);
	$("heightValue").textContent = offset === 0 ? "Default" : `${offset > 0 ? "+" : ""}${offset} px`;
}

function setTargetHeight(value) {
	if (!navContextTarget) return;
	const heights = readStoredObject("nav-heights", {});
	const offset = Math.max(-12, Math.min(12, Math.round(Number(value))));
	if (offset === 0) delete heights[navContextTarget.node.id];
	else heights[navContextTarget.node.id] = offset;
	localStorage.setItem(navStorageKey("nav-heights"), JSON.stringify(heights));
	renderCompanyNavSafe();
	updateHeightEditor();
}

function showControllerToast(message) {
	clearTimeout(toastTimeout);
	$("controllerToast").textContent = message;
	$("controllerToast").hidden = false;
	toastTimeout = setTimeout(() => {
		$("controllerToast").hidden = true;
	}, 3400);
}

function currentInsideNode(node) {
	if (currentNodeId === node.id) return true;
	if (node.kind === "page") return false;
	return node.items.some((id) => {
		if (id === currentNodeId) return true;
		const child = projectionNode(id);
		return child?.kind === "category" && child.items.includes(currentNodeId);
	});
}

function firstAvailableNavigationTarget() {
	for (const department of navigationDepartments()) {
		if (focusedDepartmentId && department.id !== focusedDepartmentId) continue;
		if (!nodeIsVisible(department.id)) continue;
		for (const childId of department.items) {
			const child = projectionNode(childId);
			if (child && nodeIsVisible(child.id)) return child;
		}
	}
	return undefined;
}

function openNavigationFallback() {
	const fallback = firstAvailableNavigationTarget();
	if (fallback) void openProjectionNode(fallback.id);
	else {
		currentNodeId = null;
		const panel = $("view-panel");
		panel.innerHTML = '<section class="collection-view"><header class="collection-view-head"><div><div class="eyebrow">Company interface</div><h1>No active pages</h1><p>Unhide navigation items or add a department to continue.</p></div></header></section>';
		show("panel");
	}
}

function hideNavigationTarget() {
	if (!navContextTarget) return;
	const { node } = navContextTarget;
	const containedCurrent = currentInsideNode(node);
	hiddenNavigation.add(node.id);
	storeNavigationSet("nav-hidden", hiddenNavigation);
	if (node.kind === "department" && focusedDepartmentId === node.id) focusedDepartmentId = null;
	closeNavContext();
	renderCompanyNavSafe();
	if (containedCurrent) openNavigationFallback();
	else if (currentView === "panel" && projectionNode(currentNodeId)?.kind === "category") renderCollection(projectionNode(currentNodeId));
	showControllerToast(
		node.kind === "department"
			? `${node.label} hidden. Right-click the navigation panel to show it again.`
			: `${node.label} hidden. Use its department Show menu to restore it.`,
	);
}

function restoreHiddenNode(node) {
	hiddenNavigation.delete(node.id);
	storeNavigationSet("nav-hidden", hiddenNavigation);
	renderCompanyNavSafe();
	if (currentView === "panel" && projectionNode(currentNodeId)?.kind === "category") renderCollection(projectionNode(currentNodeId));
	showControllerToast(`${node.label} shown in the panel.`);
}

function toggleDepartmentFocus() {
	if (navContextTarget?.node.kind !== "department") return;
	const department = navContextTarget.node;
	const enabling = focusedDepartmentId !== department.id;
	focusedDepartmentId = enabling ? department.id : null;
	closeNavContext();
	renderCompanyNavSafe();
	$("navigation").scrollTop = 0;
	if (enabling) {
		const target = department.items.map(projectionNode).find((node) => node && nodeIsVisible(node.id));
		if (target) void openProjectionNode(target.id);
		else openNavigationFallback();
		showControllerToast(`${department.label} focused. Reset Panel restores the complete view.`);
	} else {
		showControllerToast("Panel focus reset. Hidden items remain hidden.");
	}
}

function openArchiveConfirmation() {
	if (!navContextTarget) return;
	archiveTarget = navContextTarget.node;
	closeNavContext();
	$("archiveType").textContent = `Archive ${archiveTarget.kind}`;
	$("archiveTitle").textContent = `Archive ${archiveTarget.label}?`;
	$("archiveDescription").textContent = `${archiveTarget.label} will be removed from active navigation. No company files will be deleted or moved.`;
	$("archiveModal").hidden = false;
	$("archiveConfirm").focus();
}

function closeArchiveConfirmation() {
	$("archiveModal").hidden = true;
	archiveTarget = null;
	navContextTrigger?.focus();
}

function confirmArchivePreview() {
	if (!archiveTarget) return;
	const target = archiveTarget;
	const containedCurrent = currentInsideNode(target);
	archivedNavigation.add(target.id);
	hiddenNavigation.delete(target.id);
	storeNavigationSet("nav-hidden", hiddenNavigation);
	if (target.kind === "department" && focusedDepartmentId === target.id) focusedDepartmentId = null;
	$("archiveModal").hidden = true;
	archiveTarget = null;
	renderCompanyNavSafe();
	if (containedCurrent) openNavigationFallback();
	else if (currentView === "panel" && projectionNode(currentNodeId)?.kind === "category") renderCollection(projectionNode(currentNodeId));
	showControllerToast(`${target.label} archived for this preview. Durable archive remains unbound.`);
}

function renderPanelHiddenDepartments() {
	const list = $("panelHiddenDepartments");
	list.replaceChildren();
	for (const department of navigationDepartments()) {
		if (!hiddenNavigation.has(department.id)) continue;
		const button = document.createElement("button");
		button.type = "button";
		button.setAttribute("role", "menuitem");
		button.innerHTML = "<span></span><small>Show</small>";
		button.querySelector("span").textContent = department.label;
		button.onclick = () => {
			focusedDepartmentId = null;
			closePanelContext();
			restoreHiddenNode(department);
		};
		list.appendChild(button);
	}
}

function openPanelContext(event) {
	if (event.target.closest(".projection-department, .sidebar-create, .profileRow")) return;
	event.preventDefault();
	closeNavContext();
	navContextPoint = { x: event.clientX, y: event.clientY };
	renderPanelHiddenDepartments();
	$("panelContextMenu").hidden = false;
	placeFloatingMenu($("panelContextMenu"));
	$("panelHiddenDepartments").querySelector("button")?.focus();
}

function renderCompanyNav() {
	const nav = $("navigation");
	nav.innerHTML = "";
	nav.classList.toggle("focus-mode", focusedDepartmentId !== null);
	applyNavAppearance();
	for (const department of navigationDepartments()) {
		const focused = focusedDepartmentId === department.id;
		if (focusedDepartmentId && !focused) continue;
		if (!nodeIsVisible(department.id)) continue;
		const group = document.createElement("section");
		group.className = "projection-department";
		group.oncontextmenu = (event) => {
			if (!event.target.closest(".projection-row, .hidden-items-control")) openNavContext(event, department, "department");
		};
		const title = document.createElement("div");
		title.className = "projection-department-title";
		const titleLabel = document.createElement("span");
		titleLabel.className = "projection-department-label";
		titleLabel.textContent = department.label;
		title.appendChild(titleLabel);
		const hiddenItems = hiddenItemsForDepartment(department);
		if (hiddenItems.length) {
			const control = document.createElement("div");
			control.className = "hidden-items-control";
			control.innerHTML = '<button class="show-hidden-button" type="button"></button><div class="hidden-items-popover" role="menu"></div>';
			const button = control.querySelector("button");
			button.textContent = `Show ${hiddenItems.length}`;
			button.setAttribute("aria-label", `Show ${hiddenItems.length} hidden item${hiddenItems.length === 1 ? "" : "s"} in ${department.label}`);
			for (const hidden of hiddenItems) {
				const node = projectionNode(hidden.id);
				if (!node) continue;
				const restore = document.createElement("button");
				restore.type = "button";
				restore.className = "restore-hidden-item";
				restore.setAttribute("role", "menuitem");
				restore.innerHTML = "<span></span><small></small>";
				restore.querySelector("span").textContent = hidden.label;
				restore.querySelector("small").textContent = hidden.detail;
				restore.onclick = (event) => {
					event.stopPropagation();
					restoreHiddenNode(node);
				};
				control.querySelector(".hidden-items-popover").appendChild(restore);
			}
			title.appendChild(control);
		}
		title.oncontextmenu = (event) => openNavContext(event, department, "department");
		applyNavMetrics(title, department);
		group.appendChild(title);
		const items = document.createElement("div");
		items.className = "projection-department-items";
		items.dataset.emptyLabel = department.items.length ? "No visible items" : "Empty department";
		for (const childId of department.items) {
			const child = projectionNode(childId);
			if (!child || (child.kind !== "page" && child.kind !== "category")) continue;
			if (!nodeIsVisible(child.id)) continue;
			const row = document.createElement("button");
			const ownsCurrent = child.kind === "category" && child.items.includes(currentNodeId);
			row.className = `projection-row ${child.kind}${focused ? " focus-row" : ""}`;
			row.innerHTML = focused
				? '<span class="projection-row-copy"><span class="projection-row-label"></span><small></small></span><span class="focus-arrow" aria-hidden="true">-&gt;</span>'
				: '<span class="projection-row-label"></span>';
			row.querySelector(".projection-row-label").textContent = child.label;
			row.title = child.description ?? child.label;
			row.classList.toggle("active", currentNodeId === child.id || ownsCurrent);
			if (currentNodeId === child.id || ownsCurrent) row.setAttribute("aria-current", "page");
			if (focused) {
				const visiblePages = child.kind === "category" ? visibleCategoryPages(child).length : 0;
				row.querySelector("small").textContent =
					child.kind === "category"
						? `Category / ${visiblePages} page${visiblePages === 1 ? "" : "s"}`
						: child.view.type === "builtin"
							? "Built-in page"
							: "Direct surface";
			}
			if (child.id === "q:inbox") {
				const pending = state.inbox.filter((item) => item.status === "pending").length;
				if (pending) {
					const badge = document.createElement("span");
					badge.className = "badge";
					badge.textContent = String(pending);
					row.appendChild(badge);
				}
			}
			applyNavMetrics(row, child, focused);
			row.onclick = () => void openProjectionNode(child.id);
			row.oncontextmenu = (event) => openNavContext(event, child, "row");
			items.appendChild(row);
		}
		group.appendChild(items);
		nav.appendChild(group);
	}
	const diagnostics = $("projectionDiagnostics");
	const messages = state.projection?.diagnostics ?? [];
	diagnostics.textContent = messages.length ? `${messages.length} projection issue${messages.length === 1 ? "" : "s"}` : "";
	diagnostics.title = messages.join("\n");
	$("resetPanelButton").disabled = focusedDepartmentId === null;
	$("resetPanelButton").title = focusedDepartmentId ? "Exit department focus without changing hidden items" : "The panel is already in its default view";
	syncScopeChrome();
}

function setProjectionRoute(id) {
	const next = `#/p/${encodeURIComponent(id)}`;
	if (location.hash !== next) history.replaceState(null, "", next);
}

function renderCollection(node) {
	const panel = $("view-panel");
	panel.innerHTML = '<section class="collection-view"><header class="collection-view-head"><div><div class="eyebrow"></div><h1></h1><p></p></div></header><div class="collection-tools"><label class="collection-search"><input type="search" placeholder="Filter this category" aria-label="Filter pages"></label><span class="collection-count"></span></div><div class="collection-list"></div></section>';
	const department = departmentForProjectionNode(node.id);
	panel.querySelector(".eyebrow").textContent =
		node.kind === "department" ? "Company / Department" : `${department?.label ?? "Company"} / Category`;
	panel.querySelector("h1").textContent = node.label;
	panel.querySelector(".collection-view-head p").textContent =
		node.description ?? (node.kind === "department" ? "Direct pages published by this department." : "Published pages in this category.");
	const input = panel.querySelector(".collection-search input");
	const list = panel.querySelector(".collection-list");
	const count = panel.querySelector(".collection-count");
	const paint = () => {
		const query = input.value.trim().toLowerCase();
		const publishedPages =
			node.kind === "category"
				? visibleCategoryPages(node)
				: node.items.map(projectionNode).filter((page) => page?.kind === "page" && nodeIsVisible(page.id));
		const pages = publishedPages.filter((page) => `${page.label} ${page.description ?? ""}`.toLowerCase().includes(query));
		list.replaceChildren();
		count.textContent = `${pages.length} page${pages.length === 1 ? "" : "s"}`;
		if (!pages.length) {
			list.innerHTML = '<div class="collection-empty">No pages match this filter.</div>';
			return;
		}
		pages.forEach((page, index) => {
			const row = document.createElement("article");
			row.className = "collection-row";
			row.tabIndex = 0;
			row.innerHTML = '<span class="collection-index"></span><div class="collection-copy"><strong></strong><p></p></div><div class="collection-meta"><span>Published</span><span></span></div><span class="collection-arrow">-&gt;</span>';
			row.querySelector(".collection-index").textContent = String(index + 1).padStart(2, "0");
			row.querySelector("strong").textContent = page.label;
			row.querySelector("p").textContent = page.description ?? "Open this company page.";
			row.querySelector(".collection-meta span:last-child").textContent = page.view.type === "surface" ? "Surface" : "Built-in";
			row.onclick = () => void openProjectionNode(page.id);
			row.oncontextmenu = (event) => openNavContext(event, page, "collection");
			row.onkeydown = (event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					void openProjectionNode(page.id);
				}
			};
			list.appendChild(row);
		});
	};
	input.oninput = paint;
	paint();
}

function departmentStepIsValid() {
	if (departmentWizard.step === 1) return departmentWizard.type !== null;
	if (departmentWizard.step === 2) return departmentWizard.name.trim().length > 0;
	if (departmentWizard.type === "interface") return departmentWizard.template.length > 0;
	if (departmentWizard.repoMode === "local") return departmentWizard.repoPath.trim().length > 0;
	return (
		departmentWizard.repoUrl.trim().length > 0 &&
		$("repoUrl").validity.valid &&
		departmentWizard.clonePath.trim().length > 0
	);
}

function updateDepartmentActions() {
	$("departmentBack").hidden = departmentWizard.step === 1;
	$("departmentNext").hidden = departmentWizard.step === 3;
	$("departmentCreate").hidden = departmentWizard.step !== 3;
	$("departmentNext").disabled = !departmentStepIsValid();
	$("departmentCreate").disabled = !departmentStepIsValid();
}

function renderDepartmentWizard() {
	$("departmentStepType").hidden = departmentWizard.step !== 1;
	$("departmentStepName").hidden = departmentWizard.step !== 2;
	$("departmentStepSetup").hidden = departmentWizard.step !== 3;
	for (const step of document.querySelectorAll("[data-progress-step]")) {
		const value = Number(step.dataset.progressStep);
		step.classList.toggle("active", value === departmentWizard.step);
		step.classList.toggle("complete", value < departmentWizard.step);
	}
	for (const [id, type] of [
		["departmentTypeInterface", "interface"],
		["departmentTypeProduct", "product"],
	]) {
		const button = $(id);
		const selected = departmentWizard.type === type;
		button.classList.toggle("selected", selected);
		button.setAttribute("aria-pressed", String(selected));
	}
	$("departmentName").value = departmentWizard.name;
	$("departmentNameHelp").textContent =
		departmentWizard.type === "product"
			? "Use the product name people expect to see in the controller."
			: "Use the name people expect to see in the company interface.";
	$("interfaceSetup").hidden = departmentWizard.type !== "interface";
	$("productSetup").hidden = departmentWizard.type !== "product";
	for (const button of document.querySelectorAll("[data-template]")) {
		const selected = button.dataset.template === departmentWizard.template;
		button.classList.toggle("selected", selected);
		button.setAttribute("aria-pressed", String(selected));
	}
	$("localRepoMode").classList.toggle("active", departmentWizard.repoMode === "local");
	$("localRepoMode").setAttribute("aria-pressed", String(departmentWizard.repoMode === "local"));
	$("cloneRepoMode").classList.toggle("active", departmentWizard.repoMode === "clone");
	$("cloneRepoMode").setAttribute("aria-pressed", String(departmentWizard.repoMode === "clone"));
	$("localRepoFields").hidden = departmentWizard.repoMode !== "local";
	$("cloneRepoFields").hidden = departmentWizard.repoMode !== "clone";
	$("repoPath").value = departmentWizard.repoPath;
	$("repoUrl").value = departmentWizard.repoUrl;
	$("clonePath").value = departmentWizard.clonePath;
	updateDepartmentActions();
}

function focusDepartmentStep() {
	if (departmentWizard.step === 1) $("departmentTypeInterface").focus();
	else if (departmentWizard.step === 2) $("departmentName").focus();
	else if (departmentWizard.type === "interface") {
		document.querySelector(`[data-template="${departmentWizard.template}"]`)?.focus();
	} else if (departmentWizard.repoMode === "local") $("repoPath").focus();
	else $("repoUrl").focus();
}

function openDepartmentModal() {
	closeNavContext();
	closePanelContext();
	departmentWizard = {
		step: 1,
		type: null,
		name: "",
		template: "blank",
		repoMode: "local",
		repoPath: "",
		repoUrl: "",
		clonePath: "",
	};
	$("departmentModal").hidden = false;
	renderDepartmentWizard();
	requestAnimationFrame(focusDepartmentStep);
}

function closeDepartmentModal() {
	$("departmentModal").hidden = true;
	$("addDepartmentButton").focus();
}

function moveDepartmentStep(direction) {
	if (direction > 0 && !departmentStepIsValid()) return;
	departmentWizard.step = Math.max(1, Math.min(3, departmentWizard.step + direction));
	renderDepartmentWizard();
	requestAnimationFrame(focusDepartmentStep);
}

function finishDepartmentPreview() {
	if (!departmentStepIsValid()) return;
	const name = departmentWizard.name.trim();
	const template = document.querySelector(`[data-template="${departmentWizard.template}"] strong`)?.textContent;
	const setup =
		departmentWizard.type === "interface"
			? departmentWizard.template === "blank"
				? "from scratch"
				: `from the ${template} template`
			: departmentWizard.repoMode === "local"
				? "with a local repository"
				: "with a repository clone";
	closeDepartmentModal();
	showControllerToast(`${name} is ready to create ${setup}. The frontend is complete; the company command remains unbound.`);
}

function renderChats() {
	const panel = $("view-panel");
	panel.innerHTML = "";
	const head = document.createElement("div");
	head.className = "collection-head";
	const heading = document.createElement("h1");
	heading.textContent = "Chats";
	const create = document.createElement("button");
	create.textContent = "New company chat";
	create.onclick = () => void newCompanyChat();
	head.appendChild(heading);
	head.appendChild(create);
	panel.appendChild(head);
	const sessions = (state.sessions ?? []).filter((session) => session.kind !== "autonomous");
	if (!sessions.length) panel.insertAdjacentHTML("beforeend", '<div class="empty">No founder chats yet.</div>');
	for (const session of sessions) {
		const card = document.createElement("button");
		card.className = "projection-card chat-card";
		card.classList.toggle("active", currentSession === session.file);
		const label = document.createElement("strong");
		label.textContent = session.title;
		const meta = document.createElement("span");
		const page = session.page ? projectionNode(session.page) : undefined;
		const department = session.department
			? (state.departments ?? []).find((entry) => entry.path === session.department)
			: undefined;
		meta.textContent = [page?.label, department?.name, new Date(session.mtimeMs).toLocaleString()]
			.filter(Boolean)
			.join(" · ");
		card.appendChild(label);
		card.appendChild(meta);
		card.onclick = () => openSession(session.file);
		panel.appendChild(card);
	}
}

function renderProductChats(department, page) {
	const panel = $("view-panel");
	panel.innerHTML = "";
	const head = document.createElement("div");
	head.className = "collection-head";
	const heading = document.createElement("h1");
	heading.textContent = page.label;
	const create = document.createElement("button");
	create.textContent = "New product worktree chat";
	create.disabled = !department;
	create.onclick = () => void openDepartmentChat(department, page.id);
	head.appendChild(heading);
	head.appendChild(create);
	panel.appendChild(head);
	if (!department) {
		panel.insertAdjacentHTML("beforeend", '<div class="empty">Product department is unavailable.</div>');
		return;
	}
	const sessions = (state.sessions ?? []).filter(
		(session) => session.kind !== "autonomous" && session.department === department.path,
	);
	if (!sessions.length) {
		panel.insertAdjacentHTML("beforeend", '<div class="empty">No product worktree chats yet.</div>');
	}
	for (const session of sessions) {
		const card = document.createElement("button");
		card.className = "projection-card chat-card";
		card.classList.toggle("active", currentSession === session.file);
		const label = document.createElement("strong");
		label.textContent = session.title;
		const meta = document.createElement("span");
		meta.textContent = [session.worktree, new Date(session.mtimeMs).toLocaleString()].filter(Boolean).join(" · ");
		card.appendChild(label);
		card.appendChild(meta);
		card.onclick = () => openSession(session.file, page.id);
		panel.appendChild(card);
	}
}

async function openProjectionNode(id, updateRoute = true) {
	const node = projectionNode(id);
	if (!node) return;
	currentNodeId = id;
	if (updateRoute) setProjectionRoute(id);
	if (node.kind === "department" || node.kind === "category") {
		renderCollection(node);
		show("panel");
		renderCompanyNavSafe();
		return;
	}
	if (node.view.type === "surface") {
		showSurface(node);
		return;
	}
	const context = node.view.context ?? {};
	if (node.view.id === "qorpera.inbox") {
		renderInbox();
		show("panel");
	} else if (node.view.id === "qorpera.activity") {
		await renderActivity();
		show("panel");
	} else if (node.view.id === "qorpera.chats") {
		renderChats();
		show("panel");
	} else if (node.view.id === "qorpera.usage") {
		window.qorperaUsage.open({
			backendUrl,
			onBack: () => void openProjectionNode("q:main"),
		});
		show("usage");
	} else if (node.view.id === "qorpera.product-chat") {
		const department = (state.departments ?? []).find((entry) => entry.id === context.departmentId);
		renderProductChats(department, node);
		show("panel");
	} else if (node.view.id === "qorpera.pull-requests") {
		const department = (state.departments ?? []).find((entry) => entry.id === context.departmentId);
		showPullRequests(department, node);
	} else {
		const panel = $("view-panel");
		panel.innerHTML = "";
		const heading = document.createElement("h1");
		heading.textContent = context.title || node.label;
		const message = document.createElement("div");
		message.className = "empty";
		message.textContent = context.message || "This page is reserved for later.";
		panel.appendChild(heading);
		panel.appendChild(message);
		show("panel");
	}
	renderCompanyNavSafe();
}

async function openDepartmentChat(department, pageId) {
	cacheCurrentSession();
	const result = await window.qorpera.openChat(null, department.path);
	if (!result?.ok) {
		$("status").textContent = result?.error ?? "could not start product worktree";
		return;
	}
	currentSession = null;
	currentDepartment = result.department ?? null;
	currentWorktree = result.worktree ?? null;
	currentNodeId = pageId;
	setProjectionRoute(pageId);
	sidechatPageId = null;
	sidechatPending = null;
	$("messages").innerHTML = "";
	resetWorkGroup();
	show("chat");
	syncScopeChrome();
	hydrateAgentState(false);
}

function showPullRequests(department, page) {
	const panel = $("view-panel");
	panel.innerHTML = "";
	const heading = document.createElement("h1");
	heading.textContent = page.label;
	panel.appendChild(heading);
	const records = department?.pullRequests ?? [];
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
	show("panel");
}

function setupHierarchicalController() {
	$("addDepartmentButton").onclick = openDepartmentModal;
	$("resetPanelButton").onclick = () => {
		focusedDepartmentId = null;
		renderCompanyNavSafe();
		$("navigation").scrollTop = 0;
		showControllerToast("Panel reset. Manually hidden items remain hidden.");
	};
	$("conav").oncontextmenu = openPanelContext;

	$("adjustHeightButton").onclick = () => {
		$("contextActions").hidden = true;
		$("heightEditor").hidden = false;
		updateHeightEditor();
		placeFloatingMenu($("navContext"));
		$("heightSlider").focus();
	};
	$("focusDepartmentItem").onclick = toggleDepartmentFocus;
	$("hideNavigationItem").onclick = hideNavigationTarget;
	$("archiveNavigationItem").onclick = openArchiveConfirmation;
	$("heightSlider").oninput = () => setTargetHeight($("heightSlider").value);
	$("heightReset").onclick = () => setTargetHeight(0);
	$("heightDone").onclick = closeNavContext;

	$("archiveCancel").onclick = closeArchiveConfirmation;
	$("archiveConfirm").onclick = confirmArchivePreview;
	$("archiveModal").onpointerdown = (event) => {
		if (event.target === $("archiveModal")) closeArchiveConfirmation();
	};

	$("departmentClose").onclick = closeDepartmentModal;
	$("departmentCancel").onclick = closeDepartmentModal;
	$("departmentBack").onclick = () => moveDepartmentStep(-1);
	$("departmentTypeInterface").onclick = () => {
		departmentWizard.type = "interface";
		renderDepartmentWizard();
	};
	$("departmentTypeProduct").onclick = () => {
		departmentWizard.type = "product";
		renderDepartmentWizard();
	};
	$("departmentName").oninput = () => {
		departmentWizard.name = $("departmentName").value;
		updateDepartmentActions();
	};
	for (const button of document.querySelectorAll("[data-template]")) {
		button.onclick = () => {
			departmentWizard.template = button.dataset.template;
			renderDepartmentWizard();
		};
	}
	$("localRepoMode").onclick = () => {
		departmentWizard.repoMode = "local";
		renderDepartmentWizard();
		$("repoPath").focus();
	};
	$("cloneRepoMode").onclick = () => {
		departmentWizard.repoMode = "clone";
		renderDepartmentWizard();
		$("repoUrl").focus();
	};
	for (const [id, field] of [
		["repoPath", "repoPath"],
		["repoUrl", "repoUrl"],
		["clonePath", "clonePath"],
	]) {
		$(id).oninput = () => {
			departmentWizard[field] = $(id).value;
			updateDepartmentActions();
		};
	}
	$("browseRepo").onclick = () => showControllerToast("Repository browsing will bind to the trusted company command.");
	$("browseClonePath").onclick = () => showControllerToast("Destination browsing will bind to the trusted company command.");
	$("departmentForm").onsubmit = (event) => {
		event.preventDefault();
		if (departmentWizard.step < 3) moveDepartmentStep(1);
		else finishDepartmentPreview();
	};
	$("departmentModal").onpointerdown = (event) => {
		if (event.target === $("departmentModal")) closeDepartmentModal();
	};

	document.addEventListener("pointerdown", (event) => {
		if (!$("navContext").hidden && !$("navContext").contains(event.target)) closeNavContext();
		if (!$("panelContextMenu").hidden && !$("panelContextMenu").contains(event.target)) closePanelContext();
	});
	document.addEventListener("keydown", (event) => {
		if (event.key !== "Escape") return;
		if (!$("archiveModal").hidden) closeArchiveConfirmation();
		else if (!$("departmentModal").hidden) closeDepartmentModal();
		else if (!$("navContext").hidden) closeNavContext();
		else if (!$("panelContextMenu").hidden) closePanelContext();
	});
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
	$("view-panel").style.display = view === "panel" ? "block" : "none";
	$("view-usage").style.display = view === "usage" ? "block" : "none";
	renderCompanyNavSafe();
}
function renderCompanyNavSafe() {
	try {
		renderCompanyNav();
	} catch {
		/* pre-open */
	}
}

function showSurface(page) {
	currentNodeId = page.id;
	const frame = $("view-surface");
	const version = String(page.view.version ?? 0);
	if (frame.dataset.pageId !== page.id || frame.dataset.version !== version) {
		frame.src = `${backendUrl}/surface/${encodeURIComponent(page.view.entry)}?v=${version}`;
		frame.dataset.pageId = page.id;
		frame.dataset.version = version;
	}
	if (sidechatOpen && sidechatPageId !== page.id) void attachSidechat(page);
	$("sidechat-title").textContent = `Chat — ${page.label}`;
	show("surface");
	renderCompanyNavSafe();
}

// ---- sidechat: a session docked to one stable projection page ----------------

function pageSessions(pageId) {
	return (state.sessions ?? []).filter((session) => session.kind !== "autonomous" && session.page === pageId);
}

/** Attach the dock to this page: resume its latest tagged session, or
 * (fresh = true, or none yet) open a new one tagged to it. */
async function attachSidechat(page, fresh) {
	const latest = fresh ? undefined : pageSessions(page.id)[0];
	cacheCurrentSession();
	const result = await window.qorpera.openChat(latest ? latest.file : null);
	if (!result?.ok) return;
	currentSession = latest ? latest.file : null;
	currentDepartment = null;
	currentWorktree = null;
	sidechatPageId = page.id;
	sidechatPending = null;
	if (latest) {
		$("messages").innerHTML = sessionCache[latest.file] ?? '<div class="loading">loading session…</div>';
	} else {
		$("messages").innerHTML = "";
		// Tag the trail session with its stable page ID before any prompt — the
		// append-only trail can't be retro-tagged.
		window.qorpera.rpcSend({ type: "set_session_name", name: `page — ${page.id}` });
		sidechatPending = page;
	}
	resetWorkGroup();
	syncScopeChrome();
	renderCompanyNavSafe();
	hydrateAgentState(Boolean(latest));
}

function toggleSidechat(open) {
	sidechatOpen = open;
	const page = projectionNode(currentNodeId);
	if (open && page?.kind === "page" && page.view.type === "surface" && sidechatPageId !== page.id) {
		void attachSidechat(page);
	}
	if (page) $("sidechat-title").textContent = `Chat — ${page.label}`;
	show("surface");
}

function newSidechat() {
	const page = projectionNode(currentNodeId);
	if (!page || page.kind !== "page" || page.view.type !== "surface") return;
	void attachSidechat(page, true).then(() => {
		// A fresh chat over an already-empty thread looks like a no-op —
		// say what happened and put the cursor where the founder types next.
		$("status").textContent = `new chat on ${page.label} — earlier conversations stay under Chats`;
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
		open.onclick = () => openSession(session.file, "q:activity");
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
				await authorizedPost("/api/gate", { file: item.file, action: "approved" });
				await finish();
			}),
		);
		actions.appendChild(
			inboxAction("Deny", "no", async () => {
				await authorizedPost("/api/gate", { file: item.file, action: "denied" });
				await finish();
			}),
		);
	}
	if (
		item.kind === "gate" &&
		item.status === "consumed" &&
		(item.gateTool === "behavior_signature" || item.gateTool === "extension_load")
	) {
		actions.appendChild(
			inboxAction("Revoke trust", "no", async () => {
				await authorizedPost("/api/gate", { file: item.file, action: "denied" });
				await finish();
			}),
		);
	}

	if (item.kind === "message" && item.status === "pending") {
		// Settle: acknowledged, nothing to add — the controller reads the
		// acknowledgement next wake, same lane as a written response.
		actions.appendChild(
			inboxAction("Settle", "ok", async () => {
				await authorizedPost("/api/inbox/respond", {
					file: item.file,
					response: "Acknowledged — settled from the inbox.",
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
				await authorizedPost("/api/inbox/respond", { file: item.file, response: text.value });
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
		const name = String(sidechatPending.label).replace(/[[\]]/g, ")");
		const entry = String(sidechatPending.view.entry).replace(/[[\]]/g, ")");
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

	if (settingsTab === "appearance") {
		const heading = document.createElement("header");
		heading.className = "settings-heading";
		heading.innerHTML = '<div class="eyebrow">Interface</div><h1>Appearance</h1><p>Control how the company structure is presented to you. These preferences affect the interface only.</p>';
		content.appendChild(heading);
		const group = document.createElement("section");
		group.className = "settings-group";
		group.innerHTML = '<header><h2>Navigation type indicators</h2><p>Use a restrained color wash to distinguish direct pages from categories.</p></header>';
		content.appendChild(group);
		const appearance = navAppearance();
		const showKinds = document.createElement("input");
		showKinds.type = "checkbox";
		showKinds.setAttribute("aria-label", "Show navigation type hues");
		showKinds.checked = appearance.showKinds;
		const pageHue = document.createElement("input");
		pageHue.type = "color";
		pageHue.setAttribute("aria-label", "Page navigation hue");
		pageHue.value = appearance.pageHue;
		const categoryHue = document.createElement("input");
		categoryHue.type = "color";
		categoryHue.setAttribute("aria-label", "Category navigation hue");
		categoryHue.value = appearance.categoryHue;
		pageHue.className = "appearance-color";
		categoryHue.className = "appearance-color";
		const preview = document.createElement("div");
		preview.className = "appearance-preview";
		const pagePreview = document.createElement("div");
		pagePreview.className = "preview-navigation-row";
		pagePreview.textContent = "Cashflow Overview";
		const categoryPreview = document.createElement("div");
		categoryPreview.className = "preview-navigation-row";
		categoryPreview.textContent = "Forecasting";
		preview.appendChild(pagePreview);
		preview.appendChild(categoryPreview);
		const save = () => {
			localStorage.setItem(
				navStorageKey("nav-appearance"),
				JSON.stringify({ showKinds: showKinds.checked, pageHue: pageHue.value, categoryHue: categoryHue.value }),
			);
			pageHue.disabled = !showKinds.checked;
			categoryHue.disabled = !showKinds.checked;
			preview.classList.toggle("hues-hidden", !showKinds.checked);
			pagePreview.style.setProperty("--preview-hue", pageHue.value);
			categoryPreview.style.setProperty("--preview-hue", categoryHue.value);
			applyNavAppearance();
			renderCompanyNavSafe();
		};
		showKinds.onchange = save;
		pageHue.oninput = save;
		categoryHue.oninput = save;
		setRow(group, "Show type hues", "Display the indicator at the left edge of each navigation row.", showKinds);
		setRow(group, "Page hue", "Direct pages and surfaces", pageHue);
		setRow(group, "Category hue", "Folders that open a list of pages", categoryHue);
		group.appendChild(preview);
		const reset = document.createElement("button");
		reset.textContent = "Reset to defaults";
		reset.onclick = () => {
			localStorage.removeItem(navStorageKey("nav-appearance"));
			applyNavAppearance();
			renderCompanyNavSafe();
			renderSettingsTab();
		};
		const actions = document.createElement("div");
		actions.className = "appearance-actions";
		actions.appendChild(reset);
		group.appendChild(actions);
		const sizing = document.createElement("p");
		sizing.className = "sess-meta";
		sizing.textContent = "Right-click any department or navigation row to adjust its height by +/-12px.";
		group.appendChild(sizing);
		save();
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
			const res = await authorizedPost("/api/authority/config", {
				classes: {
					money: { mode: money.value, limitUsd: Number(limit.value) || 50 },
					identity: { mode: identity.value },
					irreversible: { mode: irreversible.value },
				},
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
			const res = await authorizedPost("/api/authority", { content: editor.value });
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

setupHierarchicalController();
setupSidebarToggle();
applyNavAppearance();

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
