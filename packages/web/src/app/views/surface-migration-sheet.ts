import type { ApplySurfaceMigrationInput } from "@qorpera/cloud-client/surfaces";
import type { SurfaceAutomationSummary, SurfaceMigrationChecklist } from "@qorpera/contracts";
import { SurfaceDialog } from "../../ui/dialog.ts";
import { fmtTime, h, icon } from "../../ui/dom.ts";
import { interfaceEmblem } from "../../ui/interface-emblem.ts";
import { phrase, t } from "../../ui/preferences.ts";
import {
	markSurfaceFigure,
	type SurfaceFigureId,
	surfaceFigure,
	surfaceFigureChoices,
	surfaceFigureIcon,
} from "../../ui/surface-figure.ts";
import { type SurfaceKind, surfaceKindFigure } from "../surface-kinds.ts";
import { migrationPending, type SurfacesStore } from "../surfaces-store.ts";

type AgentAction = ApplySurfaceMigrationInput["agentDecisions"][number]["action"];

function agentActionLabel(action: AgentAction): string {
	switch (action) {
		case "fold_to_automation":
			return t("Fold into a scheduled agent");
		case "fold_to_surface_brief":
			return t("Fold into a Surface brief");
		case "archive_readonly":
			return t("Archive, read-only");
		case "keep":
			return t("Keep as an agent");
	}
}

const AGENT_ACTIONS: readonly AgentAction[] = [
	"fold_to_automation",
	"fold_to_surface_brief",
	"archive_readonly",
	"keep",
];

export function migrationInput(
	checklist: SurfaceMigrationChecklist,
	choices: { agents: ReadonlyMap<string, AgentAction>; boards: ReadonlySet<string>; surfaces: ReadonlySet<string> },
): ApplySurfaceMigrationInput {
	return {
		activateSurfaceSlugs: checklist.proposedSurfaces
			.filter((surface) => choices.surfaces.has(surface.slug))
			.map((surface) => surface.slug),
		agentDecisions: checklist.specialistAgents.map((agent) => ({
			agentId: agent.agentId,
			action: choices.agents.get(agent.agentId) ?? agent.recommendedAction,
			targetSurfaceSlug: agent.recommendedTargetSurfaceSlug,
		})),
		archiveBoardNames: checklist.legacyBoards
			.filter((board) => choices.boards.has(board.appName))
			.map((board) => board.appName),
	};
}

export function openMigrationSheet(store: SurfacesStore): void {
	const checklist = store.state.migration;
	if (!checklist || !migrationPending(checklist)) return;
	const agents = new Map<string, AgentAction>(
		checklist.specialistAgents.map((agent) => [agent.agentId, agent.recommendedAction]),
	);
	const boards = new Set(
		checklist.legacyBoards
			.filter((board) => board.recommendedAction === "archive_to_files")
			.map((board) => board.appName),
	);
	const surfaces = new Set(checklist.proposedSurfaces.map((surface) => surface.slug));
	const status = h("p", { class: "surface-sheet-status", role: "status" });
	const dialog = new SurfaceDialog(t("Move to Surfaces"), "surface-sheet", () => undefined);
	const apply = h("button", { type: "button", class: "btn btn-primary" }, t("Apply checklist"));
	apply.addEventListener("click", async () => {
		apply.disabled = true;
		status.textContent = t("Applying…");
		const done = await store.applyMigration(migrationInput(checklist, { agents, boards, surfaces }));
		if (done) dialog.close();
		else {
			apply.disabled = false;
			status.textContent = store.state.error ?? t("That didn't work. Try again.");
		}
	});
	const sections: HTMLElement[] = [
		h("h2", null, t("Move to Surfaces")),
		h(
			"p",
			{ class: "surface-sheet-lead" },
			t(
				"Specialist agents become quiet Automations or Surface briefs, and stray boards move to Files. Keep any agent you like.",
			),
		),
	];
	if (checklist.proposedSurfaces.length)
		sections.push(
			h("h3", null, t("Surfaces")),
			h(
				"ul",
				{ class: "surface-sheet-list" },
				checklist.proposedSurfaces.map((surface) => {
					const box = h("input", { type: "checkbox", checked: true });
					box.addEventListener("change", () => {
						if (box.checked) surfaces.add(surface.slug);
						else surfaces.delete(surface.slug);
					});
					return h(
						"li",
						null,
						h("label", null, box, h("strong", null, surface.title), h("small", null, surface.slug)),
					);
				}),
			),
		);
	if (checklist.specialistAgents.length)
		sections.push(
			h("h3", null, t("Specialist agents")),
			h(
				"ul",
				{ class: "surface-sheet-list" },
				checklist.specialistAgents.map((agent) => {
					const select = h(
						"select",
						{ class: "surface-sheet-select", "aria-label": t("What happens to {name}", { name: agent.name }) },
						AGENT_ACTIONS.map((action) =>
							h(
								"option",
								{ value: action, selected: action === agent.recommendedAction },
								agentActionLabel(action),
							),
						),
					);
					select.addEventListener("change", () => agents.set(agent.agentId, select.value as AgentAction));
					return h(
						"li",
						null,
						h("div", null, h("strong", null, agent.name), agent.role ? h("small", null, agent.role) : null),
						select,
					);
				}),
			),
		);
	if (checklist.legacyBoards.length)
		sections.push(
			h("h3", null, t("Boards")),
			h(
				"ul",
				{ class: "surface-sheet-list" },
				checklist.legacyBoards.map((board) => {
					const box = h("input", { type: "checkbox", checked: boards.has(board.appName) });
					box.addEventListener("change", () => {
						if (box.checked) boards.add(board.appName);
						else boards.delete(board.appName);
					});
					return h(
						"li",
						null,
						h("label", null, box, h("strong", null, board.title), h("small", null, t("Archive to Files"))),
					);
				}),
			),
		);
	if (store.isLocalInteractive)
		sections.push(
			h(
				"p",
				{ class: "surface-local-note" },
				t("Local preview — changes stay in this browser until Surfaces migrations are deployed."),
			),
		);
	sections.push(h("div", { class: "surface-sheet-actions" }, status, apply));
	dialog.content.append(...sections);
	dialog.open();
}

