import type { FolderProposal, FolderProposalFile, FolderProposalUnit } from "../cloud/proposals.ts";
import { readableFileName } from "./authorization-card.ts";
import { h } from "./dom.ts";
import { phrase, t } from "./preferences.ts";

/* A member's open proposal in the agent's thread (P40c): what an agent saved through a view and that waits for review,
 * as its changes in plain words (the run's card says them the same way, cloud-folder-proposals.ts), never its files. The
 * agent's run applies it once the member agrees; the member can discard it here. */

/** Changes a card names one by one; it counts the rest. */
const CARD_CHANGES = 8;

/** Where the agent saved it, by the kind of view. */
const SAVED_ON = new Map([
	["computer_desktop", phrase("a computer")],
	["computer_shell_command", phrase("a command on a computer")],
	["coding_session", phrase("a coding session")],
	["test_machine", phrase("a test machine")],
	["run_box", phrase("the agent's workspace")],
]);

function parentOf(path: string): string {
	return path.split("/").slice(0, -1).join("/");
}

/** A name from a file's parse, on one line and at most 120 characters, else the file's own name: an agent.md or a
 * group.md is named by its folder. */
function nameOf(file: FolderProposalFile, value: string | undefined): string {
	const text = value?.replace(/\s+/g, " ").trim();
	if (text) {
		const characters = Array.from(text);
		return characters.length > 120 ? `${characters.slice(0, 119).join("")}…` : text;
	}
	const base = file.path.split("/").at(-1) ?? "";
	return readableFileName(base.replace(/\.[^.]*$/, "") === file.kind ? parentOf(file.path) || file.path : file.path);
}

/** One change in plain words: by the structured file it writes (an agent, a group chat, a routine, an interface, a
 * table), else by its op. `createsAgent` is the proposal's: an active agent.md is then a hire, else an agent made
 * active again. */
export function proposalChange(unit: FolderProposalUnit, createsAgent: boolean): string {
	const file = (kind: string) => unit.structured.find((item) => item.kind === kind);
	const agent = file("agent");
	if (agent) {
		const name = nameOf(agent, agent.name);
		if (agent.status === "archived") return t("Archive the agent “{name}”", { name });
		if (!createsAgent) return t("Make the agent “{name}” active again", { name });
		const role = agent.role?.replace(/\s+/g, " ").trim();
		return role ? t("Hire “{name}” as {role}", { name, role: nameOf(agent, role) }) : t("Hire “{name}”", { name });
	}
	const group = file("group");
	if (group) return t("Start the group chat “{name}”", { name: nameOf(group, group.name) });
	const routine = file("routine");
	if (routine) {
		const name = nameOf(routine, routine.title);
		if (routine.status === "paused") return t("Pause the routine “{name}”", { name });
		if (routine.status === "concluded") return t("End the routine “{name}”", { name });
		return t("Set up or change the routine “{name}”", { name });
	}
	const shown = file("interface");
	if (shown) return t("Set up or change the interface “{name}”", { name: nameOf(shown, shown.name) });
	const table = file("table");
	if (table) return t("Set up or change the table “{name}”", { name: nameOf(table, table.name) });
	const name = readableFileName(unit.path);
	const parent = parentOf(unit.path);
	if (unit.op === "delete")
		return parent
			? t("Delete “{name}” from “{parent}”", { name, parent: readableFileName(parent) })
			: t("Delete “{name}”", { name });
	if (unit.op === "move" && unit.to !== undefined) {
		const to = parentOf(unit.to);
		if (to === parent) {
			// Names that read the same keep their file names (7 November 2026: Blender's room.blend to room.blend1).
			const toName = readableFileName(unit.to);
			if (toName !== name) return t("Rename “{name}” to “{to}”", { name, to: toName });
			const base = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;
			return t("Rename “{name}” to “{to}”", { name: base(unit.path), to: base(unit.to) });
		}
		return to
			? t("Move “{name}” to “{to}”", { name, to: readableFileName(to) })
			: t("Move “{name}” to the top of the Company File", { name });
	}
	return t("Change “{name}”", { name });
}

export function renderProposalCard(
	proposal: FolderProposal,
	options: { discarding: boolean; discard: () => void },
): HTMLElement {
	const changes = proposal.units.slice(0, CARD_CHANGES).map((unit) => proposalChange(unit, proposal.createsAgent));
	const more = proposal.unitCount - changes.length;
	const headline =
		proposal.unitCount === 1 ? (changes[0] ?? "") : t("{count} saved changes", { count: proposal.unitCount });
	return h(
		"article",
		{
			class: "auth-card action-review-card proposal-card",
			"data-proposal-id": proposal.proposalId,
			tabindex: "-1",
		},
		h("h3", { class: "review-headline" }, headline),
		proposal.unitCount > 1
			? h(
					"div",
					{ class: "review-change" },
					...changes.map((change) => h("p", null, change)),
					more > 0 ? h("p", { class: "proposal-more" }, t("And {count} more.", { count: more })) : null,
				)
			: null,
		h(
			"p",
			{ class: "review-waiting" },
			t("From {place}. Not in the Company File yet.", { place: t(SAVED_ON.get(proposal.viewKind) ?? "a computer") }),
		),
		h(
			"div",
			{ class: "review-answer" },
			h(
				"div",
				{ class: "decision-actions" },
				h(
					"button",
					{ type: "button", class: "btn", disabled: options.discarding, onclick: options.discard },
					options.discarding ? t("Discarding…") : t("Discard"),
				),
			),
		),
	);
}
