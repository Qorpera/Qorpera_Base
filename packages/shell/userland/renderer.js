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
	staff: [],
	scheduledJobs: [],
	connectionRequests: [],
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
let currentStaffId = null; // durable staff identity for the open conversation
let currentStaffIntroStatus = null;
let currentDepartment = null; // product department of the open chat (null = company controller)
let currentWorktree = null; // kernel-assigned product worktree, when applicable
let sidechatOpen = false; // the surface view's docked chat panel
let sidechatPageId = null; // stable page ID the live session is attached to
let sidechatPending = null; // page awaiting its context preamble (fresh session)
const pendingAssistantTextByIndex = new Map();
const renderedAssistantTextByIndex = new Map();
let turnProgressBubbleCount = 0;
let turnProgressLastKind = "";
let turnProgressLastAt = 0;
let threadActivityEl = null;
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
let founderTyping = false;
let avatarActionPhase = "";
let avatarActionTimer = null;
let hiddenNavigation = new Set();
let archivedNavigation = new Set(); // frontend preview only; durable archive remains unbound
let focusedDepartmentId = null;
let navContextTarget = null;
let navContextTrigger = null;
let navContextPoint = { x: 0, y: 0 };
let staffContextTarget = null;
let staffContextTrigger = null;
let staffDeleteTarget = null;
let hiddenStaffTrigger = null;
let archiveTarget = null;
let toastTimeout = null;
let foundationUpdateVersion = "";
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
let staffCatalogCache = null;
let staffCreatorSelection = null;
let staffCreatorPending = false;
let staffCreatorClosing = false;
let staffCreatorColor = "#1684ff";
let staffCreatorShape = "round";
let staffBootstrapSelections = new Set();
let staffBootstrapPending = false;
let railSearchQuery = "";
let activityStaffId = null;
let agentSidepanelMode = null;
let agentRoutineEditor = null; // { staffAgentId, mode: "create"|"edit", id?, draft, dirty, error, status, pending }
let agentSidepanelMotionTimer = null;
let profileCreatorIcon = "hop-warm-titanium";
let currentProfileIcon = "hop-warm-titanium";

const STAFF_AVATAR_COLORS = [
	"#171716",
	"#9c7151",
	"#ff365e",
	"#ff642e",
	"#ffae00",
	"#00c878",
	"#00bfb3",
	"#1684ff",
	"#8a4dff",
	"#ff2994",
	"#7c7c7a",
	"#5367e8",
];
const STAFF_AVATAR_SHAPES = ["soft-square", "round", "wide", "gem", "tilted", "drop"];
const PROFILE_ICONS = [
	{ id: "hop-warm-titanium", label: "Warm titanium", src: "./profile-icons/hop-warm-titanium.png" },
	{ id: "hop-blue-steel", label: "Blue steel", src: "./profile-icons/hop-blue-steel.png" },
	{ id: "hop-mono-cloud", label: "Monochrome cloud", src: "./profile-icons/hop-mono-cloud.png" },
];
const STAFF_COLOR_TOKENS = {
	"qorpera-terracotta": "#ff642e",
	"qorpera-cobalt": "#1684ff",
	"qorpera-amber": "#ffae00",
	"qorpera-emerald": "#00c878",
	"qorpera-violet": "#8a4dff",
	"qorpera-coral": "#ff365e",
	"qorpera-pink": "#ff2994",
	"qorpera-indigo": "#5367e8",
	"qorpera-teal": "#00bfb3",
	"qorpera-blue": "#1684ff",
	"#cc7d5e": "#ff642e",
	"#e9606f": "#ff365e",
	"#d89b35": "#ffae00",
	"#4caf83": "#00c878",
	"#36a5a2": "#00bfb3",
	"#3f88df": "#1684ff",
	"#8c6dd7": "#8a4dff",
	"#d955a1": "#ff2994",
	"#777772": "#5367e8",
};

const DEFAULT_STAFF_TEMPLATES = [
	{
		id: "financial-officer",
		displayName: "Financial Officer",
		name: "Financial Officer",
		description: "Tracks cash, budgets, forecasts, and financial risks.",
		color: "#00c878",
		shape: "gem",
	},
	{
		id: "marketing-lead",
		displayName: "Marketing Lead",
		name: "Marketing Lead",
		description: "Shapes the story, plans campaigns, and measures what creates demand.",
		color: "#ff365e",
		shape: "drop",
	},
	{
		id: "product-manager",
		displayName: "Product Manager",
		name: "Product Manager",
		description: "Turns customer and company needs into clear product priorities.",
		color: "#8a4dff",
		shape: "soft-square",
	},
	{
		id: "software-developer",
		displayName: "Software Developer",
		name: "Software Developer",
		description: "Builds, tests, and maintains the company’s software.",
		color: "#1684ff",
		shape: "wide",
	},
	{
		id: "product-designer",
		displayName: "Product Designer",
		name: "Product Designer",
		description: "Designs clear, useful product experiences from real user needs.",
		color: "#ff2994",
		shape: "round",
	},
	{
		id: "legal-expert",
		displayName: "Legal Expert",
		name: "Legal Expert",
		description: "Reviews contracts, policies, compliance questions, and legal risk.",
		color: "#ffae00",
		shape: "gem",
	},
	{
		id: "operations-specialist",
		displayName: "Operations Specialist",
		name: "Operations Specialist",
		description: "Keeps workflows, schedules, handoffs, and recurring work moving.",
		color: "#ff642e",
		shape: "tilted",
	},
	{
		id: "research-lead",
		displayName: "Research Lead",
		name: "Research Lead",
		description: "Turns open questions into sourced findings and clear recommendations.",
		color: "#5367e8",
		shape: "round",
	},
	{
		id: "costumer-relationist",
		displayName: "Costumer Relationist",
		name: "Costumer Relationist",
		description: "Looks after customer conversations, issues, feedback, and follow-up.",
		color: "#00bfb3",
		shape: "soft-square",
	},
	{
		id: "outreaching-conversationalist",
		displayName: "Outreaching Conversationalist",
		name: "Outreaching Conversationalist",
		description: "Starts useful conversations with prospects, partners, and other people outside the company.",
		color: "#1684ff",
		shape: "drop",
	},
];

function setupSidebarToggle() {
	// The roster rail is permanent. Keeping this no-op preserves the old boot
	// call while intentionally dropping collapse state and its titlebar control.
	document.body.classList.remove("sidebar-collapsed");
}

// ---- Qorpera account -------------------------------------------------------

function setAccountControlsDisabled(disabled) {
	for (const button of $("accountProviders").querySelectorAll("button")) button.disabled = disabled;
	$("accountEmail").disabled = disabled;
	$("accountEmailForm").querySelector("button").disabled = disabled;
}

async function completeAccountSignIn(input) {
	setAccountControlsDisabled(true);
	$("accountStatus").textContent = input.provider === "email" ? "Sending a secure sign-in link…" : "Opening sign-in…";
	try {
		const result = await window.qorpera.accountSignIn(input);
		if (!result?.ok || !result.account?.authenticated) {
			throw new Error(result?.error ?? "Sign-in did not complete.");
		}
		$("accountStatus").textContent = "Signed in.";
		$("accountView").hidden = true;
		await bootSignedInWorkspace();
	} catch (error) {
		$("accountStatus").textContent = error instanceof Error ? error.message : "Sign-in did not complete.";
		setAccountControlsDisabled(false);
	}
}

function renderAccountWelcome() {
	document.body.classList.add("welcome");
	document.body.classList.remove("hub", "company-shell");
	$("accountView").hidden = false;
	$("welcomeView").hidden = true;
	$("wordmark").hidden = false;
	$("accountStatus").textContent = "";
	$("accountEmailForm").hidden = true;
	$("accountEmail").value = "";
	setAccountControlsDisabled(false);
	for (const button of $("accountProviders").querySelectorAll("[data-account-provider]")) {
		button.setAttribute("aria-expanded", "false");
		button.onclick = () => {
			const provider = button.dataset.accountProvider;
			if (provider === "email") {
				const form = $("accountEmailForm");
				form.hidden = !form.hidden;
				button.setAttribute("aria-expanded", String(!form.hidden));
				if (!form.hidden) $("accountEmail").focus();
				return;
			}
			void completeAccountSignIn({ provider });
		};
	}
	$("accountEmailForm").onsubmit = (event) => {
		event.preventDefault();
		void completeAccountSignIn({ provider: "email", email: $("accountEmail").value });
	};
	$("accountProviders").querySelector("button")?.focus();
}

// ---- intelligence-first welcome -------------------------------------------

const DEFAULT_INTELLIGENCE_PROVIDERS = [
	{ id: "openai-codex", name: "OpenAI", description: "Continue with your OpenAI or ChatGPT account", logo: "./provider-openai.svg" },
	{ id: "anthropic", name: "Anthropic", description: "Continue with your Claude account", logo: "./provider-anthropic.svg" },
	{ id: "xai", name: "xAI", description: "Continue with your xAI account", logo: "./provider-xai.svg" },
];

function intelligenceIsConfigured(info) {
	return Boolean(info?.configured || info?.ready || info?.activeProvider || info?.providerId || info?.status === "configured");
}

function intelligenceProviders(info) {
	const source = Array.isArray(info?.providers) && info.providers.length ? info.providers : DEFAULT_INTELLIGENCE_PROVIDERS;
	return source.map((provider, index) => ({
		id: provider.id ?? provider.providerId ?? provider.key,
		name: provider.name ?? provider.label ?? provider.id ?? "Provider",
		description: provider.description ?? provider.detail ?? "Sign in and use this intelligence for your staff",
		logo: provider.logo ?? DEFAULT_INTELLIGENCE_PROVIDERS[index % DEFAULT_INTELLIGENCE_PROVIDERS.length].logo,
		disabled: provider.available === false || provider.enabled === false,
	})).filter((provider) => provider.id);
}

async function renderIntelligenceWelcome(info) {
	document.body.classList.add("welcome");
	document.body.classList.remove("hub");
	$("accountView").hidden = true;
	$("welcomeView").hidden = false;
	$("wordmark").hidden = false;
	const list = $("intelligenceProviders");
	list.replaceChildren();
	for (const provider of intelligenceProviders(info)) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "provider-option";
		button.disabled = provider.disabled;
		button.innerHTML = '<span class="provider-mark"><img alt=""></span><span class="provider-option-copy"><strong></strong><small></small></span><span class="provider-option-arrow" aria-hidden="true">→</span>';
		button.querySelector(".provider-mark img").src = provider.logo;
		button.querySelector("strong").textContent = provider.name;
		button.querySelector("small").textContent = provider.description;
		button.onclick = async () => {
			for (const option of list.querySelectorAll("button")) option.disabled = true;
			$("intelligenceStatus").textContent = `Opening ${provider.name} sign-in…`;
			try {
				const result = await window.qorpera.configureIntelligence(provider.id);
				if (result?.ok === false) throw new Error(result.error ?? `${provider.name} could not be configured.`);
				const next = await window.qorpera.intelligenceInfo();
				if (!intelligenceIsConfigured(next) && result?.configured !== true && result?.ready !== true) {
					throw new Error(result?.message ?? "Sign-in did not complete.");
				}
				$("intelligenceStatus").textContent = `${provider.name} is ready.`;
				$("welcomeView").hidden = true;
				document.body.classList.remove("welcome");
				await bootWorkspace();
			} catch (error) {
				$("intelligenceStatus").textContent = error instanceof Error ? error.message : "Sign-in did not complete.";
				for (const option of list.querySelectorAll("button")) option.disabled = false;
			}
		};
		list.appendChild(button);
	}
	list.querySelector("button:not(:disabled)")?.focus();
}

// ---- hub -------------------------------------------------------------------

/** The hub is a full-screen launcher in <main> (#view-hub) — no sidebar,
 * no empty sheet. body.hub gates its visibility and hides the nav chrome. */
async function renderHub() {
	renderUpdateButton();
	document.body.classList.add("hub");
	document.body.classList.remove("welcome", "company-shell");
	$("welcomeView").hidden = true;
	$("accountView").hidden = true;
	$("wordmark").hidden = false;
	document.title = "Qorpera Base";
	$("hubError").textContent = "";
	const companies = await window.qorpera.listCompanies();
	const grid = $("hubCompanies");
	grid.innerHTML = "";
	for (const company of companies) {
		const shell = document.createElement("div");
		shell.className = "profile-card-shell";
		const card = document.createElement("button");
		card.className = "hub-card profile-card";
		card.type = "button";
		card.setAttribute("aria-label", `Open ${company.name} profile`);
		const avatar = makeProfileIcon(company.profileIcon, company.name, "profile-avatar");
		const label = document.createElement("strong");
		label.textContent = company.name;
		card.append(avatar, label);
		card.onclick = () => {
			// The click must visibly land: opening provisions the local sandbox,
			// which can take seconds — spin the card and quiet the rest.
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
		const actions = document.createElement("button");
		actions.className = "profile-card-actions";
		actions.type = "button";
		actions.setAttribute("aria-label", `Profile actions for ${company.name}`);
		actions.setAttribute("aria-expanded", "false");
		actions.textContent = "•••";
		const menu = document.createElement("div");
		menu.className = "profile-card-menu";
		menu.hidden = true;
		menu.setAttribute("role", "menu");
		const remove = document.createElement("button");
		remove.type = "button";
		remove.setAttribute("role", "menuitem");
		remove.textContent = "Remove profile";
		remove.onclick = async () => {
			menu.hidden = true;
			actions.setAttribute("aria-expanded", "false");
			const result = await window.qorpera.removeProfile(company.root);
			if (result?.ok) {
				await renderHub();
				return;
			}
			if (!result?.cancelled) $("hubError").textContent = result?.error ?? "Profile could not be removed.";
		};
		menu.appendChild(remove);
		actions.onclick = () => {
			menu.hidden = !menu.hidden;
			actions.setAttribute("aria-expanded", String(!menu.hidden));
			if (!menu.hidden) remove.focus();
		};
		shell.append(card, actions, menu);
		grid.appendChild(shell);
	}
	const create = document.createElement("button");
	create.className = "hub-card create profile-card profile-add-card";
	create.type = "button";
	create.innerHTML = '<span class="plus" aria-hidden="true">+</span><strong>New profile</strong>';
	create.onclick = openCompanyModal;
	grid.appendChild(create);
}

async function signOut() {
	const button = $("signOutButton");
	button.disabled = true;
	button.textContent = "Signing out…";
	$("hubError").textContent = "";
	try {
		const result = await window.qorpera.accountSignOut();
		if (!result?.ok) throw new Error(result?.error ?? "Could not sign out.");
		renderAccountWelcome();
		document.documentElement.dataset.qorperaReady = "account";
	} catch (error) {
		$("hubError").textContent = error instanceof Error ? error.message : "Could not sign out.";
	} finally {
		button.disabled = false;
		button.textContent = "Sign out";
	}
}

// ---- founding a durable company ----------------------------------------------
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

function profileIcon(iconId) {
	return PROFILE_ICONS.find((candidate) => candidate.id === iconId) ?? PROFILE_ICONS[0];
}

function makeProfileIcon(iconId, label, className = "") {
	const shell = document.createElement("span");
	shell.className = `company-profile-icon ${className}`.trim();
	const image = document.createElement("img");
	image.src = profileIcon(iconId).src;
	image.alt = "";
	image.setAttribute("aria-hidden", "true");
	shell.appendChild(image);
	if (label) shell.setAttribute("aria-label", `${label} profile`);
	return shell;
}

function renderCompanyIconPicker() {
	const picker = $("companyIconPicker");
	picker.replaceChildren();
	for (const icon of PROFILE_ICONS) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "company-icon-choice";
		button.dataset.profileIcon = icon.id;
		button.setAttribute("role", "radio");
		button.setAttribute("aria-label", icon.label);
		button.setAttribute("aria-checked", String(icon.id === profileCreatorIcon));
		button.appendChild(makeProfileIcon(icon.id, ""));
		button.onclick = () => {
			profileCreatorIcon = icon.id;
			$("companyIconPreview").src = icon.src;
			for (const choice of picker.querySelectorAll(".company-icon-choice")) {
				choice.setAttribute("aria-checked", String(choice.dataset.profileIcon === profileCreatorIcon));
			}
		};
		picker.appendChild(button);
	}
}

function openCompanyModal() {
	profileCreatorIcon = PROFILE_ICONS[0].id;
	$("companyName").value = "";
	$("companyFormError").textContent = "";
	$("companyCreate").disabled = true;
	$("companyIconPreview").src = profileIcon(profileCreatorIcon).src;
	renderCompanyIconPicker();
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
		$("companyFormError").textContent = "";
		button.disabled = true;
		button.textContent = "Creating…";
		try {
			const created = await window.qorpera.newCompany(root, profileCreatorIcon);
			const opened = await openCompany(created, $("companyFormError"));
			if (opened) closeCompanyModal();
		} catch (error) {
			$("companyFormError").textContent = `Could not create the profile: ${(error && error.message) || error}`;
		} finally {
			button.textContent = "Create profile";
			button.disabled = false;
		}
	});
}

// ---- company ---------------------------------------------------------------

async function openCompany(root, errorTarget = $("hubError")) {
	// The kernel opens the company runtime and reloads this fixed shell into
	// its isolated renderer partition. Returns false so a failed open can hand
	// control back to the hub.
	try {
		if (errorTarget) errorTarget.textContent = "";
		await window.qorpera.openCompany(root);
		return true;
	} catch (error) {
		if (errorTarget) errorTarget.textContent = `Could not open the profile: ${(error && error.message) || error}`;
		return false;
	}
}

