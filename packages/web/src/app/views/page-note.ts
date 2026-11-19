import { h, icon } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import { DATA_PAGE } from "../data-page.ts";
import { type AppLook, pageLook } from "./shell.ts";

export function pageNoteApp(page: string): { name: string; look: AppLook; key: string } {
	const look = pageLook(page);
	const name = page === DATA_PAGE ? "Data" : page;
	return { name, look, key: `${name}\u0000${look.key}` };
}

export function pageNoteCard(page: string, at: string | null, about: string): HTMLElement {
	const { name, look } = pageNoteApp(page);
	return h(
		"button",
		{
			type: "button",
			class: "app-card is-note",
			dataset: { openPage: page, ...(at === null ? {} : { openAt: at }) },
			title: t("Open {name}", { name }),
			...(look.colour ? { style: `--app-colour: ${look.colour}` } : {}),
		},
		h("span", { class: "app-card-emblem", "aria-hidden": "true" }, look.emblem()),
		h(
			"span",
			{ class: "app-card-copy" },
			h("strong", { class: "app-card-title" }, name),
			h("small", { class: "app-card-note", title: about }, about),
		),
		h("span", { class: "app-card-go", "aria-hidden": "true" }, icon("chevron")),
	);
}
