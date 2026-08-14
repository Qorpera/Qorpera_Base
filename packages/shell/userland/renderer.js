/* Renderer chrome. Static by design — company and session state arrives from
 * backend read models; the RPC pipe carries the attached provider's content
 * stream and direct commands. */
const $ = (id) => document.getElementById(id);
let backendUrl = "";
// Stable company identity from the kernel (appInfo). Storage is keyed by
// this, never by backendUrl: the backend port is hash-derived from a small
// space and walks forward on bind collisions, so a port-keyed pref bucket
// can silently change between opens.
let companyId = "";
let state = {
	projection: {
		schema: "qorpera.projection/v1",
		default: "q:chats",
		navigation: [],
		nodes: [],
		diagnostics: [],
	},
	inbox: [],
	sessions: [],
	departments: [],
	runtime: { revision: 0, generatedAt: "", sessions: [] },
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
let runtimeStream = null;
let hydratedExecutorId = "";
const runtimeAttachmentSequences = new Map();
let navigationGeneration = 0;
let sidechatGeneration = 0;
let activityRenderGeneration = 0;
let currentModelKey = "";
let preferredModelKey = "";
let currentEffort = "";
let currentSpeed = "standard";
let speedAsserted = false; // one re-assert of the remembered speed per child spawn
let modelMoveAsserted = false; // one off-slate model migration per child spawn
let modelPreferencePending = false;
let modelStateHydrated = false;
let modelCatalogHydrated = false;
let agentWorking = false; // a run is streaming; the composer shows Stop
let agentExited = false;
let runtimeReconnecting = false;
let pendingRewind = null; // { text } awaiting get_fork_messages for edit-and-resend
let lastSubmittedPrompt = null; // { text, images } — retained so a failed model call can be retried
let activeRunProgress = null; // completed steps and known file changes for the current founder turn
let turnFailureCard = null;
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
};
let scheduledJobPanel = null; // { mode: "view"|"create"|"run", id?, file?, draft?, dirty, error?, pending? }

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

/** The hub is a full-screen launcher in <main> (#view-hub) — no sidebar,
 * no empty sheet. body.hub gates its visibility and hides the nav chrome. */
async function renderHub() {
	document.body.classList.add("hub");
	document.title = "Qorpera Base";
	const companies = await window.qorpera.listCompanies();
	const grid = $("hubCompanies");
	grid.innerHTML = "";
	for (const company of companies) {
		const card = document.createElement("button");
		card.className = "hub-card";
		card.type = "button";
		card.title = company.root;
		const mono = document.createElement("span");
		mono.className = "monogram";
		mono.textContent = (company.name || "?").slice(0, 1).toUpperCase();
		const label = document.createElement("strong");
		label.textContent = company.name;
		const path = document.createElement("small");
		path.textContent = company.root;
		card.append(mono, label, path);
		card.onclick = () => {
			// The click must visibly land: opening provisions the sandbox and
			// forks userland, which takes seconds — spin the card, quiet the rest.
			if (document.body.classList.contains("hub-opening")) return;
			document.body.classList.add("hub-opening");
			card.classList.add("loading");
			const spinner = document.createElement("span");
			spinner.className = "hub-spinner";
			card.appendChild(spinner);
			openCompany(company.root).then((opened) => {
				// Success reloads this window into the company; reaching here
				// means the open failed — hand the hub back.
				if (!opened) {
					document.body.classList.remove("hub-opening");
					card.classList.remove("loading");
					spinner.remove();
				}
			});
		};
		grid.appendChild(card);
	}
	const create = document.createElement("button");
	create.className = "hub-card create";
	create.type = "button";
	create.innerHTML =
		'<span class="plus">+</span><strong>New company controller</strong><small>Name it — the controller does the rest</small>';
	create.onclick = openCompanyModal;
	grid.appendChild(create);
}

// ---- founding a company: name in, controller out -----------------------------
// The founder names the company; the machine derives the folder (the registry
// convention: C:\Companies\<slug>). Electron has no window.prompt() — it
// throws — so the flow lives in an in-chrome modal (#companyModal).

const COMPANIES_HOME = "C:\\Companies";

function companySlug(name) {
	return String(name)
		.toLowerCase()
		.replace(/['’]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function companyRootFor(name) {
	const slug = companySlug(name);
	return slug ? `${COMPANIES_HOME}\\${slug}` : "";
}

function openCompanyModal() {
	$("companyName").value = "";
	$("companyPathPreview").textContent = "Lives under C:\\Companies";
	$("companyCreate").disabled = true;
	$("companyModal").hidden = false;
	$("companyName").focus();
}

function closeCompanyModal() {
	$("companyModal").hidden = true;
}

function setupCompanyModal() {
	const input = $("companyName");
	input.addEventListener("input", () => {
		const root = companyRootFor(input.value.trim());
		$("companyPathPreview").textContent = root ? `Will live at ${root}` : "Lives under C:\\Companies";
		$("companyCreate").disabled = !root;
	});
	input.addEventListener("keydown", (event) => {
		if (event.key === "Escape") closeCompanyModal();
	});
	$("companyCancel").onclick = closeCompanyModal;
	$("companyModal").addEventListener("click", (event) => {
		if (event.target === $("companyModal")) closeCompanyModal();
	});
	$("companyForm").addEventListener("submit", async (event) => {
		event.preventDefault();
		const root = companyRootFor(input.value.trim());
		if (!root) return;
		const button = $("companyCreate");
		button.disabled = true;
		button.textContent = "Creating…";
		try {
			const created = await window.qorpera.newCompany(root);
			closeCompanyModal();
			await openCompany(created);
		} catch (error) {
			alert(`Could not create the company:\n${(error && error.message) || error}`);
		} finally {
			button.textContent = "Create controller";
			button.disabled = false;
		}
	});
}

// ---- company ---------------------------------------------------------------

async function openCompany(root) {
	// The kernel forks/loads the company's own userland and reloads this
	// window into it; this page's job ends here. Returns false on failure so
	// the hub can hand control back (clear spinners, re-enable cards).
	try {
		await window.qorpera.openCompany(root);
		return true;
	} catch (error) {
		alert(`Could not open the company:\n${(error && error.message) || error}`);
		return false;
	}
}

/** Boot into an already-open company (called after the kernel loads us). */
async function enterCompany(active) {
	backendUrl = active.backendUrl;
	companyId = active.id || "";
	// Appearance was applied at boot from the pre-company bucket; re-apply now
	// that this company's stored appearance is addressable.
	applyNavAppearance();
	hiddenNavigation = new Set(readStoredArray("nav-hidden"));
	archivedNavigation = new Set();
	focusedDepartmentId = null;
	document.body.classList.remove("hub");
	$("hubnav").style.display = "none";
	$("conav").style.display = "";
	$("messages").innerHTML = "";
	resetWorkGroup();
	// The kernel resumes the newest founder session across restarts; adopt its
	// trail file so the chat pile marks it active and caching keys line up.
	currentSession = active.sessionFile ?? null;
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
	hydratedExecutorId = runtimeForTrail(currentSession)?.executorId ?? "";
	connectSessionRuntime();
	document.title = `${state.name || "Company"} Controller`;
	// The titlebar shows no company title next to the sidebar toggle; only
	// the OS window title carries the "<name> Controller" label.
	$("wordmark").hidden = true;
	if (poller) clearInterval(poller);
	poller = setInterval(refreshState, 2000);
}

function runtimeForTrail(trailFile) {
	if (!trailFile) return null;
	return (state.runtime?.sessions ?? []).find((session) => session.trailFile === trailFile) ?? null;
}

let lastInterruptedRuntime = "";

/** Chat continuity belongs to the saved session. A provider process can be
 * replaced without changing which conversation the founder is in. */
function applyCurrentSessionRuntime() {
	const runtime = runtimeForTrail(currentSession);
	if (!runtime) {
		runtimeReconnecting = false;
		agentExited = false;
		agentWorking = false;
		$("status").textContent = "connecting…";
		$("stopBtn").hidden = true;
		return;
	}
	const terminalKey = `${runtime.trailFile}:${runtime.executorId}:${runtime.updatedAt}`;
	if (runtime.status === "running") {
		runtimeReconnecting = false;
		agentExited = false;
		agentWorking = true;
		$("status").textContent = "working…";
		$("stopBtn").hidden = false;
		return;
	}
	if (runtime.status === "reconnecting") {
		runtimeReconnecting = true;
		agentExited = false;
		agentWorking = false;
		$("status").textContent = `reconnecting${runtime.reconnectAttempt ? ` (${runtime.reconnectAttempt}/3)` : ""}…`;
		$("stopBtn").hidden = true;
		return;
	}
	if (runtime.status === "interrupted") {
		runtimeReconnecting = false;
		agentExited = true;
		agentWorking = false;
		closeWorkGroup();
		$("status").textContent = "controller stopped";
		$("stopBtn").hidden = true;
		if (lastInterruptedRuntime !== terminalKey) {
			lastInterruptedRuntime = terminalKey;
			addMsg(
				"log",
				"This saved session lost its runtime. Reopen it to attach a new runtime without losing the conversation.",
			);
		}
		return;
	}
	if (runtime.status === "starting") {
		runtimeReconnecting = false;
		agentExited = false;
		agentWorking = false;
		$("status").textContent = "connecting…";
		$("stopBtn").hidden = true;
		return;
	}
	if (runtime.status === "detached") {
		runtimeReconnecting = false;
		agentExited = true;
		agentWorking = false;
		$("status").textContent = "session saved — runtime detached";
		$("stopBtn").hidden = true;
		return;
	}
	runtimeReconnecting = false;
	agentExited = false;
	agentWorking = false;
	$("status").textContent = runtime.turnInterrupted ? "reconnected — previous turn interrupted" : "idle";
	$("stopBtn").hidden = true;
	if (runtime.turnInterrupted && lastInterruptedRuntime !== terminalKey) {
		lastInterruptedRuntime = terminalKey;
		addMsg(
			"log",
			"Runtime reconnected. The saved conversation is intact, but the previous request did not complete.",
		);
	}
}

function updateLiveAgentNarration() {
	const hero = document.querySelector("#view-panel .activity-layout .agent-tile-wide.running");
	if (!hero?.dataset.trail) return false;
	const runtime = runtimeForTrail(hero.dataset.trail);
	const doing = hero.querySelector(".agent-tile-doing");
	if (!runtime || !doing) return false;
	doing.textContent = runtimeDoingLine(runtime);
	return true;
}

function applyRuntimeSnapshot(snapshot, eventKind = "") {
	if (!snapshot || !Array.isArray(snapshot.sessions)) return;
	if ((snapshot.revision ?? 0) < (state.runtime?.revision ?? 0)) return;
	state.runtime = snapshot;
	for (const session of snapshot.sessions) {
		if (!Number.isSafeInteger(session.attachmentSequence)) continue;
		const known = runtimeAttachmentSequences.get(session.trailFile) ?? 0;
		if (session.attachmentSequence > known) {
			runtimeAttachmentSequences.set(session.trailFile, session.attachmentSequence);
		}
	}
	const runtimeByTrail = new Map(snapshot.sessions.map((session) => [session.trailFile, session]));
	state.sessions = (state.sessions ?? []).map((session) => ({
		...session,
		runtime: runtimeByTrail.get(session.file),
	}));
	applyCurrentSessionRuntime();
	const currentRuntime = runtimeForTrail(currentSession);
	if (
		eventKind === "executor_ready" &&
		currentRuntime?.executorId &&
		currentRuntime.executorId !== hydratedExecutorId
	) {
		hydratedExecutorId = currentRuntime.executorId;
		hydrateAgentState(true);
	}
	if (currentView === "panel" && projectionNode(currentNodeId)?.view?.id === "qorpera.activity") {
		if (eventKind !== "activity" || !updateLiveAgentNarration()) void renderActivity();
	}
}

function applyRuntimeDelta(payload) {
	if (!payload?.session || !Number.isFinite(payload.revision)) return;
	if (payload.revision <= (state.runtime?.revision ?? 0)) return;
	const sessions = [...(state.runtime?.sessions ?? [])];
	const index = sessions.findIndex((session) => session.trailFile === payload.session.trailFile);
	if (index >= 0) sessions[index] = payload.session;
	else sessions.push(payload.session);
	applyRuntimeSnapshot(
		{
			revision: payload.revision,
			generatedAt: payload.generatedAt ?? "",
			sessions,
		},
		payload.event?.kind ?? "",
	);
}

function connectSessionRuntime() {
	runtimeStream?.close();
	runtimeStream = null;
	if (!backendUrl || typeof EventSource === "undefined") return;
	const stream = new EventSource(`${backendUrl}/api/runtime`);
	const read = (event) => {
		try {
			const payload = JSON.parse(event.data);
			if (payload.snapshot) applyRuntimeSnapshot(payload.snapshot, payload.event?.kind ?? "");
			else if (payload.session) applyRuntimeDelta(payload);
			else applyRuntimeSnapshot(payload, payload.event?.kind ?? "");
		} catch {
			// A later snapshot repairs any malformed or interrupted frame.
		}
	};
	stream.addEventListener("snapshot", read);
	stream.addEventListener("runtime", read);
	runtimeStream = stream;
}

function sendRpc(frame) {
	return window.qorpera.rpcSend(frame, currentSession ?? undefined);
}

window.addEventListener("beforeunload", () => runtimeStream?.close());

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
		fillOption(
			button,
			options.find((o) => o.value === value),
		);
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
// priority lane (the OpenAI responses APIs today), disabled with a note
// otherwise.

// The picker offers a curated slate, not the raw provider catalogs: the
// Claude 5 pair plus the GPT-5.6 pair. Sol/Terra prefer the ChatGPT
// subscription lane (openai-codex) and fall back to the API-key provider.
// If none of the slate is available (unusual auth setup), fall back to the
// full catalog rather than an empty picker.
const CURATED_MODELS = [
	["anthropic::claude-fable-5"],
	["anthropic::claude-opus-5"],
	["openai-codex::gpt-5.6-sol", "openai::gpt-5.6-sol"],
	["openai-codex::gpt-5.6-terra", "openai::gpt-5.6-terra"],
];
function curateModels(models) {
	const byValue = new Map(models.map((m) => [m.value, m]));
	const picked = [];
	for (const lanes of CURATED_MODELS) {
		for (const value of lanes) {
			const model = byValue.get(value);
			if (model) {
				picked.push(model);
				break;
			}
		}
	}
	return picked.length ? picked : models;
}
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
		// Curate here too: caches written before the slate existed hold the
		// full provider catalogs.
		if (Array.isArray(cached?.models) && cached.models.length) models = curateModels(cached.models);
		if (Array.isArray(cached?.levels) && cached.levels.length) levels = cached.levels;
		if (!currentModelKey && typeof cached?.modelKey === "string") {
			currentModelKey = cached.modelKey;
			preferredModelKey = cached.modelKey;
		}
		if (!currentEffort && typeof cached?.effort === "string") currentEffort = cached.effort;
		if (cached?.speed === "fast" || cached?.speed === "standard") currentSpeed = cached.speed;
	} catch {
		// unreadable cache: start empty, the live child fills it in
	}
	const persist = () => {
		try {
			localStorage.setItem(
				CACHE_KEY,
				JSON.stringify({
					models,
					levels,
					modelKey: preferredModelKey || currentModelKey,
					effort: currentEffort,
					speed: currentSpeed,
				}),
			);
		} catch {
			// storage unavailable — the cache is a nicety, never load-bearing
		}
	};
	const EFFORT_LABELS = {
		off: "Off",
		minimal: "Minimal",
		low: "Low",
		medium: "Medium",
		high: "High",
		xhigh: "Extra High",
		max: "Max",
	};
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
			: "This model's API has no priority lane — fast responses ride the GPT-5.6 models";
		list.innerHTML = "";
		for (const model of models) {
			const item = document.createElement("button");
			item.type = "button";
			item.className = model.value === currentModelKey ? "selected" : "";
			item.textContent = model.name;
			item.onclick = () => {
				currentModelKey = model.value;
				preferredModelKey = model.value;
				const [provider, modelId] = model.value.split("::");
				sendRpc({ type: "set_model", provider, modelId });
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
		sendRpc({ type: "set_thinking_level", level });
	};
	speed.onclick = () => {
		if (speed.disabled) return;
		currentSpeed = currentSpeed === "fast" ? "standard" : "fast";
		sendRpc({ type: "set_response_speed", speed: currentSpeed });
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
		hasModel(value) {
			return models.some((model) => model.value === value);
		},
		nameFor(value) {
			return models.find((model) => model.value === value)?.name;
		},
		sync,
	};
})();
function reassertPreferredModel() {
	if (!modelPreferencePending || !modelStateHydrated || !modelCatalogHydrated) return;
	modelPreferencePending = false;
	if (!preferredModelKey || !modelCtl.hasModel(preferredModelKey) || currentModelKey === preferredModelKey) return;
	currentModelKey = preferredModelKey;
	const [provider, modelId] = preferredModelKey.split("::");
	sendRpc({ type: "set_model", provider, modelId });
	modelCtl.sync();
}
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
	const options = [
		{
			value: "",
			label: state.name ? `${state.name} Controller` : "Company",
			icon: COMPANY_ICON,
		},
	];
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
	const navigation = ++navigationGeneration;
	const next = picked || null;
	if (next === currentDepartment) return;
	cacheCurrentSession();
	const result = await window.qorpera.openChat(null, next ?? undefined);
	if (result?.ok) {
		currentSession = result.sessionFile ?? null;
		currentDepartment = result.department ?? null;
		currentWorktree = result.worktree ?? null;
		sidechatPageId = null;
		sidechatPending = null;
	}
	if (navigation !== navigationGeneration) return;
	if (!result?.ok) {
		scopeChip.value = currentDepartment ?? "";
		return;
	}
	$("messages").innerHTML = "";
	resetWorkGroup();
	show("chat");
	syncScopeChrome();
	renderCompanyNavSafe();
	hydrateAgentState(false);
});

