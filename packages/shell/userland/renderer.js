/* Renderer chrome. Static by design — company and session state arrives from
 * backend read models; the RPC pipe carries the attached provider's content
 * stream and direct commands. */
const $ = (id) => document.getElementById(id);
let backendUrl = "";
// Stable company identity from the desktop host (appInfo). Storage is keyed by
// this, never by backendUrl: the backend port is hash-derived from a small
// space and walks forward on bind collisions, so a port-keyed pref bucket
// can silently change between opens.
let companyId = "";
let state = {
	shellNavigation: {
		defaultPageId: "q:chats",
		sectionIds: [],
		nodes: [],
	},
	inbox: [],
	sessions: [],
	staff: [],
	rooms: [],
	artifacts: [],
	connectors: [],
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
let currentRoomId = null; // durable group-chat identity for the open conversation
let currentRoomMessages = [];
const roomActivity = new Map(); // room id -> Map(staff agent id -> activity)
const recentRoomWrites = new Map(); // room id -> ms timestamp of the last local registry write
const roomDeliveryCards = new Map();
let roomSettingsPending = false;
let roomSettingsTrigger = null;
let archivedRoomsTrigger = null;
let currentStaffIntroStatus = null;
let currentDepartment = null; // product department of the open chat, when applicable
let currentWorktree = null; // host-assigned product worktree, when applicable
const pendingAssistantTextByIndex = new Map();
const renderedAssistantTextByIndex = new Map();
let threadActivityEl = null;
let poller = null;
let runtimeStream = null;
let hydratedExecutorId = "";
const runtimeAttachmentSequences = new Map();
let navigationGeneration = 0;
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
let staffCreatorCreature = "pebble";
let conversationRecipients = new Set();
let staffBootstrapSelections = new Set();
let staffBootstrapPending = false;
let railSearchQuery = "";
let activityStaffId = null;
let agentSidepanelMode = null;
let agentRoutineEditor = null; // { staffAgentId, mode: "create"|"edit", id?, draft, dirty, error, status, pending }
let artifactEditor = null; // { id, expectedUpdatedAt, draft, dirty, error, pending }
const dismissedConnectionRequestGroups = new Map();
const autoStartedConnectionRequestIds = new Set();
let agentSidepanelMotionTimer = null;
let companyCreatorIcon = "anonymous";
let currentCompanyIcon = "anonymous";
let currentCompanyRoot = "";
let profileCreatorPlacement = "local";
let currentProfileAccess = {
	role: "owner",
	capabilities: { read: true, write: true, authorize: true, manageMembers: true },
};

function canUseProfile(capability) {
	return currentProfileAccess?.capabilities?.[capability] === true;
}

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
const STAFF_CREATURE_CATALOG = Object.freeze({
	pebble: Object.freeze({ label: "Pebble", asset: "./staff-creatures/pebble.png" }),
	lantern: Object.freeze({ label: "Lantern", asset: "./staff-creatures/lantern.png" }),
	folio: Object.freeze({ label: "Folio", asset: "./staff-creatures/folio.png" }),
	brain: Object.freeze({ label: "Brain", asset: "./staff-creatures/brain.png" }),
	wisp: Object.freeze({ label: "Wisp Float", asset: "./staff-creatures/wisp.png" }),
	halo: Object.freeze({ label: "Flame Halo Walker", asset: "./staff-creatures/halo.png" }),
	ribbon: Object.freeze({ label: "Ribbon", asset: "./staff-creatures/ribbon.png" }),
	bloom: Object.freeze({ label: "Bloom", asset: "./staff-creatures/bloom.png" }),
});
const STAFF_CREATURE_IDS = Object.freeze(Object.keys(STAFF_CREATURE_CATALOG));
const STAFF_CREATURE_BY_TEMPLATE = Object.freeze({
	"agent-manager": "lantern",
	"financial-officer": "pebble",
	"marketing-lead": "bloom",
	"product-manager": "folio",
	"software-developer": "wisp",
	"product-designer": "ribbon",
	"legal-expert": "halo",
	"operations-specialist": "lantern",
	"research-lead": "brain",
	"costumer-relationist": "bloom",
	"outreaching-conversationalist": "ribbon",
});
const PROFILE_PLACEMENTS = {
	local: {
		label: "On this computer",
		description: "Profile identity, history, and team access stay on this computer.",
	},
	hosted: {
		label: "Hosted for sharing",
		description: "Profile identity, team access, staff, and attended chats sync across members.",
	},
};
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
		id: "agent-manager",
		displayName: "Agent Manager",
		name: "Agent Manager",
		description: "Coordinates the room, assigns bounded work, and synthesizes the team’s output.",
		color: "#ff642e",
		shape: "tilted",
	},
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
	wireFriendsPanel();
	const companies = await window.qorpera.listCompanies();
	const grid = $("hubCompanies");
	grid.innerHTML = "";
	for (const company of companies) {
		const shell = document.createElement("div");
		shell.className = "company-card-shell";
		const card = document.createElement("button");
		card.className = "hub-card company-card";
		card.type = "button";
		card.setAttribute("aria-label", `Open ${company.name} company`);
		const avatar = makeCompanyIcon(company.companyIcon, company.name, "company-avatar");
		const label = document.createElement("strong");
		label.textContent = company.name;
		const type = document.createElement("small");
		type.className = "profile-type-label";
		const role = PROFILE_ROLE_LABELS[company.access?.role ?? company.invitationRole];
		type.textContent = company.invitationPending
			? `Invitation · Hosted profile${role ? ` · ${role}` : ""}`
			: `${company.product?.profile?.placement === "hosted" || company.profileType === "cloud" ? "Hosted profile" : "On this computer"}${company.setupRequired && role ? ` · ${role}` : ""}`;
		card.append(avatar, label, type);
		if (company.invitationPending || company.setupRequired) {
			const setup = document.createElement("small");
			setup.className = "profile-setup-label";
			setup.textContent = company.invitationPending ? "Accept invitation" : "Set up on this computer";
			card.appendChild(setup);
		}
		card.setAttribute(
			"aria-label",
			company.invitationPending
				? `Accept invitation to ${company.name}`
				: company.setupRequired
					? `Set up ${company.name} on this computer`
					: `Open ${company.name} profile`,
		);
		card.onclick = async () => {
			// The click must visibly land: opening provisions the local sandbox,
			// which can take seconds — spin the card and quiet the rest.
			if (document.body.classList.contains("hub-opening")) return;
			document.body.classList.add("hub-opening");
			card.classList.add("loading");
			const spinner = document.createElement("span");
			spinner.className = "hub-spinner";
			card.appendChild(spinner);
			if (company.invitationPending) {
				const accepted = await window.qorpera.acceptCloudInvitation(company.invitationId);
				document.body.classList.remove("hub-opening");
				card.classList.remove("loading");
				spinner.remove();
				if (!accepted?.ok) {
					$("hubError").textContent = accepted?.error ?? "Invitation could not be accepted.";
					return;
				}
				await renderHub();
				return;
			}
			const materializeAndOpen = async () => {
				try {
					let root = company.root;
					if (company.setupRequired) {
						const result = await window.qorpera.materializeCloudProfile(company.profileId);
						if (!result?.ok || !result.root) {
							throw new Error(result?.error ?? "Cloud profile setup did not return a local checkout.");
						}
						root = result.root;
					}
					if (!root) throw new Error("This profile does not have a local checkout.");
					return await openCompany(root);
				} catch (error) {
					$("hubError").textContent = error instanceof Error ? error.message : String(error);
					return false;
				}
			};
			void materializeAndOpen().then((opened) => {
				// Success reloads this window into the company; reaching here
				// means the open failed — hand the hub back.
				if (!opened) {
					document.body.classList.remove("hub-opening");
					card.classList.remove("loading");
					spinner.remove();
				}
			});
		};
		shell.appendChild(card);
		if (company.invitationPending || company.setupRequired || company.access) {
			const actions = document.createElement("button");
			actions.className = "company-card-actions";
			actions.type = "button";
			actions.setAttribute(
				"aria-label",
				company.invitationPending ? `Invitation actions for ${company.name}` : `Company actions for ${company.name}`,
			);
			actions.setAttribute("aria-expanded", "false");
			actions.textContent = "•••";
			const menu = document.createElement("div");
			menu.className = "company-card-menu";
			menu.hidden = true;
			menu.setAttribute("role", "menu");
			const remove = document.createElement("button");
			remove.type = "button";
			remove.setAttribute("role", "menuitem");
			// Which dismissal this card supports: invitations decline; cloud
			// companies follow the caller's role -- the owner deletes the
			// profile for everyone, an invited member leaves it; local
			// companies detach from this machine.
			const cloudRole = company.profileType === "cloud" ? company.access?.role : undefined;
			const dismissal = company.invitationPending
				? "decline"
				: cloudRole === "owner"
					? "delete"
					: cloudRole
						? "leave"
						: "remove";
			remove.textContent = {
				decline: "Decline invitation",
				delete: "Delete from cloud",
				leave: "Leave company",
				remove: "Remove from Qorpera",
			}[dismissal];
			remove.onclick = async () => {
				menu.hidden = true;
				actions.setAttribute("aria-expanded", "false");
				const result =
					dismissal === "decline"
						? await window.qorpera.declineCloudInvitation(company.invitationId)
						: dismissal === "delete"
							? await window.qorpera.deleteCloudProfile(company.profileId, company.name)
							: dismissal === "leave"
								? await window.qorpera.leaveCloudProfile(company.profileId, company.name)
								: await window.qorpera.removeCompany(company.root);
				if (result?.ok) {
					await renderHub();
					return;
				}
				if (!result?.cancelled) {
					$("hubError").textContent =
						result?.error ??
						{
							decline: "Invitation could not be declined.",
							delete: "Company could not be deleted from the cloud.",
							leave: "Company could not be left.",
							remove: "Company could not be removed from Qorpera.",
						}[dismissal];
				}
			};
			menu.appendChild(remove);
			actions.onclick = () => {
				menu.hidden = !menu.hidden;
				actions.setAttribute("aria-expanded", String(!menu.hidden));
				if (!menu.hidden) remove.focus();
			};
			shell.append(actions, menu);
		}
		grid.appendChild(shell);
	}
	const create = document.createElement("button");
	create.className = "hub-card create company-card company-add-card";
	create.type = "button";
	create.innerHTML = '<span class="plus" aria-hidden="true">+</span><strong>New company</strong>';
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
// The founder names the company and chooses where its profile lives. Account
// entitlement and per-session execution remain separate decisions.

function companySlug(name) {
	return String(name)
		.toLowerCase()
		.replace(/['’]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

const COMPANIES_HOME = "C:\\Companies";
function companyRootFor(name) {
	const slug = companySlug(name);
	return slug ? `${COMPANIES_HOME}\\${slug}` : "";
}

function renderCompanyPlacementPicker() {
	const picker = $("companyPlacementPicker");
	for (const choice of picker.querySelectorAll("[data-profile-placement]")) {
		const selected = choice.dataset.profilePlacement === profileCreatorPlacement;
		choice.classList.toggle("selected", selected);
		choice.setAttribute("aria-pressed", String(selected));
		choice.onclick = () => {
			profileCreatorPlacement = choice.dataset.profilePlacement;
			renderCompanyPlacementPicker();
			$("companyPlacementNote").textContent = PROFILE_PLACEMENTS[profileCreatorPlacement].description;
		};
	}
}

function makeCompanyIcon(iconId, label, className = "") {
	const shell = document.createElement("span");
	shell.className = `company-icon ${className}`.trim();
	if (typeof iconId === "string" && iconId.startsWith("data:image/")) {
		const image = document.createElement("img");
		image.src = iconId;
		image.alt = "";
		image.setAttribute("aria-hidden", "true");
		shell.appendChild(image);
	} else {
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.setAttribute("viewBox", "0 0 24 24");
		svg.setAttribute("fill", "none");
		svg.setAttribute("stroke", "currentColor");
		svg.setAttribute("stroke-width", "1.7");
		svg.setAttribute("aria-hidden", "true");
		const head = document.createElementNS("http://www.w3.org/2000/svg", "circle");
		head.setAttribute("cx", "12");
		head.setAttribute("cy", "8");
		head.setAttribute("r", "3.25");
		const shoulders = document.createElementNS("http://www.w3.org/2000/svg", "path");
		shoulders.setAttribute("d", "M5.5 19c.8-3.2 3-5 6.5-5s5.7 1.8 6.5 5");
		svg.append(head, shoulders);
		shell.appendChild(svg);
	}
	if (label) shell.setAttribute("aria-label", `${label} company`);
	return shell;
}

function renderCompanyPicturePreview() {
	const preview = makeCompanyIcon(companyCreatorIcon, "", "company-icon-preview");
	preview.id = "companyIconPreview";
	$("companyIconPreview").replaceWith(preview);
	$("companyPictureAnonymous").hidden = !companyCreatorIcon.startsWith("data:image/");
}

async function prepareCompanyPicture(file) {
	if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
		throw new Error("Choose a PNG, JPEG, or WebP image.");
	}
	if (file.size <= 0 || file.size > 10 * 1024 * 1024) throw new Error("Choose an image smaller than 10 MB.");
	const source = URL.createObjectURL(file);
	try {
		const image = new Image();
		image.src = source;
		await image.decode();
		if (!image.naturalWidth || !image.naturalHeight) throw new Error("The selected image could not be read.");
		const canvas = document.createElement("canvas");
		canvas.width = 512;
		canvas.height = 512;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("The selected image could not be prepared.");
		const side = Math.min(image.naturalWidth, image.naturalHeight);
		const sourceX = (image.naturalWidth - side) / 2;
		const sourceY = (image.naturalHeight - side) / 2;
		context.imageSmoothingEnabled = true;
		context.imageSmoothingQuality = "high";
		context.drawImage(image, sourceX, sourceY, side, side, 0, 0, canvas.width, canvas.height);
		const picture = canvas.toDataURL("image/webp", 0.86);
		if (!picture.startsWith("data:image/webp;base64,") || picture.length > 1_400_000) {
			throw new Error("The selected image is too detailed. Choose a smaller image.");
		}
		return picture;
	} finally {
		URL.revokeObjectURL(source);
	}
}

function chooseCompanyPicture(onPicture, errorTarget) {
	const input = $("companyPictureFile");
	input.value = "";
	input.onchange = async () => {
		const file = input.files?.[0];
		if (!file) return;
		try {
			if (errorTarget) errorTarget.textContent = "";
			await onPicture(await prepareCompanyPicture(file));
		} catch (error) {
			const message = error instanceof Error ? error.message : "The selected image could not be prepared.";
			if (errorTarget) errorTarget.textContent = message;
			else showToast(message);
		}
	};
	input.click();
}

async function saveCurrentCompanyIcon(companyIconId) {
	const result = await window.qorpera.setCompanyIcon(companyIconId);
	if (!result?.ok) {
		showToast(result?.error ?? "The company picture could not be saved.");
		return false;
	}
	currentCompanyIcon = result.companyIcon;
	renderCompanySwitcher();
	return true;
}

function openCompanyModal() {
	companyCreatorIcon = "anonymous";
	profileCreatorPlacement = "local";
	$("companyName").value = "";
	$("companyFormError").textContent = "";
	$("companyCreate").disabled = true;
	renderCompanyPicturePreview();
	renderCompanyPlacementPicker();
	$("companyPlacementNote").textContent = PROFILE_PLACEMENTS[profileCreatorPlacement].description;
	$("companyModal").hidden = false;
	$("companyName").focus();
}

function closeCompanyModal() {
	$("companyModal").hidden = true;
}

function setupCompanyModal() {
	const input = $("companyName");
	$("companyPictureUpload").onclick = () =>
		chooseCompanyPicture(async (picture) => {
			companyCreatorIcon = picture;
			renderCompanyPicturePreview();
		}, $("companyFormError"));
	$("companyPictureAnonymous").onclick = () => {
		companyCreatorIcon = "anonymous";
		renderCompanyPicturePreview();
	};
	input.addEventListener("input", () => {
		$("companyCreate").disabled = !companySlug(input.value.trim());
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
		const profileName = input.value.trim();
		if (!companySlug(profileName)) return;
		const button = $("companyCreate");
		$("companyFormError").textContent = "";
		button.disabled = true;
		button.textContent = "Creating…";
		try {
			const root = companyRootFor(profileName);
			const created = await window.qorpera.newCompany(root, companyCreatorIcon, profileCreatorPlacement);
			if (!created) throw new Error("creation was rejected");
			if (created.cloudError) {
				// The company exists locally; keep the modal open so the founder
				// sees why hosting did not start (a reload would swallow it).
				await renderHub();
				$("companyFormError").textContent =
					`Company created locally, but hosting could not be enabled: ${created.cloudError} ` +
					"You can host it later from Settings.";
				return;
			}
			const opened = await openCompany(created.root, $("companyFormError"));
			if (opened) closeCompanyModal();
		} catch (error) {
			$("companyFormError").textContent = `Could not create the company: ${(error && error.message) || error}`;
		} finally {
			button.textContent = "Create company";
			button.disabled = false;
		}
	});
}

// ---- company ---------------------------------------------------------------

async function openCompany(root, errorTarget = $("hubError")) {
	// The desktop host opens the company runtime and reloads this fixed shell into
	// its isolated renderer partition. Returns false so a failed open can hand
	// control back to the hub.
	try {
		if (errorTarget) errorTarget.textContent = "";
		await window.qorpera.openCompany(root);
		return true;
	} catch (error) {
		if (errorTarget) errorTarget.textContent = `Could not open the company: ${(error && error.message) || error}`;
		return false;
	}
}

/** Boot into an already-open company after the desktop host loads us. */
async function enterCompany(active) {
	backendUrl = active.backendUrl;
	companyId = active.id || "";
	currentCompanyRoot = active.root || "";
	currentCompanyIcon = active.companyIcon || "anonymous";
	currentProfileAccess = active.access ?? currentProfileAccess;
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
	// The desktop host resumes the newest user session across restarts; adopt its
	// trail file so the chat pile marks it active and caching keys line up.
	currentSession = active.sessionFile ?? null;
	currentStaffId = null;
	currentRoomId = null;
	currentRoomMessages = [];
	if (active.kickoff) {
		addMsg("tool", "· setup started — the agent is learning its responsibility…");
	}
	renderUpdateButton();
	show("roster");
	// With history: the chat child survives window reloads (dev-lane rebuilds
	// reload the chrome), so the live thread must come back with it. A fresh
	// child answers with an empty history — harmless.
	await refreshState();
	const routedRoomId = roomIdFromRoute();
	const routedRoom = (state.rooms ?? []).find((room) => room.id === routedRoomId && room.status !== "archived");
	if (routedRoomId && !routedRoom) {
		localStorage.removeItem(navStorageKey("active-room"));
		if (location.hash.startsWith("#/room/")) history.replaceState(null, "", "#/");
	}
	if (routedRoom) await openRoom(routedRoom.id);
	if (!currentRoomId) {
		const resumed = (state.sessions ?? []).find((session) => session.file === currentSession);
		currentStaffId = activeStaffMembers().some((staff) => staffId(staff) === resumed?.staffAgentId)
			? resumed.staffAgentId
			: null;
		renderStaffHome();
		renderRosterRail();
		hydratedExecutorId = runtimeForTrail(currentSession)?.executorId ?? "";
	}
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
	if (currentRoomId) {
		// A room rides the autonomous lane, not an attached provider process —
		// the attended-runtime states (exited, reconnecting) never apply here.
		runtimeReconnecting = false;
		agentExited = false;
		agentWorking = roomActiveParticipants(currentRoomId).length > 0;
		$("status").textContent = agentWorking ? roomActivityLabel(currentRoomId) || "agents working…" : "ready";
		$("stopBtn").hidden = true;
		return;
	}
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
		$("status").textContent = "agent stopped";
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
	if (currentView === "panel" && navigationNode(currentNodeId)?.view?.id === "qorpera.activity") {
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
			showToast(
				currentStaffId
					? "Open a product artifact before creating an isolated worktree."
					: "New worktrees are available from a product conversation.",
			);
			return;
		}
		const department = (state.departments ?? []).find((entry) => entry.path === currentDepartment);
		if (!department) {
			showToast("The product workspace is not available.");
			return;
		}
		close();
		void openDepartmentChat(department, currentNodeId ?? "q:chats");
	};
	return { sync };
})();

// ---- company vs product-worker scope selector -------------------------------

function departmentName(path) {
	const parts = String(path).replace(/\\/g, "/").split("/").filter(Boolean);
	return (parts[parts.length - 1] || String(path)).replace(/-development$/, "");
}

// Company-level and product-worker sessions have different capabilities.
const COMPANY_ICON =
	'<svg class="chipicon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 21h18M5 21V5.5L12 3l7 2.5V21M9.5 9h.01M14.5 9h.01M9.5 13h.01M14.5 13h.01M10 21v-3.5h4V21"/></svg>';
const PRODUCT_ICON =
	'<svg class="chipicon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8.2v7.6l-9 4.7-9-4.7V8.2L12 3.5l9 4.7Z"/><path d="M3.3 8.2 12 12.7l8.7-4.5M12 12.7V20"/></svg>';