/** Boot into an already-open company (called after the kernel loads us). */
async function enterCompany(active) {
	backendUrl = active.backendUrl;
	companyId = active.id || "";
	currentProfileIcon = profileIcon(active.profileIcon).id;
	// Appearance was applied at boot from the pre-company bucket; re-apply now
	// that this company's stored appearance is addressable.
	applyNavAppearance();
	hiddenNavigation = new Set(readStoredArray("nav-hidden"));
	archivedNavigation = new Set();
	focusedDepartmentId = null;
	document.body.classList.remove("hub", "welcome");
	document.body.classList.add("company-shell");
	$("welcomeView").hidden = true;
	$("accountView").hidden = true;
	$("hubnav").style.display = "none";
	$("conav").style.display = "";
	$("messages").innerHTML = "";
	resetWorkGroup();
	// The kernel resumes the newest founder session across restarts; adopt its
	// trail file so the chat pile marks it active and caching keys line up.
	currentSession = active.sessionFile ?? null;
	currentStaffId = null;
	if (active.kickoff) {
		addMsg("tool", "· conception started — the controller is studying the company…");
	}
	renderUpdateButton();
	show("roster");
	// With history: the chat child survives window reloads (dev-lane rebuilds
	// reload the chrome), so the live thread must come back with it. A fresh
	// child answers with an empty history — harmless.
	await refreshState();
	const resumed = (state.sessions ?? []).find((session) => session.file === currentSession);
	currentStaffId = activeStaffMembers().some((staff) => staffId(staff) === resumed?.staffAgentId)
		? resumed.staffAgentId
		: null;
	renderStaffHome();
	renderRosterRail();
	hydratedExecutorId = runtimeForTrail(currentSession)?.executorId ?? "";
	connectSessionRuntime();
	document.title = state.name || "Qorpera Base";
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
	syncVisibleStaffAvatars();
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
	$("modelCtlMenu").classList.remove("open");
	$("modelCtlBtn").setAttribute("aria-expanded", "false");
	openChipMenu = null;
}
document.addEventListener("click", (event) => {
	const path = event.composedPath();
	if (
		openChipMenu &&
		!openChipMenu.menu.contains(event.target) &&
		!openChipMenu.button.contains(event.target) &&
		!$("modelCtlMenu").contains(event.target) &&
		!$("modelCtlBtn").contains(event.target) &&
		!path.includes(openChipMenu.button)
	) {
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
	const effortOutput = $("mcEffortLabel");
	let effortLabelAnimation = null;
	let effortSnapAnimationFrame = null;
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
	const showEffortLabel = (label, animate = false) => {
		effortLabelAnimation?.cancel();
		effortLabelAnimation = null;
		effortOutput.textContent = label;
		if (!animate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		effortLabelAnimation = effortOutput.animate(
			[
				{ opacity: 0.48, transform: "translateY(2px)" },
				{ opacity: 1, transform: "translateY(0)" },
			],
			{ duration: 110, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
		);
		effortLabelAnimation.onfinish = () => {
			effortLabelAnimation = null;
		};
	};
	const currentModel = () => models.find((m) => m.value === currentModelKey);
	const fastOn = () => Boolean(currentModel()?.fastCapable) && currentSpeed === "fast";
	// The row lives inside the composer's More menu. Keep its compact, fixed
	// title while the detailed model controls remain in the nested picker.
	const renderChip = () => {
		const icon = button.querySelector("img")?.cloneNode(true);
		const title = document.createElement("span");
		title.textContent = "Model & effort";
		const detail = [fastOn() ? "Fast" : "", currentModel()?.name ?? "Model", currentEffort ? effortLabel(currentEffort) : ""]
			.filter(Boolean)
			.join(" · ");
		button.title = `Model & effort · ${detail}`;
		button.replaceChildren(...(icon ? [icon, title] : [title]));
	};
	// The track is painted by hand: accent fill up to the knob, a faint dot
	// per stop (the Desktop look — accent-color can't draw ticks).
	const paintTrack = () => {
		const max = Math.max(Number(slider.max), 1);
		const fill = (Number(slider.value) / max) * 100;
		const layers = [];
		for (let i = 1; i < max; i++) {
			const at = 4 + (i / max) * 92;
			layers.push(`radial-gradient(circle at ${at}% 50%, rgba(255, 255, 255, 0.62) 1.5px, transparent 2px)`);
		}
		layers.push(`linear-gradient(to right, var(--mc-blue) ${fill}%, #e3e3e0 ${fill}%)`);
		slider.style.setProperty("--mc-track", layers.join(", "));
	};
	const sync = () => {
		persist();
		renderChip();
		slider.max = String(Math.max(levels.length - 1, 0));
		const index = levels.indexOf(currentEffort);
		if (index >= 0) slider.value = String(index);
		slider.title = currentEffort ? `Effort: ${effortLabel(currentEffort)}` : "Effort";
		showEffortLabel(currentEffort ? effortLabel(currentEffort) : "Default");
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
				drop.setAttribute("aria-expanded", "false");
				sync();
			};
			list.appendChild(item);
		}
	};
	const sliderLevel = () => {
		const index = Math.max(0, Math.min(levels.length - 1, Math.round(Number(slider.value))));
		return levels[index];
	};
	slider.oninput = () => {
		if (effortSnapAnimationFrame !== null) {
			cancelAnimationFrame(effortSnapAnimationFrame);
			effortSnapAnimationFrame = null;
		}
		const level = sliderLevel();
		if (!level) return;
		if (level !== currentEffort) {
			currentEffort = level;
			slider.title = `Effort: ${effortLabel(level)}`;
			showEffortLabel(effortLabel(level), true);
			renderChip();
		}
		paintTrack();
	};
	slider.onchange = () => {
		const level = sliderLevel();
		if (!level) return;
		const target = levels.indexOf(level);
		const start = Number(slider.value);
		const finish = () => {
			effortSnapAnimationFrame = null;
			slider.value = String(target);
			paintTrack();
			currentEffort = level;
			persist();
			sendRpc({ type: "set_thinking_level", level });
		};
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || Math.abs(target - start) < 0.001) {
			finish();
			return;
		}
		const startedAt = performance.now();
		const duration = 145;
		const animateSnap = (now) => {
			const progress = Math.min(1, (now - startedAt) / duration);
			const eased = 1 - (1 - progress) ** 3;
			slider.value = String(start + (target - start) * eased);
			paintTrack();
			if (progress < 1) effortSnapAnimationFrame = requestAnimationFrame(animateSnap);
			else finish();
		};
		effortSnapAnimationFrame = requestAnimationFrame(animateSnap);
	};
	speed.onclick = () => {
		if (speed.disabled) return;
		currentSpeed = currentSpeed === "fast" ? "standard" : "fast";
		sendRpc({ type: "set_response_speed", speed: currentSpeed });
		sync();
	};
	// An empty list is a dark sliver, not a menu — don't open until models exist.
	drop.onclick = () => {
		if (!models.length) return;
		const opening = !list.classList.contains("open");
		list.classList.toggle("open", opening);
		drop.setAttribute("aria-expanded", String(opening));
	};
	button.onclick = (event) => {
		// Keep clicks on every part of the menu row inside the composite menu.
		// In particular, the icon-side hit target must not reach the document's
		// outside-click handler and dismiss the parent menu.
		event.stopPropagation();
		if (menu.classList.contains("open")) {
			menu.classList.remove("open");
			button.setAttribute("aria-expanded", "false");
			return;
		}
		const parentMenu = $("composerMoreMenu");
		if (!parentMenu.classList.contains("open")) return;
		const parentRect = parentMenu.getBoundingClientRect();
		const buttonRect = button.getBoundingClientRect();
		sync();
		list.classList.remove("open");
		drop.setAttribute("aria-expanded", "false");
		const panelWidth = 252;
		const preferredLeft = parentRect.right + 8;
		const left =
			preferredLeft + panelWidth <= window.innerWidth - 8
				? preferredLeft
				: Math.max(8, parentRect.left - panelWidth - 8);
		menu.style.left = `${left}px`;
		menu.style.right = "auto";
		menu.style.bottom = "auto";
		menu.classList.add("open");
		const panelHeight = menu.getBoundingClientRect().height;
		menu.style.top = `${Math.max(8, Math.min(buttonRect.bottom - panelHeight, window.innerHeight - panelHeight - 8))}px`;
		button.setAttribute("aria-expanded", "true");
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

// ---- composer More: attachments, intelligence, and worktree ----------------

const composerMore = (() => {
	const button = $("composerMoreButton");
	const menu = $("composerMoreMenu");
	const addFiles = $("composerAddFilesButton");
	const worktree = $("composerNewWorktree");
	document.body.appendChild(menu);

	const worktreeAvailable = () => Boolean(!currentStaffId && currentDepartment);
	const sync = () => {
		const available = worktreeAvailable();
		worktree.setAttribute("aria-disabled", String(!available));
		worktree.title = available
			? `Create a fresh ${departmentName(currentDepartment)} worktree`
			: currentStaffId
				? "Choose a product artifact before creating one"
				: "Available for product work";
	};

	const close = () => {
		if (openChipMenu?.menu === menu) closeOpenChipMenu();
	};

	button.onclick = () => {
		if (menu.classList.contains("open")) {
			closeOpenChipMenu();
			return;
		}
		closeOpenChipMenu();
		sync();
		const rect = button.getBoundingClientRect();
		menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 222))}px`;
		menu.style.bottom = `${window.innerHeight - rect.top + 8}px`;
		menu.classList.add("open");
		button.setAttribute("aria-expanded", "true");
		openChipMenu = { menu, button };
	};
	addFiles.onclick = () => {
		close();
		$("attachFileInput").click();
	};
	worktree.onclick = () => {
		if (!worktreeAvailable()) {
			showControllerToast(
				currentStaffId
					? "Open a product artifact before creating an isolated worktree."
					: "New worktrees are available from a product conversation.",
			);
			return;
		}
		const department = (state.departments ?? []).find((entry) => entry.path === currentDepartment);
		if (!department) {
			showControllerToast("The product workspace is not available.");
			return;
		}
		close();
		void openDepartmentChat(department, currentNodeId ?? "q:chats");
	};
	return { sync };
})();

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
	const staff = currentStaff();
	$("input").placeholder = sidechatOwner
		? `Ask about ${sidechatOwner.label}… (Enter to send, Shift+Enter for newline)`
		: staff
			? `Message ${staffDisplayName(staff)}…`
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
		currentStaffId = null;
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
	renderThreadHeader();
	syncConnectionRequestCards();
	syncScopeChrome();
	renderCompanyNavSafe();
	hydrateAgentState(false);
});

/** The bottom company control stays deliberately one-line and unlabelled. */
function renderProfileRow() {
	renderCompanySwitcher();
}

function staffId(staff) {
	return staff?.id ?? staff?.staffAgentId ?? "";
}

function staffDisplayName(staff) {
	return staff?.displayName ?? staff?.name ?? staff?.role ?? "Staff member";
}

function staffTemplateId(staff) {
	return staff?.templateId ?? staff?.roleId ?? staff?.kind ?? "";
}

function templateId(template) {
	return template?.id ?? template?.templateId ?? "";
}

function templateName(template) {
	return template?.name ?? template?.displayName ?? template?.role ?? "Staff member";
}

function staffTemplate(staff) {
	return (staffCatalogCache ?? DEFAULT_STAFF_TEMPLATES).find((template) => templateId(template) === staffTemplateId(staff));
}

function staffColor(staffOrTemplate) {
	const direct = staffOrTemplate?.appearance?.color ?? staffOrTemplate?.color ?? staffOrTemplate?.accentColor;
	if (direct) return STAFF_COLOR_TOKENS[direct] ?? direct;
	const source = staffId(staffOrTemplate) ? staffTemplate(staffOrTemplate) : staffOrTemplate;
	const color = source?.avatarColorToken ?? source?.color;
	return STAFF_COLOR_TOKENS[color] ?? color ?? "#ff642e";
}

function staffMark(staffOrTemplate) {
	const source = staffId(staffOrTemplate) ? staffTemplate(staffOrTemplate) : staffOrTemplate;
	if (source?.mark) return source.mark;
	return staffDisplayName(staffOrTemplate)
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((part) => part[0])
		.join("")
		.toUpperCase() || "Q";
}

function staffShape(staffOrTemplate) {
	const direct = staffOrTemplate?.appearance?.shape ?? staffOrTemplate?.shape;
	if (STAFF_AVATAR_SHAPES.includes(direct)) return direct;
	const source = staffId(staffOrTemplate) ? staffTemplate(staffOrTemplate) : staffOrTemplate;
	const shape = source?.avatarShapeToken ?? source?.shape;
	return STAFF_AVATAR_SHAPES.includes(shape) ? shape : "soft-square";
}

function staffDescription(staffOrTemplate) {
	const source = staffId(staffOrTemplate) ? staffTemplate(staffOrTemplate) : staffOrTemplate;
	return staffOrTemplate?.description ?? source?.description ?? "Works alongside you and keeps this responsibility moving.";
}

function staffRoleLabel(staff) {
	return staff?.role ?? staffTemplate(staff)?.name ?? "Staff member";
}

function currentStaff() {
	return activeStaffMembers().find((staff) => staffId(staff) === currentStaffId);
}

function activeStaffMembers() {
	return (state.staff ?? []).filter((staff) => staff?.employmentStatus !== "archived");
}

function staffRuntime(staff) {
	const id = staffId(staff);
	return (state.runtime?.sessions ?? []).find(
		(runtime) => (runtime.staffAgentId ?? runtime.agentId) === id && runtime.live,
	);
}

function staffStatus(staff) {
	const runtime = staffRuntime(staff);
	if (runtime?.status === "reconnecting") return "reconnecting";
	if (staffId(staff) === currentStaffId && avatarActionPhase) return avatarActionPhase;
	if (runtime?.status === "starting") return "starting";
	if (runtime?.status === "running") return "working";
	if (runtime?.status === "finishing") return "finishing";
	if (staffId(staff) === currentStaffId && founderTyping && currentView === "chat") return "listening";
	return staff?.status === "working" || staff?.status === "running" ? "working" : "idle";
}

const STAFF_MOTION_STATES = ["idle", "listening", "starting", "working", "finishing", "reconnecting"];

function setAvatarMotionState(avatar, status) {
	avatar.classList.remove(...STAFF_MOTION_STATES);
	avatar.classList.add(STAFF_MOTION_STATES.includes(status) ? status : "idle");
}

function syncVisibleStaffAvatars() {
	for (const avatar of document.querySelectorAll(".staff-avatar[data-staff-id]")) {
		const staff = activeStaffMembers().find((candidate) => staffId(candidate) === avatar.dataset.staffId);
		if (staff) setAvatarMotionState(avatar, staffStatus(staff));
	}
}

function setCurrentAvatarAction(phase, duration = 0) {
	if (avatarActionTimer) clearTimeout(avatarActionTimer);
	avatarActionTimer = null;
	avatarActionPhase = phase;
	syncVisibleStaffAvatars();
	if (duration > 0) {
		avatarActionTimer = setTimeout(() => {
			avatarActionTimer = null;
			avatarActionPhase = "";
			syncVisibleStaffAvatars();
		}, duration);
	}
}

function makeStaffAvatar(staffOrTemplate, status = "idle") {
	const avatar = document.createElement("span");
	avatar.className = `staff-avatar ${status} shape-${staffShape(staffOrTemplate)}`;
	avatar.style.setProperty("--staff-color", staffColor(staffOrTemplate));
	avatar.style.setProperty("--staff-motion-delay", staffMotionDelay(staffOrTemplate));
	if (staffId(staffOrTemplate)) avatar.dataset.staffId = staffId(staffOrTemplate);
	avatar.append(makeStaffWorkOrbit("blue"), makeStaffWorkOrbit("duo"));
	avatar.appendChild(makeStaffFace());
	avatar.setAttribute("aria-hidden", "true");
	return avatar;
}

function staffMotionDelay(staffOrTemplate) {
	const identity = staffId(staffOrTemplate) || templateId(staffOrTemplate) || staffDisplayName(staffOrTemplate);
	let seed = 0;
	for (const character of identity) seed = (seed * 31 + character.charCodeAt(0)) % 9600;
	return `${-seed}ms`;
}

function makeStaffWorkOrbit(variant) {
	const orbit = document.createElement("img");
	orbit.className = `staff-work-orbit staff-work-orbit-${variant}`;
	orbit.src = variant === "duo" ? "./staff-work-orbit-duo.png" : "./staff-work-orbit.png";
	orbit.alt = "";
	orbit.setAttribute("aria-hidden", "true");
	return orbit;
}

function makeStaffFace() {
	const figure = document.createElement("span");
	figure.className = "staff-face";
	figure.setAttribute("aria-hidden", "true");
	figure.append(document.createElement("i"), document.createElement("i"));
	return figure;
}

function paintStaffAvatar(avatar, staff, status = "idle") {
	avatar.replaceChildren(makeStaffWorkOrbit("blue"), makeStaffWorkOrbit("duo"), makeStaffFace());
	avatar.style.setProperty("--staff-color", staffColor(staff));
	avatar.style.setProperty("--staff-motion-delay", staffMotionDelay(staff));
	avatar.className = `staff-avatar ${status} shape-${staffShape(staff)}`;
	if (staffId(staff)) avatar.dataset.staffId = staffId(staff);
	else delete avatar.dataset.staffId;
}

async function loadStaffCatalog(force = false) {
	if (staffCatalogCache && !force) return staffCatalogCache;
	let remote = [];
	if (typeof window.qorpera.staffCatalog === "function") {
		try {
			const result = await window.qorpera.staffCatalog();
			remote = Array.isArray(result) ? result : (result?.templates ?? result?.staff ?? []);
		} catch {
			remote = [];
		}
	}
	const byId = new Map(remote.map((template) => [templateId(template), template]));
	staffCatalogCache = DEFAULT_STAFF_TEMPLATES.map((fallback) => ({ ...fallback, ...(byId.get(fallback.id) ?? {}) }));
	for (const template of remote) {
		if (!staffCatalogCache.some((known) => templateId(known) === templateId(template))) staffCatalogCache.push(template);
	}
	return staffCatalogCache;
}

function renderTemplateCards(container, templates, selectedId, onSelect) {
	container.replaceChildren();
	for (const template of templates) {
		const id = templateId(template);
		const card = document.createElement("button");
		card.type = "button";
		card.className = "staff-template-card";
		card.classList.toggle("selected", id === selectedId);
		card.setAttribute("role", "radio");
		card.setAttribute("aria-checked", String(id === selectedId));
		card.style.setProperty("--staff-color", staffColor(template));
		card.appendChild(makeStaffAvatar(template));
		const title = document.createElement("strong");
		title.textContent = templateName(template);
		const description = document.createElement("p");
		description.textContent = staffDescription(template);
		const detail = document.createElement("small");
		detail.textContent = template.detail ?? "Persistent staff · proactive first message";
		card.append(title, description, detail);
		card.onclick = () => onSelect(template);
		container.appendChild(card);
	}
}

function syncStaffTemplateScrollbar() {
	const grid = $("staffTemplateGrid");
	const scrollbar = $("staffTemplateScrollbar");
	const thumb = $("staffTemplateScrollbarThumb");
	const scrollRange = Math.max(0, grid.scrollWidth - grid.clientWidth);
	if (scrollRange <= 1 || scrollbar.clientWidth <= 0) {
		scrollbar.hidden = true;
		return;
	}
	scrollbar.hidden = false;
	const thumbWidth = Math.max(54, Math.round((grid.clientWidth / grid.scrollWidth) * scrollbar.clientWidth));
	const travel = Math.max(0, scrollbar.clientWidth - thumbWidth);
	const offset = scrollRange > 0 ? Math.round((grid.scrollLeft / scrollRange) * travel) : 0;
	thumb.style.width = `${thumbWidth}px`;
	thumb.style.transform = `translateX(${offset}px)`;
}

async function openStaffCreator() {
	staffCreatorPending = false;
	staffCreatorClosing = false;
	$("staffCreateStatus").textContent = "";
	$("staffModal").hidden = false;
	document.body.classList.add("staff-creator-open");
	$("threadHeader").hidden = true;
	$("staffCreatorTitlebar").hidden = false;
	if (!$("agentSidepanel").hidden) closeAgentSidepanel(false);
	renderRosterRail({ animateCreateRow: true });
	const templates = await loadStaffCatalog();
	const clearSelection = () => {
		staffCreatorSelection = null;
		staffCreatorColor = "#1684ff";
		staffCreatorShape = "round";
		$("staffDisplayName").value = "";
		$("staffCreateButton").disabled = true;
		paintStaffAvatar($("staffCreatorAvatar"), { color: staffCreatorColor, shape: staffCreatorShape });
		$("staffCreatorRole").textContent = "New Agent";
		$("staffCreatorDescription").textContent = "";
		renderStaffAppearancePickers();
		renderTemplateCards($("staffTemplateGrid"), templates, "", select);
		requestAnimationFrame(syncStaffTemplateScrollbar);
	};
	const select = (template) => {
		if (templateId(staffCreatorSelection) === templateId(template)) {
			clearSelection();
			return;
		}
		staffCreatorSelection = template;
		staffCreatorColor = staffColor(template);
		staffCreatorShape = staffShape(template);
		$("staffDisplayName").value = template.displayName ?? templateName(template);
		$("staffCreateButton").disabled = false;
		paintStaffAvatar($("staffCreatorAvatar"), { color: staffCreatorColor, shape: staffCreatorShape });
		$("staffCreatorRole").textContent = templateName(template);
		$("staffCreatorDescription").textContent = staffDescription(template);
		renderStaffAppearancePickers();
		renderTemplateCards($("staffTemplateGrid"), templates, templateId(template), select);
		requestAnimationFrame(syncStaffTemplateScrollbar);
	};
	clearSelection();
	requestAnimationFrame(() => {
		$("staffDisplayName").focus();
		syncStaffTemplateScrollbar();
	});
}

function renderStaffAppearancePickers() {
	const colorPicker = $("staffColorPicker");
	colorPicker.replaceChildren();
	for (const color of STAFF_AVATAR_COLORS) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "staff-color-choice";
		button.style.setProperty("--choice-color", color);
		button.setAttribute("role", "radio");
		button.setAttribute("aria-label", `Use ${color}`);
		button.setAttribute("aria-checked", String(color === staffCreatorColor));
		button.onclick = () => {
			staffCreatorColor = color;
			paintStaffAvatar($("staffCreatorAvatar"), { color: staffCreatorColor, shape: staffCreatorShape });
			renderStaffAppearancePickers();
		};
		colorPicker.appendChild(button);
	}
	const shapePicker = $("staffShapePicker");
	shapePicker.replaceChildren();
	for (const shape of STAFF_AVATAR_SHAPES) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = `staff-shape-choice shape-${shape}`;
		button.style.setProperty("--staff-color", staffCreatorColor);
		button.setAttribute("role", "radio");
		button.setAttribute("aria-label", `Use ${shape.replace("-", " ")} face`);
		button.setAttribute("aria-checked", String(shape === staffCreatorShape));
		button.appendChild(makeStaffFace());
		button.onclick = () => {
			staffCreatorShape = shape;
			paintStaffAvatar($("staffCreatorAvatar"), { color: staffCreatorColor, shape: staffCreatorShape });
			renderStaffAppearancePickers();
		};
		shapePicker.appendChild(button);
	}
}

function closeStaffCreator() {
	if (staffCreatorPending || staffCreatorClosing) return;
	staffCreatorClosing = true;
	const finish = () => {
		$("staffModal").hidden = true;
		document.body.classList.remove("staff-creator-open");
		$("staffCreatorTitlebar").hidden = true;
		$("threadHeader").hidden =
			currentView !== "chat" && !(currentStaffId && (currentView === "surface" || currentView === "panel"));
		staffCreatorSelection = null;
		staffCreatorClosing = false;
		renderRosterRail();
		$("addStaffButton").focus();
	};
	const createRow = document.querySelector(".staff-create-row");
	if (!createRow || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
		finish();
		return;
	}
	createRow.classList.add("is-closing");
	window.setTimeout(finish, 220);
}

async function createStaffMember() {
	if (staffCreatorPending) return;
	const displayName = $("staffDisplayName").value.trim();
	if (!displayName) {
		$("staffDisplayName").focus();
		return;
	}
	staffCreatorPending = true;
	$("staffCreateButton").disabled = true;
	$("staffCreateButton").textContent = "Creating…";
	$("staffCreateStatus").textContent = "Creating the agent and preparing its introduction…";
	try {
		const result = await window.qorpera.staffCreate({
			...(staffCreatorSelection ? { templateId: templateId(staffCreatorSelection) } : {}),
			displayName,
			appearance: { color: staffCreatorColor, shape: staffCreatorShape },
		});
		if (result?.ok === false) throw new Error(result.error ?? "Staff member could not be created.");
		const created = result?.staff ?? result?.agent ?? result;
		const id = staffId(created) || result?.staffAgentId;
		const sessionFile = result?.sessionFile ?? created?.sessionFile ?? created?.primarySessionFile;
		if (!id || !sessionFile) throw new Error("The staff member was created without a conversation session.");
		if (created && typeof created === "object" && !(state.staff ?? []).some((staff) => staffId(staff) === id)) {
			state.staff = [...(state.staff ?? []), { ...created, id, sessionFile }];
		}
		$("staffModal").hidden = true;
		document.body.classList.remove("staff-creator-open");
		$("staffCreatorTitlebar").hidden = true;
		activateStaffSession(id, sessionFile, result);
		$("staffCreateStatus").textContent = "Your new staff member is getting ready to introduce themselves…";
		let intro;
		for (let attempt = 0; attempt < 12; attempt += 1) {
			intro = await window.qorpera.staffIntroReady(id, sessionFile);
			if (intro?.ok !== false || intro.error !== "staff introduction target is not the attached ready session") break;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		if (intro?.ok === false) throw new Error(intro.error ?? "The staff introduction did not finish.");
		staffCreatorPending = false;
		await refreshState();
		setTimeout(() => {
			if (currentStaffId === id && currentSession === sessionFile) sendRpc({ type: "get_messages" });
		}, 600);
	} catch (error) {
		staffCreatorPending = false;
		const message = error instanceof Error ? error.message : "Staff member could not be created.";
		$("staffCreateStatus").textContent = message;
		if ($("staffModal").hidden) showControllerToast(message);
	} finally {
		$("staffCreateButton").textContent = "Create";
		$("staffCreateButton").disabled = staffCreatorPending || !$("staffDisplayName").value.trim();
	}
}

function setStaffRoute(id) {
	const next = `#/staff/${encodeURIComponent(id)}`;
	if (location.hash !== next) history.replaceState(null, "", next);
}

function activateStaffSession(id, sessionFile, result = {}) {
	cacheCurrentSession();
	currentStaffId = id;
	setCurrentAvatarAction("");
	currentStaffIntroStatus = result?.introStatus ?? result?.staff?.introStatus ?? null;
	currentSession = sessionFile;
	currentDepartment = result?.department ?? null;
	currentWorktree = result?.worktree ?? null;
	sidechatPageId = null;
	sidechatPending = null;
	currentNodeId = null;
	setStaffRoute(id);
	$("messages").innerHTML = sessionCache[sessionFile] ?? pageSkeletonMarkup();
	resetWorkGroup();
	show("chat");
	renderThreadHeader();
	if (!$("agentSidepanel").hidden && currentStaff()) {
		if (agentSidepanelMode === "settings") renderAgentSettingsPanel(currentStaff());
		else renderAgentComputerPanel(currentStaff());
	}
	renderRosterRail();
	syncScopeChrome();
	hydrateAgentState(true);
}

async function openStaff(id) {
	if (!$("staffModal").hidden) closeStaffCreator();
	if (currentView === "chat" && id === currentStaffId && currentSession && !agentExited) {
		setStaffRoute(id);
		show("chat");
		renderThreadHeader();
		syncConnectionRequestCards();
		return;
	}
	const navigation = ++navigationGeneration;
	cacheCurrentSession();
	const result = await window.qorpera.staffOpen(id).catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
	if (navigation !== navigationGeneration) return;
	if (result?.ok === false) {
		showControllerToast(result.error ?? "This staff member could not be opened.");
		return;
	}
	const staff = activeStaffMembers().find((candidate) => staffId(candidate) === id);
	const sessionFile = result?.sessionFile ?? result?.staff?.sessionFile ?? staff?.sessionFile ?? staff?.primarySessionFile;
	if (!sessionFile) {
		showControllerToast("This staff member does not have a conversation session yet.");
		return;
	}
	activateStaffSession(id, sessionFile, result);
}

function renderThreadHeader() {
	const staff = currentStaff();
	const avatar = $("threadAvatar");
	if (staff) {
		paintStaffAvatar(avatar, staff, staffStatus(staff));
		$("threadTitle").textContent = staffDisplayName(staff);
	} else {
		paintStaffAvatar(avatar, { color: "#171716", shape: "soft-square" });
		$("threadTitle").textContent = state.name || "Qorpera";
	}
	$("staffIdentityButton").disabled = !staff;
	$("staffIdentityButton").setAttribute("aria-expanded", String(Boolean(staff && agentSidepanelMode === "settings")));
	$("staffSidepanelButton").hidden = !staff;
	$("staffSidepanelButton").setAttribute("aria-expanded", String(Boolean(staff && agentSidepanelMode === "computer")));
	renderStaffHeaderNavigation(staff);
	composerMore.sync();
	syncConversationAccess();
}

function staffSurfaceNodes(id) {
	return (state.projection?.nodes ?? []).filter(
		(node) => node.kind === "page" && node.staffAgentId === id && node.view?.id !== "qorpera.activity" && node.view?.id !== "qorpera.chats",
	);
}

function showStaffConversation() {
	if (!currentStaffId || !currentSession) return;
	setStaffRoute(currentStaffId);
	show("chat");
	renderThreadHeader();
	syncConnectionRequestCards();
}

function renderStaffHeaderNavigation(staff) {
	const tabs = $("staffSurfaceTabs");
	tabs.replaceChildren();
	if (!staff) return;
	const appendTab = (label, active, onClick) => {
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = label;
		button.classList.toggle("active", active);
		button.setAttribute("aria-pressed", String(active));
		button.onclick = onClick;
		tabs.appendChild(button);
	};
	for (const node of staffSurfaceNodes(staffId(staff)).slice(0, 4)) {
		const active = currentNodeId === node.id && (currentView === "panel" || currentView === "surface");
		appendTab(node.label, active, () => {
			if (active) showStaffConversation();
			else void openProjectionNode(node.id);
		});
	}
}

function closeAgentSidepanel(restoreFocus = true) {
	const panel = $("agentSidepanel");
	const titlebar = $("agentSidepanelTitlebar");
	if (panel.hidden) return;
	const previousMode = agentSidepanelMode;
	agentSidepanelMode = null;
	agentRoutineEditor = null;
	$("staffIdentityButton").setAttribute("aria-expanded", "false");
	$("staffSidepanelButton").setAttribute("aria-expanded", "false");
	if (agentSidepanelMotionTimer) clearTimeout(agentSidepanelMotionTimer);
	const finish = () => {
		if (agentSidepanelMode !== null) return;
		panel.hidden = true;
		titlebar.hidden = true;
		panel.classList.remove("is-opening", "is-closing");
		titlebar.classList.remove("is-opening", "is-closing");
		agentSidepanelMotionTimer = null;
		if (!restoreFocus) return;
		if (previousMode === "settings") $("staffIdentityButton").focus();
		else $("staffSidepanelButton").focus();
	};
	if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
		finish();
		return;
	}
	panel.classList.remove("is-opening");
	titlebar.classList.remove("is-opening");
	panel.classList.add("is-closing");
	titlebar.classList.add("is-closing");
	agentSidepanelMotionTimer = setTimeout(finish, 280);
}

function handleAgentSidepanelBack() {
	if (agentSidepanelMode === "computer" && agentRoutineEditor && currentStaff()) {
		agentRoutineEditor = null;
		$("agentSidepanelTitle").textContent = staffDisplayName(currentStaff());
		renderAgentComputerPanel(currentStaff());
		return;
	}
	closeAgentSidepanel();
}

function agentRoutines(staff) {
	return (state.scheduledJobs ?? []).filter((job) => job.staffAgentId === staffId(staff));
}

function openAgentRoutineEditor(staff, job = null) {
	agentRoutineEditor = {
		staffAgentId: staffId(staff),
		mode: job ? "edit" : "create",
		...(job ? { id: job.id } : {}),
		draft: scheduledJobDraft(job),
		dirty: false,
		triggerPickerOpen: false,
		error: "",
		status: "",
		pending: false,
	};
	$("agentSidepanelTitle").textContent = "Routine";
	renderAgentComputerPanel(staff, true);
}

function agentRoutineField(labelText, control, helpText = "") {
	const label = document.createElement("label");
	label.className = "agent-routine-field";
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

function renderAgentRoutineEditor(content, staff) {
	const editor = agentRoutineEditor;
	if (!editor || editor.staffAgentId !== staffId(staff)) {
		agentRoutineEditor = null;
		renderAgentComputerPanel(staff, true);
		return;
	}
	const job = editor.mode === "edit" ? agentRoutines(staff).find((candidate) => candidate.id === editor.id) : null;
	if (editor.mode === "edit" && !job) {
		agentRoutineEditor = null;
		$("agentSidepanelTitle").textContent = staffDisplayName(staff);
		renderAgentComputerPanel(staff, true);
		return;
	}
	const section = document.createElement("section");
	section.className = "agent-routine-editor";
	const form = document.createElement("form");
	form.className = "agent-routine-form";
	const toolbar = document.createElement("div");
	toolbar.className = "agent-routine-toolbar";
	const active = document.createElement("label");
	active.className = "agent-routine-active";
	const enabled = document.createElement("input");
	enabled.type = "checkbox";
	enabled.checked = editor.draft.enabled;
	enabled.onchange = () => {
		editor.draft.enabled = enabled.checked;
		editor.dirty = true;
	};
	const switchTrack = document.createElement("span");
	switchTrack.className = "agent-routine-switch";
	active.append(enabled, switchTrack, document.createTextNode("Active"));
	toolbar.appendChild(active);
	const toolbarActions = document.createElement("div");
	toolbarActions.className = "agent-routine-toolbar-actions";
	if (job) {
		const remove = document.createElement("button");
		remove.type = "button";
		remove.textContent = "Delete";
		remove.disabled = job.running || editor.pending;
		remove.onclick = async () => {
			editor.pending = true;
			const result = await scheduledJobRequest(() => window.qorpera.deleteScheduledJob(job.id), "Could not delete the routine.");
			editor.pending = false;
			if (result?.ok) {
				forgetScheduledJob(job.id);
				agentRoutineEditor = null;
				$("agentSidepanelTitle").textContent = staffDisplayName(staff);
			} else editor.error = result?.error ?? "Could not delete the routine.";
			renderAgentComputerPanel(staff, true);
		};
		const run = document.createElement("button");
		run.type = "button";
		run.textContent = job.running ? "Running…" : "Test run";
		run.disabled = job.running || editor.pending;
		run.onclick = async () => {
			editor.pending = true;
			editor.error = "";
			const result = await scheduledJobRequest(() => window.qorpera.runScheduledJob(job.id), "Could not start the routine.");
			editor.pending = false;
			editor.status = result?.ok ? "Routine started." : "";
			editor.error = result?.ok ? "" : (result?.error ?? "Could not start the routine.");
			renderAgentComputerPanel(staff, true);
		};
		toolbarActions.append(remove, run);
	}
	toolbar.appendChild(toolbarActions);
	form.appendChild(toolbar);

	const title = document.createElement("input");
	title.type = "text";
	title.maxLength = 160;
	title.placeholder = "Name this routine";
	title.value = editor.draft.title;
	title.oninput = () => {
		editor.draft.title = title.value;
		editor.dirty = true;
	};
	form.appendChild(agentRoutineField("Name", title));
	const prompt = document.createElement("textarea");
	prompt.placeholder = "What should this routine do each time it runs?";
	prompt.value = editor.draft.prompt;
	prompt.oninput = () => {
		editor.draft.prompt = prompt.value;
		editor.dirty = true;
	};
	form.appendChild(agentRoutineField("Instruction", prompt));

	const triggerSection = document.createElement("section");
	triggerSection.className = "agent-routine-triggers";
	const triggerTitle = document.createElement("span");
	triggerTitle.textContent = "When to run";
	triggerSection.appendChild(triggerTitle);
	const eventLabels = {
		"pull_request.opened": "PR opened",
		"pull_request.updated": "PR updated",
		"pull_request.merged": "PR merged",
		"pull_request.review_requested": "Review requested",
		"review.approved": "Review approved",
		"review.changes_requested": "Changes requested",
		"pull_request.comment": "PR comment",
		"pull_request.review_comment": "Inline review comment",
		"check_run.succeeded": "CI passed",
		"check_run.failed": "CI failed",
		"issue.assigned": "Issue assigned",
	};
	const rerender = () => {
		editor.dirty = true;
		renderAgentComputerPanel(staff, true);
	};
	for (const trigger of editor.draft.triggers) {
		const card = document.createElement("div");
		card.className = `agent-routine-trigger-card ${trigger.kind}`;
		const removeTrigger = document.createElement("button");
		removeTrigger.type = "button";
		removeTrigger.className = "agent-routine-trigger-remove";
		removeTrigger.textContent = "×";
		removeTrigger.setAttribute("aria-label", "Remove trigger");
		removeTrigger.onclick = () => {
			editor.draft.triggers = editor.draft.triggers.filter((candidate) => candidate.id !== trigger.id);
			rerender();
		};
		if (trigger.kind === "schedule") {
			const icon = document.createElement("span");
			icon.className = "agent-routine-trigger-icon clock";
			icon.textContent = "◷";
			const schedule = document.createElement("select");
			for (const [minutes, label] of [[60, "Every hour"], [1440, "Every day"], [10080, "Every week"]]) {
				const option = document.createElement("option");
				option.value = String(minutes);
				option.textContent = label;
				option.selected = trigger.intervalMinutes === minutes;
				schedule.appendChild(option);
			}
			schedule.onchange = () => {
				trigger.intervalMinutes = Number(schedule.value);
				editor.dirty = true;
			};
			card.append(icon, schedule, removeTrigger);
		} else if (trigger.kind === "github") {
			const icon = document.createElement("img");
			icon.className = "agent-routine-trigger-icon";
			icon.src = "./provider-github.svg";
			icon.alt = "";
			const fields = document.createElement("div");
			fields.className = "agent-routine-github-fields";
			const details = document.createElement("details");
			details.className = "agent-routine-event-picker";
			const summary = document.createElement("summary");
			summary.textContent = trigger.events.length === 1 ? eventLabels[trigger.events[0]] : `${trigger.events.length} GitHub events`;
			details.appendChild(summary);
			const eventMenu = document.createElement("div");
			eventMenu.className = "agent-routine-event-menu";
			for (const [value, label] of Object.entries(eventLabels)) {
				const choice = document.createElement("label");
				const checkbox = document.createElement("input");
				checkbox.type = "checkbox";
				checkbox.checked = trigger.events.includes(value);
				checkbox.onchange = () => {
					if (checkbox.checked) trigger.events = [...new Set([...trigger.events, value])];
					else if (trigger.events.length > 1) trigger.events = trigger.events.filter((event) => event !== value);
					else checkbox.checked = true;
					editor.dirty = true;
					summary.textContent = trigger.events.length === 1 ? eventLabels[trigger.events[0]] : `${trigger.events.length} GitHub events`;
				};
				choice.append(checkbox, document.createTextNode(label));
				eventMenu.appendChild(choice);
			}
			details.appendChild(eventMenu);
			const repository = document.createElement("input");
			repository.type = "text";
			repository.placeholder = "owner/repo";
			repository.value = trigger.repository;
			repository.oninput = () => {
				trigger.repository = repository.value;
				editor.dirty = true;
			};
			const actors = document.createElement("input");
			actors.type = "text";
			actors.placeholder = "Anyone";
			actors.value = trigger.actors.join(", ");
			actors.oninput = () => {
				trigger.actors = actors.value.split(",").map((actor) => actor.trim()).filter(Boolean);
				editor.dirty = true;
			};
			fields.append(details, repository, actors);
			card.append(icon, fields, removeTrigger);
		}
		triggerSection.appendChild(card);
	}
	const addTrigger = document.createElement("button");
	addTrigger.type = "button";
	addTrigger.className = "agent-routine-add-trigger";
	addTrigger.textContent = "+  Add trigger";
	addTrigger.setAttribute("aria-expanded", String(editor.triggerPickerOpen));
	addTrigger.onclick = () => {
		editor.triggerPickerOpen = !editor.triggerPickerOpen;
		renderAgentComputerPanel(staff, true);
	};
	triggerSection.appendChild(addTrigger);
	if (editor.triggerPickerOpen) {
		const menu = document.createElement("div");
		menu.className = "agent-routine-trigger-menu";
		const choice = (label, detail, icon, action) => {
			const button = document.createElement("button");
			button.type = "button";
			const mark = document.createElement(icon.endsWith(".svg") ? "img" : "span");
			mark.className = "agent-routine-trigger-menu-icon";
			if (mark instanceof HTMLImageElement) {
				mark.src = icon;
				mark.alt = "";
			} else mark.textContent = icon;
			const copy = document.createElement("span");
			const strong = document.createElement("strong");
			strong.textContent = label;
			const small = document.createElement("small");
			small.textContent = detail;
			copy.append(strong, small);
			button.append(mark, copy);
			button.onclick = action;
			return button;
		};
		menu.append(
			choice("On a schedule", "Hourly, daily, or weekly", "◷", () => {
				editor.draft.triggers.push({ id: crypto.randomUUID(), kind: "schedule", intervalMinutes: 60 });
				editor.triggerPickerOpen = false;
				rerender();
			}),
			choice("GitHub event", "Pull requests, reviews, comments, or CI", "./provider-github.svg", () => {
				editor.draft.triggers.push({ id: crypto.randomUUID(), kind: "github", repository: "", events: ["pull_request.opened"], actors: [] });
				editor.triggerPickerOpen = false;
				rerender();
			}),
			choice("Build another trigger", `Ask ${staffDisplayName(staff)} to create an adapter`, "+", () => {
				closeAgentSidepanel(false);
				const input = $("input");
				input.value = "Build a new routine trigger adapter for ";
				syncComposer();
				input.focus();
			}),
		);
		triggerSection.appendChild(menu);
	}
	form.appendChild(triggerSection);
	if (editor.error) {
		const error = document.createElement("div");
		error.className = "agent-routine-error";
		error.textContent = editor.error;
		form.appendChild(error);
	}
	const status = document.createElement("div");
	status.className = "agent-routine-status";
	status.setAttribute("role", "status");
	status.textContent = editor.status;
	form.appendChild(status);
	const actions = document.createElement("footer");
	actions.className = "agent-routine-actions";
	const save = document.createElement("button");
	save.type = "submit";
	save.className = "primary-button";
	save.textContent = editor.pending ? "Saving…" : editor.mode === "create" ? "Create routine" : "Save";
	save.disabled = editor.pending;
	actions.appendChild(save);
	form.appendChild(actions);
	form.onsubmit = async (event) => {
		event.preventDefault();
		const routineTitle = editor.draft.title.trim();
		const instructions = editor.draft.prompt.trim();
		if (!routineTitle || !instructions) {
			editor.error = "Name and instructions are required.";
			renderAgentComputerPanel(staff, true);
			return;
		}
		if (!editor.draft.triggers.length) {
			editor.error = "Add at least one trigger.";
			renderAgentComputerPanel(staff, true);
			return;
		}
		if (editor.draft.triggers.some((trigger) => trigger.kind === "github" && !/^[^/\s]+\/[^/\s]+$/.test(trigger.repository.trim()))) {
			editor.error = "Enter each GitHub repository as owner/repo.";
			renderAgentComputerPanel(staff, true);
			return;
		}
		editor.pending = true;
		editor.error = "";
		const draft = {
			title: routineTitle,
			prompt: instructions,
			triggers: editor.draft.triggers,
			enabled: Boolean(editor.draft.enabled),
			staffAgentId: staffId(staff),
		};
		const result = await scheduledJobRequest(
			() => (job ? window.qorpera.updateScheduledJob(job.id, draft) : window.qorpera.createScheduledJob(draft)),
			"Could not save the routine.",
		);
		editor.pending = false;
		if (result?.ok) {
			rememberScheduledJob(result.job);
			agentRoutineEditor = {
				staffAgentId: staffId(staff),
				mode: "edit",
				id: result.job.id,
				draft: scheduledJobDraft(result.job),
				dirty: false,
				error: "",
				status: "Saved",
				triggerPickerOpen: false,
				pending: false,
			};
			$("agentSidepanelTitle").textContent = "Routine";
		} else editor.error = result?.error ?? "Could not save the routine.";
		renderAgentComputerPanel(staff, true);
	};
	section.appendChild(form);
	content.appendChild(section);
}

function renderAgentComputerPanel(staff, force = false) {
	const content = $("agentSidepanelContent");
	if (!force && agentRoutineEditor?.dirty && content.contains(document.activeElement)) return;
	content.replaceChildren();
	if (agentRoutineEditor) {
		renderAgentRoutineEditor(content, staff);
		return;
	}
	const computer = document.createElement("section");
	computer.className = "agent-computer-section";
	const screen = document.createElement("div");
	screen.className = "agent-computer-screen";
	const avatar = makeStaffAvatar(staff, staffStatus(staff));
	const screenCopy = document.createElement("span");
	const motion = staffStatus(staff);
	screenCopy.textContent =
		motion === "listening"
			? "Listening to you"
			: motion === "starting"
				? "Waking up"
				: motion === "working"
					? "Working on the company files"
					: motion === "finishing"
						? "Saving its work"
						: motion === "reconnecting"
							? "Reconnecting"
							: "Local computer is idle";
	screen.append(avatar, screenCopy);
	const caption = document.createElement("small");
	caption.textContent = `This computer · ${staffDisplayName(staff)}`;
	computer.append(screen, caption);
	content.appendChild(computer);

	const routines = document.createElement("section");
	routines.className = "agent-routines-section";
	const create = document.createElement("button");
	create.type = "button";
	create.className = "agent-routine-create";
	create.textContent = "Create Routine";
	create.onclick = () => openAgentRoutineEditor(staff);
	const jobs = agentRoutines(staff);
	if (!jobs.length) {
		const empty = document.createElement("div");
		empty.className = "agent-routines-empty";
		const copy = document.createElement("p");
		copy.textContent = "Routines are recurring tasks this agent runs on a schedule or when an event happens.";
		empty.append(copy, create);
		routines.appendChild(empty);
	} else {
		const head = document.createElement("div");
		head.className = "agent-routines-head";
		const heading = document.createElement("h2");
		heading.textContent = "Routines";
		head.append(heading, create);
		routines.appendChild(head);
		for (const job of jobs) {
			const row = document.createElement("button");
			row.type = "button";
			row.className = "agent-routine-row";
			row.onclick = () => openAgentRoutineEditor(staff, job);
			const copy = document.createElement("span");
			const title = document.createElement("strong");
			title.textContent = job.title;
			const meta = document.createElement("small");
			meta.textContent = `${scheduledJobNextLabel(job)} · ${scheduledJobScheduleLabel(job)}`;
			copy.append(title, meta);
			const stateLabel = document.createElement("small");
			stateLabel.textContent = job.running ? "Running" : job.enabled && !job.suspendedReason ? "On" : "Off";
			row.append(copy, stateLabel);
			routines.appendChild(row);
		}
	}
	content.appendChild(routines);
}

function renderAgentSettingsPanel(staff) {
	const content = $("agentSidepanelContent");
	content.replaceChildren();
	const form = document.createElement("form");
	form.className = "agent-settings-form";
	const avatar = makeStaffAvatar(staff, staffStatus(staff));
	avatar.classList.add("agent-settings-avatar");
	form.appendChild(avatar);
	const field = (labelText, value, multiline = false, readOnly = false) => {
		const label = document.createElement("label");
		const title = document.createElement("span");
		title.textContent = labelText;
		const input = document.createElement(multiline ? "textarea" : "input");
		input.value = value;
		input.readOnly = readOnly;
		if (multiline) input.rows = 3;
		label.append(title, input);
		return { label, input };
	};
	const nameField = field("Name", staffDisplayName(staff));
	const titleField = field("Title", staffRoleLabel(staff));
	const descriptionField = field("Description", staffDescription(staff), true, true);
	form.append(nameField.label, titleField.label, descriptionField.label);
	const saveStatus = document.createElement("div");
	saveStatus.className = "agent-settings-status";
	saveStatus.setAttribute("role", "status");
	saveStatus.setAttribute("aria-live", "polite");
	form.appendChild(saveStatus);
	let saving = false;
	const saveIdentity = async () => {
		if (saving) return;
		const displayName = nameField.input.value.trim();
		const role = titleField.input.value.trim();
		if (!displayName || !role) {
			saveStatus.textContent = "Name and title are required.";
			return;
		}
		if (displayName === staffDisplayName(staff) && role === staffRoleLabel(staff)) return;
		saving = true;
		nameField.input.disabled = true;
		titleField.input.disabled = true;
		saveStatus.textContent = "Saving…";
		try {
			const result = await window.qorpera.staffUpdate(staffId(staff), { displayName, role });
			if (result?.ok === false) throw new Error(result.error ?? "Agent settings could not be saved.");
			const updated = result?.staff ?? { ...staff, displayName, role };
			state.staff = (state.staff ?? []).map((candidate) => (staffId(candidate) === staffId(staff) ? { ...candidate, ...updated } : candidate));
			saveStatus.textContent = "Saved";
			renderThreadHeader();
			renderRosterRail();
			syncScopeChrome();
		} catch (error) {
			saveStatus.textContent = error instanceof Error ? error.message : "Agent settings could not be saved.";
		} finally {
			saving = false;
			nameField.input.disabled = false;
			titleField.input.disabled = false;
		}
	};
	nameField.input.onchange = () => void saveIdentity();
	titleField.input.onchange = () => void saveIdentity();
	const notice = document.createElement("div");
	notice.className = "agent-notification-setting";
	const noticeCopy = document.createElement("span");
	const noticeTitle = document.createElement("strong");
	noticeTitle.textContent = "Notifications";
	const noticeDetail = document.createElement("small");
	noticeDetail.textContent = "Notify me when this agent finishes or needs input";
	noticeCopy.append(noticeTitle, noticeDetail);
	const notificationKey = `qorpera.staff-notifications.${companyId}.${staffId(staff)}`;
	const notificationsEnabled = localStorage.getItem(notificationKey) !== "off";
	const toggle = document.createElement("button");
	toggle.type = "button";
	toggle.className = "agent-notification-toggle";
	toggle.classList.toggle("active", notificationsEnabled);
	toggle.setAttribute("role", "switch");
	toggle.setAttribute("aria-checked", String(notificationsEnabled));
	toggle.setAttribute("aria-label", "Agent notifications");
	toggle.onclick = () => {
		const next = toggle.getAttribute("aria-checked") !== "true";
		toggle.setAttribute("aria-checked", String(next));
		toggle.classList.toggle("active", next);
		localStorage.setItem(notificationKey, next ? "on" : "off");
	};
	notice.append(noticeCopy, toggle);
	form.appendChild(notice);
	if (currentStaffIntroStatus === "failed") {
		const retry = document.createElement("button");
		retry.type = "button";
		retry.className = "secondary-button agent-intro-retry";
		retry.textContent = "Retry introduction";
		retry.onclick = () => void retryStaffIntroduction();
		form.appendChild(retry);
	}
	content.appendChild(form);
}

function openAgentSidepanel(mode) {
	const staff = currentStaff();
	if (!staff) return;
	const panel = $("agentSidepanel");
	const titlebar = $("agentSidepanelTitlebar");
	if (agentSidepanelMode === mode && !panel.hidden && !panel.classList.contains("is-closing")) {
		closeAgentSidepanel();
		return;
	}
	const opening = panel.hidden || panel.classList.contains("is-closing");
	if (agentSidepanelMotionTimer) {
		clearTimeout(agentSidepanelMotionTimer);
		agentSidepanelMotionTimer = null;
	}
	agentSidepanelMode = mode;
	agentRoutineEditor = null;
	panel.hidden = false;
	titlebar.hidden = false;
	panel.classList.remove("is-closing");
	titlebar.classList.remove("is-closing");
	$("agentSidepanelTitle").textContent = mode === "settings" ? "Settings" : staffDisplayName(staff);
	$("staffIdentityButton").setAttribute("aria-expanded", String(mode === "settings"));
	$("staffSidepanelButton").setAttribute("aria-expanded", String(mode === "computer"));
	if (mode === "settings") renderAgentSettingsPanel(staff);
	else renderAgentComputerPanel(staff);
	if (!opening || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
	panel.classList.add("is-opening");
	titlebar.classList.add("is-opening");
	void panel.offsetWidth;
	requestAnimationFrame(() => {
		if (agentSidepanelMode !== mode) return;
		panel.classList.remove("is-opening");
		titlebar.classList.remove("is-opening");
	});
}

async function retryStaffIntroduction() {
	if (!currentStaffId || !currentSession || currentStaffIntroStatus !== "failed") return;
	const id = currentStaffId;
	const sessionFile = currentSession;
	$("status").textContent = "retrying staff introduction…";
	const result = await window.qorpera.staffIntroReady(id, sessionFile, true);
	if (result?.ok) {
		currentStaffIntroStatus = result.status ?? "started";
		$("status").textContent = "introduction restarted";
		setTimeout(() => {
			if (currentStaffId === id && currentSession === sessionFile) sendRpc({ type: "get_messages" });
		}, 600);
	} else {
		$("status").textContent = "introduction retry did not start";
		showControllerToast("The introduction could not be restarted yet. Try again when this staff member is ready.");
	}
}

function syncConversationAccess() {
	const input = $("input");
	input.readOnly = false;
	$("composerMoreButton").disabled = false;
	$("sendBtn").disabled = false;
	document.querySelector(".composer-shell")?.classList.remove("read-only");
}

function renderRosterRail({ animateCreateRow = false } = {}) {
	const container = $("staffNavigation");
	if (!container) return;
	container.replaceChildren();
	if (!$("staffModal").hidden) {
		const create = document.createElement("button");
		create.type = "button";
		create.className = "staff-nav-row staff-create-row active";
		create.setAttribute("aria-current", "page");
		const mark = document.createElement("span");
		mark.className = "staff-create-mark";
		mark.setAttribute("aria-hidden", "true");
		mark.textContent = "+";
		const copy = document.createElement("span");
		copy.className = "staff-nav-copy";
		const name = document.createElement("strong");
		name.textContent = "Create new";
		copy.appendChild(name);
		create.append(mark, copy);
		create.onclick = () => $("staffDisplayName").focus();
		container.appendChild(create);
		if (animateCreateRow && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			create.classList.add("is-entering");
			create.getBoundingClientRect();
			requestAnimationFrame(() => create.classList.remove("is-entering"));
		}
	}
	const pinned = storedStaffIds("staff-pinned");
	const hidden = storedStaffIds("staff-hidden");
	const staffMembers = activeStaffMembers()
		.filter((staff) => !hidden.has(staffId(staff)))
		.sort((left, right) => Number(pinned.has(staffId(right))) - Number(pinned.has(staffId(left))));
	for (const staff of staffMembers) {
		const id = staffId(staff);
		const row = document.createElement("button");
		row.type = "button";
		row.className = "staff-nav-row";
		row.classList.toggle("active", $("staffModal").hidden && currentView === "chat" && currentStaffId === id);
		row.dataset.searchText = `${staffDisplayName(staff)} ${staffRoleLabel(staff)}`.toLowerCase();
		row.appendChild(makeStaffAvatar(staff, staffStatus(staff)));
		const copy = document.createElement("span");
		copy.className = "staff-nav-copy";
		const heading = document.createElement("span");
		heading.className = "staff-nav-heading";
		const name = document.createElement("strong");
		name.textContent = staffDisplayName(staff);
		heading.appendChild(name);
		const lastMessageAt = Math.max(
			0,
			...(state.sessions ?? [])
				.filter((session) => session.staffAgentId === id && session.kind === "chat")
				.map((session) => Number(session.mtimeMs) || 0),
		);
		if (lastMessageAt) {
			const messageDate = new Date(lastMessageAt);
			const today = new Date();
			const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
			const messageDayStart = new Date(
				messageDate.getFullYear(),
				messageDate.getMonth(),
				messageDate.getDate(),
			).getTime();
			const ageInDays = Math.round((dayStart - messageDayStart) / 86_400_000);
			const time = document.createElement("time");
			time.className = "staff-nav-time";
			time.dateTime = messageDate.toISOString();
			time.textContent =
				ageInDays === 0
					? messageDate.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
					: ageInDays === 1
						? "Yesterday"
						: ageInDays > 1 && ageInDays < 7
							? messageDate.toLocaleDateString([], { weekday: "short" })
							: messageDate.toLocaleDateString([], { month: "short", day: "numeric" });
			heading.appendChild(time);
		}
		const role = document.createElement("small");
		const runtime = staffRuntime(staff);
		role.textContent = runtime ? runtimeDoingLine(runtime) : staffRoleLabel(staff);
		copy.append(heading, role);
		const arrow = document.createElement("span");
		arrow.className = "staff-nav-arrow";
		arrow.setAttribute("aria-hidden", "true");
		arrow.textContent = "›";
		row.append(copy, arrow);
		row.onclick = () => void openStaff(id);
		row.oncontextmenu = (event) => openStaffContext(event, staff);
		row.onkeydown = (event) => {
			if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
			const bounds = row.getBoundingClientRect();
			openStaffContext(event, staff, { x: bounds.left + 32, y: bounds.top + 24 });
		};
		container.appendChild(row);
	}
	const hiddenStaff = activeStaffMembers().filter((staff) => hidden.has(staffId(staff)));
	if (hiddenStaff.length) {
		const hiddenEntry = document.createElement("button");
		hiddenEntry.type = "button";
		hiddenEntry.className = "hidden-staff-entry";
		hiddenEntry.setAttribute("aria-haspopup", "dialog");
		const label = document.createElement("span");
		label.textContent = "Hidden Bots";
		const count = document.createElement("span");
		count.className = "hidden-staff-count";
		count.textContent = String(hiddenStaff.length);
		hiddenEntry.append(label, count);
		hiddenEntry.onclick = (event) => openHiddenStaffModal(event.currentTarget);
		container.appendChild(hiddenEntry);
	}
	if (!staffMembers.length && !hiddenStaff.length) {
		const empty = document.createElement("div");
		empty.className = "rail-empty";
		empty.textContent = "Choose your starting team.";
		container.appendChild(empty);
	}
	filterRosterRail(railSearchQuery);
}

function storedStaffIds(name) {
	try {
		const value = JSON.parse(localStorage.getItem(navStorageKey(name)) ?? "[]");
		return new Set(Array.isArray(value) ? value.filter((id) => typeof id === "string") : []);
	} catch {
		return new Set();
	}
}

function storeStaffIds(name, ids) {
	localStorage.setItem(navStorageKey(name), JSON.stringify([...ids]));
}

function hiddenStaffMembers() {
	const hidden = storedStaffIds("staff-hidden");
	return activeStaffMembers().filter((staff) => hidden.has(staffId(staff)));
}

function renderHiddenStaffList() {
	const list = $("hiddenStaffList");
	list.replaceChildren();
	const hiddenStaff = hiddenStaffMembers();
	if (!hiddenStaff.length) {
		const empty = document.createElement("div");
		empty.className = "hidden-staff-empty";
		empty.textContent = "No hidden Bots.";
		list.appendChild(empty);
		return;
	}
	for (const staff of hiddenStaff) {
		const row = document.createElement("div");
		row.className = "hidden-staff-row";
		row.appendChild(makeStaffAvatar(staff, staffStatus(staff)));
		const name = document.createElement("strong");
		name.textContent = staffDisplayName(staff);
		const unhide = document.createElement("button");
		unhide.type = "button";
		unhide.textContent = "Unhide";
		unhide.setAttribute("aria-label", `Unhide ${staffDisplayName(staff)}`);
		unhide.onclick = () => {
			const hidden = storedStaffIds("staff-hidden");
			hidden.delete(staffId(staff));
			storeStaffIds("staff-hidden", hidden);
			renderRosterRail();
			if (hiddenStaffMembers().length) renderHiddenStaffList();
			else closeHiddenStaffModal();
		};
		row.append(name, unhide);
		list.appendChild(row);
	}
}

function openHiddenStaffModal(trigger) {
	hiddenStaffTrigger = trigger;
	renderHiddenStaffList();
	$("hiddenStaffModal").hidden = false;
	$("hiddenStaffClose").focus();
}

function closeHiddenStaffModal(restoreFocus = true) {
	$("hiddenStaffModal").hidden = true;
	if (restoreFocus) {
		const replacement = document.querySelector(".hidden-staff-entry");
		if (replacement instanceof HTMLElement) replacement.focus();
		else if (hiddenStaffTrigger?.isConnected) hiddenStaffTrigger.focus();
		else document.querySelector("#staffNavigation button")?.focus();
	}
	hiddenStaffTrigger = null;
}

function closeStaffContext(restoreFocus = false) {
	$("staffContextMenu").hidden = true;
	staffContextTarget = null;
	if (restoreFocus) staffContextTrigger?.focus();
	staffContextTrigger = null;
}

function openStaffContext(event, staff, point) {
	event.preventDefault();
	event.stopPropagation();
	closeNavContext();
	closePanelContext();
	closeStaffContext();
	staffContextTarget = staff;
	staffContextTrigger = event.currentTarget;
	navContextPoint = point ?? { x: event.clientX, y: event.clientY };
	const id = staffId(staff);
	const pinned = storedStaffIds("staff-pinned").has(id);
	const hidden = storedStaffIds("staff-hidden").has(id);
	$("staffContextPin").querySelector("span:last-child").textContent = pinned ? "Unpin" : "Pin";
	$("staffContextHide").querySelector("span:last-child").textContent = hidden ? "Show in sidebar" : "Hide from sidebar";
	$("staffContextMenu").hidden = false;
	placeFloatingMenu($("staffContextMenu"));
	$("staffContextPin").focus();
}

function toggleStaffContextPreference(name) {
	if (!staffContextTarget) return;
	const ids = storedStaffIds(name);
	const id = staffId(staffContextTarget);
	if (ids.has(id)) ids.delete(id);
	else ids.add(id);
	storeStaffIds(name, ids);
	closeStaffContext();
	renderRosterRail();
}

function openStaffDeleteConfirmation() {
	if (!staffContextTarget) return;
	staffDeleteTarget = staffContextTarget;
	closeStaffContext();
	$("staffDeleteTitle").textContent = `Delete ${staffDisplayName(staffDeleteTarget)}?`;
	$("staffDeleteDescription").textContent =
		"This removes the agent from active staff. Its existing company trail remains in the company file for audit history.";
	$("staffDeleteModal").hidden = false;
	$("staffDeleteCancel").focus();
}

function closeStaffDeleteConfirmation() {
	$("staffDeleteModal").hidden = true;
	staffDeleteTarget = null;
}

async function deleteStaffMember() {
	if (!staffDeleteTarget) return;
	const id = staffId(staffDeleteTarget);
	const button = $("staffDeleteConfirm");
	button.disabled = true;
	button.textContent = "Deleting…";
	try {
		const result = await window.qorpera.staffArchive(id);
		if (result?.ok === false) throw new Error(result.error ?? "The agent could not be deleted.");
		const hidden = storedStaffIds("staff-hidden");
		const pinned = storedStaffIds("staff-pinned");
		hidden.delete(id);
		pinned.delete(id);
		storeStaffIds("staff-hidden", hidden);
		storeStaffIds("staff-pinned", pinned);
		closeStaffDeleteConfirmation();
		await refreshState();
	} catch (error) {
		showControllerToast(error instanceof Error ? error.message : "The agent could not be deleted.");
	} finally {
		button.disabled = false;
		button.textContent = "Delete";
	}
}

function selectedBootstrapTemplates(templates) {
	return templates.filter((template) => staffBootstrapSelections.has(templateId(template)));
}

async function startStaffBootstrap(templates) {
	if (staffBootstrapPending) return;
	const selected = selectedBootstrapTemplates(templates);
	if (!selected.length) return;
	staffBootstrapPending = true;
	renderStaffHome();
	try {
		const result = await window.qorpera.staffBootstrap({
			agents: selected.map((template) => ({
				templateId: templateId(template),
				displayName: templateName(template),
				appearance: { color: staffColor(template), shape: staffShape(template) },
			})),
		});
		if (result?.ok === false) throw new Error(result.error ?? "The team could not be created.");
		const created = Array.isArray(result?.staff) ? result.staff : [];
		if (!created.length) throw new Error("The team was created without staff sessions.");
		for (const entry of created) {
			const staff = entry?.staff ?? entry?.agent;
			if (staff && !(state.staff ?? []).some((known) => staffId(known) === staffId(staff))) {
				state.staff = [...(state.staff ?? []), { ...staff, sessionFile: entry.sessionFile }];
			}
		}
		const first = created[0];
		const firstStaff = first?.staff ?? first?.agent;
		if (!staffId(firstStaff) || !first?.sessionFile) throw new Error("The first staff conversation is unavailable.");
		activateStaffSession(staffId(firstStaff), first.sessionFile, first);
		$("status").textContent = `${created.length} staff joined. Their first conversations are starting on this computer.`;
		staffBootstrapSelections = new Set();
		staffBootstrapPending = false;
		await refreshState();
		setTimeout(() => {
			if (currentStaffId === staffId(firstStaff) && currentSession === first.sessionFile) {
				sendRpc({ type: "get_messages" });
			}
		}, 800);
	} catch (error) {
		staffBootstrapPending = false;
		showControllerToast(error instanceof Error ? error.message : "The team could not be created.");
		renderStaffHome();
	}
}

function renderStaffBootstrapHome(home, templates) {
	home.classList.add("staff-bootstrap-home");
	const header = document.createElement("header");
	header.className = "staff-bootstrap-head";
	const title = document.createElement("h1");
	title.textContent = "Choose your starting team";
	const subtitle = document.createElement("p");
	subtitle.textContent = "Select everyone you want to begin with. You can add more later.";
	header.append(title, subtitle);
	home.appendChild(header);

	const grid = document.createElement("div");
	grid.className = "staff-bootstrap-grid";
	for (const template of templates) {
		const id = templateId(template);
		const selected = staffBootstrapSelections.has(id);
		const card = document.createElement("button");
		card.type = "button";
		card.className = "staff-bootstrap-card";
		card.classList.toggle("selected", selected);
		card.setAttribute("role", "checkbox");
		card.setAttribute("aria-checked", String(selected));
		card.appendChild(makeStaffAvatar(template));
		const name = document.createElement("strong");
		name.textContent = templateName(template);
		const description = document.createElement("p");
		description.textContent = staffDescription(template);
		const check = document.createElement("span");
		check.className = "staff-bootstrap-check";
		check.textContent = selected ? "✓" : "+";
		card.append(name, description, check);
		card.onclick = () => {
			if (selected) staffBootstrapSelections.delete(id);
			else staffBootstrapSelections.add(id);
			renderStaffHome();
		};
		grid.appendChild(card);
	}
	home.appendChild(grid);

	const actions = document.createElement("footer");
	actions.className = "staff-bootstrap-actions";
	const primary = document.createElement("button");
	primary.type = "button";
	primary.className = "primary-button";
	const count = staffBootstrapSelections.size;
	primary.textContent = staffBootstrapPending ? "Creating your team…" : `Start ${count} staff`;
	primary.disabled = staffBootstrapPending || count === 0;
	primary.onclick = () => {
		void startStaffBootstrap(templates);
	};
	actions.appendChild(primary);
	home.appendChild(actions);
}

function renderStaffHome() {
	const home = $("rosterHome");
	if (!home) return;
	home.replaceChildren();
	home.classList.remove("staff-bootstrap-home");
	const staffMembers = activeStaffMembers();
	if (!staffMembers.length) {
		const templates = staffCatalogCache ?? DEFAULT_STAFF_TEMPLATES;
		renderStaffBootstrapHome(home, templates);
		void loadStaffCatalog().then((loaded) => {
			if (currentView === "roster" && !activeStaffMembers().length && loaded !== templates) renderStaffHome();
		});
		return;
	}
	const add = document.createElement("button");
	add.type = "button";
	add.className = "roster-home-add";
	add.textContent = "+ Add staff";
	add.onclick = () => void openStaffCreator();
	home.appendChild(add);
	const grid = document.createElement("div");
	grid.className = "roster-grid";
	home.appendChild(grid);
	for (const staff of staffMembers) {
		const card = document.createElement("button");
		card.type = "button";
		card.className = "roster-card";
		card.style.setProperty("--staff-color", staffColor(staff));
		card.appendChild(makeStaffAvatar(staff, staffStatus(staff)));
		const name = document.createElement("strong");
		name.textContent = staffDisplayName(staff);
		const description = document.createElement("p");
		description.textContent = staffDescription(staff);
		const meta = document.createElement("small");
		const runtime = staffRuntime(staff);
		meta.textContent = runtime ? runtimeDoingLine(runtime) : `Ready · ${staffRoleLabel(staff)}`;
		card.append(name, description, meta);
		card.onclick = () => void openStaff(staffId(staff));
		grid.appendChild(card);
	}
}

function filterRosterRail(value) {
	railSearchQuery = String(value ?? "").trim().toLowerCase();
	for (const row of document.querySelectorAll("#staffNavigation [data-search-text]")) {
		row.hidden = Boolean(railSearchQuery) && !row.dataset.searchText.includes(railSearchQuery);
	}
}

async function openCompanySwitcher() {
	const menu = $("companySwitcherMenu");
	const button = $("companySwitcherButton");
	if (!menu.hidden) {
		menu.hidden = true;
		button.setAttribute("aria-expanded", "false");
		return;
	}
	menu.replaceChildren();
	const close = () => {
		menu.hidden = true;
		button.setAttribute("aria-expanded", "false");
	};
	const item = (label, icon, action, className = "") => {
		const option = document.createElement("button");
		option.type = "button";
		option.className = className;
		option.setAttribute("role", "menuitem");
		const mark = document.createElement("img");
		mark.className = "company-switcher-menu-icon";
		mark.src = `./icon-${icon}.svg`;
		mark.alt = "";
		const text = document.createElement("span");
		text.textContent = label;
		option.append(mark, text);
		option.onclick = async () => {
			close();
			await action();
		};
		return option;
	};
	menu.append(
		item("Settings", "settings", () => openSettings("general")),
		item("Feedback", "feedback", async () => {
			const result = await window.qorpera.openFeedback();
			if (!result?.ok) showControllerToast(result?.error ?? "Feedback could not be opened.");
		}),
		item(
			"Log out",
			"log-out",
			async () => {
				const result = await window.qorpera.accountSignOut();
				if (!result?.ok) showControllerToast(result?.error ?? "Could not log out.");
			},
			"company-switcher-menu-logout",
		),
	);
	menu.hidden = false;
	button.setAttribute("aria-expanded", "true");
	menu.querySelector("button")?.focus();
}

function renderCompanySwitcher() {
	const name = state.name || "Profile";
	$("companySwitcherName").textContent = name;
	$("companySwitcherMark").replaceChildren(makeProfileIcon(currentProfileIcon, ""));
}

function syncConnectionRequestCards() {
	const messages = $("messages");
	if (!messages) return;
	for (const card of messages.querySelectorAll(".connection-request-card")) card.remove();
	const requests = Array.isArray(state.connectionRequests) ? state.connectionRequests : [];
	for (const request of requests) {
		if (request.staffAgentId !== currentStaffId) continue;
		if (["connected", "denied", "cancelled"].includes(request.status)) continue;
		const backgroundRequest = request.sessionFile !== currentSession;
		const requiresManualSetup = request.status !== "pending";
		const connectionName = request.displayName ?? "Connection";
		const card = document.createElement("article");
		card.className = "connection-request-card";
		card.dataset.connectionRequestId = request.id;
		card.setAttribute("aria-label", `${connectionName} connection requested`);
		const icon = document.createElement("span");
		icon.className = "connection-request-icon";
		icon.textContent = connectionName.slice(0, 1).toUpperCase();
		const copy = document.createElement("div");
		copy.className = "connection-request-copy";
		const title = document.createElement("strong");
		title.textContent = request.status === "failed"
			? `${staffDisplayName(currentStaff())} still needs ${connectionName}`
			: request.status === "connecting"
			? `${staffDisplayName(currentStaff())} is waiting on ${connectionName}`
			: backgroundRequest
				? `${staffDisplayName(currentStaff())} needs ${connectionName} for scheduled work`
				: `${staffDisplayName(currentStaff())} needs ${connectionName}`;
		const reason = document.createElement("p");
		reason.textContent = request.purpose ?? `Connect ${connectionName} so this work can continue.`;
		copy.append(title, reason);
		if (requiresManualSetup) {
			const limitation = document.createElement("small");
			limitation.textContent = request.status === "failed"
				? "The connection did not complete. Review the profile account, then retry when the staff member asks again."
				: "Connection setup is in progress. Complete the provider window if it asks for your attention.";
			copy.appendChild(limitation);
		}
		const action = document.createElement("button");
		action.type = "button";
		action.textContent = requiresManualSetup ? "Open Connections" : "Review connection";
		action.onclick = async () => {
			if (requiresManualSetup) {
				openSettings("connections");
				return;
			}
			action.disabled = true;
			action.textContent = "Opening request…";
			const result = await window.qorpera.beginConnectionRequest({
				id: request.id,
				staffAgentId: request.staffAgentId,
				sessionFile: request.sessionFile,
			});
			if (result?.ok === false) {
				action.disabled = false;
				action.textContent = "Review connection";
				showControllerToast(result.error ?? "The connection request could not be opened.");
				return;
			}
			const index = state.connectionRequests.findIndex((candidate) => candidate.id === request.id);
			if (index >= 0 && result?.request) state.connectionRequests[index] = result.request;
			syncConnectionRequestCards();
		};
		card.append(icon, copy, action);
		messages.appendChild(card);
	}
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
			if (currentStaffId && !activeStaffMembers().some((staff) => staffId(staff) === currentStaffId)) {
				if (!$("agentSidepanel").hidden) closeAgentSidepanel(false);
				currentStaffId = null;
				currentStaffIntroStatus = null;
				currentSession = null;
				currentNodeId = null;
				show("roster");
			}
			applyCurrentSessionRuntime();
			renderCompanyNav();
			renderRosterRail();
			renderProfileRow();
			if (currentView === "roster") renderStaffHome();
			if (currentView === "chat") syncConnectionRequestCards();
			if (!$("agentSidepanel").hidden && currentStaff()) {
				if (agentSidepanelMode === "settings") renderAgentSettingsPanel(currentStaff());
				else renderAgentComputerPanel(currentStaff());
			}
			const staffRoutinesOpen = currentNodeId === `staff-routines:${currentStaffId}`;
			if (currentNodeId && !projectionNode(currentNodeId) && !staffRoutinesOpen) currentNodeId = null;
			if (!currentNodeId && currentView !== "roster" && currentView !== "chat") {
				const routed = location.hash.match(/^#\/p\/(.+)$/)?.[1];
				let routedId;
				try {
					routedId = routed ? decodeURIComponent(routed) : undefined;
				} catch {
					routedId = undefined;
				}
				const target = projectionNode(routedId) ? routedId : undefined;
				if (target) void openProjectionNode(target);
				else show("roster");
			} else if (currentView === "panel" && staffRoutinesOpen) {
				void renderActivity(false, currentStaffId);
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
	if (!currentSession) return;
	const snapshot = $("messages").cloneNode(true);
	for (const activity of snapshot.querySelectorAll(".agent-thread-activity")) activity.remove();
	sessionCache[currentSession] = snapshot.innerHTML;
}

async function openSession(file, pageId = "q:chats") {
	const navigation = ++navigationGeneration;
	const summary = (state.sessions ?? []).find((session) => session.file === file);
	if (summary?.staffAgentId && !activeStaffMembers().some((staff) => staffId(staff) === summary.staffAgentId)) {
		showControllerToast("This archived staff conversation is available in the company trail but cannot be reopened.");
		return;
	}
	// Re-clicking the chat that is already live must only bring its view back —
	// the old path restarted the agent child, aborting any in-flight run
	// (navigate away, click back, and the streaming answer died mid-thought).
	if (file && file === currentSession && !agentExited) {
		currentStaffId = summary?.staffAgentId ?? null;
		currentNodeId = pageId;
		setProjectionRoute(pageId);
		show("chat");
		renderThreadHeader();
		syncConnectionRequestCards();
		syncScopeChrome();
		renderCompanyNavSafe();
		return;
	}
	cacheCurrentSession();
	// Product chats restore the exact department/worktree role capability
	// recorded in their append-only session name.
	const result = await window.qorpera.openChat(file, summary?.department, summary?.worktree).catch((error) => ({
		ok: false,
		error: String(error?.message ?? error),
	}));
	if (result?.ok) {
		currentSession = result.sessionFile ?? file;
		currentStaffId = summary?.staffAgentId ?? null;
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
	renderThreadHeader();
	syncConnectionRequestCards();
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
		currentStaffId = null;
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
	renderThreadHeader();
	syncConnectionRequestCards();
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
		currentStaffId = null;
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
	renderThreadHeader();
	syncConnectionRequestCards();
	syncScopeChrome();
	renderCompanyNavSafe();
	hydrateAgentState(false);
}

function renderHistory(messages) {
	$("messages").innerHTML = "";
	resetWorkGroup();
	resetAssistantStreamState();
	lastSubmittedPrompt = null;
	turnFailureCard = null;
	let historyProgress = createRunProgress();
	let historyPrompt = null;
	let historyFailureShown = false;
	const historyToolCalls = new Map();
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
				appendAssistantMessages(assistantTextPartsFromMessage(message));
			for (const part of message.content ?? []) {
				if (part.type === "toolCall") {
					if (part.id)
						historyToolCalls.set(part.id, {
							name: part.name,
							args: part.arguments,
						});
				}
			}
			if (message.stopReason === "error" && !historyFailureShown) {
				addModelFailureCard(message.errorMessage, historyProgress, historyPrompt, {
					historical: true,
				});
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
	syncConnectionRequestCards();
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
	filterRosterRail(railSearchQuery);
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
		activityStaffId = null;
		await renderActivity(false, null);
		if (navigation !== navigationGeneration || currentNodeId !== id) return;
		show("panel");
	} else if (node.view.id === "qorpera.chats") {
		show("roster");
		renderRosterRail();
	} else if (node.view.id === "qorpera.usage") {
		openSettings("connections");
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

async function showStaffRoutines(id) {
	const staff = activeStaffMembers().find((candidate) => staffId(candidate) === id);
	if (!staff) return;
	++navigationGeneration;
	currentNodeId = `staff-routines:${id}`;
	activityStaffId = id;
	$("view-panel").classList.add("activity-panel");
	$("view-panel").innerHTML = pageSkeletonMarkup();
	show("panel");
	await renderActivity(false, id);
}

async function openDepartmentChat(department, pageId) {
	const navigation = ++navigationGeneration;
	cacheCurrentSession();
	const result = await window.qorpera.openChat(null, department.path);
	if (result?.ok) {
		currentSession = result.sessionFile ?? null;
		currentStaffId = null;
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
	renderThreadHeader();
	syncConnectionRequestCards();
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
	$("addStaffButton").onclick = () => void openStaffCreator();
	$("companySwitcherButton").onclick = () => void openCompanySwitcher();
	$("staffIdentityButton").onclick = () => openAgentSidepanel("settings");
	$("staffSidepanelButton").onclick = () => openAgentSidepanel("computer");
	$("agentSidepanelBack").onclick = handleAgentSidepanelBack;
	$("agentSidepanelClose").onclick = () => closeAgentSidepanel();
	$("railSearch").oninput = () => {
		filterRosterRail($("railSearch").value);
		renderRosterRail();
	};
	$("staffClose").onclick = closeStaffCreator;
	$("staffCancel").onclick = closeStaffCreator;
	$("staffTemplateGrid").addEventListener(
		"wheel",
		(event) => {
			if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
			event.preventDefault();
			$("staffTemplateGrid").scrollLeft += event.deltaY;
		},
		{ passive: false },
	);
	$("staffTemplateGrid").addEventListener("scroll", syncStaffTemplateScrollbar, { passive: true });
	window.addEventListener("resize", syncStaffTemplateScrollbar);
	$("staffDisplayName").oninput = () => {
		$("staffCreateButton").disabled = staffCreatorPending || !$("staffDisplayName").value.trim();
	};
	$("staffForm").onsubmit = (event) => {
		event.preventDefault();
		void createStaffMember();
	};
	$("resetPanelButton").onclick = () => {
		focusedDepartmentId = null;
		renderCompanyNavSafe();
		$("navigation").scrollTop = 0;
		showControllerToast("Panel reset. Manually hidden items remain hidden.");
	};
	$("conav").oncontextmenu = (event) => event.preventDefault();
	$("staffContextPin").onclick = () => toggleStaffContextPreference("staff-pinned");
	$("staffContextHide").onclick = () => toggleStaffContextPreference("staff-hidden");
	$("staffContextEdit").onclick = async () => {
		const id = staffContextTarget ? staffId(staffContextTarget) : null;
		closeStaffContext();
		if (!id) return;
		await openStaff(id);
		if (currentStaffId === id) openAgentSidepanel("settings");
	};
	$("staffContextCopy").onclick = async () => {
		const id = staffContextTarget ? staffId(staffContextTarget) : null;
		closeStaffContext();
		if (!id) return;
		try {
			const result = await window.qorpera.copyStaffConversationId(id);
			if (!result?.ok) throw new Error(result?.error ?? "Conversation ID could not be copied.");
			showControllerToast("Conversation ID copied.");
		} catch {
			showControllerToast("The conversation ID could not be copied.");
		}
	};
	$("staffContextDelete").onclick = openStaffDeleteConfirmation;
	$("staffContextMenu").onkeydown = (event) => {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
		event.preventDefault();
		const items = [...$("staffContextMenu").querySelectorAll('button[role="menuitem"]:not(:disabled)')];
		const current = Math.max(0, items.indexOf(document.activeElement));
		const next =
			event.key === "Home"
				? 0
				: event.key === "End"
					? items.length - 1
					: (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
		items[next]?.focus();
	};
	$("staffDeleteCancel").onclick = closeStaffDeleteConfirmation;
	$("staffDeleteConfirm").onclick = () => void deleteStaffMember();
	$("staffDeleteModal").onpointerdown = (event) => {
		if (event.target === $("staffDeleteModal")) closeStaffDeleteConfirmation();
	};
	$("hiddenStaffClose").onclick = () => closeHiddenStaffModal();
	$("hiddenStaffModal").onpointerdown = (event) => {
		if (event.target === $("hiddenStaffModal")) closeHiddenStaffModal();
	};
	$("hiddenStaffModal").onkeydown = (event) => {
		if (event.key === "Escape") {
			event.preventDefault();
			closeHiddenStaffModal();
			return;
		}
		if (event.key !== "Tab") return;
		const controls = [...$("hiddenStaffModal").querySelectorAll("button:not(:disabled)")];
		if (!controls.length) return;
		const first = controls[0];
		const last = controls.at(-1);
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	};

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
		if (!$("staffContextMenu").hidden && !$("staffContextMenu").contains(event.target)) closeStaffContext();
		if (!$("companySwitcherMenu").hidden && !$("companySwitcherMenu").contains(event.target) && !$("companySwitcherButton").contains(event.target)) {
			$("companySwitcherMenu").hidden = true;
			$("companySwitcherButton").setAttribute("aria-expanded", "false");
		}
	});
	document.addEventListener("keydown", (event) => {
		if (event.key !== "Escape") return;
		if (!$("staffModal").hidden) closeStaffCreator();
		else if (!$("staffDeleteModal").hidden) closeStaffDeleteConfirmation();
		else if (!$("archiveModal").hidden) closeArchiveConfirmation();
		else if (!$("departmentModal").hidden) closeDepartmentModal();
		else if (!$("navContext").hidden) closeNavContext();
		else if (!$("panelContextMenu").hidden) closePanelContext();
		else if (!$("staffContextMenu").hidden) closeStaffContext(true);
		else if (!$("agentSidepanel").hidden) closeAgentSidepanel();
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
	const staffHeaderVisible = view === "chat" || Boolean(currentStaffId && (view === "surface" || view === "panel"));
	const staffCreatorOpen = !$("staffModal").hidden;
	dockChat(docked);
	$("threadHeader").hidden = staffCreatorOpen || !staffHeaderVisible;
	$("staffCreatorTitlebar").hidden = !staffCreatorOpen;
	$("view-roster").style.display = view === "roster" ? "block" : "none";
	$("view-chat").style.display = view === "chat" || docked ? "flex" : "none";
	$("view-surfacewrap").style.display = view === "surface" ? "flex" : "none";
	$("view-surfacewrap").classList.toggle("chat-open", sidechatOpen);
	$("view-panel").style.display = view === "panel" ? "block" : "none";
	if (view === "roster") renderStaffHome();
	if (staffHeaderVisible) renderThreadHeader();
	renderCompanyNavSafe();
	renderRosterRail();
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
	const staffOwned = Boolean(currentStaffId && page.staffAgentId === currentStaffId);
	$("view-surfacewrap").classList.toggle("staff-owned", staffOwned);
	if (staffOwned) sidechatOpen = false;
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
	if (!staffOwned && sidechatOpen && sidechatPageId !== page.id) void attachSidechat(page);
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
		currentStaffId = null;
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
	renderThreadHeader();
	syncConnectionRequestCards();
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
	const labels = (job.triggers ?? []).map((trigger) => {
		if (trigger.kind === "github") return trigger.repository ? `GitHub · ${trigger.repository}` : "GitHub event";
		if (trigger.kind === "custom") return trigger.label;
		const minutes = Number(trigger.intervalMinutes);
		if (minutes === 60) return "Hourly";
		if (minutes % 1440 === 0) return `Every ${minutes / 1440} day${minutes === 1440 ? "" : "s"}`;
		if (minutes % 60 === 0) return `Every ${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
		return `Every ${minutes} minute${minutes === 1 ? "" : "s"}`;
	});
	return labels.join(" · ") || "No trigger";
}

function scheduledJobNextLabel(job) {
	if (job.running) return "Running now";
	if (job.suspendedReason) return "Suspended";
	if (!job.enabled) return "Paused";
	if (!(job.triggers ?? []).some((trigger) => trigger.kind === "schedule")) return "Waiting for event";
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
		triggers: (job?.triggers ?? []).map((trigger) => ({
			...trigger,
			...(trigger.kind === "github" ? { events: [...trigger.events], actors: [...trigger.actors] } : {}),
		})),
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

function rememberScheduledJob(job) {
	if (!job) return;
	const jobs = Array.isArray(state.scheduledJobs) ? [...state.scheduledJobs] : [];
	const index = jobs.findIndex((candidate) => candidate.id === job.id);
	if (index >= 0) jobs[index] = job;
	else jobs.push(job);
	state.scheduledJobs = jobs;
}

function forgetScheduledJob(id) {
	state.scheduledJobs = (state.scheduledJobs ?? []).filter((job) => job.id !== id);
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
	eyebrow.textContent = scheduledJobPanel.mode === "create"
		? (activityStaffId ? "New routine" : "New scheduled job")
		: (activityStaffId ? "Routine details" : "Scheduled job details");
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
				rememberScheduledJob(result.job);
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
	prompt.placeholder = activityStaffId ? "Describe what this staff member should do" : "Describe the recurring company work";
	prompt.value = scheduledJobPanel.draft.prompt;
	prompt.oninput = () => {
		scheduledJobPanel.draft.prompt = prompt.value;
		scheduledJobPanel.dirty = true;
	};
	form.appendChild(
		scheduledJobField("Instructions", prompt, activityStaffId ? "This staff member receives the full instructions at every run." : "The assigned worker receives these full instructions at every run."),
	);
	const interval = document.createElement("input");
	interval.type = "number";
	interval.min = "5";
	interval.max = String(7 * 24 * 60);
	interval.step = "1";
	interval.value = String(scheduledJobPanel.draft.triggers.find((trigger) => trigger.kind === "schedule")?.intervalMinutes ?? 60);
	interval.oninput = () => {
		const schedule = scheduledJobPanel.draft.triggers.find((trigger) => trigger.kind === "schedule");
		if (schedule) schedule.intervalMinutes = Number(interval.value);
		else scheduledJobPanel.draft.triggers.push({ id: crypto.randomUUID(), kind: "schedule", intervalMinutes: Number(interval.value) });
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
			if (result?.ok) {
				forgetScheduledJob(job.id);
				scheduledJobPanel = null;
			}
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
	save.textContent = scheduledJobPanel.mode === "create" ? (activityStaffId ? "Create routine" : "Create scheduled job") : "Save changes";
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
			triggers: scheduledJobPanel.draft.triggers.length
				? scheduledJobPanel.draft.triggers
				: [{ id: crypto.randomUUID(), kind: "schedule", intervalMinutes: Number(interval.value) }],
			enabled: Boolean(scheduledJobPanel.draft.enabled),
			...(activityStaffId ? { staffAgentId: activityStaffId } : {}),
		};
		const result = await scheduledJobRequest(
			() => (job ? window.qorpera.updateScheduledJob(job.id, draft) : window.qorpera.createScheduledJob(draft)),
			"Could not save the scheduled job.",
		);
		scheduledJobPanel.pending = false;
		if (result?.ok) {
			rememberScheduledJob(result.job);
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
	if (["idle", "ready", "waiting"].includes(runtime?.status)) return "Ready";
	if (runtime?.status === "detached") return "Offline";
	if (runtime?.status === "interrupted") return "Needs attention";
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
					if (result?.ok) {
						rememberScheduledJob(result.job);
						void renderActivity(true);
					}
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

async function renderActivity(force = false, staffOwnerId = activityStaffId) {
	activityStaffId = staffOwnerId;
	const renderGeneration = ++activityRenderGeneration;
	const panel = $("view-panel");
	if (
		!force &&
		scheduledJobPanel?.dirty &&
		panel.querySelector(".scheduled-job-detail")?.contains(document.activeElement)
	)
		return;
	const sessions = staffOwnerId
		? (state.sessions ?? []).filter((session) => session.staffAgentId === staffOwnerId)
		: (state.sessions ?? []);
	const runtimeSessions = staffOwnerId
		? (state.runtime?.sessions ?? []).filter((session) => session.staffAgentId === staffOwnerId)
		: (state.runtime?.sessions ?? []);
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
	let jobs = Array.isArray(state.scheduledJobs) ? state.scheduledJobs : [];
	const requestedNodeId = currentNodeId;
	if (!jobs.length) try {
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
	jobs = jobs
		.filter((job) => !staffOwnerId || job.staffAgentId === staffOwnerId)
		.map((job) => ({
			...job,
			running: runtimeSessions.some(
				(session) => session.live && session.group === `job:${job.id}` && ["starting", "running", "finishing", "reconnecting"].includes(session.status),
			),
		}));
	const stillOnRequestedView = staffOwnerId
		? currentNodeId === `staff-routines:${staffOwnerId}`
		: projectionNode(requestedNodeId)?.view?.id === "qorpera.activity";
	if (
		renderGeneration !== activityRenderGeneration ||
		currentNodeId !== requestedNodeId ||
		!stillOnRequestedView
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
	const owner = staffOwnerId ? activeStaffMembers().find((staff) => staffId(staff) === staffOwnerId) : null;
	title.textContent = owner ? `${staffDisplayName(owner)} routines` : "Agents";
	const subtitle = document.createElement("p");
	subtitle.textContent = owner
		? "Recurring responsibilities, scheduled work, and durable history for this staff member."
		: "Company-wide live, scheduled, and past work.";
	pageCopy.append(title, subtitle);
	const create = document.createElement("button");
	create.type = "button";
	create.className = "primary-button";
	create.textContent = owner ? "Create routine" : "Create scheduled job";
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
	if (!owner) main.appendChild(controllerTile(sessions, jobs, liveRuntime));
	const jobsHead = document.createElement("h2");
	jobsHead.className = "trail-section scheduled-jobs-heading";
	jobsHead.textContent = `${owner ? "Routines" : "Scheduled"} · ${jobs.length}`;
	main.appendChild(jobsHead);
	if (!jobs.length) {
		const empty = document.createElement("div");
		empty.className = "scheduled-jobs-empty";
		empty.textContent = owner
			? `No routines yet. Create one to give ${staffDisplayName(owner)} recurring work.`
			: "No scheduled jobs. Create one for the company or assign it to staff.";
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

function assistantTextPartsFromMessage(message) {
	return (message?.content ?? [])
		.filter((part) => part.type === "text" && part.text)
		.map((part) => part.text)
		.filter(Boolean);
}

function assistantTextBlocksFromMessage(message) {
	return (message?.content ?? [])
		.map((part, contentIndex) => ({ contentIndex, text: part.type === "text" ? String(part.text ?? "") : "" }))
		.filter((part) => part.text);
}

/** Preserve provider-authored text blocks, then split only at top-level blank
 * lines. This changes presentation, not the stored trail or model prompt. */
function assistantDisplaySegments(source) {
	const text = String(source ?? "").replace(/\r\n?/g, "\n").trim();
	if (!text) return [];
	const blocks = [];
	let block = [];
	let fence = "";
	const flush = () => {
		const value = block.join("\n").trim();
		if (value) blocks.push(value);
		block = [];
	};
	for (const line of text.split("\n")) {
		const marker = line.match(/^\s*(```|~~~)/)?.[1] ?? "";
		if (!fence && marker) fence = marker;
		else if (fence && marker === fence) fence = "";
		if (!fence && !line.trim()) flush();
		else block.push(line);
	}
	flush();

	const segments = [];
	for (const value of blocks) {
		const structured = /^(?:[-*+]\s|\d+[.)]\s|\|)/.test(value);
		const previous = segments.at(-1);
		if (structured && previous && /[:：]\s*$/.test(previous)) segments[segments.length - 1] = `${previous}\n\n${value}`;
		else segments.push(value);
	}
	return segments;
}

function appendAssistantMessages(parts, animate = false) {
	const segments = parts.flatMap(assistantDisplaySegments);
	const messages = [];
	for (const [index, text] of segments.entries()) {
		const message = addMsg("assistant", "");
		message.classList.add("assistant-segment");
		if (animate) {
			message.classList.add("message-pop");
			message.style.setProperty("--message-pop-delay", `${Math.min(index * 65, 260)}ms`);
		}
		renderMarkdown(message, text);
		messages.push(message);
	}
	$("messages").scrollTop = $("messages").scrollHeight;
	return messages;
}

function resetAssistantStreamState() {
	pendingAssistantTextByIndex.clear();
	renderedAssistantTextByIndex.clear();
}

function assistantStreamHasPendingText() {
	return [...pendingAssistantTextByIndex.values()].some((text) => text.trim());
}

/** Commit a provider-completed text block as one or more digestible bubbles.
 * The provider stream stays canonical; hidden reasoning is never projected. */
function renderCompletedAssistantBlock(contentIndex, content) {
	const text = String(content ?? "").trim();
	if (!text) return [];
	const previous = renderedAssistantTextByIndex.get(contentIndex);
	if (previous?.text === text) return previous.elements;
	for (const element of previous?.elements ?? []) element.remove();
	const elements = appendAssistantMessages([text], true);
	renderedAssistantTextByIndex.set(contentIndex, { text, elements });
	if (elements.length) {
		turnProgressBubbleCount = Math.min(2, turnProgressBubbleCount + elements.length);
		turnProgressLastKind = "provider";
		turnProgressLastAt = Date.now();
	}
	return elements;
}

function reconcileCompletedAssistantMessage(message) {
	const blocks = assistantTextBlocksFromMessage(message);
	for (const block of blocks) renderCompletedAssistantBlock(block.contentIndex, block.text);
	if (!blocks.length) {
		for (const [contentIndex, text] of pendingAssistantTextByIndex) {
			renderCompletedAssistantBlock(contentIndex, text);
		}
	}
}

function toolProgressKind(toolName) {
	const tool = String(toolName ?? "").toLowerCase();
	if (/^(?:read|grep|find|ls|glob|search)$/.test(tool)) return "company-search";
	if (/^(?:web_search|web-search|http-request|fetch|browser|navigate)$/.test(tool)) return "web-search";
	if (/^(?:write|edit|edit-diff|apply_patch|patch|notebook_edit)$/.test(tool)) return "change";
	if (/^(?:bash|shell|shell_command)$/.test(tool)) return "command";
	return "work";
}

function toolProgressText(kind) {
	if (kind === "company-search") return "Checking the company files now.";
	if (kind === "web-search") return "Looking that up now.";
	if (kind === "change") return "Making that change now.";
	if (kind === "command") return "Running that now.";
	return "Working on that now.";
}

/** Show at most two factual phase updates per turn. These are derived from
 * explicit tool events; hidden reasoning and thinking deltas remain hidden. */
function maybeAppendToolProgress(toolName) {
	if (turnProgressBubbleCount >= 2) return;
	const kind = toolProgressKind(toolName);
	const now = Date.now();
	if (turnProgressBubbleCount && now - turnProgressLastAt < 900) return;
	if (kind === turnProgressLastKind && now - turnProgressLastAt < 6000) return;
	const [message] = appendAssistantMessages([toolProgressText(kind)], true);
	message?.classList.add("assistant-progress");
	turnProgressBubbleCount += 1;
	turnProgressLastKind = kind;
	turnProgressLastAt = now;
}

function threadActivityLabel(mode) {
	const staff = currentStaff();
	const name = staff ? staffDisplayName(staff) : $("threadTitle").textContent || "Agent";
	const action = mode === "working" ? "working" : mode === "typing" ? "writing" : "thinking";
	return `${name} ${action}`;
}

function showThreadActivity(mode) {
	if (currentView !== "chat" && !(currentView === "surface" && sidechatOpen)) return;
	const staff = currentStaff();
	const activityStaffId = staffId(staff);
	if (!threadActivityEl?.isConnected) {
		threadActivityEl = document.createElement("div");
		threadActivityEl.tabIndex = 0;
		threadActivityEl.setAttribute("role", "status");
		$("messages").appendChild(threadActivityEl);
	}
	const label = threadActivityLabel(mode);
	if (threadActivityEl.dataset.mode === mode && threadActivityEl.dataset.staffId === activityStaffId) {
		$("messages").appendChild(threadActivityEl);
		$("messages").scrollTop = $("messages").scrollHeight;
		return;
	}
	threadActivityEl.className = `agent-thread-activity is-${mode}`;
	threadActivityEl.dataset.mode = mode;
	threadActivityEl.dataset.staffId = activityStaffId;
	threadActivityEl.dataset.tooltip = label;
	threadActivityEl.setAttribute("aria-label", label);
	const motion = mode === "working" ? "working" : mode === "typing" ? "finishing" : "starting";
	threadActivityEl.replaceChildren(makeStaffAvatar(staff, motion));
	if (mode === "typing") {
		const dots = document.createElement("span");
		dots.className = "agent-writing-dots";
		dots.setAttribute("aria-hidden", "true");
		dots.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
		threadActivityEl.appendChild(dots);
		if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			for (const [index, dot] of [...dots.children].entries()) {
				dot.animate(
					[
						{ transform: "translateY(0) scale(1)", offset: 0 },
						{ transform: "translateY(-5px) scale(1.16)", offset: 0.22 },
						{ transform: "translateY(0) scale(1)", offset: 0.46 },
						{ transform: "translateY(0) scale(1)", offset: 1 },
					],
					{
						duration: 900,
						easing: "cubic-bezier(.34,.05,.3,1)",
						iterations: Number.POSITIVE_INFINITY,
						iterationStart: index * 0.13,
					},
				);
			}
		}
	}
	$("messages").appendChild(threadActivityEl);
	$("messages").scrollTop = $("messages").scrollHeight;
}

function hideThreadActivity() {
	threadActivityEl?.remove();
	threadActivityEl = null;
}

// ---- image attachments: paste or drop into the composer ----------------------
let pendingImages = []; // { mimeType, dataUrl }

function openImageLightbox(url, label = "Attached image") {
	const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	const box = document.createElement("div");
	box.className = "lightbox";
	box.setAttribute("role", "dialog");
	box.setAttribute("aria-modal", "true");
	box.setAttribute("aria-label", label);
	box.tabIndex = -1;
	const full = document.createElement("img");
	full.src = url;
	full.alt = label;
	const close = () => {
		document.removeEventListener("keydown", onKeyDown);
		box.remove();
		previousFocus?.focus();
	};
	const onKeyDown = (event) => {
		if (event.key === "Escape") close();
	};
	box.onclick = (event) => {
		if (event.target === box) close();
	};
	document.addEventListener("keydown", onKeyDown);
	box.appendChild(full);
	document.body.appendChild(box);
	box.focus();
}

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
		img.tabIndex = 0;
		img.setAttribute("role", "button");
		img.setAttribute("aria-label", "Enlarge attached image");
		img.onclick = () => openImageLightbox(image.dataUrl);
		img.onkeydown = (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			event.preventDefault();
			openImageLightbox(image.dataUrl);
		};
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

$("attachFileInput").onchange = () => {
	for (const file of $("attachFileInput").files ?? []) attachImageFile(file);
	$("attachFileInput").value = "";
};

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
		img.tabIndex = 0;
		img.setAttribute("role", "button");
		img.setAttribute("aria-label", "Enlarge attached image");
		img.onclick = () => openImageLightbox(url);
		img.onkeydown = (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			event.preventDefault();
			openImageLightbox(url);
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
	setCurrentAvatarAction("starting", 1200);
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

function addModelFailureCard(
	errorMessage,
	progress = activeRunProgress,
	prompt = lastSubmittedPrompt,
	{ historical = false } = {},
) {
	const info = modelFailureInfo(errorMessage);
	const card = document.createElement("article");
	card.className = `model-failure-card${historical ? " is-historical" : ""}`;
	const heading = document.createElement("strong");
	heading.textContent = historical ? `Previous failure: ${info.cause}` : info.cause;
	const partial = document.createElement("p");
	partial.className = "model-failure-partial";
	partial.textContent = `Partial work: ${runProgressSummary(progress)}`;
	const guidance = document.createElement("p");
	guidance.textContent = info.guidance;
	const historyNote = document.createElement("p");
	historyNote.className = "model-failure-history";
	historyNote.textContent =
		"Recorded on an earlier run. New requests use the model currently selected in Chat settings.";
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
	card.append(heading, partial, guidance);
	if (historical) card.appendChild(historyNote);
	card.appendChild(actions);
	$("messages").appendChild(card);
	$("messages").scrollTop = $("messages").scrollHeight;
	return card;
}

let composerMeasurementInput = null;

function measureComposerHeight(input, width, expanded, value = input.value) {
	if (!composerMeasurementInput) {
		composerMeasurementInput = document.createElement("textarea");
		composerMeasurementInput.tabIndex = -1;
		composerMeasurementInput.setAttribute("aria-hidden", "true");
		Object.assign(composerMeasurementInput.style, {
			position: "fixed",
			top: "0",
			left: "-10000px",
			boxSizing: "border-box",
			height: "1px",
			minHeight: "0",
			maxHeight: "none",
			border: "0",
			borderRadius: "0",
			overflow: "hidden",
			resize: "none",
			visibility: "hidden",
			whiteSpace: "pre-wrap",
		});
		document.body.appendChild(composerMeasurementInput);
	}
	const styles = getComputedStyle(input);
	Object.assign(composerMeasurementInput.style, {
		width: `${Math.max(40, width)}px`,
		padding: expanded ? "5px 0 0 5px" : "8px 1px",
		fontFamily: styles.fontFamily,
		fontSize: styles.fontSize,
		fontWeight: styles.fontWeight,
		fontStyle: styles.fontStyle,
		lineHeight: styles.lineHeight,
		letterSpacing: styles.letterSpacing,
		wordBreak: styles.wordBreak,
		overflowWrap: styles.overflowWrap,
	});
	composerMeasurementInput.value = value || " ";
	return composerMeasurementInput.scrollHeight;
}

/** Keep the resting composer compact, then grow it one text line at a time.
 * Measurements happen offscreen so editing never collapses the live composer. */
function syncComposer() {
	const input = $("input");
	const shell = document.querySelector(".composer-shell");
	if (!shell) return;
	input.style.removeProperty("height");
	const shellStyles = getComputedStyle(shell);
	const contentWidth =
		shell.clientWidth -
		Number.parseFloat(shellStyles.paddingLeft) -
		Number.parseFloat(shellStyles.paddingRight);
	const columnGap = Number.parseFloat(shellStyles.columnGap) || 0;
	const compactWidth = contentWidth - 80 - columnGap * 2;
	const compactHeight = measureComposerHeight(input, compactWidth, false);
	const compactSingleLineHeight = measureComposerHeight(input, compactWidth, false, "M");
	const expanded = Boolean(
		pendingImages.length ||
		(input.value.length > 0 && (input.value.includes("\n") || compactHeight > compactSingleLineHeight + 2)),
	);
	if (expanded) {
		const fullHeight = measureComposerHeight(input, contentWidth, true);
		const textHeight = Math.min(112, Math.max(38, fullHeight));
		shell.style.setProperty("--composer-text-height", `${textHeight}px`);
		input.style.overflowY = fullHeight > 112 ? "auto" : "hidden";
	} else {
		shell.style.removeProperty("--composer-text-height");
		input.style.overflowY = "hidden";
	}
	shell.classList.toggle("composer-expanded", expanded);
	shell.classList.toggle("composer-has-attachments", pendingImages.length > 0);
	$("sendBtn").dataset.active = input.value.trim() || pendingImages.length ? "true" : "false";
	const nextTyping = Boolean(input.value.trim());
	if (nextTyping !== founderTyping) {
		founderTyping = nextTyping;
		syncVisibleStaffAvatars();
	}
}

$("input").addEventListener("input", syncComposer);
document.querySelector(".composer-shell")?.addEventListener("focusin", syncComposer);
document.querySelector(".composer-shell")?.addEventListener("focusout", () => setTimeout(syncComposer));
document.querySelector(".composer-shell")?.addEventListener("pointerdown", (event) => {
	if (event.target !== event.currentTarget) return;
	event.preventDefault();
	$("input").focus();
});
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
	hideThreadActivity();
	resetAssistantStreamState();
	turnProgressBubbleCount = 0;
	turnProgressLastKind = "";
	turnProgressLastAt = 0;
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
	el.innerHTML = window.marked?.parse ? window.marked.parse(escaped, { breaks: true }) : escaped.replace(/\n/g, "<br>");
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
				closeWorkGroup();
				pendingAssistantTextByIndex.set(delta.contentIndex, "");
				showThreadActivity("typing");
			}
			if (delta.type === "text_delta") {
				pendingAssistantTextByIndex.set(
					delta.contentIndex,
					`${pendingAssistantTextByIndex.get(delta.contentIndex) ?? ""}${delta.delta}`,
				);
				showThreadActivity("typing");
			}
			if (delta.type === "text_end") {
				renderCompletedAssistantBlock(
					delta.contentIndex,
					delta.content ?? pendingAssistantTextByIndex.get(delta.contentIndex) ?? "",
				);
				pendingAssistantTextByIndex.delete(delta.contentIndex);
				showThreadActivity("thinking");
			}
			if (delta.type === "thinking_start") showThreadActivity("thinking");
			break;
		}
		case "tool_execution_start": {
			setCurrentAvatarAction("working");
			maybeAppendToolProgress(frame.toolName);
			showThreadActivity("working");
			pendingToolLines.push({
				toolName: frame.toolName,
				args: frame.args,
				line: null,
			});
			break;
		}
		case "tool_execution_end": {
			// Finish the matching in-flight line in place instead of adding a
			// second row per call.
			const index = pendingToolLines.findIndex((p) => p.toolName === frame.toolName);
			const entry = index >= 0 ? pendingToolLines.splice(index, 1)[0] : null;
			if (entry?.line) entry.line.textContent = `${frame.isError ? "✗" : "✓"}${entry.line.textContent.slice(1)}`;
			if (!frame.isError) recordCompletedTool(activeRunProgress, frame.toolName, entry?.args);
			if (!pendingToolLines.length && !assistantStreamHasPendingText()) showThreadActivity("thinking");
			refreshState();
			break;
		}
		case "agent_settled":
			closeWorkGroup();
			hideThreadActivity();
			setCurrentAvatarAction("finishing", 850);
			refreshState();
			break;
		case "agent_start":
			resetAssistantStreamState();
			turnProgressBubbleCount = 0;
			turnProgressLastKind = "";
			turnProgressLastAt = 0;
			setCurrentAvatarAction("working");
			showThreadActivity("thinking");
			if (!activeRunProgress) activeRunProgress = createRunProgress();
			break;
		case "message_end": {
			// A turn that errored or was stopped otherwise renders NOTHING — the
			// founder saw blank panes while the real reason (an OAuth refresh
			// failure) sat unread in the trail. Say what happened, in the thread.
			const ended = frame.message;
			if (ended?.role === "assistant") {
				hideThreadActivity();
				setCurrentAvatarAction("finishing", 850);
				if (ended.stopReason !== "error" && ended.stopReason !== "aborted") {
					reconcileCompletedAssistantMessage(ended);
				}
				resetAssistantStreamState();
			}
			if (ended?.role === "assistant" && ended.stopReason === "error") {
				closeWorkGroup();
				if (!turnFailureCard) turnFailureCard = addModelFailureCard(ended.errorMessage);
			} else if (ended?.role === "assistant" && ended.stopReason === "aborted") {
				closeWorkGroup();
				$("status").textContent = "stopped";
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

// ---- profile settings -------------------------------------------------------

const SETTINGS_TABS = new Set(["general", "connections", "authority"]);
let settingsTab = "general";
let connectingConnection = null;
let disconnectingConnection = null;
let settingsRenderVersion = 0;
let settingsReturnFocus = null;
const connectionMessages = new Map();

function syncSettingsSearch() {
	const query = $("settingsSearch").value.trim().toLocaleLowerCase();
	const buttons = [...document.querySelectorAll("#settingsView .stab")];
	const matches = buttons.filter((button) => {
		const searchable = `${button.textContent ?? ""} ${button.dataset.search ?? ""}`.toLocaleLowerCase();
		const matchesQuery = !query || searchable.includes(query);
		button.hidden = !matchesQuery;
		return matchesQuery;
	});
	$("settingsSearchEmpty").hidden = matches.length > 0;
	if (!query || matches.length === 0 || matches.some((button) => button.dataset.tab === settingsTab)) return;
	settingsTab = matches[0].dataset.tab;
	for (const button of buttons) button.classList.toggle("active", button.dataset.tab === settingsTab);
	void renderSettingsTab();
}

function openSettings(tab) {
	settingsTab = SETTINGS_TABS.has(tab) ? tab : "general";
	const view = $("settingsView");
	const opening = !view.classList.contains("open");
	if (opening) {
		settingsReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		$("settingsSearch").value = "";
		syncSettingsSearch();
	}
	view.classList.add("open");
	view.setAttribute("aria-hidden", "false");
	for (const b of document.querySelectorAll("#settingsView .stab")) {
		b.classList.toggle("active", b.dataset.tab === settingsTab);
	}
	void renderSettingsTab();
	requestAnimationFrame(() => {
		if (opening) $("settingsSearch").focus();
		else document.querySelector(`#settingsView .stab[data-tab="${settingsTab}"]`)?.focus();
	});
}
function closeSettings() {
	settingsRenderVersion += 1;
	const view = $("settingsView");
	view.classList.remove("open");
	view.setAttribute("aria-hidden", "true");
	settingsReturnFocus?.focus();
	settingsReturnFocus = null;
}

$("settingsView").addEventListener("pointerdown", (event) => {
	if (event.target === $("settingsView")) closeSettings();
});
$("settingsSearch").addEventListener("input", syncSettingsSearch);
document.addEventListener("keydown", (event) => {
	if (event.key === "Escape" && $("settingsView").classList.contains("open")) closeSettings();
});

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

const CONNECTION_LOGOS = {
	github: "./provider-github.svg",
	"openai-codex": "./provider-openai.svg",
	anthropic: "./provider-anthropic.svg",
	xai: "./provider-xai.svg",
};

function connectionLogo(connectionId) {
	const logo = document.createElement("span");
	logo.className = `connection-logo ${connectionId}`;
	const asset = CONNECTION_LOGOS[connectionId];
	if (asset) {
		const image = document.createElement("img");
		image.src = asset;
		image.alt = "";
		logo.appendChild(image);
	} else {
		logo.innerHTML = navGlyphSvg("grid", "connection-fallback-logo");
	}
	return logo;
}

async function toggleConnection(connectionId) {
	if (connectingConnection === connectionId) {
		connectionMessages.set(connectionId, "Cancelling…");
		window.qorpera.cancelConnection(connectionId);
		void renderSettingsTab();
		return;
	}
	if (connectingConnection) return;
	connectingConnection = connectionId;
	connectionMessages.set(connectionId, "Opening sign-in in your browser…");
	void renderSettingsTab();
	try {
		const result = await window.qorpera.connectAccount(connectionId);
		if (result?.ok) connectionMessages.delete(connectionId);
		else if (result?.cancelled) connectionMessages.set(connectionId, "Connection cancelled.");
		else connectionMessages.set(connectionId, result?.error ?? "Connection failed.");
	} catch (error) {
		connectionMessages.set(connectionId, error instanceof Error ? error.message : "Connection failed.");
	} finally {
		connectingConnection = null;
		if ($("settingsView").classList.contains("open") && settingsTab === "connections") {
			void renderSettingsTab();
		}
	}
}

async function disconnectConnection(connectionId, accountId) {
	if (connectingConnection || disconnectingConnection) return;
	const operationId = `${connectionId}:${accountId}`;
	disconnectingConnection = operationId;
	void renderSettingsTab();
	try {
		const result = await window.qorpera.disconnectAccount(connectionId, accountId);
		if (result?.ok) connectionMessages.delete(connectionId);
		else connectionMessages.set(connectionId, result?.error ?? "Could not disconnect this account.");
	} catch (error) {
		connectionMessages.set(connectionId, error instanceof Error ? error.message : "Could not disconnect this account.");
	} finally {
		disconnectingConnection = null;
		if ($("settingsView").classList.contains("open") && settingsTab === "connections") {
			void renderSettingsTab();
		}
	}
}

function renderAccountUsage(account) {
	const windows = account?.usage?.status === "available" ? account.usage.windows : [];
	if (!Array.isArray(windows) || windows.length === 0) return null;
	const usage = document.createElement("div");
	usage.className = "connection-usage";
	for (const window of windows) {
		const item = document.createElement("div");
		item.className = "connection-usage-window";
		const meta = document.createElement("div");
		meta.className = "connection-usage-meta";
		const label = document.createElement("span");
		label.textContent = window.label;
		const remaining = document.createElement("span");
		const remainingPercent = Math.max(0, Math.min(100, Number(window.remainingPercent) || 0));
		remaining.textContent = `${Math.round(remainingPercent)}% left`;
		meta.append(label, remaining);
		const track = document.createElement("div");
		track.className = "connection-usage-track";
		track.setAttribute("role", "meter");
		track.setAttribute("aria-label", `${window.label} usage remaining`);
		track.setAttribute("aria-valuemin", "0");
		track.setAttribute("aria-valuemax", "100");
		track.setAttribute("aria-valuenow", String(Math.round(remainingPercent)));
		const fill = document.createElement("span");
		fill.style.width = `${remainingPercent}%`;
		track.appendChild(fill);
		item.append(meta, track);
		usage.appendChild(item);
	}
	return usage;
}

function renderConnectionGroup(content, title, description, connections, accountUsageById) {
	const group = document.createElement("section");
	group.className = "settings-group";
	const header = document.createElement("header");
	const heading = document.createElement("h2");
	heading.textContent = title;
	header.appendChild(heading);
	if (description) {
		const detail = document.createElement("p");
		detail.textContent = description;
		header.appendChild(detail);
	}
	group.appendChild(header);
	const list = document.createElement("div");
	list.className = "connection-list";
	for (const connection of connections) {
		const card = document.createElement("article");
		card.className = "connection-card";
		card.appendChild(connectionLogo(connection.id));
		const copy = document.createElement("div");
		copy.className = "connection-copy";
		const name = document.createElement("strong");
		name.textContent = connection.name;
		const detail = document.createElement("small");
		detail.textContent = connectionMessages.get(connection.id) ?? connection.description;
		copy.append(name, detail);
		card.appendChild(copy);
		const accounts = Array.isArray(connection.accounts) ? connection.accounts : [];
		if (connection.group === "models") {
			card.classList.add("connection-card-multiple");
			const add = document.createElement("button");
			add.type = "button";
			add.className = "connection-action";
			const busy = connectingConnection === connection.id;
			add.dataset.busy = String(busy);
			add.textContent = busy ? "Cancel" : accounts.length ? "Add account" : "Connect";
			add.disabled = Boolean(connectingConnection && !busy);
			add.onclick = () => void toggleConnection(connection.id);
			card.appendChild(add);
			if (accounts.length) {
				const accountList = document.createElement("div");
				accountList.className = "connection-account-list";
				for (const modelAccount of accounts) {
					const row = document.createElement("div");
					row.className = "connection-account-row";
					const main = document.createElement("div");
					main.className = "connection-account-main";
					const accountName = document.createElement("span");
					accountName.textContent = modelAccount.accountName || "Account details unavailable";
					const disconnect = document.createElement("button");
					disconnect.type = "button";
					disconnect.className = "connection-action connection-disconnect";
					const operationId = `${connection.id}:${modelAccount.id}`;
					const disconnecting = disconnectingConnection === operationId;
					disconnect.textContent = disconnecting ? "Disconnecting…" : "Disconnect";
					disconnect.disabled = Boolean(connectingConnection || (disconnectingConnection && !disconnecting));
					disconnect.onclick = () => void disconnectConnection(connection.id, modelAccount.id);
					main.append(accountName, disconnect);
					row.appendChild(main);
					const usage = renderAccountUsage(accountUsageById.get(modelAccount.id));
					if (usage) row.appendChild(usage);
					accountList.appendChild(row);
				}
				card.appendChild(accountList);
			}
		} else if (connection.connected) {
			const account = document.createElement("div");
			account.className = "connection-account";
			const accountName = document.createElement("small");
			accountName.textContent = connection.accountName || "Account details unavailable";
			const disconnect = document.createElement("button");
			disconnect.type = "button";
			disconnect.className = "connection-action connection-disconnect";
			disconnect.textContent = "Disconnect";
			disconnect.disabled = Boolean(connectingConnection || disconnectingConnection);
			disconnect.onclick = () => void disconnectConnection(connection.id, connection.id);
			account.append(accountName, disconnect);
			card.appendChild(account);
		} else {
			const action = document.createElement("button");
			action.type = "button";
			action.className = "connection-action";
			const busy = connectingConnection === connection.id;
			action.dataset.busy = String(busy);
			action.textContent = busy ? "Cancel" : "Connect";
			action.disabled = Boolean(connectingConnection && !busy);
			action.onclick = () => void toggleConnection(connection.id);
			card.appendChild(action);
		}
		list.appendChild(card);
	}
	group.appendChild(list);
	content.appendChild(group);
}

function renderConnections(content, connections, accountUsageById) {
	const heading = document.createElement("header");
	heading.className = "settings-heading";
	heading.innerHTML = "<h1>Connections</h1>";
	content.appendChild(heading);

	const services = connections.filter((connection) => connection.group === "services");
	if (services.length) {
		renderConnectionGroup(
			content,
			"Services",
			"Accounts the active company can use for external work.",
			services,
			accountUsageById,
		);
	}
	const models = connections.filter((connection) => connection.group === "models");
	if (models.length) {
		renderConnectionGroup(content, "Model accounts", "", models, accountUsageById);
	}
}

async function renderSettingsTab() {
	const renderVersion = ++settingsRenderVersion;
	const renderedTab = settingsTab;
	const content = $("settingsContent");
	content.innerHTML = "";

	if (settingsTab === "general") {
		const info = await window.qorpera.settingsInfo();
		if (renderVersion !== settingsRenderVersion || renderedTab !== settingsTab) return;
		setHeading(content, "General");

		const profileGroup = document.createElement("section");
		profileGroup.className = "settings-group general-settings-group";
		profileGroup.innerHTML = "<header><h2>Profile</h2></header>";
		const profileCard = document.createElement("div");
		profileCard.className = "general-profile-card";
		profileCard.appendChild(
			makeProfileIcon(info.profile?.profileIcon || currentProfileIcon, info.profile?.name || state.name || "Current profile"),
		);
		const profileCopy = document.createElement("div");
		profileCopy.className = "general-account-copy";
		const profileName = document.createElement("strong");
		profileName.textContent = info.profile?.name || state.name || "Current profile";
		const profileDetail = document.createElement("small");
		profileDetail.textContent = "Staff, connections, and files for this profile";
		profileCopy.append(profileName, profileDetail);
		const switchProfile = document.createElement("button");
		switchProfile.type = "button";
		switchProfile.textContent = "Switch profile";
		switchProfile.onclick = async () => {
			switchProfile.disabled = true;
			await window.qorpera.showHub();
		};
		profileCard.append(profileCopy, switchProfile);
		profileGroup.appendChild(profileCard);
		content.appendChild(profileGroup);

		const accountGroup = document.createElement("section");
		accountGroup.className = "settings-group general-settings-group";
		accountGroup.innerHTML = "<header><h2>Account</h2></header>";
		const accountCard = document.createElement("div");
		accountCard.className = "general-account-card";
		const accountCopy = document.createElement("div");
		accountCopy.className = "general-account-copy";
		const accountEmail = document.createElement("strong");
		accountEmail.textContent = info.account?.user?.email || "Email unavailable";
		accountCopy.appendChild(accountEmail);
		const signOutButton = document.createElement("button");
		signOutButton.type = "button";
		signOutButton.textContent = "Sign out";
		signOutButton.onclick = async () => {
			signOutButton.disabled = true;
			const result = await window.qorpera.accountSignOut();
			if (!result?.ok) {
				signOutButton.disabled = false;
				showControllerToast(result?.error ?? "Could not sign out.");
				return;
			}
			closeSettings();
			renderAccountWelcome();
			document.documentElement.dataset.qorperaReady = "account";
		};
		accountCard.append(accountCopy, signOutButton);
		accountGroup.appendChild(accountCard);
		content.appendChild(accountGroup);

		const appearanceGroup = document.createElement("section");
		appearanceGroup.className = "settings-group general-settings-group";
		appearanceGroup.innerHTML = "<header><h2>Appearance</h2></header>";
		const theme = document.createElement("select");
		theme.setAttribute("aria-label", "Theme");
		theme.appendChild(new Option("Light", "light"));
		theme.value = "light";
		setRow(appearanceGroup, "Theme", "", theme);
		content.appendChild(appearanceGroup);

		const executionGroup = document.createElement("section");
		executionGroup.className = "settings-group general-settings-group";
		executionGroup.innerHTML = "<header><h2>Agents</h2></header>";
		const execution = document.createElement("select");
		execution.setAttribute("aria-label", "Execution on local computer");
		for (const [value, label] of [["always", "Always allow"], ["never", "Don’t allow"]]) {
			const option = document.createElement("option");
			option.value = value;
			option.textContent = label;
			execution.appendChild(option);
		}
		execution.value = info.localExecution === "never" ? "never" : "always";
		const executionStatus = document.createElement("small");
		executionStatus.className = "general-setting-status";
		execution.onchange = async () => {
			execution.disabled = true;
			executionStatus.textContent = "Saving…";
			const result = await window.qorpera.setLocalExecution(execution.value);
			if (!result?.ok) {
				execution.value = info.localExecution === "never" ? "never" : "always";
				executionStatus.textContent = result?.error ?? "Permission could not be saved.";
			} else {
				executionStatus.textContent = result.applies === "next-run" ? "Applies after the current run." : "";
			}
			execution.disabled = false;
		};
		const executionRow = setRow(
			executionGroup,
			"Execution on local computer",
			"Let agents open files and run tasks here. Qorpera’s sandbox and authority gates still apply.",
			execution,
		);
		executionRow.appendChild(executionStatus);
		content.appendChild(executionGroup);
		return;
	}

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

	if (settingsTab === "authority") {
		setHeading(content, "Authority — the gates");
		if (!backendUrl) {
			content.insertAdjacentHTML("beforeend", '<div class="sess-meta">Open a company to edit its gates.</div>');
			return;
		}
		const cfg = await (await fetch(`${backendUrl}/api/authority/config`)).json();
		if (renderVersion !== settingsRenderVersion || renderedTab !== settingsTab) return;
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
		if (renderVersion !== settingsRenderVersion || renderedTab !== settingsTab) return;
		content.replaceChildren();
		const connections = info.connections ?? [];
		const cachedUsageById = new Map(
			connections.flatMap((connection) => connection.accounts ?? []).map((account) => [account.id, account]),
		);
		renderConnections(content, connections, cachedUsageById);
		void window.qorpera
			.modelAccountUsage()
			.then((accountUsage) => {
				if (
					renderVersion !== settingsRenderVersion ||
					renderedTab !== settingsTab ||
					!Array.isArray(accountUsage)
				) {
					return;
				}
				const scrollTop = content.scrollTop;
				content.replaceChildren();
				renderConnections(content, connections, new Map(accountUsage.map((account) => [account.id, account])));
				content.scrollTop = scrollTop;
			})
			.catch(() => {});
		return;
	}

}

// ---- foundation updates -----------------------------------------------------

function renderUpdateButton() {
	const button = $("updateButton");
	const label = button.querySelector("span");
	if (foundationUpdateVersion) {
		button.hidden = false;
		button.disabled = false;
		label.textContent = `Update v${foundationUpdateVersion}`;
		button.title = `Restart and install Qorpera Base v${foundationUpdateVersion}`;
		button.onclick = async () => {
			button.disabled = true;
			const installed = await window.qorpera.updateInstall();
			if (!installed) button.disabled = false;
		};
		return;
	}
	button.hidden = true;
	button.disabled = false;
	button.onclick = null;
}

window.qorpera.onUpdateStatus((text) => {
	$("status").textContent = text;
});
window.qorpera.onUpdateReady((version) => {
	foundationUpdateVersion = version;
	renderUpdateButton();
	$("status").textContent = `v${version} downloaded — ready to install`;
});
window.qorpera.onConnectionStatus((event) => {
	if (!event?.connectionId || !event.message) return;
	if (/^Connected\b/u.test(event.message)) connectionMessages.delete(event.connectionId);
	else connectionMessages.set(event.connectionId, event.message);
	if ($("settingsView").classList.contains("open") && settingsTab === "connections") {
		void renderSettingsTab();
	}
	void refreshState();
});
window.qorpera.onAccountStatus((message) => {
	if (typeof message === "string" && !$("accountView").hidden) $("accountStatus").textContent = message;
});
window.qorpera.onOpenCompany((root) => openCompany(root));

setupHierarchicalController();
setupSidebarToggle();
setupCompanyModal();
$("signOutButton").onclick = signOut;
applyNavAppearance();

async function bootWorkspace() {
	const info = await window.qorpera.appInfo();
	$("hubVersion").textContent = `the foundation · v${info.version}`;
	if (info.activeCompany) {
		await enterCompany(info.activeCompany);
	} else if (info.pendingCompany) {
		await openCompany(info.pendingCompany);
	} else {
		await renderHub();
	}
}

async function bootSignedInWorkspace() {
	if (typeof window.qorpera.intelligenceInfo === "function") {
		try {
			const intelligence = await window.qorpera.intelligenceInfo();
			if (!intelligenceIsConfigured(intelligence)) {
				await renderIntelligenceWelcome(intelligence);
				document.documentElement.dataset.qorperaReady = "welcome";
				return;
			}
		} catch (error) {
			console.warn("intelligence readiness could not be read; continuing with the existing bridge", error);
		}
	}
	await bootWorkspace();
	document.documentElement.dataset.qorperaReady = document.body.classList.contains("hub") ? "hub" : "company";
}

(async () => {
	try {
		const account = await window.qorpera.accountInfo();
		if (!account?.authenticated) {
			renderAccountWelcome();
			document.documentElement.dataset.qorperaReady = "account";
			return;
		}
	} catch (error) {
		console.warn("Qorpera account readiness could not be read", error);
		renderAccountWelcome();
		document.documentElement.dataset.qorperaReady = "account";
		return;
	}
	await bootSignedInWorkspace();
})();