/** The bottom profile row carries the company: its name and initials. */
function renderProfileRow() {
	const name = state.name || "Company";
	const words = name.trim().split(/\s+/).filter(Boolean);
	$("coProfileName").textContent = name;
	$("coProfileAvatar").textContent = (
		words
			.slice(0, 2)
			.map((word) => word[0])
			.join("") || "C"
	).toUpperCase();
}

async function refreshState() {
	try {
		const next = await (await fetch(`${backendUrl}/api/state`)).json();
		// Polling and SSE are independent transports. Never let an older poll
		// response roll lifecycle backward over a newer streamed revision.
		if ((next.runtime?.revision ?? 0) < (state.runtime?.revision ?? 0)) {
			next.runtime = state.runtime;
			const runtimeByTrail = new Map((state.runtime?.sessions ?? []).map((session) => [session.trailFile, session]));
			next.sessions = (next.sessions ?? []).map((session) => ({
				...session,
				runtime: runtimeByTrail.get(session.file),
			}));
		}
		if (JSON.stringify(next) !== JSON.stringify(state)) {
			state = next;
			applyCurrentSessionRuntime();
			renderCompanyNav();
			renderProfileRow();
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
	hydratedExecutorId = runtimeForTrail(currentSession)?.executorId ?? "";
	speedAsserted = false;
	modelMoveAsserted = false;
	modelPreferencePending = !withHistory && Boolean(preferredModelKey);
	modelStateHydrated = false;
	modelCatalogHydrated = false;
	$("stopBtn").hidden = true;
	if (withHistory) sendRpc({ type: "get_messages" });
	const askState = () => {
		sendRpc({ type: "get_state" });
		sendRpc({ type: "get_available_models" });
		sendRpc({ type: "get_available_thinking_levels" });
	};
	askState();
	setTimeout(askState, 900);
	applyCurrentSessionRuntime();
}

function cacheCurrentSession() {
	if (currentSession) sessionCache[currentSession] = $("messages").innerHTML;
}

async function openSession(file, pageId = "q:chats") {
	const navigation = ++navigationGeneration;
	// Re-clicking the chat that is already live must only bring its view back —
	// the old path restarted the agent child, aborting any in-flight run
	// (navigate away, click back, and the streaming answer died mid-thought).
	if (file && file === currentSession && !agentExited) {
		currentNodeId = pageId;
		setProjectionRoute(pageId);
		show("chat");
		syncScopeChrome();
		renderCompanyNavSafe();
		return;
	}
	cacheCurrentSession();
	// Product chats restore the exact department/worktree role capability
	// recorded in their append-only session name.
	const summary = (state.sessions ?? []).find((s) => s.file === file);
	const result = await window.qorpera.openChat(file, summary?.department, summary?.worktree).catch((error) => ({
		ok: false,
		error: String(error?.message ?? error),
	}));
	if (result?.ok) {
		currentSession = result.sessionFile ?? file;
		currentDepartment = result.department ?? null;
		currentWorktree = result.worktree ?? null;
		sidechatPageId = null;
		sidechatPending = null;
	}
	if (navigation !== navigationGeneration) return;
	if (!result?.ok) {
		// A dead click teaches the founder nothing — say why the chat
		// wouldn't open (legacy-migration refusals land here too).
		showControllerToast(result?.error ? `could not open this chat: ${result.error}` : "could not open this chat");
		return;
	}
	currentNodeId = pageId;
	setProjectionRoute(pageId);
	// Cached pages show instantly; fresh ones get the text-line skeleton.
	// Either way the live child re-hydrates and replaces once ready.
	$("messages").innerHTML = sessionCache[file] ?? pageSkeletonMarkup();
	resetWorkGroup();
	show("chat");
	syncScopeChrome();
	renderCompanyNavSafe();
	hydrateAgentState(true);
}

async function newCompanyChat() {
	const navigation = ++navigationGeneration;
	cacheCurrentSession();
	const result = await window.qorpera.openChat(null);
	if (result?.ok) {
		currentSession = result.sessionFile ?? null;
		currentDepartment = null;
		currentWorktree = null;
		sidechatPageId = null;
		sidechatPending = null;
	}
	if (navigation !== navigationGeneration) return;
	if (!result?.ok) return;
	currentNodeId = "q:chats";
	setProjectionRoute("q:chats");
	$("messages").innerHTML = "";
	resetWorkGroup();
	show("chat");
	syncScopeChrome();
	renderCompanyNavSafe();
	hydrateAgentState(false);
}

async function newChat() {
	const navigation = ++navigationGeneration;
	cacheCurrentSession();
	// "+" keeps an existing product worktree. The department Chat row starts
	// a separate task in a fresh worktree.
	const result = await window.qorpera.openChat(null, currentDepartment ?? undefined, currentWorktree ?? undefined);
	if (result?.ok) {
		currentSession = result.sessionFile ?? null;
		currentDepartment = result.department ?? null;
		currentWorktree = result.worktree ?? null;
		sidechatPageId = null;
		sidechatPending = null;
	}
	if (navigation !== navigationGeneration) return;
	if (!result?.ok) return;
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
	lastSubmittedPrompt = null;
	turnFailureCard = null;
	let historyProgress = createRunProgress();
	let historyPrompt = null;
	let historyFailureShown = false;
	const historyToolCalls = new Map();
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
			const raw = parts
				.filter((p) => p.type === "text")
				.map((p) => p.text)
				.join("\n");
			// The sidechat context preamble is plumbing, not something the
			// founder typed — show the message as they wrote it.
			const text = raw.replace(/^\[Sidechat context:[^\]]*\]\s*/, "");
			const imageUrls = parts
				.filter((p) => p.type === "image" && p.data)
				.map((p) => `data:${p.mimeType};base64,${p.data}`);
			if (text || imageUrls.length) {
				group = null;
				appendMsgImages(decorateUserMsg(addMsg("user", text), text), imageUrls);
				historyPrompt = {
					text,
					images: imageUrls.map((dataUrl, index) => ({
						mimeType: parts.filter((p) => p.type === "image" && p.data)[index]?.mimeType,
						dataUrl,
					})),
				};
				lastSubmittedPrompt = historyPrompt;
				historyProgress = createRunProgress();
				historyFailureShown = false;
				historyToolCalls.clear();
			}
		} else if (message.role === "assistant") {
			for (const part of message.content ?? []) {
				if (part.type === "text" && part.text) {
					group = null;
					renderMarkdown(addMsg("assistant", ""), part.text);
				}
				if (part.type === "toolCall") {
					groupLine(`✓ ${part.name} ${summarizeArgs(part.arguments)}`);
					if (part.id)
						historyToolCalls.set(part.id, {
							name: part.name,
							args: part.arguments,
						});
				}
			}
			if (message.stopReason === "error" && !historyFailureShown) {
				group = null;
				addModelFailureCard(message.errorMessage, historyProgress, historyPrompt);
				historyFailureShown = true;
			}
		} else if (message.role === "toolResult" && message.isError === false) {
			const tool = historyToolCalls.get(message.toolCallId) ?? {
				name: message.toolName,
				args: undefined,
			};
			recordCompletedTool(historyProgress, tool.name, tool.args);
		}
	}
	activeRunProgress = historyProgress;
	$("messages").scrollTop = $("messages").scrollHeight;
}

function projectionNode(id) {
	return (state.projection?.nodes ?? []).find((node) => node.id === id);
}

function navStorageKey(name) {
	return `qorpera:${companyId || "base"}:${name}`;
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
	const stored = readStoredObject("nav-appearance", {});
	const appearance = {
		pageHue: "#3b82f6",
		categoryHue: "#8b5cf6",
		showKinds: true,
		density: "compact", // "compact" | "chats" (chunky chat rows) | "all"
		...stored,
	};
	// 0.18.0 stored a boolean; fold it into the density scale.
	if (!stored.density && stored.chunkySessions) appearance.density = "chats";
	return appearance;
}

function applyNavAppearance() {
	const appearance = navAppearance();
	document.documentElement.style.setProperty("--page-hue", appearance.pageHue);
	document.documentElement.style.setProperty("--category-hue", appearance.categoryHue);
	document.body.classList.toggle("hues-hidden", !appearance.showKinds);
	document.body.classList.toggle("chunky-sessions", appearance.density !== "compact");
	document.body.classList.toggle("chunky-nav", appearance.density === "all");
}