function syncScopeChrome() {
	const options = [
		{
			value: "",
			label: state.name || "Company",
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
	const staff = currentStaff();
	const room = currentRoom();
	$("input").placeholder = room
		? `Message ${roomTitle(room)}… Use @name to target specific agents.`
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
		currentRoomId = null;
		clearRoomRoute();
		currentDepartment = result.department ?? null;
		currentWorktree = result.worktree ?? null;
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
function renderCompanyRow() {
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

function staffCreatureId(staffOrTemplate) {
	const directCreature = staffOrTemplate?.appearance?.creature ?? staffOrTemplate?.creature;
	if (STAFF_CREATURE_CATALOG[directCreature]) return directCreature;
	const assignedTemplateId = staffTemplateId(staffOrTemplate);
	const catalogTemplateId = STAFF_CREATURE_BY_TEMPLATE[staffOrTemplate?.id] ? staffOrTemplate.id : "";
	const sourceId = assignedTemplateId || catalogTemplateId;
	if (sourceId && STAFF_CREATURE_BY_TEMPLATE[sourceId]) return STAFF_CREATURE_BY_TEMPLATE[sourceId];
	// No persisted character and no template: derive one stably from the staff
	// identity so both machines (and tomorrow's session) agree without writes.
	const identity = staffId(staffOrTemplate) || staffDisplayName(staffOrTemplate) || "";
	let seed = 0;
	for (const character of identity) seed = (seed * 31 + character.charCodeAt(0)) >>> 0;
	return STAFF_CREATURE_IDS[seed % STAFF_CREATURE_IDS.length];
}

function staffAvatarStyle() {
	// Characters are the identity system, not a skin: the old colored-shape
	// avatars are retired, and the pre-retirement localStorage flag is ignored.
	return "creatures";
}

function applyStaffAvatarStyle() {
	const style = staffAvatarStyle();
	document.documentElement.dataset.staffAvatarStyle = style;
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
	const runtimes = (state.runtime?.sessions ?? []).filter(
		(runtime) => (runtime.staffAgentId ?? runtime.agentId) === id,
	);
	if (id === currentStaffId) {
		const current = runtimes.find((runtime) => runtime.trailFile === currentSession);
		if (current) return current;
	}
	const live = runtimes.find((runtime) => runtime.live);
	if (live) return live;
	return runtimes.find((runtime) => !runtime.autonomous);
}

function staffNeedsAttention(staff, runtime) {
	if (runtime?.status === "interrupted") return true;
	if (staffId(staff) === currentStaffId && currentStaffIntroStatus === "failed") return true;
	if (
		!runtime?.live &&
		(state.scheduledJobs ?? []).some(
			(job) =>
				job.staffAgentId === staffId(staff) &&
				(Boolean(job.suspendedReason) || job.lastOutcome === "failed"),
		)
	)
		return true;
	return (state.connectionRequests ?? []).some(
		(request) =>
			request.staffAgentId === staffId(staff) &&
			!["connected", "denied", "cancelled"].includes(request.status),
	);
}

function staffStatus(staff) {
	const runtime = staffRuntime(staff);
	if (staffNeedsAttention(staff, runtime)) return "needs-attention";
	if (runtime?.status === "reconnecting") return "idle";
	if (staffId(staff) === currentStaffId && avatarActionPhase) return avatarActionPhase;
	if (runtime?.status === "running" && runtime.activity?.kind === "writing") return "writing";
	if (["starting", "running", "finishing"].includes(runtime?.status)) return "working";
	return staff?.status === "working" || staff?.status === "running" ? "working" : "idle";
}

const STAFF_MOTION_STATES = ["idle", "working", "writing", "needs-attention"];
const STAFF_LEGACY_MOTION_STATES = ["listening", "starting", "finishing", "reconnecting"];

function setAvatarMotionState(avatar, status) {
	const motion = STAFF_MOTION_STATES.includes(status) ? status : "idle";
	avatar.classList.remove(...STAFF_MOTION_STATES, ...STAFF_LEGACY_MOTION_STATES);
	avatar.classList.add(motion);
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
	avatar.className = `staff-avatar shape-${staffShape(staffOrTemplate)}`;
	setAvatarMotionState(avatar, status);
	avatar.style.setProperty("--staff-color", staffColor(staffOrTemplate));
	avatar.style.setProperty("--staff-motion-delay", staffMotionDelay(staffOrTemplate));
	if (staffId(staffOrTemplate)) avatar.dataset.staffId = staffId(staffOrTemplate);
	avatar.dataset.creature = staffCreatureId(staffOrTemplate);
	avatar.append(makeStaffCreature(staffOrTemplate), makeStaffFace());
	avatar.setAttribute("aria-hidden", "true");
	return avatar;
}

function staffMotionDelay(staffOrTemplate) {
	const identity = staffId(staffOrTemplate) || templateId(staffOrTemplate) || staffDisplayName(staffOrTemplate);
	let seed = 0;
	for (const character of identity) seed = (seed * 31 + character.charCodeAt(0)) % 9600;
	return `${-seed}ms`;
}

function makeStaffFace() {
	const figure = document.createElement("span");
	figure.className = "staff-face";
	figure.setAttribute("aria-hidden", "true");
	figure.append(document.createElement("i"), document.createElement("i"));
	return figure;
}

function makeStaffCreature(staffOrTemplate) {
	const creatureId = staffCreatureId(staffOrTemplate);
	const image = document.createElement("img");
	image.className = "staff-creature-image";
	image.src = STAFF_CREATURE_CATALOG[creatureId].asset;
	image.alt = "";
	image.decoding = "async";
	image.draggable = false;
	image.setAttribute("aria-hidden", "true");
	image.addEventListener("error", () => {
		image.hidden = true;
	}, { once: true });
	return image;
}

function paintStaffAvatar(avatar, staff, status = "idle") {
	avatar.replaceChildren(makeStaffCreature(staff), makeStaffFace());
	avatar.style.setProperty("--staff-color", staffColor(staff));
	avatar.style.setProperty("--staff-motion-delay", staffMotionDelay(staff));
	avatar.className = `staff-avatar shape-${staffShape(staff)}`;
	setAvatarMotionState(avatar, status);
	avatar.dataset.creature = staffCreatureId(staff);
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

function updateConversationOpenAction() {
	const selected = activeStaffMembers().filter((staff) => conversationRecipients.has(staffId(staff)));
	const button = $("conversationOpenButton");
	button.disabled = staffCreatorPending || selected.length === 0;
	button.textContent =
		selected.length > 1
			? `Create group (${selected.length})`
			: selected.length === 1
				? `Open ${staffDisplayName(selected[0])}`
				: "Open";
}

function renderConversationRecipientChips() {
	const container = $("conversationRecipientChips");
	container.replaceChildren();
	for (const staff of activeStaffMembers().filter((candidate) => conversationRecipients.has(staffId(candidate)))) {
		const chip = document.createElement("span");
		chip.className = "conversation-recipient-chip";
		chip.appendChild(makeStaffAvatar(staff));
		const label = document.createElement("span");
		label.textContent = staffDisplayName(staff);
		const remove = document.createElement("button");
		remove.type = "button";
		remove.setAttribute("aria-label", `Remove ${staffDisplayName(staff)}`);
		remove.textContent = "×";
		remove.onclick = () => {
			conversationRecipients.delete(staffId(staff));
			renderConversationRecipientChips();
			renderConversationRecipientMenu();
			updateConversationOpenAction();
		};
		chip.append(label, remove);
		container.appendChild(chip);
	}
}

/** Swap the picker for the existing configure view, pre-seeded from a
 * suggestion card (or blank for a from-scratch agent). */
function configureSuggestedAgent(template = null, proposedName = "") {
	$("conversationPickerView").hidden = true;
	$("staffConfigureView").hidden = false;
	$("conversationRecipientMenu").hidden = true;
	$("conversationRecipientSearch").setAttribute("aria-expanded", "false");
	staffCreatorSelection = template;
	staffCreatorColor = template ? staffColor(template) : "#1684ff";
	staffCreatorShape = template ? staffShape(template) : "round";
	staffCreatorCreature = template ? STAFF_CREATURE_BY_TEMPLATE[templateId(template)] ?? "pebble" : "pebble";
	$("staffDisplayName").value = proposedName || (template ? template.displayName ?? templateName(template) : "");
	$("staffCreatorRole").textContent = template ? templateName(template) : "New Agent";
	$("staffCreatorDescription").textContent = template
		? staffDescription(template)
		: "A blank persistent agent whose responsibility you define together.";
	paintStaffAvatar($("staffCreatorAvatar"), {
		...(template ?? {}),
		appearance: { color: staffCreatorColor, shape: staffCreatorShape, creature: staffCreatorCreature },
	});
	renderStaffAppearancePickers();
	$("staffCreateStatus").textContent = "";
	$("staffCreateButton").disabled = !$("staffDisplayName").value.trim();
	requestAnimationFrame(() => $("staffDisplayName").focus());
}

function renderConversationSuggestions() {
	const container = $("conversationSuggestionGrid");
	container.replaceChildren();
	const createCard = (template) => {
		const card = document.createElement("button");
		card.type = "button";
		card.className = "conversation-suggestion-card";
		if (template) card.appendChild(makeStaffAvatar(template));
		else {
			const mark = document.createElement("span");
			mark.className = "conversation-new-mark";
			mark.setAttribute("aria-hidden", "true");
			mark.textContent = "+";
			card.appendChild(mark);
		}
		const title = document.createElement("strong");
		title.textContent = template ? templateName(template) : "New";
		const description = document.createElement("p");
		description.textContent = template ? staffDescription(template) : "Create a blank agent and configure it yourself.";
		card.append(title, description);
		card.onclick = () => configureSuggestedAgent(template);
		container.appendChild(card);
	};
	createCard(null);
	for (const template of staffCatalogCache ?? DEFAULT_STAFF_TEMPLATES) createCard(template);
}

function renderConversationRecipientMenu() {
	const menu = $("conversationRecipientMenu");
	const query = $("conversationRecipientSearch").value.trim().toLowerCase();
	menu.replaceChildren();
	const create = document.createElement("button");
	create.type = "button";
	create.className = "conversation-recipient-option";
	const createMark = document.createElement("span");
	createMark.className = "conversation-new-mark";
	createMark.textContent = "+";
	const createCopy = document.createElement("span");
	const createTitle = document.createElement("strong");
	createTitle.textContent = query ? `Create “${$("conversationRecipientSearch").value.trim()}”` : "Create new agent";
	const createDetail = document.createElement("small");
	createDetail.textContent = "Configure a blank persistent agent";
	createCopy.append(createTitle, createDetail);
	create.append(createMark, createCopy);
	create.onclick = () => configureSuggestedAgent(null, $("conversationRecipientSearch").value.trim());
	menu.appendChild(create);
	for (const staff of activeStaffMembers().filter((candidate) => {
		const haystack = `${staffDisplayName(candidate)} ${staffRoleLabel(candidate)}`.toLowerCase();
		return !query || haystack.includes(query);
	})) {
		const id = staffId(staff);
		const option = document.createElement("button");
		option.type = "button";
		option.className = "conversation-recipient-option";
		option.setAttribute("role", "option");
		option.setAttribute("aria-selected", String(conversationRecipients.has(id)));
		option.appendChild(makeStaffAvatar(staff, staffStatus(staff)));
		const copy = document.createElement("span");
		const name = document.createElement("strong");
		name.textContent = staffDisplayName(staff);
		const role = document.createElement("small");
		role.textContent = staffRoleLabel(staff);
		copy.append(name, role);
		const stateLabel = document.createElement("small");
		stateLabel.textContent = conversationRecipients.has(id) ? "Added" : "Add";
		option.append(copy, stateLabel);
		option.onclick = () => {
			if (conversationRecipients.has(id)) conversationRecipients.delete(id);
			else conversationRecipients.add(id);
			renderConversationRecipientChips();
			renderConversationRecipientMenu();
			updateConversationOpenAction();
		};
		menu.appendChild(option);
	}
}

function showConversationPicker() {
	$("conversationPickerView").hidden = false;
	$("staffConfigureView").hidden = true;
	$("staffCreateStatus").textContent = "";
	renderConversationSuggestions();
	renderConversationRecipientChips();
	updateConversationOpenAction();
}

async function openStaffCreator() {
	staffCreatorPending = false;
	staffCreatorClosing = false;
	conversationRecipients = new Set();
	$("conversationRecipientSearch").value = "";
	$("conversationStatus").textContent = "";
	$("staffCreateStatus").textContent = "";
	$("staffModal").hidden = false;
	document.body.classList.add("staff-creator-open");
	$("threadHeader").hidden = true;
	$("staffCreatorTitlebar").hidden = false;
	if (!$("agentSidepanel").hidden) closeAgentSidepanel(false);
	renderRosterRail({ animateCreateRow: true });
	await loadStaffCatalog();
	showConversationPicker();
	requestAnimationFrame(() => $("conversationRecipientSearch").focus());
}

function renderStaffAppearancePickers() {
	const creaturePicker = $("staffCreaturePicker");
	creaturePicker.replaceChildren();
	for (const creature of STAFF_CREATURE_IDS) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "staff-creature-choice";
		button.setAttribute("role", "radio");
		button.setAttribute("aria-label", `Use ${STAFF_CREATURE_CATALOG[creature].label} character`);
		button.title = STAFF_CREATURE_CATALOG[creature].label;
		button.setAttribute("aria-checked", String(creature === staffCreatorCreature));
		button.appendChild(makeStaffCreature({ appearance: { creature } }));
		button.onclick = () => {
			staffCreatorCreature = creature;
			paintStaffAvatar($("staffCreatorAvatar"), {
				...(staffCreatorSelection ?? {}),
				appearance: { color: staffCreatorColor, shape: staffCreatorShape, creature: staffCreatorCreature },
			});
			renderStaffAppearancePickers();
		};
		creaturePicker.appendChild(button);
	}
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
			paintStaffAvatar($("staffCreatorAvatar"), {
				...(staffCreatorSelection ?? {}),
				appearance: { color: staffCreatorColor, shape: staffCreatorShape, creature: staffCreatorCreature },
			});
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
		button.setAttribute("aria-label", `Use ${shape.replace("-", " ")} simple agent`);
		button.setAttribute("aria-checked", String(shape === staffCreatorShape));
		button.appendChild(makeStaffFace());
		button.onclick = () => {
			staffCreatorShape = shape;
			paintStaffAvatar($("staffCreatorAvatar"), {
				...(staffCreatorSelection ?? {}),
				appearance: { color: staffCreatorColor, shape: staffCreatorShape, creature: staffCreatorCreature },
			});
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
		$("conversationRecipientMenu").hidden = true;
		$("conversationRecipientSearch").setAttribute("aria-expanded", "false");
		$("threadHeader").hidden = currentView !== "chat" && !(currentStaffId && currentView === "panel");
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
			appearance: { color: staffCreatorColor, shape: staffCreatorShape, creature: staffCreatorCreature },
		});
		if (result?.ok === false) throw new Error(result.error ?? "Staff member could not be created.");
		const created = result?.staff ?? result?.agent ?? result;
		const id = staffId(created) || result?.staffAgentId;
		const sessionFile = result?.sessionFile ?? created?.sessionFile ?? created?.primarySessionFile;
		if (!id || !sessionFile) throw new Error("The staff member was created without a conversation session.");
		if (created && typeof created === "object" && !(state.staff ?? []).some((staff) => staffId(staff) === id)) {
			state.staff = [...(state.staff ?? []), { ...created, id, sessionFile }];
		}
		staffCreatorPending = false;
		await refreshState();
		conversationRecipients.add(id);
		showConversationPicker();
		$("conversationStatus").textContent = `${staffDisplayName(created)} added. Select another agent to make this a group.`;
		// The introduction must start even when the founder never opens the 1:1
		// chat — e.g. when this agent flows straight into a group. The kernel
		// attached the fresh staff session during creation; kick the intro now.
		void (async () => {
			for (let attempt = 0; attempt < 12; attempt += 1) {
				const intro = await window.qorpera.staffIntroReady(id, sessionFile);
				if (intro?.ok !== false || intro.error !== "staff introduction target is not the attached ready session") {
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
		})();
	} catch (error) {
		staffCreatorPending = false;
		const message = error instanceof Error ? error.message : "Staff member could not be created.";
		$("staffCreateStatus").textContent = message;
		if ($("staffModal").hidden) showToast(message);
	} finally {
		$("staffCreateButton").textContent = "Create";
		$("staffCreateButton").disabled = staffCreatorPending || !$("staffDisplayName").value.trim();
		updateConversationOpenAction();
	}
}

/** The picker's single action: one recipient opens the direct staff chat,
 * several become a durable group room. */
async function openConversationRecipients() {
	if (staffCreatorPending) return;
	const ids = activeStaffMembers()
		.filter((staff) => conversationRecipients.has(staffId(staff)))
		.map(staffId);
	if (!ids.length) return;
	if (ids.length < conversationRecipients.size) {
		// A selected agent was archived since selection; never silently
		// downgrade a group to a 1:1 — resync the picker and let the founder
		// decide.
		conversationRecipients = new Set(ids);
		renderConversationRecipientChips();
		renderConversationRecipientMenu();
		updateConversationOpenAction();
		$("conversationStatus").textContent = "Some selected agents are no longer active; review the recipients.";
		return;
	}
	staffCreatorPending = true;
	updateConversationOpenAction();
	$("conversationStatus").textContent = ids.length > 1 ? "Creating group chat…" : "Opening conversation…";
	try {
		if (ids.length === 1) {
			staffCreatorPending = false;
			closeStaffCreator();
			await openStaff(ids[0]);
			return;
		}
		const result = await window.qorpera.roomCreate({ participantIds: ids });
		if (result?.ok === false || !result?.room?.id) throw new Error(result?.error ?? "Group chat could not be created.");
		rememberRoom(result.room);
		const roomId = result.room.id;
		staffCreatorPending = false;
		closeStaffCreator();
		await openRoom(roomId);
	} catch (error) {
		staffCreatorPending = false;
		$("conversationStatus").textContent = error instanceof Error ? error.message : "Conversation could not be opened.";
		updateConversationOpenAction();
	}
}

function setStaffRoute(id) {
	clearRoomRoute();
	const next = `#/staff/${encodeURIComponent(id)}`;
	if (location.hash !== next) history.replaceState(null, "", next);
}

function activateStaffSession(id, sessionFile, result = {}) {
	cacheCurrentSession();
	currentStaffId = id;
	currentRoomId = null;
	currentRoomMessages = [];
	setCurrentAvatarAction("");
	currentStaffIntroStatus = result?.introStatus ?? result?.staff?.introStatus ?? null;
	currentSession = sessionFile;
	currentDepartment = result?.department ?? null;
	currentWorktree = result?.worktree ?? null;
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
		showToast(result.error ?? "This staff member could not be opened.");
		return;
	}
	const staff = activeStaffMembers().find((candidate) => staffId(candidate) === id);
	const sessionFile = result?.sessionFile ?? result?.staff?.sessionFile ?? staff?.sessionFile ?? staff?.primarySessionFile;
	if (!sessionFile) {
		showToast("This staff member does not have a conversation session yet.");
		return;
	}
	activateStaffSession(id, sessionFile, result);
	if (result?.introStatus === "pending") {
		// Creation returns to the picker without attaching, so the introduction
		// starts on first open — once this session reports itself attached.
		void (async () => {
			let intro;
			for (let attempt = 0; attempt < 12; attempt += 1) {
				intro = await window.qorpera.staffIntroReady(id, sessionFile);
				if (intro?.ok !== false || intro.error !== "staff introduction target is not the attached ready session") break;
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
			if (intro?.ok === false) {
				showToast(intro.error ?? "The staff introduction did not finish.");
				return;
			}
			setTimeout(() => {
				if (currentStaffId === id && currentSession === sessionFile) sendRpc({ type: "get_messages" });
			}, 600);
		})();
	}
}

function currentRoom() {
	return (state.rooms ?? []).find((room) => room.id === currentRoomId && room.status !== "archived") ?? null;
}

function roomParticipants(room) {
	return (room?.participantIds ?? []).flatMap((id) => {
		const staff = activeStaffMembers().find((candidate) => staffId(candidate) === id);
		return staff ? [staff] : [];
	});
}

function roomTitle(room) {
	return room?.title || roomParticipants(room).map(staffDisplayName).join(", ") || "Group chat";
}

function roomActivityFor(roomId) {
	let activities = roomActivity.get(roomId);
	if (!activities) {
		activities = new Map();
		roomActivity.set(roomId, activities);
	}
	return activities;
}

function roomActiveParticipants(roomId) {
	return [...roomActivityFor(roomId).keys()];
}

/** Per-participant activity line, e.g. "Nova is working…" or "Nova is using bash…". */
function roomActivityLabel(roomId) {
	const activities = roomActivityFor(roomId);
	const active = activeStaffMembers().filter((staff) => activities.has(staffId(staff)));
	if (!active.length) return activities.size ? "agents working…" : "";
	if (active.length > 1) return `${active.length} agents are working…`;
	const activity = activities.get(staffId(active[0]));
	return `${staffDisplayName(active[0])} is ${activity === "working" ? "working" : `using ${activity}`}…`;
}

function makeRoomAvatar(room, status = "idle") {
	const avatar = document.createElement("span");
	avatar.className = "room-avatar";
	avatar.setAttribute("aria-hidden", "true");
	for (const staff of roomParticipants(room).slice(0, 3)) avatar.appendChild(makeStaffAvatar(staff, status));
	return avatar;
}

function setRoomRoute(id) {
	localStorage.setItem(navStorageKey("active-room"), id);
	const next = `#/room/${encodeURIComponent(id)}`;
	if (location.hash !== next) history.replaceState(null, "", next);
}

function clearRoomRoute() {
	localStorage.removeItem(navStorageKey("active-room"));
	if (location.hash.startsWith("#/room/")) history.replaceState(null, "", "#/");
}

function roomIdFromRoute() {
	const match = location.hash.match(/^#\/room\/([^/?#]+)$/);
	if (match) {
		try {
			return decodeURIComponent(match[1]);
		} catch {
			return "";
		}
	}
	// The stored room only resumes when no other destination owns the route.
	if (location.hash && location.hash !== "#" && location.hash !== "#/") return "";
	return localStorage.getItem(navStorageKey("active-room")) ?? "";
}

function renderRoomMessage(message) {
	if (!message || currentRoomMessages.some((known) => known.id === message.id)) return;
	currentRoomMessages.push(message);
	currentRoomMessages.sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
	const founder = message.speaker?.kind === "founder";
	const staff = founder
		? null
		: activeStaffMembers().find((candidate) => staffId(candidate) === message.speaker?.staffAgentId);
	const row = addMsg(founder ? "user" : "assistant", "");
	row.classList.add("room-message");
	row.dataset.roomMessageId = message.id;
	const body = document.createElement("div");
	body.className = "room-message-body";
	if (founder) {
		// The founder's bubble already sits alone on the right; no name needed.
		body.textContent = message.text ?? "";
		row.replaceChildren(body);
	} else {
		const speaker = document.createElement("strong");
		speaker.className = "room-speaker";
		speaker.textContent = staffDisplayName(staff);
		renderMarkdown(body, message.text ?? "");
		row.replaceChildren(speaker, body);
	}
	appendMsgImages(
		row,
		(message.images ?? []).map((image) => `data:${image.mimeType};base64,${image.data}`),
	);
}

function roomRecipientNames(ids) {
	const names = (ids ?? []).flatMap((id) => {
		const staff = activeStaffMembers().find((candidate) => staffId(candidate) === id);
		return staff ? [staffDisplayName(staff)] : [];
	});
	return names.join(", ") || "room participants";
}

/** Every send queues a durable delivery on the company's single autonomous
 * lane; the card narrates waiting, not failure. */
function renderRoomDelivery(delivery, status = "queued") {
	if (!delivery?.id || currentRoomId !== delivery.roomId) return;
	let card = roomDeliveryCards.get(delivery.id);
	if (!card) {
		if (status === "delivered") return;
		card = document.createElement("div");
		card.className = "room-delivery-card";
		card.dataset.deliveryId = delivery.id;
		const title = document.createElement("strong");
		title.className = "room-delivery-title";
		const detail = document.createElement("span");
		detail.className = "room-delivery-detail";
		card.append(title, detail);
		roomDeliveryCards.set(delivery.id, card);
		appendConversationEntry(card);
		$("messages").scrollTop = $("messages").scrollHeight;
	}
	const title = card.querySelector(".room-delivery-title");
	const detail = card.querySelector(".room-delivery-detail");
	if (status === "delivered") {
		title.textContent = "Delivered";
		detail.textContent = "The queued message reached its remaining recipients.";
		card.classList.add("delivered");
		setTimeout(() => {
			if (roomDeliveryCards.get(delivery.id) === card) roomDeliveryCards.delete(delivery.id);
			card.remove();
		}, 3200);
		return;
	}
	title.textContent = "Waiting to run";
	detail.textContent = `Queued for ${roomRecipientNames(delivery.targetStaffAgentIds)} — runs when the company is free${delivery.lastError ? " · retrying after a delivery error" : ""}`;
}

function renderRoomError(message) {
	const card = document.createElement("div");
	card.className = "room-error-card";
	card.textContent = message || "A group-chat operation failed.";
	appendConversationEntry(card);
	$("messages").scrollTop = $("messages").scrollHeight;
}

function renderRoomHistory(messages, deliveries) {
	currentRoomMessages = [];
	roomDeliveryCards.clear();
	$("messages").replaceChildren();
	for (const message of messages ?? []) renderRoomMessage(message);
	for (const delivery of deliveries ?? []) renderRoomDelivery(delivery);
}

async function openRoom(id) {
	if (!$("staffModal").hidden) closeStaffCreator();
	if (currentRoomId === id && currentView === "chat") return;
	const navigation = ++navigationGeneration;
	cacheCurrentSession();
	const result = await window.qorpera.roomOpen(id).catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
	if (navigation !== navigationGeneration) return;
	if (result?.ok !== true) {
		localStorage.removeItem(navStorageKey("active-room"));
		showToast(result?.error ?? "This group chat could not be opened.");
		return;
	}
	if (result?.room) rememberRoom(result.room);
	if (!$("agentSidepanel").hidden) closeAgentSidepanel(false);
	currentRoomId = id;
	currentStaffId = null;
	currentStaffIntroStatus = null;
	currentSession = null;
	currentDepartment = null;
	currentWorktree = null;
	currentNodeId = null;
	setRoomRoute(id);
	resetWorkGroup();
	show("chat");
	roomActivity.delete(id);
	if (result.activity?.staffAgentId) {
		roomActivityFor(id).set(result.activity.staffAgentId, result.activity.activity ?? "working");
	}
	renderRoomHistory(result.messages ?? [], result.deliveries ?? []);
	renderThreadHeader();
	syncConnectionRequestCards();
	renderRosterRail();
	syncScopeChrome();
	applyCurrentSessionRuntime();
}

function rememberRoom(room) {
	if (!room?.id) return;
	recentRoomWrites.set(room.id, Date.now());
	const index = (state.rooms ?? []).findIndex((candidate) => candidate.id === room.id);
	if (index >= 0) state.rooms[index] = room;
	else state.rooms = [room, ...(state.rooms ?? [])];
}

function leaveRoomView() {
	currentRoomId = null;
	currentRoomMessages = [];
	roomDeliveryCards.clear();
	clearRoomRoute();
	$("messages").replaceChildren();
	show("roster");
}

function selectedRoomParticipantIds() {
	return [...$("roomParticipantList").querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
}

function syncRoomSettingsActions() {
	const count = selectedRoomParticipantIds().length;
	$("roomSettingsSave").disabled = roomSettingsPending || count < 2;
	$("roomArchiveButton").disabled = roomSettingsPending;
	if (!roomSettingsPending) {
		$("roomSettingsStatus").textContent = count < 2 ? "Choose at least two active participants." : "";
	}
}

function renderRoomParticipantSettings(room) {
	const list = $("roomParticipantList");
	list.replaceChildren();
	for (const staff of activeStaffMembers()) {
		const id = staffId(staff);
		const row = document.createElement("label");
		row.className = "room-participant-option";
		const input = document.createElement("input");
		input.type = "checkbox";
		input.value = id;
		input.checked = room.participantIds.includes(id);
		input.onchange = syncRoomSettingsActions;
		row.append(input, makeStaffAvatar(staff, staffStatus(staff)));
		const copy = document.createElement("span");
		const name = document.createElement("strong");
		name.textContent = staffDisplayName(staff);
		const role = document.createElement("small");
		role.textContent = staffRoleLabel(staff);
		copy.append(name, role);
		row.appendChild(copy);
		list.appendChild(row);
	}
}

function openRoomSettings(trigger = document.activeElement) {
	const room = currentRoom();
	if (!room || roomSettingsPending) return;
	roomSettingsTrigger = trigger;
	$("roomTitleInput").value = room.title ?? "";
	$("roomSettingsStatus").textContent = "";
	renderRoomParticipantSettings(room);
	$("roomSettingsModal").hidden = false;
	$("staffIdentityButton").setAttribute("aria-expanded", "true");
	syncRoomSettingsActions();
	requestAnimationFrame(() => $("roomTitleInput").focus());
}

function closeRoomSettings(restoreFocus = true) {
	if (roomSettingsPending) return;
	$("roomSettingsModal").hidden = true;
	$("staffIdentityButton").setAttribute("aria-expanded", "false");
	if (restoreFocus) roomSettingsTrigger?.focus();
	roomSettingsTrigger = null;
}

async function saveRoomSettings() {
	const room = currentRoom();
	if (!room || roomSettingsPending) return;
	const participantIds = selectedRoomParticipantIds();
	if (participantIds.length < 2) {
		syncRoomSettingsActions();
		return;
	}
	roomSettingsPending = true;
	$("roomSettingsStatus").textContent = "Saving…";
	syncRoomSettingsActions();
	try {
		const title = $("roomTitleInput").value.trim();
		const result = await window.qorpera.roomUpdate(room.id, {
			title: title || null,
			participantIds,
		});
		if (result?.ok === false || !result?.room) throw new Error(result?.error ?? "Room settings could not be saved.");
		rememberRoom(result.room);
		renderThreadHeader();
		renderRosterRail();
		syncScopeChrome();
		roomSettingsPending = false;
		closeRoomSettings();
	} catch (error) {
		$("roomSettingsStatus").textContent = error instanceof Error ? error.message : "Room settings could not be saved.";
		roomSettingsPending = false;
		syncRoomSettingsActions();
	}
}

async function archiveCurrentRoom() {
	const room = currentRoom();
	if (!room || roomSettingsPending) return;
	roomSettingsPending = true;
	$("roomSettingsStatus").textContent = "Archiving…";
	syncRoomSettingsActions();
	try {
		const result = await window.qorpera.roomArchive(room.id);
		if (result?.ok === false || !result?.room) throw new Error(result?.error ?? "The group chat could not be archived.");
		rememberRoom(result.room);
		roomSettingsPending = false;
		closeRoomSettings(false);
		leaveRoomView();
	} catch (error) {
		$("roomSettingsStatus").textContent = error instanceof Error ? error.message : "The group chat could not be archived.";
		roomSettingsPending = false;
		syncRoomSettingsActions();
	}
}

function closeArchivedRooms(restoreFocus = true) {
	$("archivedRoomsModal").hidden = true;
	if (restoreFocus) archivedRoomsTrigger?.focus();
	archivedRoomsTrigger = null;
}

function renderArchivedRooms() {
	const list = $("archivedRoomsList");
	list.replaceChildren();
	const rooms = (state.rooms ?? []).filter((room) => room.status === "archived");
	if (!rooms.length) {
		const empty = document.createElement("div");
		empty.className = "hidden-staff-empty";
		empty.textContent = "No archived group chats.";
		list.appendChild(empty);
		return;
	}
	for (const room of rooms) {
		const row = document.createElement("div");
		row.className = "hidden-staff-row archived-room-row";
		row.appendChild(makeRoomAvatar(room));
		const copy = document.createElement("span");
		const name = document.createElement("strong");
		name.textContent = roomTitle(room);
		const detail = document.createElement("small");
		detail.textContent = `${roomParticipants(room).length} active former participants`;
		copy.append(name, detail);
		const restore = document.createElement("button");
		restore.type = "button";
		restore.textContent = "Restore";
		restore.onclick = async () => {
			restore.disabled = true;
			restore.textContent = "Restoring…";
			const result = await window.qorpera
				.roomRestore(room.id)
				.catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
			if (result?.ok === false || !result?.room) {
				restore.disabled = false;
				restore.textContent = "Restore";
				showToast(result?.error ?? "The group chat could not be restored.");
				return;
			}
			rememberRoom(result.room);
			closeArchivedRooms(false);
			renderRosterRail();
			await openRoom(result.room.id);
		};
		row.append(copy, restore);
		list.appendChild(row);
	}
}

function openArchivedRooms(trigger) {
	archivedRoomsTrigger = trigger;
	renderArchivedRooms();
	$("archivedRoomsModal").hidden = false;
	requestAnimationFrame(() => $("archivedRoomsClose").focus());
}

function renderThreadHeader() {
	const staff = currentStaff();
	const room = currentRoom();
	const avatar = $("threadAvatar");
	if (room) {
		const composite = makeRoomAvatar(room, agentWorking ? "working" : "idle");
		avatar.className = composite.className;
		avatar.replaceChildren(...composite.childNodes);
		avatar.removeAttribute("style");
		delete avatar.dataset.staffId;
		$("threadTitle").textContent = roomTitle(room);
	} else if (staff) {
		paintStaffAvatar(avatar, staff, staffStatus(staff));
		$("threadTitle").textContent = staffDisplayName(staff);
	} else {
		paintStaffAvatar(avatar, { color: "#171716", shape: "soft-square" });
		$("threadTitle").textContent = state.name || "Qorpera";
	}
	$("staffIdentityButton").disabled = !staff && !room;
	$("staffIdentityButton").setAttribute("aria-label", room ? "Open group chat settings" : "Open agent settings");
	$("staffIdentityButton").setAttribute(
		"aria-expanded",
		String(room ? !$("roomSettingsModal").hidden : Boolean(staff && agentSidepanelMode === "settings")),
	);
	$("staffSidepanelButton").hidden = !staff || Boolean(room);
	$("staffSidepanelButton").setAttribute("aria-expanded", String(Boolean(staff && agentSidepanelMode === "computer")));
	renderStaffHeaderNavigation(room ? null : staff);
	$("modelCtlBtn").hidden = Boolean(room);
	composerMore.sync();
	syncConversationAccess();
}

function artifactNodeId(id) {
	return `artifact:${id}`;
}

function artifactByNodeId(id) {
	if (typeof id !== "string" || !id.startsWith("artifact:")) return null;
	const artifactId = id.slice("artifact:".length);
	return (state.artifacts ?? []).find((artifact) => artifact.id === artifactId) ?? null;
}

function staffArtifacts(id) {
	return (state.artifacts ?? []).filter((artifact) => artifact.stewardAgentId === id);
}

function showStaffConversation() {
	if (!currentStaffId || !currentSession) return;
	setStaffRoute(currentStaffId);
	show("chat");
	renderThreadHeader();
	syncConnectionRequestCards();
}

function renderStaffHeaderNavigation(staff) {
	const tabs = $("staffArtifactTabs");
	tabs.replaceChildren();
	if (!staff) return;
	const artifacts = staffArtifacts(staffId(staff));
	const artifactButton = (artifact) => {
		const nodeId = artifactNodeId(artifact.id);
		const active = currentNodeId === nodeId && currentView === "panel";
		const button = document.createElement("button");
		button.type = "button";
		button.className = "staff-artifact-tab";
		const label = document.createElement("span");
		label.textContent = artifact.title;
		button.appendChild(label);
		const unresolved = (artifact.dataNeeds ?? []).filter(
			(need) => need.status !== "available" && need.status !== "declined",
		).length;
		if (unresolved) {
			const badge = document.createElement("span");
			badge.className = "staff-artifact-tab-badge";
			badge.textContent = String(unresolved);
			badge.setAttribute("aria-label", `${unresolved} setup item${unresolved === 1 ? "" : "s"}`);
			button.appendChild(badge);
		}
		button.classList.toggle("active", active);
		button.setAttribute("aria-pressed", String(active));
		button.onclick = () => {
			if (active) showStaffConversation();
			else openStaffArtifact(artifact.id);
		};
		return button;
	};
	let direct = artifacts;
	if (artifacts.length > 3) {
		const active = artifacts.find((artifact) => currentNodeId === artifactNodeId(artifact.id));
		direct = [...artifacts.slice(0, 2), ...(active && !artifacts.slice(0, 2).includes(active) ? [active] : [artifacts[2]])];
	}
	for (const artifact of direct) tabs.appendChild(artifactButton(artifact));
	const overflow = artifacts.filter((artifact) => !direct.includes(artifact));
	if (overflow.length) {
		const more = document.createElement("details");
		more.className = "staff-artifact-tab-more";
		const summary = document.createElement("summary");
		summary.textContent = `+${overflow.length}`;
		summary.setAttribute("aria-label", `${overflow.length} more artifacts`);
		more.appendChild(summary);
		const menu = document.createElement("div");
		menu.className = "staff-artifact-tab-menu";
		for (const artifact of overflow) menu.appendChild(artifactButton(artifact));
		more.appendChild(menu);
		tabs.appendChild(more);
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

const SCHEDULED_JOB_EFFORT_OPTIONS = [
	["low", "Low"],
	["medium", "Medium"],
	["high", "High"],
	["xhigh", "Extra high"],
	["max", "Maximum"],
];

function scheduledJobEffortSelect(value, onChange) {
	const select = document.createElement("select");
	for (const [optionValue, label] of SCHEDULED_JOB_EFFORT_OPTIONS) {
		const option = document.createElement("option");
		option.value = optionValue;
		option.textContent = label;
		select.appendChild(option);
	}
	select.value = value ?? "high";
	select.onchange = () => onChange(select.value);
	return select;
}

const ROUTINE_PLACEMENT_OPTIONS = [
	["local", "This computer"],
	["requires-local", "Requires this computer"],
	["cloud", "Cloud (not yet available)"],
];

function scheduledJobPlacementSelect(value, onChange) {
	const select = document.createElement("select");
	for (const [optionValue, label] of ROUTINE_PLACEMENT_OPTIONS) {
		const option = document.createElement("option");
		option.value = optionValue;
		option.textContent = label;
		select.appendChild(option);
	}
	select.value = value ?? "local";
	select.onchange = () => onChange(select.value);
	return select;
}

function scheduledJobEffortLabel(value) {
	return SCHEDULED_JOB_EFFORT_OPTIONS.find(([optionValue]) => optionValue === value)?.[1] ?? "High";
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
	const effort = scheduledJobEffortSelect(editor.draft.effort, (value) => {
		editor.draft.effort = value;
		editor.dirty = true;
	});
	form.appendChild(
		agentRoutineField("Effort", effort, "High by default for scheduled work; change it when the routine needs less or deeper reasoning."),
	);
	const placement = scheduledJobPlacementSelect(editor.draft.placement, (value) => {
		editor.draft.placement = value;
		editor.dirty = true;
	});
	form.appendChild(
		agentRoutineField(
			"Runs on",
			placement,
			"Cloud placement is fail-closed: this computer never runs a cloud-placed routine, and it stays parked until hosted routine execution exists.",
		),
	);

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
			effort: editor.draft.effort,
			placement: editor.draft.placement,
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
		motion === "writing"
			? "Writing"
			: motion === "working"
				? "Working"
				: motion === "needs-attention"
					? "Needs your attention"
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
	// Per-agent model: each employee keeps their own durable model choice, and
	// "Company default" clears it back to the shared runtime preference.
	const modelRow = document.createElement("label");
	modelRow.className = "agent-settings-model";
	const modelTitle = document.createElement("span");
	modelTitle.textContent = "Model";
	const modelSelect = document.createElement("select");
	const modelCatalog = (() => {
		try {
			const cached = JSON.parse(localStorage.getItem("qorpera.modelCatalog") ?? "null");
			return Array.isArray(cached?.models) && cached.models.length ? curateModels(cached.models) : [];
		} catch {
			return [];
		}
	})();
	const staffModelValue = staff.model ? `${staff.model.provider}::${staff.model.modelId}` : "";
	const defaultOption = document.createElement("option");
	defaultOption.value = "";
	defaultOption.textContent = "Company default";
	modelSelect.appendChild(defaultOption);
	for (const model of modelCatalog) {
		const option = document.createElement("option");
		option.value = model.value;
		option.textContent = model.name ?? model.value;
		modelSelect.appendChild(option);
	}
	if (staffModelValue && !modelCatalog.some((model) => model.value === staffModelValue)) {
		const option = document.createElement("option");
		option.value = staffModelValue;
		option.textContent = staff.model.modelId;
		modelSelect.appendChild(option);
	}
	modelSelect.value = staffModelValue;
	modelRow.append(modelTitle, modelSelect);
	form.append(nameField.label, titleField.label, descriptionField.label, modelRow);
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
	modelSelect.onchange = async () => {
		if (saving) {
			modelSelect.value = staffModelValue;
			return;
		}
		const value = modelSelect.value;
		const separator = value.indexOf("::");
		const model = value ? { provider: value.slice(0, separator), modelId: value.slice(separator + 2) } : null;
		saving = true;
		modelSelect.disabled = true;
		saveStatus.textContent = "Saving…";
		try {
			const result = await window.qorpera.staffUpdate(staffId(staff), { model });
			if (result?.ok === false) throw new Error(result.error ?? "Agent model could not be saved.");
			const updated = result?.staff ?? { ...staff, model: model ?? undefined };
			state.staff = (state.staff ?? []).map((candidate) => (staffId(candidate) === staffId(staff) ? { ...candidate, ...updated, model: updated.model } : candidate));
			saveStatus.textContent = "Saved";
		} catch (error) {
			modelSelect.value = staffModelValue;
			saveStatus.textContent = error instanceof Error ? error.message : "Agent model could not be saved.";
		} finally {
			saving = false;
			modelSelect.disabled = false;
		}
	};
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
		showToast("The introduction could not be restarted yet. Try again when this staff member is ready.");
	}
}

function syncConversationAccess() {
	const input = $("input");
	const canWrite = canUseProfile("write");
	input.readOnly = !canWrite;
	if (!canWrite) input.placeholder = "Read-only profile — ask an owner or admin for contributor access";
	$("composerMoreButton").disabled = !canWrite;
	$("sendBtn").disabled = !canWrite;
	document.querySelector(".composer-shell")?.classList.toggle("read-only", !canWrite);
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
		create.onclick = () => $("conversationRecipientSearch").focus();
		container.appendChild(create);
		if (animateCreateRow && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			create.classList.add("is-entering");
			create.getBoundingClientRect();
			requestAnimationFrame(() => create.classList.remove("is-entering"));
		}
	}
	const activeRooms = (state.rooms ?? [])
		.filter((room) => room.status !== "archived")
		.sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
	for (const room of activeRooms) {
		const row = document.createElement("button");
		row.type = "button";
		row.className = "staff-nav-row room-nav-row";
		row.classList.toggle("active", $("staffModal").hidden && currentView === "chat" && currentRoomId === room.id);
		row.dataset.searchText = `${roomTitle(room)} group chat`.toLowerCase();
		const active = roomActiveParticipants(room.id).length > 0;
		row.appendChild(makeRoomAvatar(room, active ? "working" : "idle"));
		const copy = document.createElement("span");
		copy.className = "staff-nav-copy";
		const heading = document.createElement("span");
		heading.className = "staff-nav-heading";
		const name = document.createElement("strong");
		name.textContent = roomTitle(room);
		heading.appendChild(name);
		const role = document.createElement("small");
		role.textContent = roomActivityLabel(room.id) || `${roomParticipants(room).length} agents`;
		copy.append(heading, role);
		row.appendChild(copy);
		row.onclick = () => void openRoom(room.id);
		container.appendChild(row);
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
		row.classList.toggle(
			"active",
			$("staffModal").hidden && currentView === "chat" && !currentRoomId && currentStaffId === id,
		);
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
				.filter((session) => session.staffAgentId === id && !session.roomId && session.kind === "chat")
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
	const archivedStaff = (state.staff ?? []).filter((staff) => staff?.employmentStatus === "archived");
	if (hiddenStaff.length || archivedStaff.length) {
		const hiddenEntry = document.createElement("button");
		hiddenEntry.type = "button";
		hiddenEntry.className = "hidden-staff-entry";
		hiddenEntry.setAttribute("aria-haspopup", "dialog");
		const label = document.createElement("span");
		label.textContent = hiddenStaff.length && !archivedStaff.length ? "Hidden agents" : "Inactive agents";
		const count = document.createElement("span");
		count.className = "hidden-staff-count";
		count.textContent = String(hiddenStaff.length + archivedStaff.length);
		hiddenEntry.append(label, count);
		hiddenEntry.onclick = (event) => openHiddenStaffModal(event.currentTarget);
		container.appendChild(hiddenEntry);
	}
	const archivedRooms = (state.rooms ?? []).filter((room) => room.status === "archived");
	if (archivedRooms.length) {
		const archivedEntry = document.createElement("button");
		archivedEntry.type = "button";
		archivedEntry.className = "hidden-staff-entry archived-room-entry";
		archivedEntry.setAttribute("aria-haspopup", "dialog");
		const label = document.createElement("span");
		label.textContent = "Archived chats";
		const count = document.createElement("span");
		count.className = "hidden-staff-count";
		count.textContent = String(archivedRooms.length);
		archivedEntry.append(label, count);
		archivedEntry.onclick = (event) => openArchivedRooms(event.currentTarget);
		container.appendChild(archivedEntry);
	}
	if (!staffMembers.length && !hiddenStaff.length && !archivedStaff.length && !activeRooms.length) {
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

function archivedStaffMembers() {
	return (state.staff ?? []).filter((staff) => staff?.employmentStatus === "archived");
}

function renderHiddenStaffList() {
	const list = $("hiddenStaffList");
	list.replaceChildren();
	const hiddenStaff = hiddenStaffMembers();
	const archivedStaff = archivedStaffMembers();
	if (!hiddenStaff.length && !archivedStaff.length) {
		const empty = document.createElement("div");
		empty.className = "hidden-staff-empty";
		empty.textContent = "No inactive agents.";
		list.appendChild(empty);
		return;
	}
	for (const staff of archivedStaff) {
		const row = document.createElement("div");
		row.className = "hidden-staff-row";
		row.appendChild(makeStaffAvatar(staff, "idle"));
		const name = document.createElement("strong");
		name.textContent = staffDisplayName(staff);
		const restore = document.createElement("button");
		restore.type = "button";
		restore.textContent = "Restore";
		restore.setAttribute("aria-label", `Restore ${staffDisplayName(staff)}`);
		restore.onclick = async () => {
			restore.disabled = true;
			restore.textContent = "Restoring…";
			try {
				const result = await window.qorpera.staffRestore(staffId(staff));
				if (result?.ok === false) throw new Error(result.error ?? "The agent could not be restored.");
				await refreshState();
				if (hiddenStaffMembers().length || archivedStaffMembers().length) renderHiddenStaffList();
				else closeHiddenStaffModal();
			} catch (error) {
				showToast(error instanceof Error ? error.message : "The agent could not be restored.");
				restore.disabled = false;
				restore.textContent = "Restore";
			}
		};
		row.append(name, restore);
		list.appendChild(row);
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
	$("staffDeleteTitle").textContent = `Archive ${staffDisplayName(staffDeleteTarget)}?`;
	$("staffDeleteDescription").textContent =
		"Archive keeps the agent, its artifacts, and its trail in the company so it can be restored later. Permanent deletion removes the agent and its owned artifacts from the current company state; its trail and Git history remain reconstructable.";
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
	const permanentButton = $("staffDeletePermanent");
	button.disabled = true;
	permanentButton.disabled = true;
	button.textContent = "Archiving…";
	try {
		const result = await window.qorpera.staffArchive(id);
		if (result?.ok === false) throw new Error(result.error ?? "The agent could not be archived.");
		const hidden = storedStaffIds("staff-hidden");
		const pinned = storedStaffIds("staff-pinned");
		hidden.delete(id);
		pinned.delete(id);
		storeStaffIds("staff-hidden", hidden);
		storeStaffIds("staff-pinned", pinned);
		closeStaffDeleteConfirmation();
		await refreshState();
	} catch (error) {
		showToast(error instanceof Error ? error.message : "The agent could not be archived.");
	} finally {
		button.disabled = false;
		permanentButton.disabled = false;
		button.textContent = "Archive";
	}
}

async function permanentlyDeleteStaffMember() {
	if (!staffDeleteTarget) return;
	const id = staffId(staffDeleteTarget);
	const button = $("staffDeletePermanent");
	const archiveButton = $("staffDeleteConfirm");
	button.disabled = true;
	archiveButton.disabled = true;
	button.textContent = "Deleting…";
	try {
		const result = await window.qorpera.staffDelete(id);
		if (result?.ok === false) throw new Error(result.error ?? "The agent could not be permanently deleted.");
		const hidden = storedStaffIds("staff-hidden");
		const pinned = storedStaffIds("staff-pinned");
		hidden.delete(id);
		pinned.delete(id);
		storeStaffIds("staff-hidden", hidden);
		storeStaffIds("staff-pinned", pinned);
		closeStaffDeleteConfirmation();
		await refreshState();
	} catch (error) {
		showToast(error instanceof Error ? error.message : "The agent could not be permanently deleted.");
	} finally {
		button.disabled = false;
		archiveButton.disabled = false;
		button.textContent = "Delete permanently";
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
				appearance: {
					color: staffColor(template),
					shape: staffShape(template),
					creature: STAFF_CREATURE_BY_TEMPLATE[templateId(template)] ?? "pebble",
				},
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
		showToast(error instanceof Error ? error.message : "The team could not be created.");
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
		meta.textContent = runtime ? runtimeDoingLine(runtime) : staffRoleLabel(staff);
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
	const companySection = document.createElement("div");
	companySection.className = "company-switcher-profile-section";
	const companyTrigger = document.createElement("button");
	companyTrigger.type = "button";
	companyTrigger.className = "company-switcher-profile-trigger";
	companyTrigger.setAttribute("role", "menuitem");
	companyTrigger.setAttribute("aria-haspopup", "menu");
	companyTrigger.setAttribute("aria-expanded", "false");
	companyTrigger.appendChild(makeCompanyIcon(currentCompanyIcon, "", "company-switcher-menu-profile-icon"));
	const companyLabel = document.createElement("span");
	companyLabel.textContent = "Companies";
	const companyCaret = document.createElement("span");
	companyCaret.className = "company-switcher-profile-caret";
	companyCaret.setAttribute("aria-hidden", "true");
	companyCaret.textContent = "›";
	companyTrigger.append(companyLabel, companyCaret);
	const companyList = document.createElement("div");
	companyList.className = "company-switcher-profile-list";
	companyList.setAttribute("role", "menu");
	companyList.setAttribute("aria-label", "Companies");
	companyList.hidden = true;
	let companies = [];
	try {
		companies = await window.qorpera.listCompanies();
	} catch {
		// Keep the rest of the account menu available if company discovery fails.
	}
	const normalizeRoot = (root) => String(root ?? "").replace(/\//g, "\\").replace(/\\+$/g, "").toLowerCase();
	for (const company of companies) {
		const selected = normalizeRoot(company.root) === normalizeRoot(currentCompanyRoot);
		const option = document.createElement("button");
		option.type = "button";
		option.className = "company-switcher-profile-option";
		option.classList.toggle("selected", selected);
		option.setAttribute("role", "menuitemradio");
		option.setAttribute("aria-checked", String(selected));
		option.appendChild(makeCompanyIcon(company.companyIcon, "", "company-switcher-profile-option-icon"));
		const name = document.createElement("span");
		name.textContent = company.name;
		const check = document.createElement("span");
		check.className = "company-switcher-profile-check";
		check.setAttribute("aria-hidden", "true");
		check.textContent = "✓";
		option.append(name, check);
		option.onclick = async (event) => {
			event.stopPropagation();
			if (selected) {
				close();
				button.focus();
				return;
			}
			close();
			const opened = await openCompany(company.root, null);
			if (!opened) showToast(`Could not switch to ${company.name}.`);
		};
		companyList.appendChild(option);
	}
	if (!companies.length) {
		const unavailable = document.createElement("div");
		unavailable.className = "company-switcher-profile-empty";
		unavailable.textContent = "Companies unavailable";
		companyList.appendChild(unavailable);
	}
	companyTrigger.onclick = (event) => {
		event.stopPropagation();
		const opening = companyList.hidden;
		companyList.hidden = !opening;
		companyTrigger.setAttribute("aria-expanded", String(opening));
		companySection.classList.toggle("open", opening);
		if (opening) companyList.querySelector("button")?.focus();
	};
	companySection.append(companyTrigger, companyList);
	menu.append(
		companySection,
		item("Settings", "settings", () => openSettings("general")),
		item("Feedback", "feedback", async () => {
			const result = await window.qorpera.openFeedback();
			if (!result?.ok) showToast(result?.error ?? "Feedback could not be opened.");
		}),
		item(
			"Log out",
			"log-out",
			async () => {
				const result = await window.qorpera.accountSignOut();
				if (!result?.ok) showToast(result?.error ?? "Could not log out.");
			},
			"company-switcher-menu-logout",
		),
	);
	menu.hidden = false;
	button.setAttribute("aria-expanded", "true");
	menu.querySelector("button")?.focus();
}

function renderCompanySwitcher() {
	const name = state.name || "Company";
	$("companySwitcherName").textContent = name;
	$("companySwitcherMark").replaceChildren(makeCompanyIcon(currentCompanyIcon, ""));
}

function connectionRequestIdentity(request) {
	return {
		id: request.id,
		staffAgentId: request.staffAgentId,
		sessionFile: request.sessionFile,
	};
}

function applyConnectionRequestResult(request, result) {
	const index = state.connectionRequests.findIndex((candidate) => candidate.id === request.id);
	if (result?.request) {
		if (index >= 0) state.connectionRequests[index] = result.request;
		else state.connectionRequests.push(result.request);
	}
	if (currentView === "chat") syncConnectionRequestCards();
	const artifact = artifactByNodeId(currentNodeId);
	if (currentView === "panel" && artifact) renderStaffArtifact(artifact);
}

async function reviewConnectionRequest(request) {
	const result = await window.qorpera.beginConnectionRequest(connectionRequestIdentity(request));
	applyConnectionRequestResult(request, result);
	if (result?.ok === false) showToast(result.error ?? "The connection request could not be opened.");
	return result;
}

async function selectConnectionChoice(request, label, custom = "") {
	const result = await window.qorpera.selectConnectionRequest(connectionRequestIdentity(request), {
		label: custom || label,
		kind: custom ? "custom" : "suggestion",
	});
	applyConnectionRequestResult(request, result);
	if (result?.ok === false) showToast(result.error ?? "The connection choice could not be saved.");
	return result;
}

async function prepareSelectedConnection(request) {
	const result = await window.qorpera.prepareConnectionRequest(connectionRequestIdentity(request));
	applyConnectionRequestResult(request, result);
	if (result?.ok === false) showToast(result.error ?? "The connection setup could not be started.");
	return result;
}

function connectionRequestGroupKey(request) {
	if (request.artifactId && request.dataNeedId) return `artifact:${request.artifactId}:${request.dataNeedId}`;
	return `session:${request.sessionFile}:${request.purpose}`;
}

function connectionRequestGeneration(requests) {
	return requests.map((request) => request.id).sort().join(":");
}

function activeConnectionRequest(requests) {
	return [...requests].sort((left, right) => {
		const leftUpdated = Date.parse(left.updatedAt ?? left.createdAt ?? "");
		const rightUpdated = Date.parse(right.updatedAt ?? right.createdAt ?? "");
		const updatedDifference = (Number.isFinite(leftUpdated) ? leftUpdated : 0) -
			(Number.isFinite(rightUpdated) ? rightUpdated : 0);
		if (updatedDifference) return updatedDifference;
		const leftCreated = Date.parse(left.createdAt ?? "");
		const rightCreated = Date.parse(right.createdAt ?? "");
		const createdDifference = (Number.isFinite(leftCreated) ? leftCreated : 0) -
			(Number.isFinite(rightCreated) ? rightCreated : 0);
		return createdDifference || String(left.id).localeCompare(String(right.id));
	}).at(-1);
}

function connectionRequestContext(request) {
	const artifact = request.artifactId
		? (state.artifacts ?? []).find((candidate) => candidate.id === request.artifactId)
		: undefined;
	const need = artifact?.dataNeeds?.find((candidate) => candidate.id === request.dataNeedId);
	return { artifact, need };
}

function connectionPhaseLabel(phase) {
	return (
		{
			suggested: "Choose source",
			selected: "Selected",
			preparing: "Preparing",
			awaiting_setup: "Waiting for sign-in",
			awaiting_auth: "Browser open",
			verifying: "Verifying",
			connected: "Connected",
			syncing: "Syncing",
			ready: "Ready",
			failed: "Failed",
			denied: "Declined",
			cancelled: "Cancelled",
		}[phase] ?? "Choose source"
	);
}

function connectionGuidance(request) {
	if (!request) return "";
	return (
		{
			preparing: `Preparing ${request.displayName}…`,
			awaiting_setup: `${request.displayName} is ready at the first private sign-in step. Complete it in Qorpera Chrome, then return here.`,
			awaiting_auth: `${request.displayName} is open in your browser. Sign in and approve access.`,
			verifying: `Qorpera is checking that ${request.displayName} completed the connection.`,
			connected: `${request.displayName} is connected.`,
			syncing: `${request.displayName} is connected. The agent is checking the first data before marking it ready.`,
			ready: `${request.displayName} is ready.`,
		}[request.phase] ?? ""
	);
}

function genericConnectionChoiceLabel(request) {
	const identity = `${request.displayName ?? ""} ${request.recipeId ?? ""}`.toLowerCase();
	if (/sheet|excel|csv|file|drive|document/.test(identity)) return "Company files and spreadsheets";
	if (/bank|plaid/.test(identity)) return "Banking only for now";
	if (/xero|quickbooks|account|stripe|adyen|payment|ledger/.test(identity)) {
		return "Accounting, banking, and payments";
	}
	return request.displayName ?? "Suggested connection";
}

function connectionChoices(requests) {
	const first = activeConnectionRequest(requests);
	const proposedProviders = first.providerSuggestions ??
		activeConnectionRequest(requests.filter((request) => request.providerSuggestions?.length))?.providerSuggestions;
	if (proposedProviders?.length) {
		return proposedProviders.slice(0, 4).map((label) => ({ label, request: undefined }));
	}
	const { artifact, need } = connectionRequestContext(first);
	const installedConnectors = (state.connectors ?? []).filter(
		(connector) =>
			requests.some((request) => request.recipeId === `company:${connector.id}`),
	);
	const financeContext = /financ|cash|burn|runway|ledger|bank|payment|revenue|commitment/i.test(
		`${staffDisplayName(currentStaff())} ${artifact?.title ?? ""} ${need?.label ?? ""} ${first.purpose ?? ""}`,
	);
	const defaults = financeContext
		? [
				"Accounting, banking, and payments",
				"Company files and spreadsheets",
				"Banking only for now",
				"Choose services individually",
			]
		: [
				...(need?.connectorHints ?? []).map((hint) =>
					hint
						.split(/[-_ ]+/)
						.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
						.join(" "),
				),
				"Use company files for now",
				"Choose services individually",
			];
	const requestByLabel = new Map();
	const installedConnectorByRecipe = new Map(
		installedConnectors.map((connector) => [`company:${connector.id}`, connector]),
	);
	for (const request of requests) {
		const label = installedConnectorByRecipe.get(request.recipeId)?.displayName ?? genericConnectionChoiceLabel(request);
		const current = requestByLabel.get(label);
		if (!current || activeConnectionRequest([current, request]) === request) requestByLabel.set(label, request);
	}
	for (const connector of installedConnectors) {
		const matchingRequest = activeConnectionRequest(
			requests.filter((request) => request.recipeId === `company:${connector.id}`),
		);
		if (matchingRequest) requestByLabel.set(connector.displayName, matchingRequest);
	}
	const seenLabels = new Set();
	const labels = [...requestByLabel.keys(), ...installedConnectors.map((connector) => connector.displayName), ...defaults].filter(
		(label) => {
			const normalized = label?.trim().toLocaleLowerCase();
			if (!normalized || seenLabels.has(normalized)) return false;
			seenLabels.add(normalized);
			return true;
		},
	);
	return labels.slice(0, 4).map((label) => ({ label, request: requestByLabel.get(label) }));
}

async function sendConnectionChoiceToAgent(request, label, custom = "") {
	const selected = await selectConnectionChoice(request, label, custom);
	if (!selected?.ok) return false;
	const selectedRequest = selected.request ?? request;
	const { artifact, need } = connectionRequestContext(request);
	showStaffConversation();
	const input = $("input");
	input.value = custom || label;
	syncComposer();
	input.focus();
	const safe = (value) => String(value ?? "").replace(/[[\]]/g, ")");
	const artifactContext = artifact && need
		? ` for data need "${safe(need.label)}" in artifact "${safe(artifact.title)}" (artifactId "${safe(artifact.id)}", dataNeedId "${safe(need.id)}")`
		: "";
	const promptContext = `[Connection choice context: selected "${safe(custom || label)}"${artifactContext}. Use existing company files or installed connections first. If support is missing, build the smallest connector needed. Use the Qorpera-controlled Chrome profile to handle every public setup step yourself, dismiss cookie/privacy prompts without accepting optional tracking where possible, and hand it over only at the first unobstructed sign-in, identity, MFA, consent, or equivalent secure user-only boundary. Completion of that protected step authorizes the rest of the exact selected connector setup; continue without another approval. Store provider-generated secrets directly through use_computer store_secret and never ask the founder to copy them. Do not stop on a landing page or ask the founder to navigate it.]`;
	const sent = await sendPrompt(promptContext);
	if (sent) await prepareSelectedConnection(selectedRequest);
	return sent;
}

function renderConnectionChoiceForm(requests) {
	const first = activeConnectionRequest(requests);
	const groupKey = connectionRequestGroupKey(first);
	const preparedRequest = first.phase === "preparing" && first.recipeId ? first : undefined;
	const selectedRequest = !preparedRequest && first.selection && !["failed", "denied", "cancelled"].includes(first.phase)
		? first
		: undefined;
	const form = document.createElement("form");
	form.className = "connection-choice-form";
	form.dataset.connectionRequestGroup = groupKey;
	form.setAttribute("aria-label", "Choose a connection setup");

	const header = document.createElement("div");
	header.className = "connection-choice-header";
	const copy = document.createElement("div");
	const title = document.createElement("strong");
	const explanation = document.createElement("p");
	if (preparedRequest) title.textContent = "Ready to connect";
	else if (selectedRequest?.phase === "awaiting_setup") title.textContent = "Sign in to continue";
	else if (selectedRequest?.phase === "awaiting_auth") title.textContent = "Finish in your browser";
	else if (selectedRequest?.phase === "verifying") title.textContent = "Checking the connection";
	else if (selectedRequest?.phase === "connected") title.textContent = "Connection added";
	else if (selectedRequest?.phase === "syncing") title.textContent = "Checking the first data";
	else if (selectedRequest?.phase === "preparing") title.textContent = `Preparing ${selectedRequest.displayName}`;
	else title.textContent = "Where should I look first?";
	explanation.textContent = preparedRequest
		? `${preparedRequest.displayName} is ready. Continue to secure verification in your browser.`
		: selectedRequest?.guidance || connectionGuidance(selectedRequest) ||
		"You can change this later. Nothing connects before you choose; secure verification opens in your browser when needed.";
	copy.append(title, explanation);
	const close = document.createElement("button");
	close.type = "button";
	close.className = "connection-choice-close";
	close.textContent = "×";
	close.setAttribute("aria-label", "Dismiss connection choices");
	close.onclick = () => {
		dismissedConnectionRequestGroups.set(groupKey, connectionRequestGeneration(requests));
		form.remove();
	};
	header.append(copy, close);
	form.appendChild(header);

	const list = document.createElement("div");
	list.className = "connection-choice-list";
	const choices = preparedRequest
		? [{ label: preparedRequest.displayName, request: preparedRequest }]
		: selectedRequest
			? [{ label: selectedRequest.selection.label, request: selectedRequest }]
		: connectionChoices(requests);
	choices.forEach((choice, index) => {
		const action = document.createElement("button");
		action.type = "button";
		action.className = "connection-choice-row";
		const request = choice.request;
		const working = ["preparing", "awaiting_setup", "awaiting_auth", "verifying", "syncing"].includes(request?.phase) &&
			!(request?.phase === "preparing" && request.recipeId);
		action.classList.toggle("selected", Boolean(request?.selection));
		action.disabled = working;
		const shortcut = document.createElement("span");
		shortcut.className = "connection-choice-shortcut";
		shortcut.textContent = String.fromCharCode(65 + index);
		const label = document.createElement("span");
		label.textContent = choice.label;
		action.append(shortcut, label);
		if (working || request === preparedRequest) {
			const stateLabel = document.createElement("span");
			stateLabel.className = "connection-choice-state";
			stateLabel.textContent = request === preparedRequest ? "Connect" : `${connectionPhaseLabel(request.phase)}…`;
			action.appendChild(stateLabel);
		}
		action.onclick = async () => {
			for (const row of list.querySelectorAll(".connection-choice-row")) row.disabled = true;
			action.classList.add("selected");
			if (request?.recipeId) {
				const selected = request === preparedRequest
					? { ok: true, request }
					: await selectConnectionChoice(request, choice.label);
				const result = selected?.ok ? await reviewConnectionRequest(selected.request ?? request) : selected;
				if (result?.ok === false) {
					for (const row of list.querySelectorAll(".connection-choice-row")) row.disabled = false;
					action.classList.remove("selected");
				}
				return;
			}
			const sent = await sendConnectionChoiceToAgent(request ?? first, choice.label);
			if (!sent) {
				for (const row of list.querySelectorAll(".connection-choice-row")) row.disabled = false;
				action.classList.remove("selected");
			}
		};
		list.appendChild(action);
	});
	form.appendChild(list);

	if (!selectedRequest && !preparedRequest) {
		const custom = document.createElement("input");
		custom.className = "connection-choice-custom";
		custom.type = "text";
		custom.maxLength = 240;
		custom.placeholder = "Describe another setup";
		custom.setAttribute("aria-label", "Describe another connection setup");
		form.appendChild(custom);
		form.onsubmit = async (event) => {
			event.preventDefault();
			const value = custom.value.trim();
			if (!value) return;
			custom.disabled = true;
			if (!(await sendConnectionChoiceToAgent(first, "Custom setup", value))) custom.disabled = false;
		};
	}
	return form;
}

function connectionRequestFingerprint(requests) {
	return JSON.stringify(
		requests.map((request) => ({
			id: request.id,
			displayName: request.displayName,
			purpose: request.purpose,
			recipeId: request.recipeId,
			providerSuggestions: request.providerSuggestions,
			status: request.status,
			phase: request.phase,
			guidance: request.guidance,
			selection: request.selection,
			failure: request.failure,
			updatedAt: request.updatedAt,
		})),
	);
}

function insertConnectionRequestForm(messages, form, request) {
	const createdAt = Date.parse(request.createdAt ?? "");
	const laterMessage = Number.isFinite(createdAt)
		? [...messages.children].find((element) => {
				const timestamp = Number(element.dataset.messageTimestamp);
				return Number.isFinite(timestamp) && timestamp > createdAt;
			})
		: undefined;
	if (laterMessage) messages.insertBefore(form, laterMessage);
	else if (threadActivityEl?.isConnected) messages.insertBefore(form, threadActivityEl);
	else messages.appendChild(form);
}

function syncConnectionRequestCards() {
	const messages = $("messages");
	if (!messages) return;
	for (const card of messages.querySelectorAll(".connection-request-card")) card.remove();
	const existingForms = new Map(
		[...messages.querySelectorAll(".connection-choice-form[data-connection-request-group]")].map((form) => [
			form.dataset.connectionRequestGroup,
			form,
		]),
	);
	const requests = Array.isArray(state.connectionRequests) ? state.connectionRequests : [];
	const groups = new Map();
	for (const request of requests) {
		if (request.staffAgentId !== currentStaffId) continue;
		if (request.phase === "ready" || ["denied", "cancelled"].includes(request.status)) continue;
		const key = connectionRequestGroupKey(request);
		const group = groups.get(key) ?? [];
		group.push(request);
		groups.set(key, group);
	}
	const visibleGroups = new Set();
	for (const [key, group] of groups) {
		const existing = existingForms.get(key);
		const generation = connectionRequestGeneration(group);
		if (dismissedConnectionRequestGroups.get(key) === generation) {
			existing?.remove();
			continue;
		}
		dismissedConnectionRequestGroups.delete(key);
		visibleGroups.add(key);
		const fingerprint = connectionRequestFingerprint(group);
		if (!existing || existing.dataset.connectionRequestFingerprint !== fingerprint) {
			const form = renderConnectionChoiceForm(group);
			form.dataset.connectionRequestFingerprint = fingerprint;
			existing?.remove();
			insertConnectionRequestForm(messages, form, activeConnectionRequest(group));
		}
		const prepared = group.find(
			(request) => request.phase === "preparing" && request.selection && request.recipeId === "github",
		);
		if (prepared && !autoStartedConnectionRequestIds.has(prepared.id)) {
			autoStartedConnectionRequestIds.add(prepared.id);
			queueMicrotask(() => void reviewConnectionRequest(prepared));
		}
	}
	for (const [key, form] of existingForms) {
		if (!visibleGroups.has(key)) form.remove();
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
			if (
				currentRoomId &&
				!(state.rooms ?? []).some((room) => room.id === currentRoomId && room.status !== "archived") &&
				// A poll snapshot fetched before a just-created or just-restored
				// room's registry write must not bounce the founder out of it.
				Date.now() - (recentRoomWrites.get(currentRoomId) ?? 0) > 10_000
			) {
				roomSettingsPending = false;
				if (!$("roomSettingsModal").hidden) closeRoomSettings(false);
				leaveRoomView();
			}
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
			renderCompanyRow();
			if (currentView === "roster") renderStaffHome();
			if (currentView === "chat") syncConnectionRequestCards();
			if (!$("agentSidepanel").hidden && currentStaff()) {
				if (agentSidepanelMode === "settings") renderAgentSettingsPanel(currentStaff());
				else renderAgentComputerPanel(currentStaff());
			}
			const staffRoutinesOpen = currentNodeId === `staff-routines:${currentStaffId}`;
			const staffArtifactOpen = artifactByNodeId(currentNodeId);
			if (currentNodeId && !navigationNode(currentNodeId) && !staffRoutinesOpen && !staffArtifactOpen) {
				currentNodeId = null;
			}
			if (!currentNodeId && currentView !== "roster" && currentView !== "chat") {
				const routed = location.hash.match(/^#\/p\/(.+)$/)?.[1];
				let routedId;
				try {
					routedId = routed ? decodeURIComponent(routed) : undefined;
				} catch {
					routedId = undefined;
				}
				const target = navigationNode(routedId) ? routedId : undefined;
				if (target) void openNavigationNode(target);
				else show("roster");
			} else if (currentView === "panel" && staffRoutinesOpen) {
				void renderActivity(false, currentStaffId);
			} else if (currentView === "panel" && staffArtifactOpen) {
				if (!artifactEditor?.dirty || artifactEditor.id !== staffArtifactOpen.id) {
					renderStaffArtifact(staffArtifactOpen);
				}
			} else if (currentView === "panel") {
				// Refresh the open read model without disturbing a live chat. A
				// product Chat page is now inert until its explicit create action.
				void openNavigationNode(currentNodeId, false);
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
	for (const transient of snapshot.querySelectorAll(
		".agent-thread-activity, .connection-choice-form, .connection-request-card",
	)) transient.remove();
	sessionCache[currentSession] = snapshot.innerHTML;
}

async function openSession(file, pageId = "q:chats") {
	const navigation = ++navigationGeneration;
	const summary = (state.sessions ?? []).find((session) => session.file === file);
	if (summary?.staffAgentId && !activeStaffMembers().some((staff) => staffId(staff) === summary.staffAgentId)) {
		showToast("This archived staff conversation is available in the company trail but cannot be reopened.");
		return;
	}
	// Re-clicking the chat that is already live must only bring its view back —
	// the old path restarted the agent child, aborting any in-flight run
	// (navigate away, click back, and the streaming answer died mid-thought).
	if (file && file === currentSession && !agentExited) {
		currentStaffId = summary?.staffAgentId ?? null;
		currentRoomId = null;
		clearRoomRoute();
		currentNodeId = pageId;
		setNavigationRoute(pageId);
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
		currentRoomId = null;
		clearRoomRoute();
		currentDepartment = result.department ?? null;
		currentWorktree = result.worktree ?? null;
	}
	if (navigation !== navigationGeneration) return;
	if (!result?.ok) {
		// A dead click teaches the founder nothing — say why the chat
		// wouldn't open (legacy-migration refusals land here too).
		showToast(result?.error ? `could not open this chat: ${result.error}` : "could not open this chat");
		return;
	}
	currentNodeId = pageId;
	setNavigationRoute(pageId);
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
		currentRoomId = null;
		clearRoomRoute();
		currentDepartment = null;
		currentWorktree = null;
	}
	if (navigation !== navigationGeneration) return;
	if (!result?.ok) return;
	currentNodeId = "q:chats";
	setNavigationRoute("q:chats");
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
		currentRoomId = null;
		clearRoomRoute();
		currentDepartment = result.department ?? null;
		currentWorktree = result.worktree ?? null;
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
			// Context preambles are runtime plumbing, not something the
			// founder typed — show the message as they wrote it.
			const text = raw.replace(/^(?:\[(?:Sidechat|Connection choice) context:[^\]]*\]\s*)+/, "");
			const imageUrls = parts
				.filter((p) => p.type === "image" && p.data)
				.map((p) => `data:${p.mimeType};base64,${p.data}`);
			if (text || imageUrls.length) {
				appendMsgImages(decorateUserMsg(addMsg("user", text, message.timestamp), text), imageUrls);
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
				appendAssistantMessages(assistantTextPartsFromMessage(message), false, message.timestamp);
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

function navigationNode(id) {
	return (state.shellNavigation?.nodes ?? []).find((node) => node.id === id);
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
	return (state.shellNavigation?.sectionIds ?? [])
		.map(navigationNode)
		.filter((node) => node?.kind === "department");
}

function departmentForNavigationNode(id) {
	return navigationDepartments().find((department) =>
		department.items.some((childId) => {
			if (childId === id) return true;
			const child = navigationNode(childId);
			return child?.kind === "category" && child.items.includes(id);
		}),
	);
}

function nodeIsVisible(id) {
	return !hiddenNavigation.has(id) && !archivedNavigation.has(id);
}

function visibleCategoryPages(category) {
	return category.items.map(navigationNode).filter((node) => node?.kind === "page" && nodeIsVisible(node.id));
}

function hiddenItemsForDepartment(department) {
	const hidden = [];
	for (const childId of department.items) {
		const child = navigationNode(childId);
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
			const page = navigationNode(pageId);
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
	// Chats are trail sessions, not navigation nodes: pinnable, but height /
	// hide / archive act on navigation ids and stay out of their menu.
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
 * Enter/blur commits (empty restores the navigation label) or Escape cancels.
 * Presentation override only — the navigation document is never modified. */
function startDepartmentRename(department) {
	closeNavContext();
	const group = document.querySelector(`.navigation-department[data-department-id="${CSS.escape(department.id)}"]`);
	const label = group?.querySelector(".navigation-department-label");
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

function showToast(message) {
	clearTimeout(toastTimeout);
	$("appToast").textContent = message;
	$("appToast").hidden = false;
	toastTimeout = setTimeout(() => {
		$("appToast").hidden = true;
	}, 3400);
}

function currentInsideNode(node) {
	if (currentNodeId === node.id) return true;
	if (node.kind === "page") return false;
	return node.items.some((id) => {
		if (id === currentNodeId) return true;
		const child = navigationNode(id);
		return child?.kind === "category" && child.items.includes(currentNodeId);
	});
}

function firstAvailableNavigationTarget() {
	for (const department of navigationDepartments()) {
		if (focusedDepartmentId && department.id !== focusedDepartmentId) continue;
		if (!nodeIsVisible(department.id)) continue;
		for (const childId of department.items) {
			const child = navigationNode(childId);
			if (child && nodeIsVisible(child.id)) return child;
		}
	}
	return undefined;
}

function openNavigationFallback() {
	const fallback = firstAvailableNavigationTarget();
	if (fallback) void openNavigationNode(fallback.id);
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
	else if (currentView === "panel" && navigationNode(currentNodeId)?.kind === "category")
		renderCollection(navigationNode(currentNodeId));
	showToast(
		node.kind === "department"
			? `${node.label} hidden. Right-click the navigation panel to show it again.`
			: `${node.label} hidden. Use its department Show menu to restore it.`,
	);
}

function restoreHiddenNode(node) {
	hiddenNavigation.delete(node.id);
	storeNavigationSet("nav-hidden", hiddenNavigation);
	renderCompanyNavSafe();
	if (currentView === "panel" && navigationNode(currentNodeId)?.kind === "category")
		renderCollection(navigationNode(currentNodeId));
	showToast(`${node.label} shown in the panel.`);
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
		const target = department.items.map(navigationNode).find((node) => node && nodeIsVisible(node.id));
		if (target) void openNavigationNode(target.id);
		else openNavigationFallback();
		showToast(`${department.label} focused. Reset Panel restores the complete view.`);
	} else {
		showToast("Panel focus reset. Hidden items remain hidden.");
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
	else if (currentView === "panel" && navigationNode(currentNodeId)?.kind === "category")
		renderCollection(navigationNode(currentNodeId));
	showToast(`${target.label} archived for this preview. Durable archive remains unbound.`);
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
	if (event.target.closest(".navigation-department, .sidebar-create")) return;
	event.preventDefault();
	closeNavContext();
	navContextPoint = { x: event.clientX, y: event.clientY };
	renderPanelHiddenDepartments();
	$("panelContextMenu").hidden = false;
	placeFloatingMenu($("panelContextMenu"));
	$("panelHiddenDepartments").querySelector("button")?.focus();
}

// ---- department identity glyphs ---------------------------------------------
// The navigation schema carries no icon field, so the glyph derives from the
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
		const child = navigationNode(childId);
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
// the navigation document itself is never modified from the frontend.
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
// store under a reserved id no navigation document produces.
const CHAT_PILE_ID = "chat-pile";

// ---- pins: founder-chosen shortcuts at the top of the panel (T3 shape) -------
// Pin state is panel presentation like collapse/hidden — stored per machine,
// never in company documents. One ordered list carries every pin: `node:<id>`
// entries are navigation pages/categories (rendered in the Pinned section) or
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
	row.querySelector(".session-scope").textContent = session.worktree ?? "Company";
	row.querySelector(".session-time").textContent = relativeSessionTime(session.mtimeMs);
	row.title = session.title;
	row.onclick = () => openSession(session.file);
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
			const node = navigationNode(key.slice(5));
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
			row.onclick = () => void openNavigationNode(entry.node.id);
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
		group.className = "navigation-department";
		group.dataset.departmentId = department.id;
		const isMainDepartment = department.id === "q:main";
		if (isMainDepartment) group.classList.add("dept-main");
		const collapsed = !isMainDepartment && !focused && collapsedNavigation().has(department.id);
		group.classList.toggle("collapsed", collapsed);
		group.oncontextmenu = (event) => {
			if (!event.target.closest(".navigation-row, .hidden-items-control"))
				openNavContext(event, department, "department");
		};
		const title = document.createElement("div");
		title.className = "navigation-department-title";
		title.innerHTML = navGlyphSvg(departmentGlyphName(department), "dept-glyph");
		title.setAttribute("role", "button");
		title.setAttribute("aria-expanded", String(!collapsed));
		title.onclick = (event) => {
			if (event.target.closest(".hidden-items-control") || title.querySelector(".dept-rename-input")) return;
			toggleDepartmentCollapsed(department.id);
		};
		const titleLabel = document.createElement("span");
		titleLabel.className = "navigation-department-label";
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
				const node = navigationNode(hidden.id);
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
		items.className = "navigation-department-items";
		items.dataset.emptyLabel = department.items.length ? "No visible items" : "Empty department";
		if (isMainDepartment) {
			// Codex-app shape: the panel leads with starting a conversation.
			const newChat = document.createElement("button");
			newChat.type = "button";
			newChat.className = "navigation-row page new-chat-row";
			newChat.innerHTML = '<span class="navigation-row-label"></span>';
			newChat.querySelector(".navigation-row-label").innerHTML = `${navGlyphSvg("plus", "nav-row-glyph")}New chat`;
			newChat.title = "Start a new company chat";
			newChat.onclick = () => void newCompanyChat();
			items.appendChild(newChat);
		}
		for (const childId of department.items) {
			const child = navigationNode(childId);
			if (!child || (child.kind !== "page" && child.kind !== "category")) continue;
			if (!nodeIsVisible(child.id)) continue;
			// The chat archive lives in the pile below the departments now; the
			// nav row it used to occupy became "New chat" above.
			if (isMainDepartment && child.kind === "page" && child.view?.id === "qorpera.chats") continue;
			const row = document.createElement("button");
			const ownsCurrent = child.kind === "category" && child.items.includes(currentNodeId);
			row.className = `navigation-row ${child.kind}${focused ? " focus-row" : ""}`;
			row.innerHTML = focused
				? '<span class="navigation-row-copy"><span class="navigation-row-label"></span><small></small></span><span class="focus-arrow" aria-hidden="true">-&gt;</span>'
				: '<span class="navigation-row-label"></span>';
			row.querySelector(".navigation-row-label").textContent = child.label;
			// Main's free rows carry their own glyphs (Codex-app shape) since
			// the department header that would anchor them is not rendered.
			if (isMainDepartment && !focused) {
				row.querySelector(".navigation-row-label").insertAdjacentHTML(
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
						: "Built-in page";
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
			row.onclick = () => void openNavigationNode(child.id);
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
	$("resetPanelButton").disabled = focusedDepartmentId === null;
	$("resetPanelButton").title = focusedDepartmentId
		? "Exit department focus without changing hidden items"
		: "The panel is already in its default view";
	syncScopeChrome();
	filterRosterRail(railSearchQuery);
}

function setNavigationRoute(id) {
	const next = `#/p/${encodeURIComponent(id)}`;
	if (location.hash !== next) history.replaceState(null, "", next);
}

function renderCollection(node) {
	const panel = $("view-panel");
	panel.innerHTML =
		'<section class="collection-view"><header class="collection-view-head"><div><div class="eyebrow"></div><h1></h1><p></p></div></header><div class="collection-tools"><label class="collection-search"><input type="search" placeholder="Filter this category" aria-label="Filter pages"></label><span class="collection-count"></span></div><div class="collection-list"></div></section>';
	const department = departmentForNavigationNode(node.id);
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
				: node.items.map(navigationNode).filter((page) => page?.kind === "page" && nodeIsVisible(page.id));
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
			row.querySelector(".collection-meta span:last-child").textContent = "Built-in";
			row.onclick = () => void openNavigationNode(page.id);
			row.oncontextmenu = (event) => openNavContext(event, page, "collection");
			row.onkeydown = (event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					void openNavigationNode(page.id);
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
			? "Use the product name people expect to see in the company."
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
					showToast(result?.error ?? "Product department was not created.");
				return;
			}
			closeDepartmentModal();
			await refreshState();
			showToast(`${name} product-development department created.`);
		} catch (error) {
			showToast(error instanceof Error ? error.message : "Product department could not be created.");
		} finally {
			create.textContent = "Create department";
			updateDepartmentActions();
		}
		return;
	}
	const template = document.querySelector(`[data-template="${departmentWizard.template}"] strong`)?.textContent;
	const setup = departmentWizard.template === "blank" ? "from scratch" : `from the ${template} template`;
	closeDepartmentModal();
	showToast(
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
		card.className = "navigation-card chat-card";
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

async function openNavigationNode(id, updateRoute = true) {
	const navigation = updateRoute || currentNodeId !== id ? ++navigationGeneration : navigationGeneration;
	const node = navigationNode(id);
	if (!node) return;
	$("view-panel").classList.toggle("activity-panel", node.view?.id === "qorpera.activity");
	const pageChanged = currentNodeId !== id;
	// Remember the page being left so returning to it insta-loads.
	if (pageChanged) cacheCurrentPanelPage();
	currentNodeId = id;
	if (updateRoute) setNavigationRoute(id);
	if (pageChanged) {
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

function artifactStatusLabel(status) {
	return String(status ?? "setting-up")
		.split("-")
		.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
		.join(" ");
}

function appendArtifactMeta(container, label, value) {
	if (value === undefined || value === null || value === "") return;
	const item = document.createElement("span");
	const key = document.createElement("strong");
	key.textContent = `${label}: `;
	item.append(key, document.createTextNode(String(value)));
	container.appendChild(item);
}

function askStaffForArtifactData(artifact, need) {
	showStaffConversation();
	const input = $("input");
	const hints = need.connectorHints?.length ? ` Likely sources: ${need.connectorHints.join(", ")}.` : "";
	input.value = `Set up the missing data for \"${need.label}\" in the \"${artifact.title}\" artifact. ${need.purpose}.${hints} Use existing company data first, then request only the minimum connector you need. If a connector is required, link request_connection to artifactId \"${artifact.id}\" and dataNeedId \"${need.id}\".`;
	syncComposer();
	input.focus();
}

function artifactDefinitionDraft(artifact) {
	return {
		title: artifact.title,
		purpose: artifact.purpose,
		accountableDepartmentId: artifact.accountableDepartmentId ?? "",
		metrics: (artifact.metrics ?? []).map((metric) => ({
			id: metric.id,
			label: metric.label,
			description: metric.description,
			direction: metric.direction,
			unit: metric.unit ?? "",
			target: metric.target ?? "",
		})),
		dataNeeds: (artifact.dataNeeds ?? []).map((need) => ({
			id: need.id,
			label: need.label,
			purpose: need.purpose,
			connectorHints: [...(need.connectorHints ?? [])],
		})),
	};
}

function artifactEditField(labelText, control, className = "") {
	const label = document.createElement("label");
	label.className = `staff-artifact-edit-field${className ? ` ${className}` : ""}`;
	const caption = document.createElement("span");
	caption.textContent = labelText;
	label.append(caption, control);
	return label;
}

function artifactEditorInput(value, update, multiline = false) {
	const input = document.createElement(multiline ? "textarea" : "input");
	input.value = value ?? "";
	input.oninput = () => {
		update(input.value);
		artifactEditor.dirty = true;
	};
	return input;
}

function artifactDefinitionGroup(headingText, entries, renderEntry, addLabel, addEntry, artifact) {
	const group = document.createElement("section");
	group.className = "staff-artifact-edit-group";
	const heading = document.createElement("div");
	heading.className = "staff-artifact-edit-group-heading";
	const name = document.createElement("h3");
	name.textContent = headingText;
	const add = document.createElement("button");
	add.type = "button";
	add.textContent = addLabel;
	add.onclick = () => {
		entries.push(addEntry());
		artifactEditor.dirty = true;
		renderStaffArtifact(artifactByNodeId(currentNodeId) ?? artifact);
	};
	heading.append(name, add);
	group.appendChild(heading);
	entries.forEach((entry, index) => group.appendChild(renderEntry(entry, index)));
	return group;
}

function renderArtifactEditor(view, artifact) {
	const editor = artifactEditor;
	if (!editor || editor.id !== artifact.id) return;
	const form = document.createElement("form");
	form.className = "staff-artifact-editor";
	const title = document.createElement("h2");
	title.textContent = "Artifact definition";
	const explanation = document.createElement("p");
	explanation.textContent = "Edit what this agent owns and measures. Observed values, evidence, and connection state remain agent-maintained.";
	form.append(title, explanation);

	const overview = document.createElement("div");
	overview.className = "staff-artifact-edit-overview";
	overview.appendChild(
		artifactEditField("Name", artifactEditorInput(editor.draft.title, (value) => (editor.draft.title = value))),
	);
	overview.appendChild(
		artifactEditField(
			"Purpose",
			artifactEditorInput(editor.draft.purpose, (value) => (editor.draft.purpose = value), true),
			"wide",
		),
	);
	const department = document.createElement("select");
	const unassigned = document.createElement("option");
	unassigned.value = "";
	unassigned.textContent = "No department";
	department.appendChild(unassigned);
	for (const candidate of state.departments ?? []) {
		const option = document.createElement("option");
		option.value = candidate.id;
		option.textContent = candidate.name ?? candidate.label ?? candidate.id;
		department.appendChild(option);
	}
	department.value = editor.draft.accountableDepartmentId;
	department.onchange = () => {
		editor.draft.accountableDepartmentId = department.value;
		editor.dirty = true;
	};
	overview.appendChild(artifactEditField("Accountable department", department));
	form.appendChild(overview);

	form.appendChild(
		artifactDefinitionGroup(
			"Measures",
			editor.draft.metrics,
			(metric, index) => {
				const row = document.createElement("article");
				row.className = "staff-artifact-edit-row";
				const remove = document.createElement("button");
				remove.type = "button";
				remove.className = "staff-artifact-edit-remove";
				remove.textContent = "Remove";
				remove.onclick = () => {
					editor.draft.metrics.splice(index, 1);
					editor.dirty = true;
					renderStaffArtifact(artifactByNodeId(currentNodeId) ?? artifact);
				};
				const direction = document.createElement("select");
				for (const value of ["higher-is-better", "lower-is-better", "target", "observe"]) {
					const option = document.createElement("option");
					option.value = value;
					option.textContent = artifactStatusLabel(value);
					direction.appendChild(option);
				}
				direction.value = metric.direction;
				direction.onchange = () => {
					metric.direction = direction.value;
					editor.dirty = true;
				};
				row.append(
					artifactEditField("Measure", artifactEditorInput(metric.label, (value) => (metric.label = value))),
					artifactEditField("Direction", direction),
					artifactEditField("Target", artifactEditorInput(metric.target, (value) => (metric.target = value))),
					artifactEditField("Unit", artifactEditorInput(metric.unit, (value) => (metric.unit = value))),
					artifactEditField(
						"Definition",
						artifactEditorInput(metric.description, (value) => (metric.description = value), true),
						"wide",
					),
					remove,
				);
				return row;
			},
			"Add measure",
			() => ({
				id: `metric-${crypto.randomUUID()}`,
				label: "New measure",
				description: "Define what this measure represents.",
				direction: "observe",
				unit: "",
				target: "",
			}),
			artifact,
		),
	);

	form.appendChild(
		artifactDefinitionGroup(
			"Data needs",
			editor.draft.dataNeeds,
			(need, index) => {
				const row = document.createElement("article");
				row.className = "staff-artifact-edit-row";
				const remove = document.createElement("button");
				remove.type = "button";
				remove.className = "staff-artifact-edit-remove";
				remove.textContent = "Remove";
				remove.onclick = () => {
					editor.draft.dataNeeds.splice(index, 1);
					editor.dirty = true;
					renderStaffArtifact(artifactByNodeId(currentNodeId) ?? artifact);
				};
				row.append(
					artifactEditField("Data", artifactEditorInput(need.label, (value) => (need.label = value))),
					artifactEditField(
						"Connector hints",
						artifactEditorInput(need.connectorHints.join(", "), (value) => {
							need.connectorHints = value.split(",").map((hint) => hint.trim()).filter(Boolean);
						}),
					),
					artifactEditField(
						"Purpose",
						artifactEditorInput(need.purpose, (value) => (need.purpose = value), true),
						"wide",
					),
					remove,
				);
				return row;
			},
			"Add data need",
			() => ({
				id: `data-${crypto.randomUUID()}`,
				label: "New data need",
				purpose: "Explain why the agent needs this data.",
				connectorHints: [],
			}),
			artifact,
		),
	);

	if (editor.error) {
		const error = document.createElement("div");
		error.className = "staff-artifact-edit-error";
		error.textContent = editor.error;
		form.appendChild(error);
	}
	const actions = document.createElement("div");
	actions.className = "staff-artifact-edit-actions";
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.textContent = "Cancel";
	cancel.onclick = () => {
		artifactEditor = null;
		renderStaffArtifact(artifactByNodeId(currentNodeId) ?? artifact);
	};
	const save = document.createElement("button");
	save.type = "submit";
	save.className = "primary";
	save.textContent = editor.pending ? "Saving…" : "Save definition";
	save.disabled = editor.pending;
	actions.append(cancel, save);
	form.appendChild(actions);
	form.onsubmit = async (event) => {
		event.preventDefault();
		editor.pending = true;
		editor.error = "";
		renderStaffArtifact(artifactByNodeId(currentNodeId) ?? artifact);
		const response = await authorizedPost("/api/artifact/update", {
			id: artifact.id,
			update: {
				expectedUpdatedAt: editor.expectedUpdatedAt,
				title: editor.draft.title,
				purpose: editor.draft.purpose,
				accountableDepartmentId: editor.draft.accountableDepartmentId || null,
				metrics: editor.draft.metrics.map((metric) => ({
					...metric,
					unit: metric.unit || null,
					target: metric.target === "" ? null : metric.target,
				})),
				dataNeeds: editor.draft.dataNeeds,
			},
		});
		const result = await response.json().catch(() => ({}));
		if (!response.ok || !result.artifact) {
			editor.pending = false;
			editor.error = result.error ?? "Artifact definition could not be saved.";
			renderStaffArtifact(artifactByNodeId(currentNodeId) ?? artifact);
			return;
		}
		const index = state.artifacts.findIndex((candidate) => candidate.id === artifact.id);
		if (index >= 0) state.artifacts[index] = result.artifact;
		artifactEditor = null;
		renderStaffArtifact(result.artifact);
	};
	view.appendChild(form);
}

function connectionRequestForDataNeed(artifact, need) {
	const requests = state.connectionRequests ?? [];
	return (
		requests.find((request) => request.id === need.connectionRequestId) ??
		[...requests]
			.reverse()
			.find((request) => request.artifactId === artifact.id && request.dataNeedId === need.id)
	);
}

function artifactMetricValue(metric) {
	if (metric.value === undefined) return "—";
	const unit = metric.unit ?? "";
	const separator = unit && !/^[%°]/.test(unit) ? " " : "";
	return `${metric.value}${separator}${unit}`;
}

function artifactMetricObservations(metric) {
	return globalThis.QorperaArtifactDashboard.metricObservations(metric);
}

function artifactMetricChange(metric) {
	const delta = globalThis.QorperaArtifactDashboard.metricDelta(metric);
	if (!delta) return "—";
	const unit = metric.unit ?? "";
	const separator = unit && !/^[%°]/.test(unit) ? " " : "";
	return `${delta.value > 0 ? "+" : ""}${Number(delta.value.toFixed(2))}${separator}${unit}`;
}

function artifactMetricSource(metric) {
	return globalThis.QorperaArtifactDashboard.latestMetricSource(metric) ?? "—";
}

function artifactUpdatedLabel(value) {
	if (!value || !Number.isFinite(Date.parse(value))) return "—";
	return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(
		new Date(value),
	);
}

function drawArtifactTrend(canvas, metric, observations) {
	const context = canvas.getContext("2d");
	if (!context || observations.length < 2) return;
	const width = canvas.width;
	const height = canvas.height;
	const padding = { top: 18, right: 18, bottom: 32, left: 54 };
	const values = observations.map((observation) => observation.value);
	const rawMin = Math.min(...values);
	const rawMax = Math.max(...values);
	const spread = rawMax - rawMin || Math.max(Math.abs(rawMax) * 0.1, 1);
	const minimum = rawMin - spread * 0.15;
	const maximum = rawMax + spread * 0.15;
	const chartWidth = width - padding.left - padding.right;
	const chartHeight = height - padding.top - padding.bottom;
	const x = (index) => padding.left + (index / (observations.length - 1)) * chartWidth;
	const y = (value) => padding.top + ((maximum - value) / (maximum - minimum)) * chartHeight;

	context.clearRect(0, 0, width, height);
	context.font = '15px "Segoe UI Variable Text", "Segoe UI", sans-serif';
	context.fillStyle = "#686866";
	context.strokeStyle = "rgba(18, 18, 17, 0.09)";
	context.lineWidth = 1;
	for (let index = 0; index <= 4; index += 1) {
		const value = minimum + ((maximum - minimum) * (4 - index)) / 4;
		const lineY = padding.top + (chartHeight * index) / 4;
		context.beginPath();
		context.moveTo(padding.left, lineY);
		context.lineTo(width - padding.right, lineY);
		context.stroke();
		context.fillText(`${Number(value.toFixed(1))}${metric.unit ? ` ${metric.unit}` : ""}`, 4, lineY + 7);
	}

	context.strokeStyle = "#22a578";
	context.lineWidth = 3;
	context.lineJoin = "round";
	context.lineCap = "round";
	context.beginPath();
	observations.forEach((observation, index) => {
		if (index === 0) context.moveTo(x(index), y(observation.value));
		else context.lineTo(x(index), y(observation.value));
	});
	context.stroke();

	context.fillStyle = "#686866";
	const labelIndexes = [...new Set([0, Math.floor((observations.length - 1) / 2), observations.length - 1])];
	for (const index of labelIndexes) {
		const label = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
			new Date(observations[index].at),
		);
		const measured = context.measureText(label).width;
		context.fillText(label, Math.max(0, Math.min(width - measured, x(index) - measured / 2)), height - 8);
	}
}

function renderStaffArtifact(artifact) {
	if (!artifact || artifact.stewardAgentId !== currentStaffId) return;
	currentNodeId = artifactNodeId(artifact.id);
	$("view-panel").classList.remove("activity-panel");
	const panel = $("view-panel");
	panel.replaceChildren();
	const view = document.createElement("section");
	view.className = "staff-artifact";

	const header = document.createElement("header");
	header.className = "staff-artifact-header";
	const headingCopy = document.createElement("div");
	const heading = document.createElement("h1");
	heading.textContent = artifact.title;
	const purpose = document.createElement("p");
	purpose.textContent = artifact.purpose;
	headingCopy.append(heading, purpose);
	const health = document.createElement("div");
	health.className = "staff-artifact-health";
	const edit = document.createElement("button");
	edit.type = "button";
	edit.className = "staff-artifact-edit-button";
	edit.textContent = artifactEditor?.id === artifact.id ? "Close editor" : "Edit definition";
	edit.onclick = () => {
		if (artifactEditor?.id === artifact.id) artifactEditor = null;
		else {
			artifactEditor = {
				id: artifact.id,
				expectedUpdatedAt: artifact.updatedAt,
				draft: artifactDefinitionDraft(artifact),
				dirty: false,
				error: "",
				pending: false,
			};
		}
		renderStaffArtifact(artifactByNodeId(currentNodeId) ?? artifact);
	};
	health.appendChild(edit);
	header.append(headingCopy, health);
	view.appendChild(header);
	const department = artifact.accountableDepartmentId
		? (state.departments ?? []).find((candidate) => candidate.id === artifact.accountableDepartmentId)
		: undefined;
	const metadata = document.createElement("div");
	metadata.className = "staff-artifact-metadata";
	const artifactSummary = globalThis.QorperaArtifactDashboard.artifactSummary(artifact);
	const status = document.createElement("span");
	status.className = `staff-artifact-status status-${artifact.status}`;
	const statusDot = document.createElement("span");
	statusDot.className = "staff-artifact-status-dot";
	status.append(statusDot, document.createTextNode(artifactStatusLabel(artifact.status)));
	metadata.appendChild(status);
	appendArtifactMeta(
		metadata,
		"Coverage",
		`${artifactSummary.measuredMetricCount}/${artifactSummary.metricCount} measures`,
	);
	appendArtifactMeta(metadata, "Data through", artifactUpdatedLabel(artifactSummary.latestObservedAt));
	appendArtifactMeta(
		metadata,
		"Sources",
		artifactSummary.sourceCount ? String(artifactSummary.sourceCount) : "None yet",
	);
	appendArtifactMeta(
		metadata,
		"Issues",
		artifactSummary.staleMetricCount || artifactSummary.blockedMetricCount
			? [
					artifactSummary.staleMetricCount ? `${artifactSummary.staleMetricCount} stale` : "",
					artifactSummary.blockedMetricCount ? `${artifactSummary.blockedMetricCount} blocked` : "",
				].filter(Boolean).join(" · ")
			: undefined,
	);
	appendArtifactMeta(metadata, "Owner", staffDisplayName(currentStaff()));
	appendArtifactMeta(
		metadata,
		"Department",
		department?.name ?? department?.label ?? artifact.accountableDepartmentId,
	);
	appendArtifactMeta(metadata, "Confidence", Number.isFinite(artifact.score) ? `${artifact.score}/100` : undefined);
	view.appendChild(metadata);
	renderArtifactEditor(view, artifact);

	const trendMetrics = (artifact.metrics ?? []).filter((metric) => artifactMetricObservations(metric).length >= 2);
	if (trendMetrics.length) {
		const trendSection = document.createElement("section");
		trendSection.className = "staff-artifact-trends";
		const trendHeading = document.createElement("div");
		trendHeading.className = "staff-artifact-section-heading";
		const trendTitle = document.createElement("h2");
		trendTitle.textContent = "Trends";
		const trendRange = document.createElement("span");
		trendRange.textContent = `${trendMetrics.length} measured series`;
		trendHeading.append(trendTitle, trendRange);
		const trendGrid = document.createElement("div");
		trendGrid.className = "staff-artifact-trend-grid";
		const charts = [];
		for (const metric of trendMetrics) {
			const observations = artifactMetricObservations(metric);
			const trend = document.createElement("article");
			trend.className = "staff-artifact-trend";
			const metricHeading = document.createElement("div");
			metricHeading.className = "staff-artifact-trend-heading";
			const label = document.createElement("h3");
			label.textContent = metric.label;
			const current = document.createElement("strong");
			current.textContent = artifactMetricValue(metric);
			metricHeading.append(label, current);
			const canvas = document.createElement("canvas");
			canvas.className = "staff-artifact-trend-canvas";
			canvas.width = 720;
			canvas.height = 240;
			canvas.setAttribute("role", "img");
			canvas.setAttribute("aria-label", `${metric.label} over ${observations.length} observations`);
			const provenance = document.createElement("div");
			provenance.className = "staff-artifact-trend-provenance";
			const source = artifactMetricSource(metric);
			provenance.textContent = `${observations.length} observations · ${artifactUpdatedLabel(observations.at(-1).at)} · ${source}`;
			provenance.title = source;
			trend.append(metricHeading, canvas, provenance);
			trendGrid.appendChild(trend);
			charts.push({ canvas, metric, observations });
		}
		trendSection.append(trendHeading, trendGrid);
		view.appendChild(trendSection);
		requestAnimationFrame(() => {
			for (const chart of charts) drawArtifactTrend(chart.canvas, chart.metric, chart.observations);
		});
	}

	const metricSection = document.createElement("section");
	metricSection.className = "staff-artifact-measure-section";
	const metricHeading = document.createElement("div");
	metricHeading.className = "staff-artifact-section-heading";
	const metricTitle = document.createElement("h2");
	metricTitle.textContent = "Measures";
	const metricCount = document.createElement("span");
	metricCount.textContent = `${(artifact.metrics ?? []).length} tracked`;
	metricHeading.append(metricTitle, metricCount);
	metricSection.appendChild(metricHeading);
	const metrics = document.createElement("div");
	metrics.className = "staff-artifact-table-wrap";
	const table = document.createElement("table");
	table.className = "staff-artifact-metric-table";
	const tableHead = document.createElement("thead");
	const headingRow = document.createElement("tr");
	for (const label of ["Measure", "Current", "Change", "Target", "Status", "Source", "Updated"]) {
		const cell = document.createElement("th");
		cell.scope = "col";
		cell.textContent = label;
		headingRow.appendChild(cell);
	}
	tableHead.appendChild(headingRow);
	const tableBody = document.createElement("tbody");
	for (const metric of artifact.metrics ?? []) {
		const row = document.createElement("tr");
		row.className = `metric-${metric.status}`;
		const measure = document.createElement("th");
		measure.scope = "row";
		const measureLabel = document.createElement("strong");
		measureLabel.textContent = metric.label;
		const description = document.createElement("small");
		description.textContent = metric.description;
		measure.append(measureLabel, description);
		const current = document.createElement("td");
		current.className = "numeric";
		current.textContent = artifactMetricValue(metric);
		const change = document.createElement("td");
		change.className = "numeric";
		change.textContent = artifactMetricChange(metric);
		const delta = globalThis.QorperaArtifactDashboard.metricDelta(metric);
		if (delta) change.classList.add(`change-${delta.tone}`);
		const target = document.createElement("td");
		target.className = "numeric";
		target.textContent = metric.target === undefined ? "—" : String(metric.target);
		const metricStatus = document.createElement("td");
		const metricState = document.createElement("span");
		metricState.className = `staff-artifact-table-status status-${metric.status}`;
		const metricDot = document.createElement("span");
		metricDot.className = "staff-artifact-status-dot";
		metricState.append(metricDot, document.createTextNode(artifactStatusLabel(metric.status)));
		if (metric.statusReason) {
			metricState.title = `${metric.statusReason}${metric.statusChangedAt ? ` · ${artifactUpdatedLabel(metric.statusChangedAt)}` : ""}`;
		}
		metricStatus.appendChild(metricState);
		const source = document.createElement("td");
		source.textContent = artifactMetricSource(metric);
		source.title = source.textContent;
		const updated = document.createElement("td");
		updated.textContent = artifactUpdatedLabel(metric.observedAt);
		row.append(measure, current, change, target, metricStatus, source, updated);
		tableBody.appendChild(row);
	}
	if (!(artifact.metrics ?? []).length) {
		const row = document.createElement("tr");
		const empty = document.createElement("td");
		empty.colSpan = 7;
		empty.className = "staff-artifact-empty";
		empty.textContent = "This agent has not defined its measures yet.";
		row.appendChild(empty);
		tableBody.appendChild(row);
	}
	table.append(tableHead, tableBody);
	metrics.appendChild(table);
	metricSection.appendChild(metrics);
	view.appendChild(metricSection);

	const dataSection = document.createElement("section");
	dataSection.className = "staff-artifact-data-section";
	const dataHeading = document.createElement("div");
	dataHeading.className = "staff-artifact-section-heading";
	const dataTitle = document.createElement("h2");
	dataTitle.textContent = "Sources";
	const dataCount = document.createElement("span");
	const unresolvedCount = (artifact.dataNeeds ?? []).filter(
		(need) => need.status !== "available" && need.status !== "connected" && need.status !== "declined",
	).length;
	dataCount.textContent = unresolvedCount ? `${unresolvedCount} need setup` : "Current";
	dataHeading.append(dataTitle, dataCount);
	dataSection.appendChild(dataHeading);
	const needs = document.createElement("div");
	needs.className = "staff-artifact-needs";
	for (const need of artifact.dataNeeds ?? []) {
		const request = connectionRequestForDataNeed(artifact, need);
		const row = document.createElement("article");
		row.className = `staff-artifact-need need-${need.status}${request ? ` request-${request.phase ?? request.status}` : ""}`;
		const copy = document.createElement("div");
		copy.className = "staff-artifact-need-copy";
		const title = document.createElement("h3");
		title.textContent = need.label;
		const needPurpose = document.createElement("p");
		needPurpose.textContent = need.purpose;
		const source = document.createElement("small");
		source.textContent = need.sourceRefs?.length
			? `Sources: ${need.sourceRefs.join(", ")}`
			: `Likely: ${(need.connectorHints ?? []).join(", ") || "company files"}`;
		copy.append(title, needPurpose, source);
		const stateChip = document.createElement("span");
		stateChip.className = "staff-artifact-need-state";
		const needStatus = request ? connectionPhaseLabel(request.phase) : artifactStatusLabel(need.status);
		const needDot = document.createElement("span");
		needDot.className = "staff-artifact-status-dot";
		stateChip.append(needDot, document.createTextNode(needStatus));
		row.append(copy, stateChip);
		if (request?.phase === "suggested" || request?.phase === "failed") {
			const action = document.createElement("button");
			action.type = "button";
			action.textContent = "Choose source";
			action.onclick = () => {
				dismissedConnectionRequestGroups.delete(connectionRequestGroupKey(request));
				showStaffConversation();
			};
			row.appendChild(action);
		} else if (["selected", "preparing", "awaiting_auth", "verifying", "syncing"].includes(request?.phase)) {
			const action = document.createElement("button");
			action.type = "button";
			action.disabled = true;
			action.textContent = `${connectionPhaseLabel(request.phase)}…`;
			row.appendChild(action);
		} else if (
			need.status === "missing" ||
			need.status === "selected" ||
			["failed", "cancelled", "denied"].includes(request?.status)
		) {
			const action = document.createElement("button");
			action.type = "button";
			action.textContent = request ? "Review sources" : "Choose source";
			action.onclick = () => askStaffForArtifactData(artifact, need);
			row.appendChild(action);
		}
		needs.appendChild(row);
	}
	if (!(artifact.dataNeeds ?? []).length) {
		const empty = document.createElement("div");
		empty.className = "staff-artifact-empty";
		empty.textContent = "No external data needs are currently defined.";
		needs.appendChild(empty);
	}
	dataSection.appendChild(needs);
	view.appendChild(dataSection);

	const footer = document.createElement("footer");
	footer.className = "staff-artifact-footer";
	footer.textContent = `${artifact.relativePath} · Updated ${new Date(artifact.updatedAt).toLocaleString()}`;
	view.appendChild(footer);
	panel.appendChild(view);
	show("panel");
}

function openStaffArtifact(id) {
	const artifact = (state.artifacts ?? []).find((candidate) => candidate.id === id);
	if (!artifact || artifact.stewardAgentId !== currentStaffId) return;
	++navigationGeneration;
	cacheCurrentPanelPage();
	setStaffRoute(currentStaffId);
	renderStaffArtifact(artifact);
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
		currentRoomId = null;
		clearRoomRoute();
		currentDepartment = result.department ?? null;
		currentWorktree = result.worktree ?? null;
	}
	if (navigation !== navigationGeneration) return;
	if (!result?.ok) {
		$("status").textContent = result?.error ?? "could not start product worktree";
		return;
	}
	currentNodeId = pageId;
	setNavigationRoute(pageId);
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

function setupCompanyNavigation() {
	$("addDepartmentButton").onclick = openDepartmentModal;
	$("addStaffButton").onclick = () => void openStaffCreator();
	$("companySwitcherButton").onclick = () => void openCompanySwitcher();
	$("staffIdentityButton").onclick = () => {
		if (currentRoom()) openRoomSettings($("staffIdentityButton"));
		else openAgentSidepanel("settings");
	};
	$("staffSidepanelButton").onclick = () => openAgentSidepanel("computer");
	$("agentSidepanelBack").onclick = handleAgentSidepanelBack;
	$("agentSidepanelClose").onclick = () => closeAgentSidepanel();
	$("railSearch").oninput = () => {
		filterRosterRail($("railSearch").value);
		renderRosterRail();
	};
	$("staffClose").onclick = closeStaffCreator;
	$("staffCancel").onclick = showConversationPicker;
	$("staffConfigureBack").onclick = showConversationPicker;
	$("conversationOpenButton").onclick = () => void openConversationRecipients();
	$("conversationRecipientSearch").onfocus = () => {
		renderConversationRecipientMenu();
		$("conversationRecipientMenu").hidden = false;
		$("conversationRecipientSearch").setAttribute("aria-expanded", "true");
	};
	$("conversationRecipientSearch").oninput = () => {
		renderConversationRecipientMenu();
		$("conversationRecipientMenu").hidden = false;
		$("conversationRecipientSearch").setAttribute("aria-expanded", "true");
	};
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
		// Enter in the picker's recipient search targets the picker's action;
		// only the configure view submits a create.
		if (!$("conversationPickerView").hidden) {
			void openConversationRecipients();
			return;
		}
		void createStaffMember();
	};
	$("resetPanelButton").onclick = () => {
		focusedDepartmentId = null;
		renderCompanyNavSafe();
		$("navigation").scrollTop = 0;
		showToast("Panel reset. Manually hidden items remain hidden.");
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
			showToast("Conversation ID copied.");
		} catch {
			showToast("The conversation ID could not be copied.");
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
	$("staffDeletePermanent").onclick = () => void permanentlyDeleteStaffMember();
	$("staffDeleteConfirm").onclick = () => void deleteStaffMember();
	$("staffDeleteModal").onpointerdown = (event) => {
		if (event.target === $("staffDeleteModal")) closeStaffDeleteConfirmation();
	};
	$("hiddenStaffClose").onclick = () => closeHiddenStaffModal();
	$("hiddenStaffModal").onpointerdown = (event) => {
		if (event.target === $("hiddenStaffModal")) closeHiddenStaffModal();
	};
	$("roomSettingsClose").onclick = () => closeRoomSettings();
	$("roomSettingsCancel").onclick = () => closeRoomSettings();
	$("roomArchiveButton").onclick = () => void archiveCurrentRoom();
	$("roomSettingsForm").onsubmit = (event) => {
		event.preventDefault();
		void saveRoomSettings();
	};
	$("roomSettingsModal").onpointerdown = (event) => {
		if (event.target === $("roomSettingsModal")) closeRoomSettings();
	};
	$("archivedRoomsClose").onclick = () => closeArchivedRooms();
	$("archivedRoomsModal").onpointerdown = (event) => {
		if (event.target === $("archivedRoomsModal")) closeArchivedRooms();
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
		if (
			!$("conversationRecipientMenu").hidden &&
			!$("conversationRecipientMenu").contains(event.target) &&
			!$("conversationRecipientSearch").contains(event.target)
		) {
			$("conversationRecipientMenu").hidden = true;
			$("conversationRecipientSearch").setAttribute("aria-expanded", "false");
		}
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
		else if (!$("roomSettingsModal").hidden) closeRoomSettings();
		else if (!$("archivedRoomsModal").hidden) closeArchivedRooms();
		else if (!$("archiveModal").hidden) closeArchiveConfirmation();
		else if (!$("departmentModal").hidden) closeDepartmentModal();
		else if (!$("navContext").hidden) closeNavContext();
		else if (!$("panelContextMenu").hidden) closePanelContext();
		else if (!$("staffContextMenu").hidden) closeStaffContext(true);
		else if (!$("companySwitcherMenu").hidden) {
			$("companySwitcherMenu").hidden = true;
			$("companySwitcherButton").setAttribute("aria-expanded", "false");
			$("companySwitcherButton").focus();
		}
		else if (!$("agentSidepanel").hidden) closeAgentSidepanel();
	});
}

// ---- views -----------------------------------------------------------------

let currentView = null;

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
const pageCache = new Map(); // navigation node id -> #view-panel innerHTML

function cacheCurrentPanelPage() {
	if (currentView === "panel" && currentNodeId && !$("view-panel").querySelector(".page-skeleton")) {
		pageCache.set(currentNodeId, $("view-panel").innerHTML);
	}
}

function show(view) {
	currentView = view;
	const staffHeaderVisible = view === "chat" || Boolean(currentStaffId && view === "panel");
	const staffCreatorOpen = !$("staffModal").hidden;
	$("threadHeader").hidden = staffCreatorOpen || !staffHeaderVisible;
	$("staffCreatorTitlebar").hidden = !staffCreatorOpen;
	$("view-roster").style.display = view === "roster" ? "block" : "none";
	$("view-chat").style.display = view === "chat" ? "flex" : "none";
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

/** Autonomous sessions only; chats live in the navigation. */
/** The trail categorizes what it is a trail OF — user-led conversations are
 * different from autonomous work. Section
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
	if (job.placement === "cloud") return "Waiting for cloud execution";
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
		effort: job?.effort ?? "high",
		placement: job?.placement ?? "local",
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
	const effort = scheduledJobEffortSelect(scheduledJobPanel.draft.effort, (value) => {
		scheduledJobPanel.draft.effort = value;
		scheduledJobPanel.dirty = true;
	});
	form.appendChild(
		scheduledJobField("Effort", effort, "Scheduled work defaults to high. The selected model will use the nearest supported level."),
	);
	const placementSelect = scheduledJobPlacementSelect(scheduledJobPanel.draft.placement, (value) => {
		scheduledJobPanel.draft.placement = value;
		scheduledJobPanel.dirty = true;
	});
	form.appendChild(
		scheduledJobField(
			"Runs on",
			placementSelect,
			"Cloud placement is fail-closed until hosted routine execution exists; this computer never runs a cloud-placed job.",
		),
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
			scheduledJobFact("Effort", scheduledJobEffortLabel(job.effort)),
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
			effort: scheduledJobPanel.draft.effort,
			placement: scheduledJobPanel.draft.placement,
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

function companyRuntimeTile(sessions, jobs, liveRuntime) {
	const working = Boolean(liveRuntime);
	const liveSession = working ? sessions.find((session) => session.file === liveRuntime.trailFile) : undefined;
	const attended = working && !liveRuntime.autonomous;
		const agentName = liveRuntime?.actor === "product-worker" ? departmentName(liveRuntime.department) : "Company runtime";
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
					// A declined host review or a failed write must not be a
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
			doing.textContent = `Paused after repeated failures: ${job.suspendedReason}.`;
	} else if (job.lastOutcome === "failed" && lastRun) {
		doing.classList.add("failure");
		doing.textContent = `Last run failed: ${runFailureCause(lastRun, "failed")}`;
	} else doing.textContent = job.prompt;
	meta.textContent = `${scheduledJobNextLabel(job)} · ${scheduledJobScheduleLabel(job)} · ${scheduledJobEffortLabel(job.effort)} effort`;
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
		: navigationNode(requestedNodeId)?.view?.id === "qorpera.activity";
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
	if (!owner) main.appendChild(companyRuntimeTile(sessions, jobs, liveRuntime));
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
		// Settle: acknowledged, nothing to add — the agent reads the
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
		text.placeholder = "Respond…";
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

function appendConversationEntry(element) {
	const messages = $("messages");
	if (threadActivityEl?.isConnected && element !== threadActivityEl) messages.insertBefore(element, threadActivityEl);
	else if (element.parentNode !== messages || messages.lastElementChild !== element) messages.appendChild(element);
	return element;
}

function addMsg(cls, text, timestamp) {
	const div = document.createElement("div");
	div.className = `msg ${cls}`;
	div.textContent = text;
	if (Number.isFinite(timestamp)) div.dataset.messageTimestamp = String(timestamp);
	appendConversationEntry(div);
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

function stripMechanicalFileSummaries(source) {
	const lines = String(source ?? "").split("\n");
	const visible = [];
	for (let index = 0; index < lines.length; index += 1) {
		if (
			/^(?:#{1,6}\s*)?(?:\*\*|__)?(?:files? (?:touched|changed)|changed files|change[- ]set files)(?:\*\*|__)?\s*:?$/i.test(
				lines[index].trim(),
			)
		) {
			let cursor = index + 1;
			while (cursor < lines.length && !lines[cursor].trim()) cursor += 1;
			const firstItem = cursor;
			while (cursor < lines.length && /^(?:[-*+]\s+|\d+[.)]\s+)\S+/.test(lines[cursor].trim())) cursor += 1;
			if (cursor > firstItem) {
				index = cursor - 1;
				continue;
			}
		}
		visible.push(lines[index]);
	}
	return visible.join("\n");
}

/** Preserve provider-authored text blocks, then split only at top-level blank
 * lines. Mechanical change-set path inventories remain in the trail but are
 * not useful conversation, so both live and historical rendering omit them. */
function assistantDisplaySegments(source) {
	const text = stripMechanicalFileSummaries(String(source ?? "").replace(/\r\n?/g, "\n")).trim();
	if (!text) return [];
	const blocks = [];
	let block = [];
	let fence = "";
	const flush = () => {
		const value = block.join("\n").trim();
		// Some providers emit their transient activity caption as a completed
		// text block. The dedicated activity row already communicates this state;
		// keeping the caption would turn it into a permanent chat message.
		if (value && !/^(?:running|working) (?:on )?that now[.!…]*$/i.test(value)) blocks.push(value);
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

function appendAssistantMessages(parts, animate = false, timestamp) {
	const segments = parts.flatMap(assistantDisplaySegments);
	const messages = [];
	for (const [index, text] of segments.entries()) {
		const message = addMsg("assistant", "", timestamp);
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

function threadActivityLabel(mode) {
	const staff = currentStaff();
	const name = staff ? staffDisplayName(staff) : $("threadTitle").textContent || "Agent";
	const action = mode === "writing" ? "writing" : "working";
	return `${name} ${action}`;
}

function showThreadActivity(mode) {
	if (currentView !== "chat") return;
	const staff = currentStaff();
	const activityStaffId = staffId(staff);
	if (!threadActivityEl?.isConnected) {
		threadActivityEl = document.createElement("div");
		threadActivityEl.tabIndex = 0;
		threadActivityEl.setAttribute("role", "status");
		appendConversationEntry(threadActivityEl);
	}
	const label = threadActivityLabel(mode);
	if (threadActivityEl.dataset.mode === mode && threadActivityEl.dataset.staffId === activityStaffId) {
		$("messages").scrollTop = $("messages").scrollHeight;
		return;
	}
	threadActivityEl.className = `agent-thread-activity is-${mode}`;
	threadActivityEl.dataset.mode = mode;
	threadActivityEl.dataset.staffId = activityStaffId;
	threadActivityEl.dataset.tooltip = label;
	threadActivityEl.setAttribute("aria-label", label);
	threadActivityEl.replaceChildren(makeStaffAvatar(staff, mode));
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
		showToast("stop the run first, then rewind");
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

/** @mention parsing narrows a room send to specific participants: @First (when
 * unambiguous) or the @Full Name. Nothing recognized means broadcast. */
function roomMentionTargets(text, room) {
	const normalized = String(text ?? "").normalize("NFKC");
	const containsMention = (name) => {
		const escaped = name.normalize("NFKC").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return new RegExp(`(^|[^\\p{L}\\p{N}_])@${escaped}(?=$|[^\\p{L}\\p{N}_])`, "iu").test(normalized);
	};
	const participants = roomParticipants(room);
	const firstNameCounts = new Map();
	for (const staff of participants) {
		const first = staffDisplayName(staff).trim().normalize("NFKC").split(/\s+/)[0].toLocaleLowerCase();
		firstNameCounts.set(first, (firstNameCounts.get(first) ?? 0) + 1);
	}
	const targets = participants.filter((staff) => {
		const name = staffDisplayName(staff).trim().normalize("NFKC");
		const first = name.split(/\s+/)[0];
		return containsMention(name) || (firstNameCounts.get(first.toLocaleLowerCase()) === 1 && containsMention(first));
	});
	return targets.length ? targets.map(staffId) : undefined;
}

async function sendRoomPrompt(text, images) {
	const room = currentRoom();
	if (!room) {
		showToast("This group chat is unavailable.");
		return;
	}
	const targetStaffAgentIds = roomMentionTargets(text, room);
	const payload = {
		...(text ? { text } : {}),
		...(images.length
			? {
					images: images.map((image) => ({
						mimeType: image.mimeType,
						data: image.dataUrl.slice(image.dataUrl.indexOf(",") + 1),
					})),
				}
			: {}),
		...(targetStaffAgentIds ? { targetStaffAgentIds } : {}),
	};
	const result = await window.qorpera
		.roomSend(currentRoomId, payload)
		.catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
	if (result?.ok === false) {
		showToast(result.error ?? "The group message could not be sent. Your draft was preserved.");
		return;
	}
	if (result?.message) renderRoomMessage(result.message);
	if (result?.delivery) renderRoomDelivery(result.delivery);
	$("input").value = "";
	pendingImages = [];
	renderAttachStrip();
	syncComposer();
}

async function sendPrompt(promptContext = "") {
	const input = $("input");
	if (!canUseProfile("write")) {
		showToast("This profile is read-only. Ask an owner or admin for contributor access.");
		return;
	}
	const text = input.value.trim();
	const images = pendingImages;
	if (!text && !images.length) return false;
	if (currentRoomId) {
		await sendRoomPrompt(text, images);
		return false;
	}
	if (agentExited) {
		showToast("agent stopped — reopen this saved chat to attach a new runtime");
		return false;
	}
	const hiddenContext = typeof promptContext === "string" ? promptContext.trim() : "";
	const message = hiddenContext ? `${hiddenContext}\n\n${text}` : text;
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
		showToast(
			runtimeReconnecting
				? "agent is reconnecting — your draft was preserved"
				: "agent is busy with autonomous work — your draft was preserved",
		);
		return false;
	}
	setCurrentAvatarAction("working", 1200);
	input.value = "";
	lastSubmittedPrompt = {
		text,
		images: images.map((image) => ({
			mimeType: image.mimeType,
			dataUrl: image.dataUrl,
		})),
	};
	pendingImages = [];
	renderAttachStrip();
	syncComposer();
	appendMsgImages(
		decorateUserMsg(addMsg("user", text), text),
		images.map((image) => image.dataUrl),
	);
	return true;
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
			cause: "The agent stopped before it finished.",
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
		uncertainShellChanges: false,
	};
}

function recordCompletedTool(progress, toolName) {
	if (!progress) return;
	progress.completedSteps += 1;
	if (/^(?:bash|shell|shell_command)$/i.test(String(toolName ?? ""))) progress.uncertainShellChanges = true;
}

function runProgressSummary(progress) {
	const completed = progress?.completedSteps ?? 0;
	if (!completed) return "No completed steps were reported before the model stopped.";
	if (progress?.uncertainShellChanges) {
		return `Completed ${completed} step${completed === 1 ? "" : "s"}. Shell work may have changed files; review the work log before retrying.`;
	}
	return `Completed ${completed} read-only step${completed === 1 ? "" : "s"}. No file changes were reported.`;
}

async function retryPrompt(prompt = lastSubmittedPrompt) {
	if (!prompt?.text && !prompt?.images?.length) {
		showToast("there is no failed request to retry");
		return;
	}
	if (agentWorking) {
		showToast("wait for the current run to finish before retrying");
		return;
	}
	if (agentExited) {
		showToast("agent stopped — start a new chat, then retry the request");
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
	appendConversationEntry(card);
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
	appendConversationEntry(workGroup.el);
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
}

// ---- resizable pane: sidebar -----------------------------------------------
// Width persists per machine (localStorage — chrome preference, not company
// state).

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
		const startX = event.clientX;
		const startWidth = opts.el().getBoundingClientRect().width;
		const move = (ev) => apply(startWidth + (ev.clientX - startX) * opts.direction);
		const up = () => {
			handle.removeEventListener("pointermove", move);
			handle.removeEventListener("pointerup", up);
			delete handle.dataset.dragging;
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

/* Markdown for assistant prose. The source is HTML-escaped BEFORE parsing so
 * raw HTML in model output renders as text — formatting without injection. */
function renderMarkdown(el, source) {
	const escaped = source.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	el.innerHTML = window.marked?.parse ? window.marked.parse(escaped, { breaks: true }) : escaped.replace(/\n/g, "<br>");
}

window.qorpera.onRoomEvent((event) => {
	if (!event?.roomId) return;
	if (event.kind === "room" && event.room) {
		rememberRoom(event.room);
		if (event.room.status === "archived" && currentRoomId === event.roomId) {
			roomSettingsPending = false;
			if (!$("roomSettingsModal").hidden) closeRoomSettings(false);
			leaveRoomView();
			return;
		}
		if (currentRoomId === event.roomId) {
			renderThreadHeader();
			syncScopeChrome();
		}
		renderRosterRail();
		if (!$("archivedRoomsModal").hidden) renderArchivedRooms();
		return;
	}
	if (event.kind === "message") {
		const room = (state.rooms ?? []).find((candidate) => candidate.id === event.roomId);
		if (room && event.message?.createdAt) room.updatedAt = event.message.createdAt;
		if (currentRoomId === event.roomId) renderRoomMessage(event.message);
		renderRosterRail();
		return;
	}
	if (event.kind === "activity" && event.staffAgentId) {
		const activities = roomActivityFor(event.roomId);
		if (event.activity === "idle" || event.activity === "offline") activities.delete(event.staffAgentId);
		else activities.set(event.staffAgentId, event.activity);
		if (currentRoomId === event.roomId) {
			applyCurrentSessionRuntime();
			renderThreadHeader();
		}
		renderRosterRail();
		return;
	}
	if (event.kind === "delegation" && currentRoomId === event.roomId) {
		const source = activeStaffMembers().find((staff) => staffId(staff) === event.fromStaffAgentId);
		const target = activeStaffMembers().find((staff) => staffId(staff) === event.toStaffAgentId);
		$("status").textContent = `${staffDisplayName(source)} delegated to ${staffDisplayName(target)}`;
		return;
	}
	if (event.kind === "delivery" && currentRoomId === event.roomId) {
		renderRoomDelivery(event.delivery);
		return;
	}
	if (event.kind === "delivered" && currentRoomId === event.roomId) {
		renderRoomDelivery({ id: event.deliveryId, roomId: event.roomId }, "delivered");
		return;
	}
	if (event.kind === "error" && currentRoomId === event.roomId) renderRoomError(event.message);
});

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
				setCurrentAvatarAction("writing");
				showThreadActivity("writing");
			}
			if (delta.type === "text_delta") {
				pendingAssistantTextByIndex.set(
					delta.contentIndex,
					`${pendingAssistantTextByIndex.get(delta.contentIndex) ?? ""}${delta.delta}`,
				);
				setCurrentAvatarAction("writing");
				showThreadActivity("writing");
			}
			if (delta.type === "text_end") {
				renderCompletedAssistantBlock(
					delta.contentIndex,
					delta.content ?? pendingAssistantTextByIndex.get(delta.contentIndex) ?? "",
				);
				pendingAssistantTextByIndex.delete(delta.contentIndex);
				setCurrentAvatarAction("working");
				showThreadActivity("working");
			}
			if (delta.type === "thinking_start") {
				setCurrentAvatarAction("working");
				showThreadActivity("working");
			}
			break;
		}
		case "tool_execution_start": {
			setCurrentAvatarAction("working");
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
			if (!pendingToolLines.length && !assistantStreamHasPendingText()) showThreadActivity("working");
			refreshState();
			break;
		}
		case "agent_settled":
			closeWorkGroup();
			hideThreadActivity();
			setCurrentAvatarAction(turnFailureCard ? "needs-attention" : "idle", turnFailureCard ? 0 : 850);
			refreshState();
			break;
		case "agent_start":
			resetAssistantStreamState();
			setCurrentAvatarAction("working");
			showThreadActivity("working");
			if (!activeRunProgress) activeRunProgress = createRunProgress();
			break;
		case "message_end": {
			// A turn that errored or was stopped otherwise renders NOTHING — the
			// founder saw blank panes while the real reason (an OAuth refresh
			// failure) sat unread in the trail. Say what happened, in the thread.
			const ended = frame.message;
			if (ended?.role === "assistant") {
				hideThreadActivity();
				setCurrentAvatarAction(
					ended.stopReason === "error" ? "needs-attention" : "idle",
					ended.stopReason === "error" ? 0 : 850,
				);
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
					else showToast("could not find that message to rewind");
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

// ---- company settings -------------------------------------------------------

const SETTINGS_TABS = new Set(["general", "team", "connections", "authority"]);
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
		window.qorpera.setSettingsOverlayActive?.(true);
	}
	view.inert = false;
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
	const returnTarget =
		settingsReturnFocus?.isConnected && !view.contains(settingsReturnFocus)
			? settingsReturnFocus
			: $("input").offsetParent
				? $("input")
				: $("companySwitcherButton").offsetParent
					? $("companySwitcherButton")
					: $("railSearch");
	returnTarget?.focus();
	if (document.activeElement instanceof HTMLElement && view.contains(document.activeElement)) {
		document.activeElement.blur();
	}
	view.inert = true;
	view.classList.remove("open");
	view.setAttribute("aria-hidden", "true");
	window.qorpera.setSettingsOverlayActive?.(false);
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
		if (!canUseProfile("authorize")) {
			for (const button of card.querySelectorAll("button")) button.disabled = true;
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

const PROFILE_ROLE_LABELS = {
	owner: "Owner",
	admin: "Full access",
	contributor: "Partial access",
	viewer: "Read-only",
};

const PROFILE_ROLE_DETAILS = {
	owner: "Can manage access, authorize actions, and contribute",
	admin: "Can manage access, authorize actions, and contribute",
	contributor: "Can write and communicate, but cannot authorize actions",
	viewer: "Can inspect the profile without making changes",
};

function invitationDeliveryDetail(delivery) {
	if (delivery?.status === "delivered") return "Email sent";
	if (delivery?.status === "delivering") return "Sending email";
	if (delivery?.status === "retrying") return `Email retrying · attempt ${delivery.attemptCount}`;
	if (delivery?.status === "failed") return "Email delivery needs attention";
	return "Email queued";
}

function profileRoleSelect(value, includeAdmin) {
	const select = document.createElement("select");
	select.setAttribute("aria-label", "Profile access level");
	for (const role of ["admin", "contributor", "viewer"]) {
		if (role === "admin" && !includeAdmin) continue;
		const option = document.createElement("option");
		option.value = role;
		option.textContent = PROFILE_ROLE_LABELS[role];
		option.selected = role === value;
		select.appendChild(option);
	}
	return select;
}

function profileMemberLabel(member) {
	return member.displayName || member.email || "Qorpera account";
}

function applyCloudProfileTransition(result) {
	companyId = result.profileKey ?? companyId;
	currentProfileAccess = result.team ?? currentProfileAccess;
}

const PROFILE_STATUS_LABELS = {
	identity: { local: "Local identity", cloud: "Cloud identity" },
	sharedStaff: {
		local: "Local only",
		pending: "Migration pending",
		retrying: "Reconnecting",
		attention: "Needs attention",
		cloud: "Shared",
	},
	trail: {
		local: "Local only",
		pending: "Starting",
		retrying: "Reconnecting",
		attention: "Needs attention",
		cloud: "Synced",
	},
	sessions: {
		local: "Local only",
		pending: "Starting",
		retrying: "Reconnecting",
		attention: "Needs attention",
		cloud: "Arbitrated",
	},
	execution: { local: "This computer", cloud: "Ephemeral cloud runner", computer: "Qorpera Computer" },
	files: {
		local: "Local checkout",
		pending: "Starting",
		retrying: "Reconnecting",
		attention: "Needs attention",
		cloud: "Publishing",
	},
};

const PROFILE_PROMOTION_LABELS = {
	requested: "Ready to start",
	provisioning: "Provisioning hosted identity",
	"identity-ready": "Hosted identity ready · shared sync starting",
	complete: "Hosted profile ready",
	failed: "Needs attention",
};

function renderProfileProductControls(content, info) {
	const profile = info.profile;
	if (!profile) return;
	const product = profile.product ?? {
		account: { entitlement: "not-connected" },
		profile: {
			placement: profile.profileType === "cloud" ? "hosted" : "local",
			billingSponsor: profile.profileType === "cloud" ? "not-configured" : "not-applicable",
		},
		execution: { target: "local" },
	};
	const group = document.createElement("section");
	group.className = "settings-group general-settings-group";
	const header = document.createElement("header");
	const heading = document.createElement("h2");
	heading.textContent = "Product and execution";
	const description = document.createElement("p");
	description.textContent =
		"Account access, profile placement, execution target, and billing responsibility are independent.";
	header.append(heading, description);
	group.appendChild(header);

	const entitlement = document.createElement("small");
	entitlement.textContent =
		product.account.entitlement === "not-connected" ? "Billing not connected" : product.account.entitlement;
	setRow(
		group,
		"Account entitlement",
		"Capabilities and subscription belong to the signed-in account, not to this profile.",
		entitlement,
	);
	const placement = document.createElement("small");
	placement.textContent = product.profile.placement === "hosted" ? "Hosted profile" : "On this computer";
	setRow(group, "Profile placement", "Controls where shared profile state is stored and synchronized.", placement);
	const execution = document.createElement("small");
	execution.textContent =
		product.execution.target === "cloud"
			? "Ephemeral cloud runner"
			: product.execution.target === "computer"
				? "Qorpera Computer"
				: "This computer";
	setRow(
		group,
		"Execution target",
		"Chosen per session or worktree. Hosted profiles do not automatically move execution to the cloud.",
		execution,
	);
	const sponsor = document.createElement("small");
	sponsor.textContent = product.profile.billingSponsor === "not-applicable" ? "Not applicable" : "Not configured";
	setRow(
		group,
		"Billing sponsor",
		product.profile.billingSponsor === "not-applicable"
			? "Local profile activity has no shared hosting sponsor."
			: "The sponsor will cover shared profile costs; contributors will not have to buy a plan merely to join.",
		sponsor,
	);

	for (const [key, label] of [
		["sharedStaff", "Staff roster"],
		["trail", "Attended chat trail"],
		["sessions", "Session arbitration"],
		["execution", "Agent execution"],
		["files", "Company files"],
	]) {
		const value = profile.status?.[key];
		const status = document.createElement("small");
		status.textContent = PROFILE_STATUS_LABELS[key]?.[value] ?? value ?? "Unknown";
		setRow(group, label, "", status);
	}

	if (profile.promotion) {
		const promotion = document.createElement("small");
		promotion.textContent = PROFILE_PROMOTION_LABELS[profile.promotion.phase] ?? profile.promotion.phase;
		setRow(
			group,
			"Hosting setup",
			profile.promotion.lastError ?? "The local profile remains recoverable throughout promotion.",
			promotion,
		);
	}

	if (profile.profileType === "local") {
		const host = document.createElement("button");
		host.type = "button";
		host.textContent =
			profile.promotion?.phase === "failed"
				? "Retry hosting setup"
				: profile.promotion
					? "Resume hosting setup"
					: "Host this profile";
		host.disabled = profile.access?.capabilities?.manageMembers !== true;
		host.onclick = async () => {
			host.disabled = true;
			const result = await window.qorpera.enableCloudProfile();
			if (result?.ok) {
				applyCloudProfileTransition(result);
				showToast("Hosted profile is active. Shared staff and attended chats are syncing.");
			} else {
				showToast(result?.error ?? "Hosting setup still needs attention.");
			}
			await renderSettingsTab();
		};
		const actions = document.createElement("div");
		actions.className = "appearance-actions";
		actions.appendChild(host);
		group.appendChild(actions);
	}
	content.appendChild(group);
}

function renderProfileCloudControls(content, info) {
	const profile = info.profile;
	if (!profile) return;
	const group = document.createElement("section");
	group.className = "settings-group general-settings-group";
	const header = document.createElement("header");
	const heading = document.createElement("h2");
	heading.textContent = "Profile placement";
	const description = document.createElement("p");
	description.textContent =
		profile.profileType === "cloud"
			? "Profile identity, team access, shared staff, and attended chats are hosted. Files remain attached to this checkout unless published; execution is selected separately."
			: "This profile identity, its team list, files, and agent trail currently exist only on this computer.";
	header.append(heading, description);
	group.appendChild(header);

	if (profile.profileType === "cloud") {
		const identity = document.createElement("small");
		identity.textContent = profile.profileId;
		setRow(
			group,
			"Hosted profile",
			"Hosting and usage are scoped to this profile. Product entitlement remains attached to each account.",
			identity,
		);
		content.appendChild(group);
		return;
	}

	const canEnable = profile.access?.capabilities?.manageMembers === true;
	const attach = document.createElement("button");
	attach.type = "button";
	attach.textContent = "Choose cloud profile";
	attach.disabled = !canEnable;
	attach.onclick = async () => {
		attach.disabled = true;
		attach.textContent = "Loading…";
		const result = await window.qorpera.cloudProfileOptions();
		if (!result?.ok) {
			attach.disabled = false;
			attach.textContent = "Choose cloud profile";
			showToast(result?.error ?? "Cloud profiles could not be loaded.");
			return;
		}
		const profiles = result.profiles ?? [];
		if (!profiles.length) {
			attach.disabled = false;
			attach.textContent = "Choose cloud profile";
			showToast("No cloud profiles are available to this account.");
			return;
		}
		const select = document.createElement("select");
		select.setAttribute("aria-label", "Cloud profile to attach");
		select.appendChild(new Option("Choose a cloud profile", ""));
		for (const candidate of profiles) {
			select.appendChild(
				new Option(
					`${candidate.profileName} · ${PROFILE_ROLE_LABELS[candidate.role] ?? candidate.role}`,
					candidate.profileId,
				),
			);
		}
		const confirm = document.createElement("button");
		confirm.type = "button";
		confirm.textContent = "Attach folder";
		confirm.disabled = true;
		select.onchange = () => {
			confirm.disabled = !select.value;
		};
		confirm.onclick = async () => {
			select.disabled = true;
			confirm.disabled = true;
			const attached = await window.qorpera.attachCloudProfile(select.value);
			if (!attached?.ok) {
				select.disabled = false;
				confirm.disabled = !select.value;
				if (!attached?.cancelled) showToast(attached?.error ?? "Cloud profile could not be attached.");
				return;
			}
			applyCloudProfileTransition(attached);
			showToast("Folder attached. Profile identity and team access now come from the cloud profile.");
			await renderSettingsTab();
		};
		const row = attach.closest(".setrow");
		if (row) {
			attach.remove();
			row.append(select, confirm);
		}
	};
	setRow(
		group,
		"Attach to an existing cloud profile",
		"Use this folder as a local checkout. Qorpera will confirm before replacing its local profile identity.",
		attach,
	);
	content.appendChild(group);
}

function renderCloudCompanyWorkspaces(content, info) {
	const profile = info.profile;
	if (profile?.profileType !== "cloud") return;
	const group = document.createElement("section");
	group.className = "settings-group general-settings-group";
	const header = document.createElement("header");
	const heading = document.createElement("h2");
	heading.textContent = "Company workspaces";
	const description = document.createElement("p");
	description.textContent =
		"Each computer publishes an isolated company-file fork. Remote changes are previewed and merged explicitly; they never overwrite this checkout on arrival.";
	header.append(heading, description);
	group.appendChild(header);

	const health = document.createElement("small");
	const inboxPhase = profile.workspaceInboxHealth?.phase;
	health.textContent =
		inboxPhase === "attention"
			? "Needs attention"
			: inboxPhase === "retrying"
				? "Reconnecting"
				: inboxPhase === "healthy"
					? "Up to date"
					: "Starting";
	setRow(group, "Workspace inbox", "Realtime invalidations are verified against immutable snapshots.", health);

	const workspaces = profile.workspaces ?? [];
	for (const workspace of workspaces) {
		const actions = document.createElement("div");
		const updated = Number.isFinite(Date.parse(workspace.updatedAt))
			? new Date(workspace.updatedAt).toLocaleString()
			: "Update time unavailable";
		const detail = workspace.head
			? `${workspace.head.tree.fileCount} files · ${updated}`
			: `No published files · ${updated}`;
		if (workspace.isLocal) {
			const local = document.createElement("small");
			local.textContent = workspace.head ? "This computer · published" : "This computer · preparing";
			actions.appendChild(local);
		} else if (workspace.head) {
			const preview = document.createElement("button");
			preview.type = "button";
			preview.textContent = "Preview";
			preview.onclick = async () => {
				preview.disabled = true;
				const result = await window.qorpera.previewCloudCompanyWorkspace(workspace.workspaceId);
				preview.disabled = false;
				showToast(result?.ok ? "Verified preview opened." : result?.error ?? "Preview could not be opened.");
			};
			const merge = document.createElement("button");
			merge.type = "button";
			merge.textContent = "Review merge";
			merge.onclick = async () => {
				merge.disabled = true;
				merge.textContent = "Reviewing…";
				const inspection = await window.qorpera.inspectCloudCompanyMerge(workspace.workspaceId);
				if (!inspection?.ok) {
					merge.disabled = false;
					merge.textContent = "Review merge";
					showToast(inspection?.error ?? "Merge could not be inspected.");
					return;
				}
				const plan = inspection.plan;
				if (plan.conflicts.length) {
					merge.textContent = `${plan.conflicts.length} conflict${plan.conflicts.length === 1 ? "" : "s"}`;
					merge.title = plan.conflicts.map((conflict) => conflict.path).join("\n");
					showToast("This fork has conflicting paths. Preview it before resolving locally.");
					return;
				}
				if (!plan.changedPaths.length) {
					merge.textContent = "Already included";
					return;
				}
				if (profile.access?.capabilities?.write !== true) {
					merge.textContent = `${plan.changedPaths.length} changes · read-only`;
					return;
				}
				merge.disabled = false;
				merge.textContent = `Merge ${plan.changedPaths.length} changes`;
				merge.onclick = async () => {
					merge.disabled = true;
					const result = await window.qorpera.mergeCloudCompanyWorkspace(workspace.workspaceId);
					if (!result?.ok) {
						merge.disabled = false;
						if (!result?.cancelled) showToast(result?.error ?? "Remote changes were not merged.");
						return;
					}
					showToast(result.applied ? "Remote changes merged and published." : "No files were changed.");
					await renderSettingsTab();
				};
			};
			actions.append(preview, merge);
		}
		setRow(group, workspace.name, detail, actions);
	}
	if (!workspaces.some((workspace) => !workspace.isLocal)) {
		const empty = document.createElement("small");
		empty.textContent = "No remote forks";
		setRow(
			group,
			"Other computers",
			"A teammate's published fork will appear here after they open this cloud profile.",
			empty,
		);
	}
	content.appendChild(group);
}

function teamPersonAvatar(label, pending = false) {
	const avatar = document.createElement("span");
	avatar.className = `team-person-avatar${pending ? " pending" : ""}`;
	const source = (label ?? "").trim();
	let seed = 0;
	for (const character of source.toLowerCase()) seed = (seed * 31 + character.charCodeAt(0)) >>> 0;
	avatar.style.setProperty("--person-color", STAFF_AVATAR_COLORS[seed % STAFF_AVATAR_COLORS.length]);
	avatar.textContent = (source[0] ?? "?").toUpperCase();
	avatar.setAttribute("aria-hidden", "true");
	return avatar;
}

function teamGroup(content, title, description) {
	const group = document.createElement("section");
	group.className = "settings-group general-settings-group";
	const header = document.createElement("header");
	const heading = document.createElement("h2");
	heading.textContent = title;
	header.appendChild(heading);
	if (description) {
		const copy = document.createElement("p");
		copy.textContent = description;
		header.appendChild(copy);
	}
	group.appendChild(header);
	content.appendChild(group);
	return group;
}

function teamPersonRow(group, name, detail, { pending = false } = {}) {
	const row = document.createElement("div");
	row.className = "setrow team-person-row";
	row.appendChild(teamPersonAvatar(name, pending));
	const copy = document.createElement("label");
	copy.textContent = name;
	if (detail) {
		const small = document.createElement("small");
		small.textContent = detail;
		copy.appendChild(small);
	}
	row.appendChild(copy);
	group.appendChild(row);
	return row;
}

function renderTeamTab(content, info, friendsResult) {
	const team = info.profile?.team;
	if (!team) {
		content.insertAdjacentHTML("beforeend", '<div class="sess-meta">Open a company to manage its team.</div>');
		return;
	}
	const cloudProfile = info.profile?.profileType === "cloud";
	const actorId = info.account?.user?.id;
	const canManage = team.capabilities?.manageMembers === true;
	const actorIsOwner = team.role === "owner";
	const members = team.members ?? [];
	const invitations = canManage ? (team.invitations ?? []) : [];

	// Company identity card, then one shared inline error line. Every action in
	// this tab reports failures there and IPC rejections are caught too — a
	// silently swallowed failure is exactly how invitations went missing in
	// 0.20.5.
	const card = document.createElement("section");
	card.className = "settings-group general-settings-group";
	const companyCard = document.createElement("div");
	companyCard.className = "general-company-card";
	const companyLabel = info.company?.name || state.name || "Current company";
	companyCard.appendChild(makeCompanyIcon(info.company?.companyIcon || currentCompanyIcon, companyLabel));
	const companyCopy = document.createElement("div");
	companyCopy.className = "general-account-copy";
	const companyName = document.createElement("strong");
	companyName.textContent = companyLabel;
	const companyDetail = document.createElement("small");
	const memberCount = members.length === 1 ? "1 member" : `${members.length} members`;
	companyDetail.textContent = `${cloudProfile ? "Hosted profile" : "On this computer"} · ${memberCount}${
		invitations.length ? ` · ${invitations.length} invited` : ""
	}`;
	companyCopy.append(companyName, companyDetail);
	companyCard.appendChild(companyCopy);
	card.appendChild(companyCard);
	const errorBox = document.createElement("div");
	errorBox.className = "hub-error team-error";
	errorBox.setAttribute("role", "status");
	errorBox.setAttribute("aria-live", "polite");
	card.appendChild(errorBox);
	content.appendChild(card);

	const runTeamAction = async (button, action, successMessage) => {
		if (button) button.disabled = true;
		errorBox.textContent = "";
		try {
			const result = await action();
			if (!result?.ok) throw new Error(result?.error || "That did not work.");
			if (successMessage) showToast(successMessage);
			await renderSettingsTab();
			return result;
		} catch (error) {
			errorBox.textContent = error instanceof Error ? error.message : String(error);
			if (button) button.disabled = false;
			return undefined;
		}
	};

	const people = teamGroup(
		content,
		"People",
		canManage
			? "Everyone with access to this profile. Roles control what each person can do."
			: "People who share access to this profile.",
	);
	for (const member of members) {
		const detail = [member.email, PROFILE_ROLE_DETAILS[member.role]].filter(Boolean).join(" · ");
		const editable =
			canManage &&
			member.role !== "owner" &&
			(actorIsOwner || member.role !== "admin") &&
			member.userId !== actorId;
		const row = teamPersonRow(people, profileMemberLabel(member), detail);
		if (editable) {
			const control = profileRoleSelect(member.role, actorIsOwner);
			control.onchange = () =>
				runTeamAction(control, () => window.qorpera.updateProfileMemberRole(member.userId, control.value));
			const remove = document.createElement("button");
			remove.type = "button";
			remove.textContent = "Remove";
			remove.onclick = () =>
				runTeamAction(remove, () => window.qorpera.removeProfileMember(member.userId), "Removed from the team.");
			row.append(control, remove);
		} else {
			const roleLabel = document.createElement("small");
			roleLabel.textContent = PROFILE_ROLE_LABELS[member.role] ?? member.role;
			row.appendChild(roleLabel);
		}
	}
	for (const invitation of invitations) {
		const row = teamPersonRow(
			people,
			invitation.email,
			`Pending acceptance · ${PROFILE_ROLE_LABELS[invitation.role]}${
				cloudProfile ? ` · ${invitationDeliveryDetail(invitation.delivery)}` : ""
			}`,
			{ pending: true },
		);
		if (invitation.delivery?.status === "failed") {
			const retry = document.createElement("button");
			retry.type = "button";
			retry.textContent = "Retry email";
			retry.onclick = () =>
				runTeamAction(
					retry,
					() => window.qorpera.retryProfileInvitationDelivery(invitation.id),
					"Invitation email queued again.",
				);
			row.appendChild(retry);
		}
		const cancel = document.createElement("button");
		cancel.type = "button";
		cancel.textContent = "Cancel invite";
		cancel.onclick = () =>
			runTeamAction(cancel, () => window.qorpera.cancelProfileInvitation(invitation.id), "Invitation cancelled.");
		row.appendChild(cancel);
	}

	if (canManage) {
		const inviteGroup = teamGroup(
			content,
			"Invite a friend",
			cloudProfile
				? "Pick a friend and choose their access. Qorpera sends them an expiring email invitation to accept."
				: "Pick a friend and choose their access. It activates when they sign in on this installation.",
		);
		if (!friendsResult?.ok) {
			const note = document.createElement("div");
			note.className = "sess-meta";
			note.textContent = friendsResult?.error ?? "Friends are unavailable right now.";
			inviteGroup.appendChild(note);
		} else {
			const memberEmails = new Set(members.map((member) => (member.email ?? "").toLowerCase()));
			const invitedEmails = new Set(invitations.map((invitation) => invitation.email.toLowerCase()));
			const incoming = friendsResult.friends.filter(
				(friend) => friend.status === "pending" && friend.direction === "incoming",
			);
			const outgoing = friendsResult.friends.filter(
				(friend) => friend.status === "pending" && friend.direction === "outgoing",
			);
			const accepted = friendsResult.friends.filter((friend) => friend.status === "accepted");
			for (const friend of accepted) {
				const onTeam = memberEmails.has(friend.email.toLowerCase());
				const invited = invitedEmails.has(friend.email.toLowerCase());
				const row = teamPersonRow(
					inviteGroup,
					friend.displayName,
					onTeam
						? `${friend.email} · Already on the team`
						: invited
							? `${friend.email} · Invitation pending`
							: friend.email,
				);
				if (!onTeam && !invited) {
					const role = profileRoleSelect("contributor", actorIsOwner);
					const invite = document.createElement("button");
					invite.type = "button";
					invite.textContent = "Invite";
					invite.onclick = () =>
						runTeamAction(
							invite,
							() => window.qorpera.inviteProfileMember({ email: friend.email, role: role.value }),
							cloudProfile
								? `Invitation email queued for ${friend.displayName}.`
								: `${friend.displayName} can join when they sign in here.`,
						);
					row.append(role, invite);
				}
			}
			if (!accepted.length) {
				const empty = document.createElement("div");
				empty.className = "sess-meta";
				empty.textContent = "No friends yet — add one below and invite them once they accept.";
				inviteGroup.appendChild(empty);
			}
			for (const friend of incoming) {
				const row = teamPersonRow(inviteGroup, friend.displayName, `${friend.email} · Wants to be friends`, {
					pending: true,
				});
				const accept = document.createElement("button");
				accept.type = "button";
				accept.textContent = "Accept";
				accept.onclick = () =>
					runTeamAction(
						accept,
						() => window.qorpera.friendsRespond(friend.userId, true),
						`${friend.displayName} is now a friend.`,
					);
				const decline = document.createElement("button");
				decline.type = "button";
				decline.textContent = "Decline";
				decline.onclick = () => runTeamAction(decline, () => window.qorpera.friendsRespond(friend.userId, false));
				row.append(accept, decline);
			}
			for (const friend of outgoing) {
				teamPersonRow(inviteGroup, friend.displayName, `${friend.email} · Friend request sent`, { pending: true });
			}
		}

		const addEmail = document.createElement("input");
		addEmail.type = "email";
		addEmail.placeholder = "friend@example.com";
		addEmail.setAttribute("aria-label", "Friend email address");
		const add = document.createElement("button");
		add.type = "button";
		add.textContent = "Add friend";
		add.onclick = () =>
			runTeamAction(
				add,
				async () => {
					const address = addEmail.value.trim();
					if (!address) throw new Error("Enter an email address to add a friend.");
					return window.qorpera.friendsRequest(address);
				},
				"Friend request sent.",
			);
		const addRow = setRow(
			inviteGroup,
			"Add friends",
			"Not friends yet? Send a request by email — they appear here once they accept.",
			addEmail,
		);
		addRow.appendChild(add);

		const email = document.createElement("input");
		email.type = "email";
		email.placeholder = "colleague@example.com";
		email.setAttribute("aria-label", "Invitee email address");
		const role = profileRoleSelect("contributor", actorIsOwner);
		const invite = document.createElement("button");
		invite.type = "button";
		invite.textContent = "Create invite";
		invite.onclick = () =>
			runTeamAction(
				invite,
				async () => {
					const address = email.value.trim();
					if (!address) throw new Error("Enter an email address to invite.");
					return window.qorpera.inviteProfileMember({ email: address, role: role.value });
				},
				cloudProfile ? "Invitation created. Email queued." : "Invitation created.",
			);
		const emailGroup = teamGroup(
			content,
			"Invite by email",
			cloudProfile
				? "Sends an expiring email invitation. The recipient must sign in with this address and accept explicitly."
				: "Access activates when this email signs in on the same Qorpera installation.",
		);
		const inviteRow = setRow(emailGroup, "Email invitation", "", email);
		inviteRow.append(role, invite);
	}

	const staff = activeStaffMembers();
	if (staff.length) {
		const staffGroup = teamGroup(
			content,
			"Staff at work",
			"The company's agent staff. They come with the company — no invitation needed.",
		);
		const grid = document.createElement("div");
		grid.className = "team-staff-grid";
		for (const member of staff) {
			const staffCard = document.createElement("div");
			staffCard.className = "team-staff-card";
			staffCard.appendChild(makeStaffAvatar(member, staffStatus(member)));
			const name = document.createElement("strong");
			name.textContent = staffDisplayName(member);
			const roleLabel = document.createElement("small");
			roleLabel.textContent = staffRoleLabel(member);
			staffCard.append(name, roleLabel);
			grid.appendChild(staffCard);
		}
		staffGroup.appendChild(grid);
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
		if (info.profile?.profileType === "cloud") {
			const cloud = await window.qorpera.cloudCompanyWorkspaces().catch(() => undefined);
			if (renderVersion !== settingsRenderVersion || renderedTab !== settingsTab) return;
			if (cloud?.ok) {
				info.profile.workspaces = cloud.inbox?.workspaces ?? info.profile.workspaces;
				info.profile.workspaceInboxHealth = cloud.inboxHealth;
			}
		}
		currentProfileAccess = info.profile?.access ?? info.profile?.team ?? currentProfileAccess;
		setHeading(content, "General");

		const companyGroup = document.createElement("section");
		companyGroup.className = "settings-group general-settings-group";
		companyGroup.innerHTML = "<header><h2>Company</h2></header>";
		const companyCard = document.createElement("div");
		companyCard.className = "general-company-card";
		companyCard.appendChild(
			makeCompanyIcon(
				info.company?.companyIcon || currentCompanyIcon,
				info.company?.name || state.name || "Current company",
			),
		);
		const companyCopy = document.createElement("div");
		companyCopy.className = "general-account-copy";
		const companyName = document.createElement("strong");
		companyName.textContent = info.company?.name || state.name || "Current company";
		const companyDetail = document.createElement("small");
		const profileTypeLabel =
			info.profile?.product?.profile?.placement === "hosted" ? "Hosted profile" : "On this computer";
		companyDetail.textContent = info.profile
			? `${profileTypeLabel} · ${PROFILE_ROLE_LABELS[currentProfileAccess.role] ?? "Shared access"}`
			: "Agents, connector recipes, and work for this company";
		companyCopy.append(companyName, companyDetail);
		const companyActions = document.createElement("div");
		companyActions.className = "general-company-actions";
		const changePicture = document.createElement("button");
		changePicture.type = "button";
		changePicture.textContent = "Choose picture";
		changePicture.onclick = () =>
			chooseCompanyPicture(async (picture) => {
				changePicture.disabled = true;
				if (await saveCurrentCompanyIcon(picture)) await renderSettingsTab();
				else changePicture.disabled = false;
			});
		companyActions.appendChild(changePicture);
		if (currentCompanyIcon.startsWith("data:image/")) {
			const useAnonymous = document.createElement("button");
			useAnonymous.type = "button";
			useAnonymous.textContent = "Use anonymous icon";
			useAnonymous.onclick = async () => {
				useAnonymous.disabled = true;
				if (await saveCurrentCompanyIcon("anonymous")) await renderSettingsTab();
				else useAnonymous.disabled = false;
			};
			companyActions.appendChild(useAnonymous);
		}
		const switchCompany = document.createElement("button");
		switchCompany.type = "button";
		switchCompany.textContent = "Switch company";
		switchCompany.onclick = async () => {
			switchCompany.disabled = true;
			await window.qorpera.showHub();
		};
		companyActions.appendChild(switchCompany);
		companyCard.append(companyCopy, companyActions);
		companyGroup.appendChild(companyCard);
		content.appendChild(companyGroup);
		renderProfileProductControls(content, info);
		renderProfileCloudControls(content, info);
		renderCloudCompanyWorkspaces(content, info);

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
				showToast(result?.error ?? "Could not sign out.");
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
		execution.disabled = !canUseProfile("authorize");
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
		const background = document.createElement("button");
		background.type = "button";
		background.className = "settings-toggle";
		background.setAttribute("role", "switch");
		background.setAttribute("aria-label", "Keep running in the background");
		let backgroundEnabled = Boolean(info.backgroundEnabled);
		const syncBackground = () => {
			background.classList.toggle("active", backgroundEnabled);
			background.setAttribute("aria-checked", String(backgroundEnabled));
		};
		syncBackground();
		background.disabled = !info.company || !canUseProfile("authorize");
		const backgroundStatus = document.createElement("small");
		backgroundStatus.className = "general-setting-status";
		background.onclick = async () => {
			background.disabled = true;
			backgroundStatus.textContent = "Saving…";
			const result = await window.qorpera.setBackgroundEnabled(!backgroundEnabled);
			if (result?.ok) {
				backgroundEnabled = Boolean(result.backgroundEnabled);
				backgroundStatus.textContent = backgroundEnabled
					? "Closing this window keeps the company running in the tray."
					: "";
			} else {
				backgroundStatus.textContent = result?.error ?? "Background preference could not be saved.";
			}
			syncBackground();
			background.disabled = !info.company || !canUseProfile("authorize");
		};
		const backgroundRow = setRow(
			executionGroup,
			"Keep running in the background",
			"Closing this company’s window hides it to the system tray while routines, group-chat deliveries, and coworker mail keep running. Qorpera also starts at login while any company is opted in.",
			background,
		);
		backgroundRow.appendChild(backgroundStatus);
		content.appendChild(executionGroup);
		return;
	}

	if (settingsTab === "team") {
		const info = await window.qorpera.settingsInfo();
		if (renderVersion !== settingsRenderVersion || renderedTab !== settingsTab) return;
		currentProfileAccess = info.profile?.access ?? info.profile?.team ?? currentProfileAccess;
		const friends =
			info.profile?.team?.capabilities?.manageMembers === true ? await window.qorpera.friendsList() : undefined;
		if (renderVersion !== settingsRenderVersion || renderedTab !== settingsTab) return;
		setHeading(content, "Team");
		renderTeamTab(content, info, friends);
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
		setRow(group, "Page hue", "Built-in company pages", pageHue);
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
			"company agents are read-only here; product-workers can modify only their assigned worktree — not configurable",
		);

		setRow(content, "Authority itself", "editing gates, protected company files, or the inbox — always gated, not configurable");

		const save = document.createElement("button");
		save.className = "save";
		save.textContent = "Save gates";
		const canAuthorize = canUseProfile("authorize");
		money.disabled = !canAuthorize;
		limit.disabled = !canAuthorize;
		identity.disabled = !canAuthorize;
		irreversible.disabled = !canAuthorize;
		save.disabled = !canAuthorize;
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
if (typeof window.qorpera.onConnectionRequestsChanged === "function") {
	window.qorpera.onConnectionRequestsChanged((request) => {
		if (!request?.id) return;
		applyConnectionRequestResult(request, { request });
	});
}
window.qorpera.onAccountStatus((message) => {
	if (typeof message === "string" && !$("accountView").hidden) $("accountStatus").textContent = message;
});
window.qorpera.onOpenCompany((root) => openCompany(root));

setupCompanyNavigation();
setupSidebarToggle();
setupCompanyModal();
$("signOutButton").onclick = signOut;
applyNavAppearance();
applyStaffAvatarStyle();

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


// ---- friends ---------------------------------------------------------------
// Friends are the social graph the hub renders: requests, the roster, and the
// pending company invitations that previously only lived in email. Errors
// surface in the panel instead of being swallowed -- an invisible failure
// here is exactly how invitations went missing before.

let friendsWired = false;

function wireFriendsPanel() {
	if (friendsWired) return;
	friendsWired = true;
	$("friendsButton").onclick = () => {
		const panel = $("friendsPanel");
		panel.hidden = !panel.hidden;
		if (!panel.hidden) void renderFriendsPanel();
	};
	$("friendsClose").onclick = () => {
		$("friendsPanel").hidden = true;
	};
	$("friendAdd").onclick = async () => {
		const input = $("friendEmail");
		const email = input.value.trim();
		if (!email) return;
		$("friendsError").textContent = "";
		const result = await window.qorpera.friendsRequest(email);
		if (result?.ok) {
			input.value = "";
			await renderFriendsPanel();
		} else {
			$("friendsError").textContent = result?.error ?? "Friend request failed.";
		}
	};
}

function friendRow(label, sub, buttons) {
	const row = document.createElement("div");
	row.className = "friend-row";
	const who = document.createElement("span");
	who.className = "who";
	who.textContent = label;
	const small = document.createElement("small");
	small.textContent = sub;
	who.appendChild(small);
	row.appendChild(who);
	for (const [text, action] of buttons) {
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = text;
		button.onclick = async () => {
			button.disabled = true;
			$("friendsError").textContent = "";
			const result = await action();
			if (result?.ok) {
				await renderFriendsPanel();
				if (result.refreshHub) await renderHub();
			} else {
				button.disabled = false;
				$("friendsError").textContent = result?.error ?? "That did not work.";
			}
		};
		row.appendChild(button);
	}
	return row;
}

function friendsSection(container, title) {
	const heading = document.createElement("div");
	heading.className = "friends-section-title";
	heading.textContent = title;
	container.appendChild(heading);
}

async function renderFriendsPanel() {
	const invitesBox = $("friendsInvites");
	const listBox = $("friendsList");
	invitesBox.innerHTML = "";
	listBox.innerHTML = "";
	$("friendsError").textContent = "";

	const invites = await window.qorpera.listCloudInvitations();
	if (!invites?.ok) {
		$("friendsError").textContent = `Invitations: ${invites?.error ?? "unavailable"}`;
	} else if (invites.invitations.length > 0) {
		friendsSection(invitesBox, "Company invites");
		for (const invitation of invites.invitations) {
			invitesBox.appendChild(
				friendRow(invitation.profileName, `invited as ${invitation.role}`, [
					[
						"Accept",
						async () => {
							const result = await window.qorpera.acceptCloudInvitation(invitation.id);
							return result?.ok ? { ok: true, refreshHub: true } : result;
						},
					],
					["Decline", () => window.qorpera.declineCloudInvitation(invitation.id)],
				]),
			);
		}
	}

	const friends = await window.qorpera.friendsList();
	if (!friends?.ok) {
		$("friendsError").textContent = friends?.error ?? "Friends are unavailable.";
		return;
	}
	const incoming = friends.friends.filter((friend) => friend.status === "pending" && friend.direction === "incoming");
	const outgoing = friends.friends.filter((friend) => friend.status === "pending" && friend.direction === "outgoing");
	const accepted = friends.friends.filter((friend) => friend.status === "accepted");
	if (incoming.length > 0) {
		friendsSection(listBox, "Friend requests");
		for (const friend of incoming) {
			listBox.appendChild(
				friendRow(friend.displayName, friend.email, [
					["Accept", () => window.qorpera.friendsRespond(friend.userId, true)],
					["Decline", () => window.qorpera.friendsRespond(friend.userId, false)],
				]),
			);
		}
	}
	friendsSection(listBox, accepted.length > 0 ? "Friends" : "No friends yet — add one by email.");
	for (const friend of accepted) {
		listBox.appendChild(
			friendRow(friend.displayName, friend.email, [["Remove", () => window.qorpera.friendsRemove(friend.userId)]]),
		);
	}
	if (outgoing.length > 0) {
		friendsSection(listBox, "Waiting on");
		for (const friend of outgoing) {
			listBox.appendChild(friendRow(friend.displayName, `${friend.email} · invited`, []));
		}
	}
}