function automationLine(automation: SurfaceAutomationSummary): string {
	const parts = [automation.scheduleSummary];
	if (automation.lastRunAt) parts.push(t("Last run {time}", { time: fmtTime(automation.lastRunAt) }));
	if (automation.lastOutcomeSummary) parts.push(automation.lastOutcomeSummary);
	return parts.join(" · ");
}

export function openAutomationsSheet(store: SurfacesStore): void {
	const list = h("ul", { class: "surface-automations" });
	const status = h("p", { class: "surface-sheet-status", role: "status" });
	const toggling = new Set<string>();
	let closed = false;
	const draw = () => {
		if (closed) return;
		const state = store.state;
		const rows = state.automations.map((automation) => {
			const toggle = h("button", {
				type: "button",
				class: "surface-switch is-large",
				role: "switch",
				"aria-checked": String(automation.enabled),
				"aria-label": t("Turn {name} on or off", { name: automation.title }),
				disabled: toggling.has(automation.id) || Boolean(state.busy[`automation:${automation.id}`]),
			});
			toggle.addEventListener("click", async () => {
				if (toggling.has(automation.id)) return;
				toggling.add(automation.id);
				toggle.disabled = true;
				try {
					await store.toggleAutomation(automation.id, !automation.enabled);
				} finally {
					toggling.delete(automation.id);
				}
				if (closed) return;
				status.textContent = store.state.error ?? "";
				draw();
			});
			return h(
				"li",
				{ class: automation.enabled ? "" : "is-paused" },
				h("span", { class: "surface-automation-mark" }, interfaceEmblem("pulse", 18)),
				h("div", null, h("strong", null, automation.title), h("small", null, automationLine(automation))),
				toggle,
			);
		});
		list.replaceChildren(
			...(rows.length
				? rows
				: [
						h(
							"li",
							{ class: "surface-automations-empty" },
							t("No automations yet. Background routines appear here once they move out of agents."),
						),
					]),
		);
	};
	const dialog = new SurfaceDialog(t("Automations"), "surface-sheet", () => {
		closed = true;
	});
	const sections: HTMLElement[] = [
		h("h2", null, t("Automations")),
		h(
			"p",
			{ class: "surface-sheet-lead" },
			t("Background routines work quietly and surface results as sessions or decisions."),
		),
		list,
		status,
	];
	if (store.isLocalInteractive)
		sections.push(
			h(
				"p",
				{ class: "surface-local-note" },
				t("Local preview — changes stay in this browser until Surfaces migrations are deployed."),
			),
		);
	if (migrationPending(store.state.migration))
		sections.push(
			h(
				"div",
				{ class: "surface-sheet-actions" },
				h(
					"button",
					{
						type: "button",
						class: "btn",
						onclick: () => {
							dialog.close(false);
							openMigrationSheet(store);
						},
					},
					icon("reset"),
					t("Review the move to Surfaces"),
				),
			),
		);
	dialog.content.append(...sections);
	draw();
	dialog.open();
}