function applyNavMetrics(element, node, focused = false) {
	const heights = readStoredObject("nav-heights", {});
	const chunkyNav = navAppearance().density === "all";
	const offset = Math.max(-12, Math.min(12, Number(heights[node.id]) || 0));
	const baseHeight = node.kind === "department" ? (chunkyNav ? 32 : 27) : focused ? 58 : chunkyNav ? 40 : 30;
	const scale = 1 + offset / 60;
	element.style.setProperty("--nav-item-height", `${baseHeight + offset}px`);
	element.style.setProperty(
		"--nav-font-size",
		`${(node.kind === "department" ? (chunkyNav ? 13.5 : 13) : focused ? 13.5 : chunkyNav ? 13 : 12.5) * scale}px`,
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
	return (state.projection?.navigation ?? []).map(projectionNode).filter((node) => node?.kind === "department");
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
			hidden.push({
				id: child.id,
				label: child.label,
				detail: child.kind === "category" ? "Category" : "Page",
			});
		}
		if (child.kind !== "category") continue;
		for (const pageId of child.items) {
			const page = projectionNode(pageId);
			if (page?.kind === "page" && hiddenNavigation.has(page.id)) {
				hidden.push({
					id: page.id,
					label: page.label,
					detail: `${child.label} / Page`,
				});
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
	$("contextTitle").textContent = `${node.kind} / ${displayLabel(node)}`;
	$("contextActions").hidden = false;
	$("heightEditor").hidden = true;
	$("iconEditor").hidden = true;
	// Chats are trail sessions, not projection nodes: pinnable, but height /
	// hide / archive act on projection ids and stay out of their menu.
	const isChat = node.kind === "chat";
	const canAdjust = placement !== "collection" && !isChat;
	$("adjustHeightButton").hidden = !canAdjust;
	$("focusDepartmentItem").hidden = node.kind !== "department";
	$("renameDepartmentItem").hidden = node.kind !== "department";
	$("changeIconItem").hidden = node.kind !== "department";
	$("contextHeightSeparator").hidden = (!canAdjust && node.kind !== "department") || isChat;
	$("hideNavigationItem").hidden = isChat;
	$("archiveNavigationItem").hidden = isChat;
	$("focusDepartmentItem").querySelector("span").textContent =
		focusedDepartmentId === node.id ? "Exit focus" : "Focus department";
	$("focusDepartmentItem").querySelector("small").textContent =
		focusedDepartmentId === node.id ? "Restore the complete panel" : "Show only this department";
	const pinned = isPinned(contextPinKey(navContextTarget));
	$("pinNavigationItem").querySelector("span").textContent = pinned ? "Unpin" : "Pin";
	$("pinNavigationItem").querySelector("small").textContent = pinned
		? "Remove from Pinned"
		: node.kind === "department"
			? "Order this department first"
			: "Keep at the top of the panel";
	$("navContext").hidden = false;
	placeFloatingMenu($("navContext"));
	(canAdjust ? $("adjustHeightButton") : isChat ? $("pinNavigationItem") : $("hideNavigationItem")).focus();
}

/** Context menu for a chat row: a pseudo-node keyed by its trail file. */
function openSessionContext(event, session) {
	openNavContext(event, { kind: "chat", id: session.file, label: session.title }, "session");
}

/** Inline rename: the department title label becomes an input until
 * Enter/blur commits (empty restores the projection label) or Escape cancels.
 * Presentation override only — the projection document is never modified. */
function startDepartmentRename(department) {
	closeNavContext();
	const group = document.querySelector(`.projection-department[data-department-id="${CSS.escape(department.id)}"]`);
	const label = group?.querySelector(".projection-department-label");
	if (!label) return;
	const input = document.createElement("input");
	input.className = "dept-rename-input";
	input.type = "text";
	input.maxLength = 64;
	input.value = displayLabel(department);
	input.setAttribute("aria-label", `Rename ${department.label}`);
	let done = false;
	const finish = (commit) => {
		if (done) return;
		done = true;
		if (commit) {
			const value = input.value.trim();
			setNavOverride(department.id, {
				label: value === department.label ? null : value || null,
			});
		}
		renderCompanyNavSafe();
	};
	input.onkeydown = (event) => {
		if (event.key === "Enter") finish(true);
		else if (event.key === "Escape") finish(false);
	};
	input.onblur = () => finish(true);
	input.onclick = (event) => event.stopPropagation();
	label.replaceWith(input);
	input.focus();
	input.select();
}

function openIconEditor() {
	if (!navContextTarget) return;
	const department = navContextTarget.node;
	$("contextActions").hidden = true;
	$("heightEditor").hidden = true;
	$("iconEditor").hidden = false;
	const grid = $("iconGrid");
	grid.innerHTML = "";
	const current = navOverrides()[department.id]?.icon;
	for (const name of DEPARTMENT_ICON_CHOICES) {
		const button = document.createElement("button");
		button.type = "button";
		button.innerHTML = navGlyphSvg(name, "dept-glyph");
		button.title = name;
		button.classList.toggle("selected", current === name);
		button.onclick = () => {
			setNavOverride(department.id, { icon: name });
			renderCompanyNavSafe();
			closeNavContext();
		};
		grid.appendChild(button);
	}
	placeFloatingMenu($("navContext"));
	grid.querySelector("button")?.focus();
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
		panel.innerHTML =
			'<section class="collection-view"><header class="collection-view-head"><div><div class="eyebrow">Company interface</div><h1>No active pages</h1><p>Unhide navigation items or add a department to continue.</p></div></header></section>';
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
	else if (currentView === "panel" && projectionNode(currentNodeId)?.kind === "category")
		renderCollection(projectionNode(currentNodeId));
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
	if (currentView === "panel" && projectionNode(currentNodeId)?.kind === "category")
		renderCollection(projectionNode(currentNodeId));
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
	$("archiveDescription").textContent =
		`${archiveTarget.label} will be removed from active navigation. No company files will be deleted or moved.`;
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
	else if (currentView === "panel" && projectionNode(currentNodeId)?.kind === "category")
		renderCollection(projectionNode(currentNodeId));
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

// ---- department identity glyphs ---------------------------------------------
// The projection schema carries no icon field, so the glyph derives from the
// department's shape: product departments (their pages bind a departmentId)
// get the code glyph; interface departments match on the founder's own words;
// everything else is a folder.
const NAV_GLYPHS = {
	code: '<path d="M8 7 3.5 12 8 17M16 7l4.5 5-4.5 5"/>',
	chart: '<path d="M4 4v16h16M8.5 14.5v2.5M12.5 11v6M16.5 8v9"/>',
	bubble: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5 8.6 8.6 0 0 1-3.6-.8L3 21l1.8-5A8.5 8.5 0 1 1 21 11.5z"/>',
	people:
		'<circle cx="9" cy="8" r="3.4"/><path d="M2.8 20a6.2 6.2 0 0 1 12.4 0M15.5 5a3.4 3.4 0 0 1 0 6.4M21.2 20a6.2 6.2 0 0 0-4.4-5.9"/>',
	mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>',
	folder: '<path d="M3 7a2 2 0 0 1 2-2h4.2l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
	inbox: '<path d="M21 13h-4.8l-1.6 2.4h-5.2L7.8 13H3"/><path d="M5.6 6.3 3 13v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4l-2.6-6.7A1.6 1.6 0 0 0 16.9 5H7.1a1.6 1.6 0 0 0-1.5 1.3z"/>',
	clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2.5"/>',
	grid: '<rect x="3.5" y="3.5" width="7.2" height="7.2" rx="1.8"/><rect x="13.3" y="3.5" width="7.2" height="7.2" rx="1.8"/><rect x="3.5" y="13.3" width="7.2" height="7.2" rx="1.8"/><rect x="13.3" y="13.3" width="7.2" height="7.2" rx="1.8"/>',
	expand: '<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>',
	pause: '<rect x="7" y="5" width="3.4" height="14" rx="1.4"/><rect x="13.6" y="5" width="3.4" height="14" rx="1.4"/>',
	resume: '<path d="M7 5.3v13.4c0 1 1.1 1.7 2 1.1l10.4-6.7c.8-.5.8-1.7 0-2.2L9 4.2c-.9-.6-2 .1-2 1.1z"/>',
	page: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
	plus: '<path d="M12 5v14M5 12h14"/>',
	pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"/>',
};

// Glyphs offered by the department icon picker (context menu → Change icon).
const DEPARTMENT_ICON_CHOICES = ["folder", "code", "chart", "bubble", "people", "mail", "inbox", "clock", "page"];

function navGlyphSvg(name, className) {
	const paths = NAV_GLYPHS[name] ?? NAV_GLYPHS.folder;
	return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

function departmentGlyphName(department) {
	const override = navOverrides()[department.id]?.icon;
	if (override && NAV_GLYPHS[override]) return override;
	const productLike = department.items.some((childId) => {
		const child = projectionNode(childId);
		return child?.kind === "page" && child.view?.context?.departmentId !== undefined;
	});
	const label = displayLabel(department).toLowerCase();
	if (productLike || /develop|engineer|product\b/.test(label)) return "code";
	if (/financ|cash|revenue|budget|account/.test(label)) return "chart";
	if (/support|customer|service|help/.test(label)) return "bubble";
	if (/people|culture|talent|hiring|\bhr\b/.test(label)) return "people";
	if (/mail|comms|communic|marketing/.test(label)) return "mail";
	return "folder";
}

function mainPageGlyphName(node) {
	if (node.view?.id === "qorpera.inbox") return "inbox";
	if (node.view?.id === "qorpera.activity") return "grid";
	if (node.view?.id === "qorpera.chats") return "bubble";
	return "page";
}

// ---- session pile: chats sit under the department they belong to -------------
function relativeSessionTime(mtimeMs) {
	const minutes = Math.round((Date.now() - mtimeMs) / 60000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.round(hours / 24);
	if (days < 30) return `${days}d`;
	return new Date(mtimeMs).toLocaleDateString();
}

// ---- local navigation overrides (rename / icon) and collapse state -----------
// Panel presentation only, stored per machine like heights and hidden items —
// the projection document itself is never modified from the frontend.
function navOverrides() {
	return readStoredObject("nav-overrides", {});
}

function setNavOverride(id, patch) {
	const overrides = navOverrides();
	const next = { ...(overrides[id] ?? {}), ...patch };
	for (const key of Object.keys(next)) {
		if (next[key] === null || next[key] === undefined || next[key] === "") delete next[key];
	}
	if (Object.keys(next).length === 0) delete overrides[id];
	else overrides[id] = next;
	localStorage.setItem(navStorageKey("nav-overrides"), JSON.stringify(overrides));
}

function displayLabel(node) {
	return navOverrides()[node.id]?.label ?? node.label;
}

function collapsedNavigation() {
	return new Set(readStoredArray("nav-collapsed"));
}

function toggleDepartmentCollapsed(id) {
	const collapsed = collapsedNavigation();
	if (collapsed.has(id)) collapsed.delete(id);
	else collapsed.add(id);
	storeNavigationSet("nav-collapsed", collapsed);
	renderCompanyNavSafe();
}

// The chat pile collapses like a department; it shares the nav-collapsed
// store under a reserved id no projection document produces.
const CHAT_PILE_ID = "chat-pile";

// ---- pins: founder-chosen shortcuts at the top of the panel (T3 shape) -------
// Pin state is panel presentation like collapse/hidden — stored per machine,
// never in company documents. One ordered list carries every pin: `node:<id>`
// entries are projection pages/categories (rendered in the Pinned section) or
// departments (ordered first among departments); `chat:<file>` entries are
// trail sessions lifted out of the chat pile.
function pinnedNavigation() {
	return readStoredArray("nav-pinned");
}

const chatPinKey = (file) => `chat:${file}`;
const nodePinKey = (id) => `node:${id}`;

function isPinned(key) {
	return pinnedNavigation().includes(key);
}

function togglePinned(key) {
	const pinned = pinnedNavigation();
	const index = pinned.indexOf(key);
	if (index >= 0) pinned.splice(index, 1);
	else pinned.push(key);
	localStorage.setItem(navStorageKey("nav-pinned"), JSON.stringify(pinned));
	renderCompanyNavSafe();
}

/** The pin key a context-menu target answers to (chats key by trail file). */
function contextPinKey(target) {
	return target.node.kind === "chat" ? chatPinKey(target.node.id) : nodePinKey(target.node.id);
}

// The flat chat pile below the departments starts at five rows; "Show more"
// grows it in fives (session-local, not persisted).
let sessionPileLimit = 5;

function pileSessions() {
	return (state.sessions ?? [])
		.filter((session) => session.kind !== "autonomous")
		.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** One chat row, shared by the pile and the Pinned section. */
function sessionRow(session) {
	const row = document.createElement("button");
	row.type = "button";
	row.className = "session-row";
	// Lit only while the chat is actually in front — a chat row staying
	// highlighted while the founder reads another page misstates where they are.
	row.classList.toggle("active", currentSession === session.file && currentView === "chat");
	row.innerHTML = `${navGlyphSvg("bubble", "session-glyph")}<span class="session-copy"><span class="session-title"></span><small class="session-meta"><span class="session-scope"></span><span class="session-time"></span></small></span>`;
	row.querySelector(".session-title").textContent = session.title;
	const page = session.page ? projectionNode(session.page) : undefined;
	row.querySelector(".session-scope").textContent = page?.label ?? session.worktree ?? "Company";
	row.querySelector(".session-time").textContent = relativeSessionTime(session.mtimeMs);
	row.title = session.title;
	row.onclick = () => openSession(session.file, session.page);
	row.oncontextmenu = (event) => openSessionContext(event, session);
	return row;
}

/** The pin glyph on a pinned row: state cue and one-click unpin (T3 shape).
 * A span with a button role — rows are <button>s and buttons can't nest. */
function pinnedUnpinControl(key) {
	const control = document.createElement("span");
	control.className = "pin-unpin";
	control.title = "Unpin";
	control.setAttribute("role", "button");
	control.setAttribute("aria-label", "Unpin");
	control.tabIndex = 0;
	control.innerHTML = navGlyphSvg("pin", "pin-unpin-glyph");
	control.onclick = (event) => {
		event.stopPropagation();
		togglePinned(key);
	};
	control.onkeydown = (event) => {
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		event.stopPropagation();
		togglePinned(key);
	};
	return control;
}

/** The Pinned section: founder-chosen shortcuts right under the Main rows.
 * T3 pins threads atop its sidebar; here pages, categories, and chats share
 * one block in pin order. Rows read like the chat pile for coherence. */
function renderPinnedSection(nav) {
	if (focusedDepartmentId !== null) return;
	const entries = [];
	for (const key of pinnedNavigation()) {
		if (key.startsWith("node:")) {
			const node = projectionNode(key.slice(5));
			// Departments pin by ordering first, not by a shortcut row; stale
			// pins (removed nodes) and hidden/archived items stay out.
			if (!node || node.kind === "department" || !nodeIsVisible(node.id)) continue;
			entries.push({ key, node });
		} else if (key.startsWith("chat:")) {
			const session = (state.sessions ?? []).find(
				(candidate) => candidate.kind !== "autonomous" && candidate.file === key.slice(5),
			);
			if (session) entries.push({ key, session });
		}
	}
	if (!entries.length) return;
	const section = document.createElement("section");
	section.className = "session-section pinned-section";
	const heading = document.createElement("div");
	heading.className = "session-section-title";
	heading.textContent = "Pinned";
	section.appendChild(heading);
	const pile = document.createElement("div");
	pile.className = "session-pile";
	for (const entry of entries) {
		let row;
		if (entry.node) {
			row = document.createElement("button");
			row.type = "button";
			row.className = "session-row pinned-row";
			row.classList.toggle("active", currentNodeId === entry.node.id);
			row.innerHTML = `${navGlyphSvg(entry.node.kind === "category" ? "folder" : mainPageGlyphName(entry.node), "session-glyph")}<span class="session-copy"><span class="session-title"></span></span>`;
			row.querySelector(".session-title").textContent = displayLabel(entry.node);
			row.title = entry.node.description ?? displayLabel(entry.node);
			row.onclick = () => void openProjectionNode(entry.node.id);
			row.oncontextmenu = (event) => openNavContext(event, entry.node, "pinned");
		} else {
			row = sessionRow(entry.session);
			row.classList.add("pinned-row");
		}
		row.appendChild(pinnedUnpinControl(entry.key));
		pile.appendChild(row);
	}
	section.appendChild(pile);
	nav.appendChild(section);
}

function renderCompanyNav() {
	const nav = $("navigation");
	nav.innerHTML = "";
	nav.classList.toggle("focus-mode", focusedDepartmentId !== null);
	applyNavAppearance();
	// Pinned departments order first; Main stays structural at the very top.
	const departments = navigationDepartments();
	const orderedDepartments = [
		...departments.filter((department) => department.id === "q:main"),
		...departments.filter((department) => department.id !== "q:main" && isPinned(nodePinKey(department.id))),
		...departments.filter((department) => department.id !== "q:main" && !isPinned(nodePinKey(department.id))),
	];
	let pinnedSectionPlaced = false;
	for (const department of orderedDepartments) {
		const focused = focusedDepartmentId === department.id;
		if (focusedDepartmentId && !focused) continue;
		if (!nodeIsVisible(department.id)) continue;
		const group = document.createElement("section");
		group.className = "projection-department";
		group.dataset.departmentId = department.id;
		const isMainDepartment = department.id === "q:main";
		if (isMainDepartment) group.classList.add("dept-main");
		const collapsed = !isMainDepartment && !focused && collapsedNavigation().has(department.id);
		group.classList.toggle("collapsed", collapsed);
		group.oncontextmenu = (event) => {
			if (!event.target.closest(".projection-row, .hidden-items-control"))
				openNavContext(event, department, "department");
		};
		const title = document.createElement("div");
		title.className = "projection-department-title";
		title.innerHTML = navGlyphSvg(departmentGlyphName(department), "dept-glyph");
		title.setAttribute("role", "button");
		title.setAttribute("aria-expanded", String(!collapsed));
		title.onclick = (event) => {
			if (event.target.closest(".hidden-items-control") || title.querySelector(".dept-rename-input")) return;
			toggleDepartmentCollapsed(department.id);
		};
		const titleLabel = document.createElement("span");
		titleLabel.className = "projection-department-label";
		titleLabel.textContent = displayLabel(department);
		title.appendChild(titleLabel);
		const caret = document.createElement("span");
		caret.className = "dept-caret";
		caret.setAttribute("aria-hidden", "true");
		caret.textContent = "▾";
		const hiddenItems = hiddenItemsForDepartment(department);
		if (hiddenItems.length) {
			const control = document.createElement("div");
			control.className = "hidden-items-control";
			control.innerHTML =
				'<button class="show-hidden-button" type="button"></button><div class="hidden-items-popover" role="menu"></div>';
			const button = control.querySelector("button");
			button.textContent = `Show ${hiddenItems.length}`;
			button.setAttribute(
				"aria-label",
				`Show ${hiddenItems.length} hidden item${hiddenItems.length === 1 ? "" : "s"} in ${department.label}`,
			);
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
		if (!isMainDepartment && isPinned(nodePinKey(department.id))) {
			// The glyph is the in-title pin cue, T3-style: always visible while
			// pinned so the founder can read WHY this department orders first.
			const pinMark = document.createElement("span");
			pinMark.className = "dept-pin";
			pinMark.title = "Pinned — this department orders first";
			pinMark.innerHTML = navGlyphSvg("pin", "dept-pin-glyph");
			title.appendChild(pinMark);
		}
		title.appendChild(caret);
		title.oncontextmenu = (event) => openNavContext(event, department, "department");
		applyNavMetrics(title, department);
		group.appendChild(title);
		const items = document.createElement("div");
		items.className = "projection-department-items";
		items.dataset.emptyLabel = department.items.length ? "No visible items" : "Empty department";
		if (isMainDepartment) {
			// Codex-app shape: the panel leads with starting a conversation.
			const newChat = document.createElement("button");
			newChat.type = "button";
			newChat.className = "projection-row page new-chat-row";
			newChat.innerHTML = '<span class="projection-row-label"></span>';
			newChat.querySelector(".projection-row-label").innerHTML = `${navGlyphSvg("plus", "nav-row-glyph")}New chat`;
			newChat.title = "Start a new company chat";
			newChat.onclick = () => void newCompanyChat();
			items.appendChild(newChat);
		}
		for (const childId of department.items) {
			const child = projectionNode(childId);
			if (!child || (child.kind !== "page" && child.kind !== "category")) continue;
			if (!nodeIsVisible(child.id)) continue;
			// The chat archive lives in the pile below the departments now; the
			// nav row it used to occupy became "New chat" above.
			if (isMainDepartment && child.kind === "page" && child.view?.id === "qorpera.chats") continue;
			const row = document.createElement("button");
			const ownsCurrent = child.kind === "category" && child.items.includes(currentNodeId);
			row.className = `projection-row ${child.kind}${focused ? " focus-row" : ""}`;
			row.innerHTML = focused
				? '<span class="projection-row-copy"><span class="projection-row-label"></span><small></small></span><span class="focus-arrow" aria-hidden="true">-&gt;</span>'
				: '<span class="projection-row-label"></span>';
			row.querySelector(".projection-row-label").textContent = child.label;
			// Main's free rows carry their own glyphs (Codex-app shape) since
			// the department header that would anchor them is not rendered.
			if (isMainDepartment && !focused) {
				row.querySelector(".projection-row-label").insertAdjacentHTML(
					"afterbegin",
					navGlyphSvg(mainPageGlyphName(child), "nav-row-glyph"),
				);
			}
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
		if (isMainDepartment && !pinnedSectionPlaced) {
			renderPinnedSection(nav);
			pinnedSectionPlaced = true;
		}
	}
	if (!pinnedSectionPlaced) renderPinnedSection(nav);
	// The flat chat pile sits below every department (ChatGPT/Codex shape).
	// Pinned chats live in the Pinned section above; the pile is the rest.
	const sessions = pileSessions().filter((session) => !isPinned(chatPinKey(session.file)));
	if (sessions.length && focusedDepartmentId === null) {
		const section = document.createElement("section");
		section.className = "session-section";
		const collapsed = collapsedNavigation().has(CHAT_PILE_ID);
		section.classList.toggle("collapsed", collapsed);
		// Same affordance as a department: click the title, the caret hints.
		const heading = document.createElement("button");
		heading.type = "button";
		heading.className = "session-section-title";
		heading.setAttribute("aria-expanded", String(!collapsed));
		const headingLabel = document.createElement("span");
		headingLabel.textContent = "Chats";
		heading.appendChild(headingLabel);
		const caret = document.createElement("span");
		caret.className = "dept-caret";
		caret.setAttribute("aria-hidden", "true");
		caret.textContent = "▾";
		heading.appendChild(caret);
		heading.onclick = () => toggleDepartmentCollapsed(CHAT_PILE_ID);
		section.appendChild(heading);
		const pile = document.createElement("div");
		pile.className = "session-pile";
		for (const session of sessions.slice(0, sessionPileLimit)) {
			pile.appendChild(sessionRow(session));
		}
		if (sessions.length > sessionPileLimit) {
			const more = document.createElement("button");
			more.type = "button";
			more.className = "session-more";
			more.textContent = "Show more";
			more.onclick = () => {
				sessionPileLimit += 5;
				renderCompanyNavSafe();
			};
			pile.appendChild(more);
		}
		section.appendChild(pile);
		nav.appendChild(section);
	}
	const diagnostics = $("projectionDiagnostics");
	const messages = state.projection?.diagnostics ?? [];
	diagnostics.textContent = messages.length
		? `${messages.length} projection issue${messages.length === 1 ? "" : "s"}`
		: "";
	diagnostics.title = messages.join("\n");
	$("resetPanelButton").disabled = focusedDepartmentId === null;
	$("resetPanelButton").title = focusedDepartmentId
		? "Exit department focus without changing hidden items"
		: "The panel is already in its default view";
	syncScopeChrome();
}

function setProjectionRoute(id) {
	const next = `#/p/${encodeURIComponent(id)}`;
	if (location.hash !== next) history.replaceState(null, "", next);
}

function renderCollection(node) {
	const panel = $("view-panel");
	panel.innerHTML =
		'<section class="collection-view"><header class="collection-view-head"><div><div class="eyebrow"></div><h1></h1><p></p></div></header><div class="collection-tools"><label class="collection-search"><input type="search" placeholder="Filter this category" aria-label="Filter pages"></label><span class="collection-count"></span></div><div class="collection-list"></div></section>';
	const department = departmentForProjectionNode(node.id);
	panel.querySelector(".eyebrow").textContent =
		node.kind === "department" ? "Company / Department" : `${department?.label ?? "Company"} / Category`;
	panel.querySelector("h1").textContent = node.label;
	panel.querySelector(".collection-view-head p").textContent =
		node.description ??
		(node.kind === "department" ? "Direct pages published by this department." : "Published pages in this category.");
	const input = panel.querySelector(".collection-search input");
	const list = panel.querySelector(".collection-list");
	const count = panel.querySelector(".collection-count");
	const paint = () => {
		const query = input.value.trim().toLowerCase();
		const publishedPages =
			node.kind === "category"
				? visibleCategoryPages(node)
				: node.items.map(projectionNode).filter((page) => page?.kind === "page" && nodeIsVisible(page.id));
		const pages = publishedPages.filter((page) =>
			`${page.label} ${page.description ?? ""}`.toLowerCase().includes(query),
		);
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
			row.innerHTML =
				'<span class="collection-index"></span><div class="collection-copy"><strong></strong><p></p></div><div class="collection-meta"><span>Published</span><span></span></div><span class="collection-arrow">-&gt;</span>';
			row.querySelector(".collection-index").textContent = String(index + 1).padStart(2, "0");
			row.querySelector("strong").textContent = page.label;
			row.querySelector("p").textContent = page.description ?? "Open this company page.";
			row.querySelector(".collection-meta span:last-child").textContent =
				page.view.type === "surface" ? "Surface" : "Built-in";
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
	return departmentWizard.repoUrl.trim().length > 0 && $("repoUrl").validity.valid;
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

async function finishDepartmentCreation() {
	if (!departmentStepIsValid()) return;
	const name = departmentWizard.name.trim();
	if (departmentWizard.type === "product") {
		const source =
			departmentWizard.repoMode === "local" ? departmentWizard.repoPath.trim() : departmentWizard.repoUrl.trim();
		const create = $("departmentCreate");
		create.disabled = true;
		create.textContent = "Creating…";
		try {
			const result = await window.qorpera.addProduct(name, source);
			if (!result?.ok) {
				if (result?.error !== "cancelled")
					showControllerToast(result?.error ?? "Product department was not created.");
				return;
			}
			closeDepartmentModal();
			await refreshState();
			showControllerToast(`${name} product-development department created.`);
		} catch (error) {
			showControllerToast(error instanceof Error ? error.message : "Product department could not be created.");
		} finally {
			create.textContent = "Create department";
			updateDepartmentActions();
		}
		return;
	}
	const template = document.querySelector(`[data-template="${departmentWizard.template}"] strong`)?.textContent;
	const setup = departmentWizard.template === "blank" ? "from scratch" : `from the ${template} template`;
	closeDepartmentModal();
	showControllerToast(
		`${name} is ready to create ${setup}. The frontend is complete; the company command remains unbound.`,
	);
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
	const navigation = updateRoute || currentNodeId !== id ? ++navigationGeneration : navigationGeneration;
	const node = projectionNode(id);
	if (!node) return;
	$("view-panel").classList.toggle("activity-panel", node.view?.id === "qorpera.activity");
	const pageChanged = currentNodeId !== id;
	// Remember the page being left so returning to it insta-loads.
	if (pageChanged) cacheCurrentPanelPage();
	currentNodeId = id;
	if (updateRoute) setProjectionRoute(id);
	if (pageChanged && node.view?.type !== "surface") {
		// Visited pages restore instantly; fresh ones show the text skeleton
		// until their renderer replaces it (sync renderers do so same-frame).
		$("view-panel").innerHTML = pageCache.get(id) ?? pageSkeletonMarkup();
	}
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
		if (navigation !== navigationGeneration || currentNodeId !== id) return;
		show("panel");
	} else if (node.view.id === "qorpera.chats") {
		renderChats();
		show("panel");
	} else if (node.view.id === "qorpera.usage") {
		// Company-authored usage pages only — the platform's Usage lives in Settings.
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
	const navigation = ++navigationGeneration;
	cacheCurrentSession();
	const result = await window.qorpera.openChat(null, department.path);
	if (result?.ok) {
		currentSession = result.sessionFile ?? null;
		currentDepartment = result.department ?? null;
		currentWorktree = result.worktree ?? null;
		sidechatPageId = null;
		sidechatPending = null;
	}
	if (navigation !== navigationGeneration) return;
	if (!result?.ok) {
		$("status").textContent = result?.error ?? "could not start product worktree";
		return;
	}
	currentNodeId = pageId;
	setProjectionRoute(pageId);
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
	$("renameDepartmentItem").onclick = () => {
		if (navContextTarget) startDepartmentRename(navContextTarget.node);
	};
	$("changeIconItem").onclick = openIconEditor;
	$("iconDefault").onclick = () => {
		if (navContextTarget) setNavOverride(navContextTarget.node.id, { icon: null });
		renderCompanyNavSafe();
		closeNavContext();
	};
	$("iconDone").onclick = closeNavContext;
	$("hideNavigationItem").onclick = hideNavigationTarget;
	$("archiveNavigationItem").onclick = openArchiveConfirmation;
	$("pinNavigationItem").onclick = () => {
		if (!navContextTarget) return;
		togglePinned(contextPinKey(navContextTarget));
		closeNavContext();
	};
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
	]) {
		$(id).oninput = () => {
			departmentWizard[field] = $(id).value;
			updateDepartmentActions();
		};
	}
	$("browseRepo").onclick = async () => {
		const result = await window.qorpera.chooseProductSource();
		if (!result?.ok || !result.path) return;
		departmentWizard.repoPath = result.path;
		$("repoPath").value = result.path;
		updateDepartmentActions();
	};
	$("departmentForm").onsubmit = (event) => {
		event.preventDefault();
		if (departmentWizard.step < 3) moveDepartmentStep(1);
		else void finishDepartmentCreation();
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

/** The between-pages loading state: a text-line skeleton, as if a text
 * page's contents are arriving. Widths vary so it reads as prose. */
function pageSkeletonMarkup() {
	const lines = ["92%", "100%", "97%", "88%", "63%", "", "96%", "90%", "99%", "42%"];
	return `<div class="page-skeleton"><div class="sk-line sk-title"></div>${lines
		.map((width) => (width ? `<div class="sk-line" style="width:${width}"></div>` : '<div class="sk-gap"></div>'))
		.join("")}</div>`;
}

/** Session-scoped page cache: a page the founder already visited restores
 * instantly on return (its renderer then refreshes it in place from live
 * state); only never-visited pages show the loading skeleton. */
const pageCache = new Map(); // projection node id -> #view-panel innerHTML

function cacheCurrentPanelPage() {
	if (currentView === "panel" && currentNodeId && !$("view-panel").querySelector(".page-skeleton")) {
		pageCache.set(currentNodeId, $("view-panel").innerHTML);
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
	// Leave the usage view alone while it is docked inside Settings.
	if ($("view-usage").parentElement !== $("settingsContent")) {
		$("view-usage").style.display = view === "usage" ? "block" : "none";
	}
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
	if (currentNodeId !== page.id) cacheCurrentPanelPage();
	currentNodeId = page.id;
	const frame = $("view-surface");
	const version = String(page.view.version ?? 0);
	if (frame.dataset.pageId !== page.id || frame.dataset.version !== version) {
		// A fresh surface load gets the text skeleton over the iframe until its
		// document arrives; revisits keep the loaded iframe and skip it.
		let overlay = document.getElementById("surfaceSkeleton");
		if (!overlay) {
			overlay = document.createElement("div");
			overlay.id = "surfaceSkeleton";
			overlay.className = "surface-skeleton";
			frame.parentElement.appendChild(overlay);
		}
		overlay.innerHTML = pageSkeletonMarkup();
		overlay.hidden = false;
		frame.addEventListener(
			"load",
			() => {
				overlay.hidden = true;
			},
			{ once: true },
		);
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
	const attachment = ++sidechatGeneration;
	const navigation = navigationGeneration;
	const latest = fresh ? undefined : pageSessions(page.id)[0];
	cacheCurrentSession();
	const result = await window.qorpera.openChat(
		latest ? latest.file : null,
		undefined,
		undefined,
		latest ? undefined : `page — ${page.id}`,
	);
	if (result?.ok) {
		currentSession = result.sessionFile ?? latest?.file ?? null;
		currentDepartment = null;
		currentWorktree = null;
		sidechatPageId = page.id;
		sidechatPending = latest ? null : page;
	}
	if (
		attachment !== sidechatGeneration ||
		navigation !== navigationGeneration ||
		!sidechatOpen ||
		currentNodeId !== page.id
	) {
		return;
	}
	if (!result?.ok) return;
	if (latest) {
		$("messages").innerHTML = sessionCache[latest.file] ?? '<div class="loading">loading session…</div>';
	} else {
		$("messages").innerHTML = "";
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
/** The trail categorizes what it is a trail OF — user-led conversations are
 * different from the kernel's own work (founder call 2026-08-13). Section
 * order tells the story: the founder's words first, then scoped product
 * work, then each autonomous lane. */
const TRAIL_SECTIONS = [
	{
		category: "conversation",
		heading: "Founder conversations",
		badge: "conversation",
	},
	{ category: "product", heading: "Product work", badge: "product" },
	{ category: "conception", heading: "Conception", badge: "conception" },
	{ category: "merge", heading: "Userland merges", badge: "merge" },
	{ category: "wake", heading: "Wakes & routines", badge: "wake" },
	{
		category: "autonomous",
		heading: "Other autonomous work",
		badge: "autonomous",
	},
];

const TRAIL_OUTCOME_LABELS = {
	running: "Running",
	succeeded: "Completed",
	failed: "Failed",
	incomplete: "Incomplete",
};

function scheduledJobScheduleLabel(job) {
	const minutes = Number(job.intervalMinutes);
	if (minutes === 60) return "Hourly";
	if (minutes % 1440 === 0) return `Every ${minutes / 1440} day${minutes === 1440 ? "" : "s"}`;
	if (minutes % 60 === 0) return `Every ${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
	return `Every ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function scheduledJobNextLabel(job) {
	if (job.running) return "Running now";
	if (job.suspendedReason) return "Suspended";
	if (!job.enabled) return "Paused";
	const next = Date.parse(job.nextRunAt);
	if (!Number.isFinite(next) || next <= Date.now()) return "Due now";
	const minutes = Math.ceil((next - Date.now()) / 60000);
	if (minutes < 60) return `Next run in ${minutes}m`;
	const hours = Math.ceil(minutes / 60);
	if (hours < 24) return `Next run in ${hours}h`;
	return `Next run in ${Math.ceil(hours / 24)}d`;
}

function scheduledJobDraft(job) {
	return {
		title: job?.title ?? "",
		prompt: job?.prompt ?? "",
		intervalMinutes: job?.intervalMinutes ?? 10,
		enabled: job?.enabled ?? true,
	};
}

function scheduledJobField(labelText, control, helpText) {
	const label = document.createElement("label");
	label.className = "scheduled-job-field";
	const title = document.createElement("span");
	title.textContent = labelText;
	label.append(title, control);
	if (helpText) {
		const help = document.createElement("small");
		help.textContent = helpText;
		label.appendChild(help);
	}
	return label;
}

function scheduledJobFact(label, value) {
	const row = document.createElement("div");
	row.className = "scheduled-job-fact";
	const name = document.createElement("span");
	name.textContent = label;
	const text = document.createElement("strong");
	text.textContent = value || "—";
	row.append(name, text);
	return row;
}

async function scheduledJobRequest(request, fallback) {
	try {
		return await request();
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : fallback,
		};
	}
}

function sessionRunTime(session) {
	return session.kind === "autonomous" ? (session.startedAtMs ?? session.mtimeMs) : session.mtimeMs;
}

function openRunInspection(session) {
	scheduledJobPanel = {
		mode: "run",
		file: session.file,
		dirty: false,
		error: "",
		pending: false,
	};
	void renderActivity(true);
}

function runFailureCause(session, outcome) {
	if (session.failureCause) return session.failureCause;
	if (outcome === "incomplete") return "This run stopped without a final result.";
	return "The run did not finish successfully.";
}

function runFailureGuidance(session, outcome) {
	if (session.failureGuidance) return session.failureGuidance;
	if (outcome === "incomplete") return "Review the partial work, then retry the job.";
	return "Review the partial work below, then retry. If it repeats, choose another model.";
}

function renderRunInspection(shell, jobs, sessions, autonomousRunning, autonomousTrailFile) {
	const run = sessions.find((session) => session.file === scheduledJobPanel.file);
	if (!run) {
		scheduledJobPanel = null;
		return;
	}
	const outcome = displayedTrailOutcome(run, autonomousTrailFile);
	const job = jobs.find((candidate) => candidate.id === run.scheduledJobId);
	const aside = document.createElement("aside");
	aside.className = "scheduled-job-detail run-inspection";
	const header = document.createElement("header");
	const heading = document.createElement("div");
	const eyebrow = document.createElement("span");
	eyebrow.textContent = "Run details";
	const status = document.createElement("strong");
	status.textContent = TRAIL_OUTCOME_LABELS[outcome] ?? outcome ?? "Run";
	heading.append(eyebrow, status);
	const headerActions = document.createElement("div");
	if (job && outcome !== "running") {
		const retry = document.createElement("button");
		retry.type = "button";
		retry.textContent = scheduledJobPanel.pending ? "Starting…" : autonomousRunning ? "Runtime busy" : "Retry now";
		retry.disabled = autonomousRunning || scheduledJobPanel.pending;
		retry.onclick = async () => {
			scheduledJobPanel.pending = true;
			scheduledJobPanel.error = "";
			const result = await scheduledJobRequest(
				() => window.qorpera.runScheduledJob(job.id),
				"Could not retry the job.",
			);
			scheduledJobPanel.pending = false;
			scheduledJobPanel.error = result?.ok ? "" : (result?.error ?? "Could not retry the job.");
			void renderActivity(true);
		};
		headerActions.appendChild(retry);
	}
	const close = document.createElement("button");
	close.className = "scheduled-job-close";
	close.type = "button";
	close.setAttribute("aria-label", "Close run details");
	close.textContent = "×";
	close.onclick = () => {
		scheduledJobPanel = job
			? {
					mode: "view",
					id: job.id,
					draft: scheduledJobDraft(job),
					dirty: false,
				}
			: null;
		void renderActivity();
	};
	headerActions.appendChild(close);
	header.append(heading, headerActions);
	aside.appendChild(header);

	const body = document.createElement("section");
	body.className = "run-inspection-body";
	const title = document.createElement("h2");
	title.textContent = run.title;
	const note = document.createElement("p");
	note.className = "run-inspection-note";
	note.textContent = "Read-only inspection. Opening this panel does not resume or change the historical run.";
	body.append(title, note);
	if (outcome === "failed" || outcome === "incomplete") {
		const failure = document.createElement("section");
		failure.className = "run-failure-summary";
		const cause = document.createElement("strong");
		cause.textContent = runFailureCause(run, outcome);
		const guidance = document.createElement("p");
		guidance.textContent = runFailureGuidance(run, outcome);
		failure.append(cause, guidance);
		if (run.failureDetail) {
			const detail = document.createElement("details");
			const detailTitle = document.createElement("summary");
			detailTitle.textContent = "Technical detail";
			const detailText = document.createElement("code");
			detailText.textContent = run.failureDetail;
			detail.append(detailTitle, detailText);
			failure.appendChild(detail);
		}
		body.appendChild(failure);
	}
	const facts = document.createElement("section");
	facts.className = "scheduled-job-facts";
	facts.append(
		scheduledJobFact("Started", new Date(sessionRunTime(run)).toLocaleString()),
		scheduledJobFact("Status", TRAIL_OUTCOME_LABELS[outcome] ?? outcome),
		scheduledJobFact(
			"Duration",
			Number.isFinite(run.durationMs) ? formatDuration(run.durationMs) : "No final duration",
		),
		scheduledJobFact(
			"Model",
			run.modelId ? (modelCtl.nameFor(`${run.modelProvider}::${run.modelId}`) ?? run.modelId) : "Not recorded",
		),
		scheduledJobFact("Model calls", Number.isFinite(run.calls) ? String(run.calls) : "Not recorded"),
		scheduledJobFact("Job", job?.title ?? run.scheduledJobTitle ?? "Autonomous work"),
	);
	body.appendChild(facts);
	const partial = document.createElement("section");
	partial.className = "run-partial-summary";
	const partialTitle = document.createElement("h3");
	partialTitle.textContent = "Work completed before it stopped";
	const partialText = document.createElement("p");
	partialText.textContent = run.partialChangeSummary ?? "No partial-work summary was recorded for this run.";
	partial.append(partialTitle, partialText);
	body.appendChild(partial);
	if (job?.prompt) {
		const instructions = document.createElement("details");
		instructions.className = "run-instructions";
		const instructionsTitle = document.createElement("summary");
		instructionsTitle.textContent = "Job instructions";
		const instructionsText = document.createElement("p");
		instructionsText.textContent = job.prompt;
		instructions.append(instructionsTitle, instructionsText);
		body.appendChild(instructions);
	}
	if (scheduledJobPanel.error) {
		const error = document.createElement("div");
		error.className = "scheduled-job-error";
		error.textContent = scheduledJobPanel.error;
		body.appendChild(error);
	}
	aside.appendChild(body);
	shell.appendChild(aside);
}

function renderScheduledJobPanel(shell, jobs, sessions, autonomousRunning, autonomousTrailFile) {
	if (!scheduledJobPanel) return;
	if (scheduledJobPanel.mode === "run") {
		renderRunInspection(shell, jobs, sessions, autonomousRunning, autonomousTrailFile);
		return;
	}
	const job =
		scheduledJobPanel.mode === "view" ? jobs.find((candidate) => candidate.id === scheduledJobPanel.id) : null;
	if (scheduledJobPanel.mode === "view" && !job) {
		scheduledJobPanel = null;
		return;
	}
	const aside = document.createElement("aside");
	aside.className = "scheduled-job-detail";
	const header = document.createElement("header");
	const heading = document.createElement("div");
	const eyebrow = document.createElement("span");
	eyebrow.textContent = scheduledJobPanel.mode === "create" ? "New scheduled job" : "Scheduled job details";
	const status = document.createElement("strong");
	status.textContent = scheduledJobPanel.mode === "create" ? "Draft" : scheduledJobNextLabel(job);
	heading.append(eyebrow, status);
	const headerActions = document.createElement("div");
	if (job) {
		const run = document.createElement("button");
		run.type = "button";
		run.textContent = job.running ? "Running…" : autonomousRunning ? "Runtime busy" : "Run now";
		run.disabled = autonomousRunning || scheduledJobPanel.pending;
		if (autonomousRunning && !job.running) {
			run.title = "Another scheduled job or autonomous merge is running.";
		}
		run.onclick = async () => {
			scheduledJobPanel.pending = true;
			scheduledJobPanel.error = "";
			run.disabled = true;
			const result = await scheduledJobRequest(
				() => window.qorpera.runScheduledJob(job.id),
				"Could not start the job.",
			);
			scheduledJobPanel.pending = false;
			scheduledJobPanel.error = result?.ok ? "" : (result?.error ?? "Could not start the job.");
			if (result?.ok) scheduledJobPanel.dirty = false;
			void renderActivity(true);
		};
		headerActions.appendChild(run);
		const toggle = document.createElement("button");
		toggle.type = "button";
		toggle.textContent = job.enabled && !job.suspendedReason ? "Pause" : "Resume";
		toggle.disabled = job.running || scheduledJobPanel.pending;
		toggle.onclick = async () => {
			scheduledJobPanel.pending = true;
			const result = await scheduledJobRequest(
				() =>
					window.qorpera.updateScheduledJob(job.id, {
						enabled: !(job.enabled && !job.suspendedReason),
					}),
				"Could not update the job.",
			);
			scheduledJobPanel.pending = false;
			scheduledJobPanel.error = result?.ok ? "" : (result?.error ?? "Could not update the job.");
			if (result?.ok) {
				scheduledJobPanel.draft.enabled = result.job.enabled;
				scheduledJobPanel.dirty = false;
			}
			void renderActivity(true);
		};
		headerActions.appendChild(toggle);
	}
	const close = document.createElement("button");
	close.className = "scheduled-job-close";
	close.type = "button";
	close.setAttribute("aria-label", "Collapse scheduled job details");
	close.textContent = "×";
	close.onclick = () => {
		scheduledJobPanel = null;
		void renderActivity();
	};
	headerActions.appendChild(close);
	header.append(heading, headerActions);
	aside.appendChild(header);

	const form = document.createElement("form");
	form.className = "scheduled-job-form";
	const title = document.createElement("input");
	title.type = "text";
	title.placeholder = "Scheduled job title";
	title.maxLength = 160;
	title.value = scheduledJobPanel.draft.title;
	title.oninput = () => {
		scheduledJobPanel.draft.title = title.value;
		scheduledJobPanel.dirty = true;
	};
	form.appendChild(scheduledJobField("Title", title));
	const prompt = document.createElement("textarea");
	prompt.placeholder = "Describe what the company controller should do";
	prompt.value = scheduledJobPanel.draft.prompt;
	prompt.oninput = () => {
		scheduledJobPanel.draft.prompt = prompt.value;
		scheduledJobPanel.dirty = true;
	};
	form.appendChild(
		scheduledJobField("Instructions", prompt, "The controller receives these full instructions at every run."),
	);
	const interval = document.createElement("input");
	interval.type = "number";
	interval.min = "5";
	interval.max = String(7 * 24 * 60);
	interval.step = "1";
	interval.value = String(scheduledJobPanel.draft.intervalMinutes);
	interval.oninput = () => {
		scheduledJobPanel.draft.intervalMinutes = Number(interval.value);
		scheduledJobPanel.dirty = true;
	};
	form.appendChild(
		scheduledJobField("Repeat every (minutes)", interval, "5 minutes minimum; jobs run while this company is open."),
	);
	const enabled = document.createElement("input");
	enabled.type = "checkbox";
	enabled.checked = scheduledJobPanel.draft.enabled;
	enabled.onchange = () => {
		scheduledJobPanel.draft.enabled = enabled.checked;
		scheduledJobPanel.dirty = true;
	};
	form.appendChild(scheduledJobField("Active", enabled, "Paused jobs keep their definition and run history."));

	if (job) {
		const runs = sessions.filter((session) => session.scheduledJobId === job.id).slice(0, 5);
		const lastFailedRun =
			runs.find(
				(run) => run.file === job.lastTrailFile && displayedTrailOutcome(run, autonomousTrailFile) === "failed",
			) ?? runs.find((run) => displayedTrailOutcome(run, autonomousTrailFile) === "failed");
		const facts = document.createElement("section");
		facts.className = "scheduled-job-facts";
		facts.append(
			scheduledJobFact("Schedule", scheduledJobScheduleLabel(job)),
			scheduledJobFact("Next run", job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : "Paused"),
			scheduledJobFact("Last ran", job.lastRunAt ? new Date(job.lastRunAt).toLocaleString() : "Never"),
			scheduledJobFact(
				"Last completed outcome",
				TRAIL_OUTCOME_LABELS[job.lastOutcome] ?? (job.running ? "Running" : "No run yet"),
			),
			scheduledJobFact("Failure streak", String(job.failureStreak ?? 0)),
			scheduledJobFact("Created", new Date(job.createdAt).toLocaleString()),
			scheduledJobFact("Updated", new Date(job.updatedAt).toLocaleString()),
			scheduledJobFact("Job ID", job.id),
		);
		if (job.suspendedReason) facts.appendChild(scheduledJobFact("Suspended", job.suspendedReason));
		form.appendChild(facts);
		if (job.lastOutcome === "failed" && lastFailedRun) {
			const failure = document.createElement("section");
			failure.className = "run-failure-summary job-last-failure";
			const cause = document.createElement("strong");
			cause.textContent = runFailureCause(lastFailedRun, "failed");
			const guidance = document.createElement("p");
			guidance.textContent = runFailureGuidance(lastFailedRun, "failed");
			const inspect = document.createElement("button");
			inspect.type = "button";
			inspect.textContent = "Inspect failed run";
			inspect.onclick = () => openRunInspection(lastFailedRun);
			failure.append(cause, guidance, inspect);
			form.appendChild(failure);
		}
		const recent = document.createElement("section");
		recent.className = "scheduled-job-recent";
		const recentHeading = document.createElement("h3");
		recentHeading.textContent = "Recent runs";
		recent.appendChild(recentHeading);
		if (!runs.length) {
			const empty = document.createElement("p");
			empty.textContent = "No runs recorded yet.";
			recent.appendChild(empty);
		}
		for (const run of runs) {
			const row = document.createElement("button");
			row.type = "button";
			row.className = "scheduled-job-run";
			const runTitle = document.createElement("strong");
			const outcome = displayedTrailOutcome(run, autonomousTrailFile);
			runTitle.textContent =
				outcome === "failed" || outcome === "incomplete"
					? `${TRAIL_OUTCOME_LABELS[outcome]} — ${runFailureCause(run, outcome)}`
					: (TRAIL_OUTCOME_LABELS[outcome] ?? outcome ?? "Run");
			const runMeta = document.createElement("span");
			runMeta.textContent = [
				new Date(sessionRunTime(run)).toLocaleString(),
				Number.isFinite(run.durationMs) ? formatDuration(run.durationMs) : "",
			]
				.filter(Boolean)
				.join(" · ");
			row.append(runTitle, runMeta);
			row.title = "Inspect this run without resuming it";
			row.onclick = () => openRunInspection(run);
			recent.appendChild(row);
		}
		form.appendChild(recent);
	}
	if (scheduledJobPanel.error) {
		const error = document.createElement("div");
		error.className = "scheduled-job-error";
		error.textContent = scheduledJobPanel.error;
		form.appendChild(error);
	}
	const actions = document.createElement("footer");
	if (job) {
		const remove = document.createElement("button");
		remove.type = "button";
		remove.className = "danger-button";
		remove.textContent = "Delete";
		remove.disabled = job.running || scheduledJobPanel.pending;
		remove.onclick = async () => {
			const result = await scheduledJobRequest(
				() => window.qorpera.deleteScheduledJob(job.id),
				"Could not delete the job.",
			);
			if (result?.ok) scheduledJobPanel = null;
			else scheduledJobPanel.error = result?.error ?? "Could not delete the job.";
			void renderActivity(true);
		};
		actions.appendChild(remove);
	}
	const spacer = document.createElement("span");
	actions.appendChild(spacer);
	const save = document.createElement("button");
	save.type = "submit";
	save.className = "primary-button";
	save.textContent = scheduledJobPanel.mode === "create" ? "Create scheduled job" : "Save changes";
	save.disabled = scheduledJobPanel.pending;
	actions.appendChild(save);
	form.appendChild(actions);
	form.onsubmit = async (event) => {
		event.preventDefault();
		scheduledJobPanel.pending = true;
		scheduledJobPanel.error = "";
		save.disabled = true;
		const draft = {
			title: scheduledJobPanel.draft.title,
			prompt: scheduledJobPanel.draft.prompt,
			intervalMinutes: Number(scheduledJobPanel.draft.intervalMinutes),
			enabled: Boolean(scheduledJobPanel.draft.enabled),
		};
		const result = await scheduledJobRequest(
			() => (job ? window.qorpera.updateScheduledJob(job.id, draft) : window.qorpera.createScheduledJob(draft)),
			"Could not save the scheduled job.",
		);
		scheduledJobPanel.pending = false;
		if (result?.ok) {
			scheduledJobPanel = {
				mode: "view",
				id: result.job.id,
				draft: scheduledJobDraft(result.job),
				dirty: false,
			};
		} else {
			scheduledJobPanel.error = result?.error ?? "Could not save the scheduled job.";
		}
		void renderActivity(true);
	};
	aside.appendChild(form);
	shell.appendChild(aside);
}

function displayedTrailOutcome(session, autonomousTrailFile) {
	if (
		session.file === autonomousTrailFile ||
		(session.runtime?.live && ["starting", "running", "finishing", "reconnecting"].includes(session.runtime.status))
	)
		return "running";
	if (session.runtime && session.runtime.status !== "settled") return "incomplete";
	return session.outcome === "running" ? "incomplete" : session.outcome;
}

function trailRunMeta(session, displayedOutcome) {
	if (!displayedOutcome) return null;
	const row = document.createElement("div");
	row.className = "trail-run-meta";
	const outcome = document.createElement("span");
	outcome.className = `trail-outcome trail-outcome-${displayedOutcome}`;
	outcome.textContent = TRAIL_OUTCOME_LABELS[displayedOutcome] ?? displayedOutcome;
	row.appendChild(outcome);
	const facts = [];
	if (session.modelId) {
		const key = session.modelProvider ? `${session.modelProvider}::${session.modelId}` : "";
		facts.push(modelCtl.nameFor(key) ?? session.modelId);
	}
	if (Number.isFinite(session.durationMs)) facts.push(formatDuration(session.durationMs));
	if (Number.isFinite(session.calls)) facts.push(`${session.calls} call${session.calls === 1 ? "" : "s"}`);
	if (Number.isFinite(session.costUsd)) facts.push(`$${session.costUsd.toFixed(4)}`);
	if (facts.length) row.appendChild(document.createTextNode(` · ${facts.join(" · ")}`));
	return row;
}

// ---- Agents page tiles -------------------------------------------------------
// Every tile reads the same projected lifecycle as chat chrome. Activity-only
// updates change the narration in place; lifecycle changes rebuild the page.
function runtimeDoingLine(runtime) {
	const info = runtime?.activity;
	if (runtime?.status === "starting") return "Waking up…";
	if (runtime?.status === "reconnecting") return "Reconnecting to its saved session…";
	if (runtime?.status === "finishing") return "Saving its work…";
	if (!info) return "Working…";
	if (info.kind === "starting") return "Waking up…";
	if (info.kind === "thinking") return "Thinking…";
	if (info.kind === "writing") return "Writing its findings…";
	if (info.kind === "tool") {
		const tool = info.tool ?? "";
		const short = info.subject ? info.subject.split(/[\\/]/).pop() : "";
		if (/^read$/i.test(tool)) return short ? `Reading ${short}` : "Reading company files";
		if (/^(write|edit|edit-diff|apply_patch)$/i.test(tool))
			return short ? `Editing ${short}` : "Editing company files";
		if (/^(grep|find|ls)$/i.test(tool)) return "Searching the company";
		if (/^bash$/i.test(tool)) return "Running a command";
		if (/^http-request$/i.test(tool)) return "Reaching out to the web";
		return short ? `Using ${tool} on ${short}` : `Using ${tool}`;
	}
	return "Working…";
}

function agentIconButton(label, glyph, onClick) {
	const btn = document.createElement("button");
	btn.type = "button";
	btn.className = "agent-icon-button";
	btn.title = label;
	btn.setAttribute("aria-label", label);
	btn.innerHTML = navGlyphSvg(glyph, "agent-icon-glyph");
	btn.onclick = (event) => {
		event.stopPropagation();
		onClick();
	};
	return btn;
}

function agentTileActions(...buttons) {
	const acts = document.createElement("span");
	acts.className = "agent-tile-acts";
	for (const button of buttons) if (button) acts.appendChild(button);
	return acts;
}

/** One anatomy for every tile: header (status glyph · name · actions), a
 * plain-language doing line, a small meta line. Callers fill the parts. */
function agentTile({ statusClass, name, actions, wide }) {
	const tile = document.createElement("div");
	tile.className = `agent-tile${wide ? " agent-tile-wide" : ""}`;
	const top = document.createElement("div");
	top.className = "agent-tile-top";
	const status = document.createElement("span");
	status.className = statusClass;
	const title = document.createElement("strong");
	title.className = "agent-tile-name";
	title.textContent = name;
	top.append(status, title);
	if (actions?.length) top.appendChild(agentTileActions(...actions));
	const doing = document.createElement("p");
	doing.className = "agent-tile-doing";
	const meta = document.createElement("div");
	meta.className = "agent-tile-meta";
	tile.append(top, doing, meta);
	return { tile, doing, meta };
}

function controllerTile(sessions, jobs, liveRuntime) {
	const working = Boolean(liveRuntime);
	const liveSession = working ? sessions.find((session) => session.file === liveRuntime.trailFile) : undefined;
	const attended = working && !liveRuntime.autonomous;
	const agentName = liveRuntime?.actor === "product-worker" ? departmentName(liveRuntime.department) : "Controller";
	const liveAction = liveSession
		? attended
			? agentIconButton("Open chat", "expand", () => openSession(liveSession.file, liveSession.page ?? "q:chats"))
			: agentIconButton("Inspect live", "expand", () => openRunInspection(liveSession))
		: null;
	const { tile, doing, meta } = agentTile({
		statusClass: working ? "agent-spin" : "agent-dot scheduled",
		name: agentName,
		wide: true,
		actions: liveAction ? [liveAction] : [],
	});
	if (working) {
		tile.classList.add("running");
		tile.dataset.trail = liveRuntime.trailFile;
	}
	if (working) doing.textContent = runtimeDoingLine(liveRuntime);
	else if (!jobs.length) doing.textContent = "Resting. No schedules yet — create one to give it recurring work.";
	else {
		const nextJob = jobs
			.filter((job) => job.enabled && !job.suspendedReason && Number.isFinite(Date.parse(job.nextRunAt)))
			.sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt))[0];
		doing.textContent = nextJob
			? `Resting. ${scheduledJobNextLabel(nextJob)} — ${nextJob.title}.`
			: "Resting. All schedules are paused.";
	}
	meta.textContent = working
		? (liveSession?.title ?? (liveRuntime.autonomous ? "Autonomous run" : "Founder-led session"))
		: `${jobs.filter((job) => job.enabled && !job.suspendedReason).length} of ${jobs.length} schedule${jobs.length === 1 ? "" : "s"} active`;
	return tile;
}

function scheduledJobTile(job, sessions) {
	const lastRun =
		sessions.find((session) => session.file === job.lastTrailFile) ??
		sessions.find((session) => session.scheduledJobId === job.id);
	const active = job.enabled && !job.suspendedReason;
	const openDetails = (error = "") => {
		scheduledJobPanel = {
			mode: "view",
			id: job.id,
			draft: scheduledJobDraft(job),
			dirty: false,
			error,
		};
		void renderActivity(true);
	};
	const { tile, doing, meta } = agentTile({
		statusClass: job.running ? "agent-spin" : active ? "agent-dot scheduled" : "agent-dot",
		name: job.title,
		actions: [
			agentIconButton(
				active ? "Pause" : job.suspendedReason ? "Re-enable" : "Resume",
				active ? "pause" : "resume",
				async () => {
					const result = await scheduledJobRequest(
						() => window.qorpera.updateScheduledJob(job.id, { enabled: !active }),
						"Could not update the job.",
					);
					// A declined kernel review or a failed write must not be a
					// silent no-op: surface it in the job's detail panel.
					if (result?.ok) void renderActivity(true);
					else openDetails(result?.error ?? "Could not update the job.");
				},
			),
			agentIconButton("Details", "expand", () => openDetails()),
		],
	});
	if (!active) tile.classList.add("paused");
	if (job.running) tile.classList.add("running");
	if (scheduledJobPanel?.id === job.id) tile.classList.add("selected");
	// The tile itself is a mouse convenience; the keyboard path is the real
	// Details button, so no role/keydown shims wrap the nested controls.
	tile.onclick = () => openDetails();
	if (job.running) doing.textContent = "Running now.";
	else if (job.suspendedReason) {
		doing.classList.add("failure");
		doing.textContent = `Suspended by the kernel: ${job.suspendedReason}.`;
	} else if (job.lastOutcome === "failed" && lastRun) {
		doing.classList.add("failure");
		doing.textContent = `Last run failed: ${runFailureCause(lastRun, "failed")}`;
	} else doing.textContent = job.prompt;
	meta.textContent = `${scheduledJobNextLabel(job)} · ${scheduledJobScheduleLabel(job)}`;
	return tile;
}

async function renderActivity(force = false) {
	const renderGeneration = ++activityRenderGeneration;
	const panel = $("view-panel");
	if (
		!force &&
		scheduledJobPanel?.dirty &&
		panel.querySelector(".scheduled-job-detail")?.contains(document.activeElement)
	)
		return;
	const sessions = state.sessions ?? [];
	const runtimeSessions = state.runtime?.sessions ?? [];
	const liveRuntime =
		runtimeSessions.find(
			(session) =>
				session.live &&
				session.autonomous &&
				["starting", "running", "finishing", "reconnecting"].includes(session.status),
		) ??
		runtimeSessions.find(
			(session) =>
				session.live &&
				!session.autonomous &&
				["starting", "running", "finishing", "reconnecting"].includes(session.status),
		);
	// Autonomous trails are inspected read-only in Activity. They are never
	// rebound to the chat child, including while another run is active.
	const liveAutonomous = liveRuntime?.autonomous ? liveRuntime : undefined;
	const autonomousRunning = Boolean(liveAutonomous);
	const autonomousTrailFile = liveAutonomous?.trailFile ?? "";
	let jobs = [];
	const requestedNodeId = currentNodeId;
	try {
		const active = (await window.qorpera.appInfo())?.activeCompany;
		jobs = (active?.scheduledJobs ?? []).map((job) => ({
			...job,
			running: runtimeSessions.some(
				(session) =>
					session.live &&
					session.group === `job:${job.id}` &&
					["starting", "running", "finishing", "reconnecting"].includes(session.status),
			),
		}));
	} catch {
		// bridge unavailable mid-reload: leave Open enabled
	}
	if (
		renderGeneration !== activityRenderGeneration ||
		currentNodeId !== requestedNodeId ||
		projectionNode(requestedNodeId)?.view?.id !== "qorpera.activity"
	)
		return;
	panel.innerHTML = "";
	const shell = document.createElement("div");
	shell.className = `activity-layout${scheduledJobPanel ? " has-detail" : ""}`;
	const main = document.createElement("section");
	main.className = "activity-main";
	const pageHeader = document.createElement("header");
	pageHeader.className = "activity-head";
	const pageCopy = document.createElement("div");
	const title = document.createElement("h1");
	title.textContent = "Agents";
	const subtitle = document.createElement("p");
	subtitle.textContent = "Every agent working for the company — live, scheduled, and past.";
	pageCopy.append(title, subtitle);
	const create = document.createElement("button");
	create.type = "button";
	create.className = "primary-button";
	create.textContent = "Create scheduled job";
	create.onclick = () => {
		scheduledJobPanel = {
			mode: "create",
			draft: scheduledJobDraft(),
			dirty: false,
		};
		void renderActivity();
	};
	pageHeader.append(pageCopy, create);
	main.appendChild(pageHeader);
	main.appendChild(controllerTile(sessions, jobs, liveRuntime));
	const jobsHead = document.createElement("h2");
	jobsHead.className = "trail-section scheduled-jobs-heading";
	jobsHead.textContent = `Scheduled · ${jobs.length}`;
	main.appendChild(jobsHead);
	if (!jobs.length) {
		const empty = document.createElement("div");
		empty.className = "scheduled-jobs-empty";
		empty.textContent = "No scheduled jobs. Create one to give the controller recurring work.";
		main.appendChild(empty);
	} else {
		const jobGrid = document.createElement("div");
		jobGrid.className = "agents-grid";
		for (const job of jobs) jobGrid.appendChild(scheduledJobTile(job, sessions));
		main.appendChild(jobGrid);
	}
	const historyHead = document.createElement("h2");
	historyHead.className = "trail-section activity-history-heading";
	historyHead.textContent = "History";
	main.appendChild(historyHead);
	if (!sessions.length) {
		main.insertAdjacentHTML(
			"beforeend",
			'<div class="empty">No trail yet — conversations, product work, conception, routines, and merges will appear here.</div>',
		);
	}
	for (const section of TRAIL_SECTIONS) {
		// Sessions listed before categories existed fall back by kind.
		const rows = sessions.filter(
			(s) => (s.category ?? (s.kind === "autonomous" ? "autonomous" : "conversation")) === section.category,
		);
		if (!rows.length) continue;
		const head = document.createElement("h2");
		head.className = "trail-section";
		head.textContent = section.heading;
		main.appendChild(head);
		for (const session of rows) {
			const d = document.createElement("div");
			d.className = "gate";
			d.innerHTML = '<div class="t"></div><div class="s sess-meta"></div>';
			const titleEl = d.querySelector(".t");
			titleEl.textContent = session.title;
			const badge = document.createElement("span");
			badge.className = `trail-badge trail-badge-${section.badge}`;
			badge.textContent = section.badge;
			titleEl.prepend(badge);
			d.querySelector(".s").textContent =
				`${new Date(sessionRunTime(session)).toLocaleString()} · ${session.file}` +
				(session.department ? ` · ${departmentName(session.department)}` : "");
			const outcome = displayedTrailOutcome(session, autonomousTrailFile);
			const sessionRunning = outcome === "running";
			const runMeta = trailRunMeta(session, outcome);
			if (runMeta) d.appendChild(runMeta);
			if (session.kind === "autonomous" && (outcome === "failed" || outcome === "incomplete")) {
				const cause = document.createElement("div");
				cause.className = "trail-failure-cause";
				cause.textContent = runFailureCause(session, outcome);
				d.appendChild(cause);
			}
			const open = document.createElement("button");
			open.textContent = session.kind === "autonomous" ? (sessionRunning ? "Inspect live" : "Inspect") : "Open";
			open.title =
				session.kind === "autonomous" ? "Inspect without resuming or changing this run" : "Open this conversation";
			open.onclick = () =>
				session.kind === "autonomous" ? openRunInspection(session) : openSession(session.file, "q:activity");
			d.appendChild(open);
			main.appendChild(d);
		}
	}
	shell.appendChild(main);
	renderScheduledJobPanel(shell, jobs, sessions, autonomousRunning, autonomousTrailFile);
	panel.appendChild(shell);
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
	const tech =
		item.kind === "gate" && item.gateTool ? ` · ${item.gateTool}${item.gateClass ? ` (${item.gateClass})` : ""}` : "";
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
				await authorizedPost("/api/gate", {
					file: item.file,
					action: "approved",
				});
				await finish();
			}),
		);
		actions.appendChild(
			inboxAction("Deny", "no", async () => {
				await authorizedPost("/api/gate", {
					file: item.file,
					action: "denied",
				});
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
				await authorizedPost("/api/gate", {
					file: item.file,
					action: "denied",
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
				await authorizedPost("/api/inbox/respond", {
					file: item.file,
					response: text.value,
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
		panel.insertAdjacentHTML(
			"beforeend",
			'<div class="empty" style="padding:14px 0; text-align:left">Nothing needs you right now.</div>',
		);
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

/** The Stop square next to Send: aborts the streaming run in place. */
function stopAgent() {
	sendRpc({ type: "abort" });
}

/**
 * Edit & resend: rewind the session to just before a sent user message (pi's
 * fork), put its text back in the composer for editing, and re-render the
 * rewound thread. Matching is by exact text against the forkable user
 * messages (last occurrence wins), which holds for any thread the founder can
 * see; a collision between identical resent messages rewinds to the newest.
 */
function rewindUserMessage(text) {
	if (agentWorking) {
		showControllerToast("stop the run first, then rewind");
		return;
	}
	pendingRewind = { text };
	sendRpc({ type: "get_fork_messages" });
}

/** Attach the rewind affordance to a rendered user message row. */
function decorateUserMsg(el, text) {
	if (!text) return el;
	const btn = document.createElement("button");
	btn.type = "button";
	btn.className = "msg-rewind";
	btn.title = "Edit & resend from here";
	btn.textContent = "↺";
	btn.onclick = () => rewindUserMessage(text);
	el.appendChild(btn);
	return el;
}

async function sendPrompt() {
	const input = $("input");
	const text = input.value.trim();
	const images = pendingImages;
	if (!text && !images.length) return;
	if (agentExited) {
		showControllerToast("controller stopped — reopen this saved chat to attach a new runtime");
		return;
	}
	let message = text;
	const sidechatContext = sidechatPending;
	if (sidechatPending) {
		// First prompt of a fresh sidechat: tell the controller what the founder
		// is looking at. Square brackets are stripped from the interpolations so
		// the block stays cleanly parseable (chrome and backend both strip it
		// from display; see renderHistory / listTrailSessions).
		const name = String(sidechatPending.label).replace(/[[\]]/g, ")");
		const entry = String(sidechatPending.view.entry).replace(/[[\]]/g, ")");
		message = `[Sidechat context: this chat is docked to the surface "${name}" — app/surfaces/${entry}. The founder is looking at it right now; orient from that file before answering.]\n\n${text}`;
	}
	const frame = { type: "prompt", message };
	if (images.length) {
		frame.images = images.map((image) => ({
			type: "image",
			data: image.dataUrl.slice(image.dataUrl.indexOf(",") + 1),
			mimeType: image.mimeType,
		}));
	}
	activeRunProgress = createRunProgress();
	turnFailureCard = null;
	const result = await sendRpc(frame);
	if (!result?.ok) {
		activeRunProgress = null;
		showControllerToast(
			runtimeReconnecting
				? "controller is reconnecting — your draft was preserved"
				: "controller is busy with autonomous work — your draft was preserved",
		);
		return;
	}
	input.value = "";
	lastSubmittedPrompt = {
		text,
		images: images.map((image) => ({
			mimeType: image.mimeType,
			dataUrl: image.dataUrl,
		})),
	};
	pendingImages = [];
	if (sidechatPending === sidechatContext) sidechatPending = null;
	renderAttachStrip();
	syncComposer();
	appendMsgImages(
		decorateUserMsg(addMsg("user", text), text),
		images.map((image) => image.dataUrl),
	);
}

function modelFailureInfo(value) {
	const detail = String(value ?? "unknown error")
		.split(/; stack=|\n\s+at /, 1)[0]
		.trim()
		.slice(0, 320);
	const raw = detail.toLowerCase();
	if (/oauth|invalid_grant|refresh token|sign-in|unauthori[sz]ed|\b401\b|\b403\b/.test(raw)) {
		return {
			cause: "The model connection needs attention.",
			guidance: "Reconnect that model account or choose another model, then retry.",
			detail,
		};
	}
	if (/insufficient_quota|quota|billing|credit balance/.test(raw)) {
		return {
			cause: "The model account cannot accept more work.",
			guidance: "Check its quota or billing, or choose another model, then retry.",
			detail,
		};
	}
	if (/context|prompt is too long|input.*too (?:large|long)|maximum.*tokens/.test(raw)) {
		return {
			cause: "The request was too large for this model.",
			guidance: "Shorten the request, start a fresh chat, or choose a model with more context.",
			detail,
		};
	}
	if (
		/connection refused|connect error|disconnect|reset before headers|transport failure|socket hang up|timed? out|timeout|overloaded|rate.?limit|\b429\b|\b502\b|\b503\b|\b529\b/.test(
			raw,
		)
	) {
		return {
			cause: "The model service could not be reached.",
			guidance: "Retry now. If it happens again, choose another model or check the model connection in Settings.",
			detail,
		};
	}
	if (/terminated|aborted|stopped/.test(raw)) {
		return {
			cause: "The controller stopped before it finished.",
			guidance: "Review the partial work below, then retry.",
			detail,
		};
	}
	return {
		cause: "The model could not complete this request.",
		guidance: "Review the partial work below, then retry. If it repeats, choose another model.",
		detail,
	};
}

function createRunProgress() {
	return {
		completedSteps: 0,
		changedFiles: new Set(),
		uncertainShellChanges: false,
	};
}

function mutationPath(toolName, args) {
	if (!/^(?:write|edit|apply_patch|patch|notebook_edit)$/i.test(String(toolName ?? ""))) return "";
	const value = args?.path ?? args?.filePath ?? args?.file_path;
	return typeof value === "string" ? value.trim().replace(/\\/g, "/") : "";
}

function recordCompletedTool(progress, toolName, args) {
	if (!progress) return;
	progress.completedSteps += 1;
	const path = mutationPath(toolName, args);
	if (path) progress.changedFiles.add(path);
	if (/^(?:bash|shell|shell_command)$/i.test(String(toolName ?? ""))) progress.uncertainShellChanges = true;
}

function runProgressSummary(progress) {
	const completed = progress?.completedSteps ?? 0;
	const files = [...(progress?.changedFiles ?? [])].sort();
	if (files.length) {
		const visible = files.slice(0, 5).join(", ");
		const remainder = files.length > 5 ? ` and ${files.length - 5} more` : "";
		const shellNote = progress.uncertainShellChanges ? " Other shell steps may also have changed files." : "";
		return `Changed ${files.length} file${files.length === 1 ? "" : "s"}: ${visible}${remainder}.${shellNote}`;
	}
	if (!completed) return "No completed steps were reported before the model stopped.";
	if (progress?.uncertainShellChanges) {
		return `Completed ${completed} step${completed === 1 ? "" : "s"}. Shell work may have changed files; review the work log before retrying.`;
	}
	return `Completed ${completed} read-only step${completed === 1 ? "" : "s"}. No file changes were reported.`;
}

async function retryPrompt(prompt = lastSubmittedPrompt) {
	if (!prompt?.text && !prompt?.images?.length) {
		showControllerToast("there is no failed request to retry");
		return;
	}
	if (agentWorking) {
		showControllerToast("wait for the current run to finish before retrying");
		return;
	}
	if (agentExited) {
		showControllerToast("controller stopped — start a new chat, then retry the request");
		return;
	}
	$("input").value = prompt.text;
	pendingImages = (prompt.images ?? []).map((image) => ({ ...image }));
	renderAttachStrip();
	syncComposer();
	await sendPrompt();
}

function addModelFailureCard(errorMessage, progress = activeRunProgress, prompt = lastSubmittedPrompt) {
	const info = modelFailureInfo(errorMessage);
	const card = document.createElement("article");
	card.className = "model-failure-card";
	const heading = document.createElement("strong");
	heading.textContent = info.cause;
	const partial = document.createElement("p");
	partial.className = "model-failure-partial";
	partial.textContent = `Partial work: ${runProgressSummary(progress)}`;
	const guidance = document.createElement("p");
	guidance.textContent = info.guidance;
	const actions = document.createElement("div");
	actions.className = "model-failure-actions";
	const retry = document.createElement("button");
	retry.type = "button";
	retry.className = "primary-button";
	retry.textContent = "Retry";
	retry.onclick = () => void retryPrompt(prompt);
	actions.appendChild(retry);
	if (info.detail && info.detail !== info.cause) {
		const details = document.createElement("details");
		const summary = document.createElement("summary");
		summary.textContent = "Technical detail";
		const text = document.createElement("code");
		text.textContent = info.detail;
		details.append(summary, text);
		actions.appendChild(details);
	}
	card.append(heading, partial, guidance, actions);
	$("messages").appendChild(card);
	$("messages").scrollTop = $("messages").scrollHeight;
	return card;
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

let workGroup = null; // { el, summary, body, start, steps, timer }
let pendingToolLines = []; // tool lines awaiting their execution_end

function makeWorkGroup(open) {
	const el = document.createElement("details");
	el.className = "work";
	el.open = open;
	const summary = document.createElement("summary");
	const body = document.createElement("div");
	body.className = "workbody";
	el.appendChild(summary);
	el.appendChild(body);
	const group = { el, summary, body, start: Date.now(), steps: 0, timer: null };
	if (open) {
		const spinner = document.createElement("span");
		spinner.className = "work-spinner";
		spinner.setAttribute("aria-hidden", "true");
		const label = document.createElement("span");
		const update = () => {
			label.textContent = `Working for ${formatDuration(Date.now() - group.start, true)}`;
		};
		update();
		group.timer = setInterval(update, 1000);
		summary.append(spinner, label);
	} else {
		summary.textContent = "Worked";
	}
	return group;
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

function formatDuration(ms, allowZero = false) {
	const seconds = allowZero ? Math.max(0, Math.floor(ms / 1000)) : Math.max(1, Math.round(ms / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Stamp the summary with the elapsed time and collapse the group. */
function closeWorkGroup() {
	if (!workGroup) return;
	clearInterval(workGroup.timer);
	workGroup.summary.textContent = `Worked for ${formatDuration(Date.now() - workGroup.start)} · ${workGroup.steps} step${workGroup.steps === 1 ? "" : "s"}`;
	workGroup.el.open = false;
	workGroup = null;
	pendingToolLines = [];
}

/** Forget the group without touching the DOM (thread was replaced). */
function resetWorkGroup() {
	if (workGroup) clearInterval(workGroup.timer);
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
	const runtimeIdentity = frame?._qorperaRuntime;
	if (
		runtimeIdentity?.trailFile &&
		(!currentSession || runtimeIdentity.trailFile !== currentSession)
	) {
		return;
	}
	if (runtimeIdentity?.trailFile && Number.isSafeInteger(runtimeIdentity.attachmentSequence)) {
		const projected = runtimeForTrail(runtimeIdentity.trailFile);
		const knownSequence = Math.max(
			runtimeAttachmentSequences.get(runtimeIdentity.trailFile) ?? 0,
			projected?.attachmentSequence ?? 0,
		);
		if (runtimeIdentity.attachmentSequence < knownSequence) return;
		if (
			projected?.attachmentSequence === runtimeIdentity.attachmentSequence &&
			projected.executorId &&
			projected.executorId !== runtimeIdentity.executorId
		) {
			return;
		}
		runtimeAttachmentSequences.set(runtimeIdentity.trailFile, runtimeIdentity.attachmentSequence);
	}
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
			if (delta.type === "thinking_start") {
				thinkingEl = workMsg("thinking assistant", "");
				thinkingEl.dataset.source = "";
			}
			if (delta.type === "thinking_delta" && thinkingEl) {
				thinkingEl.dataset.source += delta.delta;
				renderMarkdown(thinkingEl, thinkingEl.dataset.source);
			}
			if (delta.type === "thinking_end") thinkingEl = null;
			if (delta.type === "text_end") assistantEl = null;
			break;
		}
		case "tool_execution_start": {
			const group = ensureWorkGroup();
			group.steps += 1;
			const line = workMsg("tool", `▸ ${frame.toolName} ${summarizeArgs(frame.args)}`);
			pendingToolLines.push({
				toolName: frame.toolName,
				args: frame.args,
				line,
			});
			break;
		}
		case "tool_execution_end": {
			// Finish the matching in-flight line in place instead of adding a
			// second row per call.
			const index = pendingToolLines.findIndex((p) => p.toolName === frame.toolName);
			const entry = index >= 0 ? pendingToolLines.splice(index, 1)[0] : null;
			if (entry) entry.line.textContent = `${frame.isError ? "✗" : "✓"}${entry.line.textContent.slice(1)}`;
			else workMsg("tool", `${frame.isError ? "✗" : "✓"} ${frame.toolName}`);
			if (!frame.isError) recordCompletedTool(activeRunProgress, frame.toolName, entry?.args);
			refreshState();
			break;
		}
		case "agent_settled":
			closeWorkGroup();
			refreshState();
			break;
		case "agent_start":
			if (!activeRunProgress) activeRunProgress = createRunProgress();
			break;
		case "message_end": {
			// A turn that errored or was stopped otherwise renders NOTHING — the
			// founder saw blank panes while the real reason (an OAuth refresh
			// failure) sat unread in the trail. Say what happened, in the thread.
			const ended = frame.message;
			if (ended?.role === "assistant" && ended.stopReason === "error") {
				closeWorkGroup();
				if (!turnFailureCard) turnFailureCard = addModelFailureCard(ended.errorMessage);
			} else if (ended?.role === "assistant" && ended.stopReason === "aborted") {
				closeWorkGroup();
				addMsg("log", "stopped");
			}
			break;
		}
		case "response":
			if (frame.command === "get_messages" && frame.success) renderHistory(frame.data?.messages ?? frame.data);
			else if (frame.command === "get_available_models" && frame.success) {
				const models = frame.data?.models ?? frame.data ?? [];
				const offered = curateModels(
					models.map((m) => ({
						value: `${m.provider}::${m.id}`,
						name: m.name ?? m.id,
						// Both OpenAI responses lanes take service_tier: "priority";
						// Anthropic has no priority lane, so fast stays disabled there.
						fastCapable: m.api === "openai-codex-responses" || m.api === "openai-responses",
					})),
				);
				modelCtl.setModels(offered);
				modelCatalogHydrated = true;
				// A session restored on a model we no longer offer would leave the
				// chip naming nothing in the list — move it onto the same model's
				// offered lane when one exists, otherwise the slate's head.
				// Once per spawn: hydrate asks twice (immediate + the dropped-input
				// belt), and each unguarded answer re-sent set_model — duplicate
				// model_change trail entries and aborted in-flight runs.
				if (
					currentModelKey &&
					!offered.some((m) => m.value === currentModelKey) &&
					offered.length &&
					!modelMoveAsserted
				) {
					modelMoveAsserted = true;
					const currentId = currentModelKey.split("::")[1];
					const target = offered.find((m) => m.value.split("::")[1] === currentId) ?? offered[0];
					const [provider, modelId] = target.value.split("::");
					currentModelKey = target.value;
					preferredModelKey = target.value;
					sendRpc({ type: "set_model", provider, modelId });
				}
				reassertPreferredModel();
			} else if (frame.command === "get_fork_messages" && frame.success) {
				if (pendingRewind) {
					const wanted = pendingRewind.text.trim();
					pendingRewind = null;
					const candidates = (frame.data?.messages ?? []).filter((m) => (m.text ?? "").trim() === wanted);
					const target = candidates[candidates.length - 1];
					if (target) sendRpc({ type: "fork", entryId: target.entryId });
					else showControllerToast("could not find that message to rewind");
				}
			} else if (frame.command === "fork" && frame.success) {
				if (!frame.data?.cancelled) {
					// The session is rebound to the branch point: re-render the
					// rewound thread and hand the founder their words back to edit.
					if (typeof frame.data?.text === "string") {
						$("input").value = frame.data.text;
						syncComposer();
						$("input").focus();
					}
					hydrateAgentState(true);
				}
			} else if (frame.command === "get_available_thinking_levels" && frame.success) {
				modelCtl.setLevels(frame.data?.levels ?? []);
			} else if (frame.command === "get_state" && frame.success) {
				const model = frame.data?.model;
				if (model?.id) currentModelKey = `${model.provider}::${model.id}`;
				modelStateHydrated = true;
				if (frame.data?.thinkingLevel) currentEffort = frame.data.thinkingLevel;
				const reported = frame.data?.responseSpeed;
				if (reported) {
					// Speed is session-local in the runtime; the chrome carries the
					// machine's preference across spawns and re-asserts it once.
					if (!speedAsserted && currentSpeed === "fast" && reported === "standard") {
						sendRpc({
							type: "set_response_speed",
							speed: "fast",
						});
					} else {
						currentSpeed = reported;
					}
					speedAsserted = true;
				}
				modelCtl.sync();
				reassertPreferredModel();
			} else if (frame.command === "set_model" && frame.success && frame.data?.id) {
				currentModelKey = `${frame.data.provider}::${frame.data.id}`;
				preferredModelKey = currentModelKey;
				// The child re-clamps the thinking level to the new model's range,
				// and the range itself differs per model — refetch both so the
				// slider's stops and knob match what the session will actually run.
				sendRpc({ type: "get_available_thinking_levels" });
				sendRpc({ type: "get_state" });
				modelCtl.sync();
			} else if (frame.success === false) addMsg("log", `error: ${frame.error ?? frame.command}`);
			break;
		default:
			break;
	}
});
window.qorpera.onRpcLog((line) => {
	// Provider stderr is diagnostic output, not session state. A benign warning
	// must never replace "idle", "working", or "reconnecting" in the chrome.
	console.debug("agent runtime:", line);
});
window.qorpera.onRpcExit((code) => {
	// Process exit is transport detail. The session control plane decides
	// whether this becomes reconnecting, interrupted, or merely detached.
	void code;
	refreshState();
});

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
	settingsTab = tab || "usage";
	$("settingsView").classList.add("open");
	for (const b of document.querySelectorAll("#settingsView .stab")) {
		b.classList.toggle("active", b.dataset.tab === settingsTab);
	}
	renderSettingsTab();
}
function closeSettings() {
	undockUsage();
	$("settingsView").classList.remove("open");
}

/** The one usage view (#view-usage) docks inside Settings for the Usage tab
 * and returns to <main> for company-authored usage pages. Must run before
 * settingsContent is cleared, or the node would be destroyed with it. */
function undockUsage() {
	const usage = $("view-usage");
	if (usage.parentElement === $("settingsContent")) {
		usage.style.display = "none";
		document.querySelector("main").insertBefore(usage, $("status"));
	}
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
	undockUsage();
	content.innerHTML = "";

	if (settingsTab === "usage") {
		if (!backendUrl) {
			setHeading(content, "Usage");
			content.insertAdjacentHTML(
				"beforeend",
				'<div class="sess-meta">Open a company — usage covers its trail sessions.</div>',
			);
			return;
		}
		const usage = $("view-usage");
		content.appendChild(usage);
		usage.style.display = "block";
		window.qorperaUsage.open({
			backendUrl,
			embedded: true,
			onBack: () => closeSettings(),
		});
		return;
	}

	if (settingsTab === "general") {
		const info = await window.qorpera.settingsInfo();
		setHeading(content, "General");
		setRow(
			content,
			`Qorpera Base v${info.version}`,
			info.packaged
				? "installed — auto-updates from the release channel"
				: "dev tree — updates by rebuilding the repo",
		);
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
		heading.innerHTML =
			'<div class="eyebrow">Interface</div><h1>Appearance</h1><p>Control how the company structure is presented to you. These preferences affect the interface only.</p>';
		content.appendChild(heading);
		const group = document.createElement("section");
		group.className = "settings-group";
		group.innerHTML =
			"<header><h2>Navigation type indicators</h2><p>Use a restrained color wash to distinguish direct pages from categories.</p></header>";
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
		const density = document.createElement("select");
		density.setAttribute("aria-label", "Navigation row density");
		for (const [value, label] of [
			["compact", "Compact"],
			["chats", "Chunky chats"],
			["all", "Chunky everything"],
		]) {
			const option = document.createElement("option");
			option.value = value;
			option.textContent = label;
			density.appendChild(option);
		}
		density.value = appearance.density;
		const save = () => {
			localStorage.setItem(
				navStorageKey("nav-appearance"),
				JSON.stringify({
					showKinds: showKinds.checked,
					pageHue: pageHue.value,
					categoryHue: categoryHue.value,
					density: density.value,
				}),
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
		density.onchange = save;
		setRow(group, "Show type hues", "Display the indicator at the left edge of each navigation row.", showKinds);
		setRow(group, "Page hue", "Direct pages and surfaces", pageHue);
		setRow(group, "Category hue", "Folders that open a list of pages", categoryHue);
		setRow(
			group,
			"Row density",
			"Chunky chats turns the chat list into two-line rows with scope and last activity; Chunky everything also enlarges the navigation rows.",
			density,
		);
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
			content.insertAdjacentHTML(
				"beforeend",
				'<div class="sess-meta">Open a company — its app is a fork of the base, managed here.</div>',
			);
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
			const note =
				versionsView === "favorites"
					? "No favorites yet — star a version to keep it handy."
					: "No saved versions yet.";
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
		fetch(`${backendUrl}/api/authority`)
			.then((r) => r.text())
			.then((text) => {
				editor.value = text;
			});
		const save = document.createElement("button");
		save.className = "save";
		save.textContent = "Save authority.toml";
		const note = document.createElement("div");
		note.className = "sess-meta";
		save.onclick = async () => {
			const res = await authorizedPost("/api/authority", {
				content: editor.value,
			});
			const result = await res.json().catch(() => ({ ok: false, error: "unexpected response" }));
			note.textContent = result.ok
				? "saved — gates apply immediately"
				: `rejected: ${result.error ?? "invalid TOML"}`;
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
setupCompanyModal();
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
