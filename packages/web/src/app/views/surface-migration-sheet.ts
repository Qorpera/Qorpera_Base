import type { ApplySurfaceMigrationInput } from "@qorpera/cloud-client/surfaces";
import type { SurfaceAutomationSummary, SurfaceMigrationChecklist } from "@qorpera/contracts";
import { SurfaceDialog } from "../../ui/dialog.ts";
import { fmtTime, h, icon } from "../../ui/dom.ts";
import { interfaceEmblem } from "../../ui/interface-emblem.ts";
import { t } from "../../ui/preferences.ts";
import { migrationPending, type SurfacesStore } from "../surfaces-store.ts";

type AgentAction = ApplySurfaceMigrationInput["agentDecisions"][number]["action"];

function agentActionLabel(action: AgentAction): string {
	switch (action) {
		case "fold_to_automation":
			return t("Fold into an Automation");
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
	const draw = () => {
		const state = store.state;
		const rows = state.automations.map((automation) => {
			const toggle = h("button", {
				type: "button",
				class: "surface-switch is-large",
				role: "switch",
				"aria-checked": String(automation.enabled),
				"aria-label": t("Turn {name} on or off", { name: automation.title }),
				disabled: Boolean(state.busy[`automation:${automation.id}`]),
			});
			toggle.addEventListener("click", async () => {
				await store.toggleAutomation(automation.id, !automation.enabled);
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
	const dialog = new SurfaceDialog(t("Automations"), "surface-sheet", () => undefined);
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
