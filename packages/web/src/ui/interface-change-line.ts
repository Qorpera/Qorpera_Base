import { withProblems } from "../cloud/company-folder-writes.ts";
import {
	type InterfaceChange,
	type InterfaceChangeSubject,
	type InterfaceUndo,
	interfaceChangeSubjects,
} from "../cloud/interface-changes.ts";
import { h } from "./dom.ts";
import { presentationLocale, t } from "./preferences.ts";

/* An agent's change to the company's interfaces or tables in its thread (Interfaces I10, RUNTIME-INTERFACES.md §7): one
 * centered line in plain words, never its files, with Undo. A change that needs no review is saved at once; Undo takes
 * it back as the member's own change. */

/** Interfaces and tables a line names one by one; it counts the rest. */
const NAMED = 4;

/** Undo of one change in this thread, as it stands. `failed`: it threw; nothing is known to be undone. */
export type InterfaceUndoState =
	| { readonly state: "sending" }
	| { readonly state: "answered"; readonly answer: InterfaceUndo }
	| { readonly state: "failed" };

/** A name on one line and at most 120 characters. */
function clip(value: string): string {
	const characters = Array.from(value.replace(/\s+/g, " ").trim());
	return characters.length > 120 ? `${characters.slice(0, 119).join("")}…` : characters.join("");
}

/** The change in plain words: what it made, changed and deleted, each interface or table by its title (`title`, the
 * folder's name when it has none). */
export function interfaceChangeText(
	change: InterfaceChange,
	title: (subject: InterfaceChangeSubject) => string | undefined,
): string {
	const { subjects, order } = interfaceChangeSubjects(change);
	const list = new Intl.ListFormat(presentationLocale(), { style: "long", type: "conjunction" });
	const named = subjects.slice(0, NAMED);
	const things = (how: InterfaceChangeSubject["how"]) =>
		named
			.filter((subject) => subject.how === how)
			.map((subject) => {
				const name = clip(title(subject) || subject.name) || subject.name;
				return subject.kind === "interface"
					? t("the interface “{name}”", { name })
					: t("the table “{name}”", { name });
			});
	const made = things("made");
	const changed = [...things("changed"), ...(order ? [t("the order of the interfaces")] : [])];
	const removed = things("removed");
	const clauses = [
		...(made.length ? [t("made {things}", { things: list.format(made) })] : []),
		...(changed.length ? [t("changed {things}", { things: list.format(changed) })] : []),
		...(removed.length ? [t("deleted {things}", { things: list.format(removed) })] : []),
	];
	const more = subjects.length - named.length;
	if (more === 1) clauses.push(t("1 other change"));
	else if (more > 1) clauses.push(t("{count} other changes", { count: more }));
	const text = list.format(clauses);
	return `${text.charAt(0).toLocaleUpperCase(presentationLocale())}${text.slice(1)}`;
}

/** Why Undo did not take everything back, in plain words. */
function undoNote(answer: InterfaceUndo): string {
	switch (answer.outcome) {
		case "undone":
			return t("Undone.");
		case "changed":
			return t("Not undone: it changed again since.");
		case "too_large":
			return t("This change is too large to undo here. Ask the agent to change it back.");
		case "unavailable":
			return t("This change can't be undone here. Ask the agent to change it back.");
		case "not_saved": {
			const { result } = answer;
			// A refusal's problems are the core's, in English, as every other refusal of a member's change shows them.
			const reason =
				result.outcome === "denied"
					? t("You don't have access to change this.")
					: result.outcome === "refused"
						? withProblems(
								t("The Company File refused it."),
								result.problems.map((problem) => problem.message),
							)
						: result.outcome === "conflict"
							? t("It changed again since.")
							: t("It wasn't saved.");
			return answer.saved > 0 ? t("Undone in part. {reason}", { reason }) : t("Not undone. {reason}", { reason });
		}
	}
}

/** The line, with Undo when `undo` is given and it was not answered yet: the member can write, and Undo can take this
 * change back at all. Focus stays on the line (`data-interface-change`) through a redraw. */
export function renderInterfaceChangeLine(
	change: InterfaceChange,
	text: string,
	options: { state?: InterfaceUndoState; undo?: () => void },
): HTMLElement {
	const { state, undo } = options;
	const status =
		state?.state === "answered"
			? undoNote(state.answer)
			: state?.state === "failed"
				? t("Could not undo. Try again.")
				: null;
	const offered = undo !== undefined && state?.state !== "answered";
	const sending = state?.state === "sending";
	const undone = state?.state === "answered" && state.answer.outcome === "undone";
	return h(
		"div",
		{ class: "interface-change", role: "note", "data-interface-change": change.commitId, tabindex: "-1" },
		h("span", { class: "interface-change-text" }, text),
		offered
			? h(
					"button",
					{
						type: "button",
						class: "interface-change-undo",
						disabled: sending,
						// The line says what it takes back; the button alone says only "Undo".
						"aria-label": sending ? null : t("Undo: {change}", { change: text }),
						onclick: undo,
					},
					sending ? t("Undoing…") : t("Undo"),
				)
			: null,
		status
			? h("span", { class: undone ? "interface-change-status" : "interface-change-status failed" }, status)
			: null,
	);
}