interface SurfacePreset {
	readonly id: string;
	readonly slug: string | null;
	readonly kind: SurfaceKind;
	readonly title: string;
	readonly description: string;
	readonly archetype: "live_build" | "studio";
	readonly folderRoot?: string;
}

const SURFACE_PRESETS: readonly SurfacePreset[] = [
	{
		id: "identity",
		slug: "identity",
		kind: "identity",
		title: phrase("Identity"),
		description: phrase("Global branding, voice, design tokens, and philosophy shared across every product."),
		archetype: "studio",
		folderRoot: "identity",
	},
	{
		id: "website",
		slug: "website",
		kind: "website",
		title: phrase("Website"),
		description: phrase("Marketing site or storefront with live preview and publish."),
		archetype: "live_build",
	},
	{
		id: "web_app",
		slug: "app",
		kind: "web_app",
		title: phrase("Web App"),
		description: phrase("Interactive product or customer portal built in parallel sessions."),
		archetype: "live_build",
	},
	{
		id: "mobile_app",
		slug: "mobile",
		kind: "mobile_app",
		title: phrase("Mobile App"),
		description: phrase("iOS and Android app, previewed in a real phone frame."),
		archetype: "live_build",
	},
	{
		id: "desktop_app",
		slug: "desktop",
		kind: "desktop_app",
		title: phrase("Desktop App"),
		description: phrase("macOS and Windows app in a native window."),
		archetype: "live_build",
	},
	{
		id: "database",
		slug: "database",
		kind: "database",
		title: phrase("Database"),
		description: phrase("Tables, schemas, records, and queries."),
		archetype: "studio",
		folderRoot: "database",
	},
	{
		id: "dashboard",
		slug: "dashboard",
		kind: "dashboard",
		title: phrase("Financial Dashboard"),
		description: phrase("MRR, runway, cashflow, P&L, and KPIs at a glance."),
		archetype: "live_build",
	},
	{
		id: "product",
		slug: "product",
		kind: "product",
		title: phrase("Product Studio"),
		description: phrase("Product specs, colorways, BOM, and design briefs in one place."),
		archetype: "studio",
		folderRoot: "product",
	},
	{
		id: "report",
		slug: "reports",
		kind: "report",
		title: phrase("Report & Analysis"),
		description: phrase("Long-form essays, vendor analyses, and design notes with inline charts and tables."),
		archetype: "studio",
		folderRoot: "reports",
	},
	{
		id: "custom",
		slug: null,
		kind: "custom",
		title: phrase("Custom Surface"),
		description: phrase("Anything else: an inventory tracker, investor room, support desk…"),
		archetype: "live_build",
	},
];

function figureTile(figure: SurfaceFigureId): HTMLElement {
	return h("span", { class: "surface-tile is-sheet", "aria-hidden": "true" }, surfaceFigure(figure));
}

