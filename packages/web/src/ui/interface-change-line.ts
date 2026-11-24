import {
	type InterfaceChange,
	type InterfaceChangeSubject,
	interfaceChangeSubjects,
} from "../cloud/interface-changes.ts";
import { h } from "./dom.ts";
import { presentationLocale, t } from "./preferences.ts";

const NAMED = 4;

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

export function renderInterfaceChangeLine(change: InterfaceChange, text: string): HTMLElement {
	return h(
		"div",
		{ class: "interface-change", role: "note", "data-interface-change": change.commitId, tabindex: "-1" },
		h("span", { class: "interface-change-text" }, text),
	);
}