export function openCreateSurfaceSheet(store: SurfacesStore, profileId: string): void {
	let selected: SurfacePreset = SURFACE_PRESETS[0]!;
	let customArchetype: "live_build" | "studio" = "live_build";
	let figure: SurfaceFigureId = surfaceKindFigure(selected.kind);
	let figureChosen = false;
	const dialog = new SurfaceDialog(t("New surface"), "surface-sheet surface-create-sheet", () => undefined);
	const nameInput = h("input", {
		type: "text",
		class: "surface-create-input",
		value: t(selected.title),
		placeholder: t("Surface name"),
		autocomplete: "off",
	});
	let customName = false;
	nameInput.addEventListener("input", () => {
		customName = nameInput.value.trim().length > 0;
	});
	const promptInput = h("textarea", {
		class: "surface-create-prompt",
		rows: 2,
		placeholder: t("Optional: describe the first change to start right away…"),
	});
	const descriptionInput = h("textarea", {
		class: "surface-create-prompt",
		rows: 2,
		placeholder: t("What is this surface for? An agent shapes it from this brief."),
	});
	const status = h("p", { class: "surface-sheet-status", role: "status" });
	const segment = (value: "live_build" | "studio", label: string, hint: string) => {
		const button = h(
			"button",
			{
				type: "button",
				class: value === customArchetype ? "is-on" : "",
				"aria-pressed": String(value === customArchetype),
				title: hint,
			},
			label,
		);
		button.addEventListener("click", () => {
			customArchetype = value;
			for (const other of archetypeRow.querySelectorAll("button")) {
				const on = other === button;
				other.classList.toggle("is-on", on);
				other.setAttribute("aria-pressed", String(on));
			}
		});
		return button;
	};
	const archetypeRow: HTMLElement = h("div", { class: "surface-seg surface-create-seg", role: "group" });
	archetypeRow.append(
		segment("live_build", t("Live preview"), t("Built and previewed live, like a website or app.")),
		segment("studio", t("Studio files"), t("Documents, tables, and specs that sessions edit.")),
	);
	archetypeRow.setAttribute("aria-label", t("How it is built"));
	const figures = surfaceFigureChoices(figure, (id) => {
		figure = id;
		figureChosen = true;
	});
	const customPanel = h(
		"div",
		{ class: "surface-create-custom", hidden: true },
		h("div", { class: "surface-create-field" }, h("span", null, t("How it is built")), archetypeRow),
		h("label", { class: "surface-create-field" }, h("span", null, t("Brief")), descriptionInput),
	);
	const cards = SURFACE_PRESETS.map((preset) => {
		const card = h(
			"button",
			{
				type: "button",
				class: `surface-create-card${preset.id === selected.id ? " is-selected" : ""}`,
				"aria-pressed": String(preset.id === selected.id),
				"data-preset": preset.id,
			},
			figureTile(surfaceKindFigure(preset.kind)),
			h(
				"span",
				{ class: "surface-create-card-copy" },
				h("strong", null, t(preset.title)),
				h("small", null, t(preset.description)),
			),
		);
		card.addEventListener("click", () => {
			selected = preset;
			for (const other of cards) {
				const on = other === card;
				other.classList.toggle("is-selected", on);
				other.setAttribute("aria-pressed", String(on));
			}
			customPanel.hidden = preset.kind !== "custom";
			if (!figureChosen) {
				figure = surfaceKindFigure(preset.kind);
				markSurfaceFigure(figures, figure);
			}
			if (!customName) nameInput.value = preset.kind === "custom" ? "" : t(preset.title);
			if (preset.kind === "custom") nameInput.focus({ preventScroll: true });
		});
		return card;
	});
	const submit = h("button", { type: "submit", class: "btn btn-primary" }, t("Create surface"));
	const form = h(
		"form",
		{ class: "surface-create-form" },
		h("h2", null, t("New surface")),
		h(
			"p",
			{ class: "surface-sheet-lead" },
			t("Each surface is a shared place your sessions build and update together."),
		),
		h("div", { class: "surface-create-grid", role: "group", "aria-label": t("Surface type") }, cards),
		customPanel,
		h("div", { class: "surface-create-field" }, h("span", null, t("Figure")), figures),
		h("label", { class: "surface-create-field" }, h("span", null, t("Name")), nameInput),
		h("label", { class: "surface-create-field" }, h("span", null, t("First session (optional)")), promptInput),
		store.isLocalInteractive
			? h(
					"p",
					{ class: "surface-local-note" },
					t("Local preview — changes stay in this browser until Surfaces migrations are deployed."),
				)
			: null,
		h(
			"div",
			{ class: "surface-sheet-actions" },
			h(
				"a",
				{
					class: "surface-sheet-link",
					href: `#/c/${profileId}/new-program`,
					onclick: () => dialog.close(false),
				},
				t("Import a program instead"),
			),
			status,
			submit,
		),
	);
	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		const title = nameInput.value.trim();
		if (!title) {
			nameInput.focus();
			return;
		}
		submit.disabled = true;
		const custom = selected.kind === "custom";
		const archetype = custom ? customArchetype : selected.archetype;
		const created = await store.createSurface({
			title,
			...(selected.slug ? { slug: selected.slug } : {}),
			archetype,
			icon: surfaceFigureIcon(figure),
			kind: selected.kind,
			folderRoot: custom && archetype === "studio" ? undefined : selected.folderRoot,
			description: custom ? descriptionInput.value.trim() || undefined : undefined,
			initialPrompt: promptInput.value.trim() || undefined,
		});
		if (created) dialog.close(false);
		else {
			submit.disabled = false;
			status.textContent = store.state.error ?? t("That didn't work. Try again.");
		}
	});
	dialog.content.append(form);
	dialog.open();
	nameInput.focus({ preventScroll: true });
	nameInput.select();
}

const SCHEDULE_PRESETS: readonly string[] = [
	phrase("Every day · 09:00"),
	phrase("Every evening · 21:45"),
	phrase("Every Monday · 09:00"),
	phrase("Every hour"),
];

export function openScheduleAgentSheet(store: SurfacesStore, existing?: SurfaceAutomationSummary): void {
	const editing = Boolean(existing);
	const titleText = editing ? t("Scheduled agent") : t("New scheduled agent");
	const dialog = new SurfaceDialog(titleText, "surface-sheet surface-schedule-sheet", () => undefined);
	const nameInput = h("input", {
		type: "text",
		class: "surface-create-input",
		value: existing?.title ?? "",
		placeholder: t("e.g. Weekly cashflow check"),
		autocomplete: "off",
	});
	const initialPrompt = existing
		? (store.state.scheduledAgentPrompts[existing.id] ?? existing.lastOutcomeSummary ?? existing.scheduleSummary)
		: "";
	const promptInput = h(
		"textarea",
		{
			class: "surface-create-prompt",
			rows: 3,
			placeholder: t("What should this agent do each time it runs?"),
		},
		initialPrompt,
	);
	const scheduleInput = h("input", {
		type: "text",
		class: "surface-create-input",
		value: existing?.scheduleSummary ?? t(SCHEDULE_PRESETS[0]!),
		placeholder: t("Every day · 09:00"),
		autocomplete: "off",
	});
	const presets = h(
		"div",
		{ class: "surface-schedule-presets", role: "group", "aria-label": t("Schedule") },
		SCHEDULE_PRESETS.map((preset) => {
			const label = t(preset);
			return h(
				"button",
				{
					type: "button",
					class: "surface-schedule-pill",
					onclick: () => {
						scheduleInput.value = label;
					},
				},
				label,
			);
		}),
	);
	const surfaces = store.state.surfaces.filter((surface) => surface.status === "active");
	const targetSelect = h(
		"select",
		{ class: "surface-sheet-select surface-schedule-select", "aria-label": t("Target surface") },
		h("option", { value: "", selected: !existing?.targetSurfaceSlug }, t("Co-Founder decisions")),
		...surfaces.map((surface) =>
			h("option", { value: surface.slug, selected: existing?.targetSurfaceSlug === surface.slug }, surface.title),
		),
	);
	const status = h("p", { class: "surface-sheet-status", role: "status" });
	const submit = h(
		"button",
		{ type: "submit", class: "btn btn-primary" },
		editing ? t("Save") : t("Create scheduled agent"),
	);
	const remove =
		editing && existing && store.isLocalInteractive && existing.id.startsWith("local-")
			? (() => {
					const button = h("button", { type: "button", class: "btn" }, t("Delete"));
					button.addEventListener("click", async () => {
						if (button.disabled) return;
						button.disabled = true;
						submit.disabled = true;
						const deleted = await store.deleteScheduledAgent(existing.id);
						if (deleted) {
							dialog.close(false);
						} else {
							button.disabled = false;
							submit.disabled = false;
							status.textContent = store.state.error ?? t("That didn't work. Try again.");
						}
					});
					return button;
				})()
			: null;
	const form = h(
		"form",
		{ class: "surface-create-form" },
		h("h2", null, titleText),
		h(
			"p",
			{ class: "surface-sheet-lead" },
			t("A scheduled agent runs its prompt on a clock and surfaces its work where it belongs."),
		),
		h("label", { class: "surface-create-field" }, h("span", null, t("Name")), nameInput),
		h("label", { class: "surface-create-field" }, h("span", null, t("Prompt")), promptInput),
		h("label", { class: "surface-create-field" }, h("span", null, t("Schedule")), scheduleInput, presets),
		h("label", { class: "surface-create-field" }, h("span", null, t("Where results go")), targetSelect),
		store.isLocalInteractive
			? h(
					"p",
					{ class: "surface-local-note" },
					t("Local preview — changes stay in this browser until Surfaces migrations are deployed."),
				)
			: null,
		h("div", { class: "surface-sheet-actions" }, remove, status, submit),
	);
	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		const title = nameInput.value.trim();
		const prompt = promptInput.value.trim();
		if (!title) {
			nameInput.focus();
			return;
		}
		if (!prompt) {
			promptInput.focus();
			return;
		}
		submit.disabled = true;
		const payload = {
			title,
			prompt,
			scheduleSummary: scheduleInput.value.trim() || t(SCHEDULE_PRESETS[0]!),
			targetSurfaceSlug: targetSelect.value || null,
		};
		const done =
			editing && existing
				? await store.updateScheduledAgent(existing.id, payload)
				: await store.createScheduledAgent(payload);
		if (done) dialog.close(false);
		else {
			submit.disabled = false;
			status.textContent = store.state.error ?? t("That didn't work. Try again.");
		}
	});
	dialog.content.append(form);
	dialog.open();
	nameInput.focus({ preventScroll: true });
}
