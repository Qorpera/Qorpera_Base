/* An interface page (`#/c/{id}/i/{name}`): the library's definition drawn from the fixed blocks with the
 * company's live state. Every value is read with the member's own authority through the store the rest of the
 * app reads; the file only arranges blocks and names sources. Text from a file is set as text, never markup. */

import { fillInterfaceText, plainText, queryInterfaceRows } from "@qorpera/cloud-client/interface-query";
import type { InterfaceBlock } from "@qorpera/cloud-client/interfaces";
import { agentFigure } from "../../ui/avatar.ts";
import { h, replace } from "../../ui/dom.ts";
import { interfaceEmblem } from "../../ui/interface-emblem.ts";
import { t } from "../../ui/preferences.ts";
import type { CompanyController } from "../company.ts";
import {
	companyInterface,
	drawableBlock,
	type InterfaceRow,
	interfaceRows,
	interfaceSourceTime,
} from "../interfaces.ts";

/** What each container last showed, so an unchanged page keeps its elements (and its motion). */
const shownIn = new WeakMap<HTMLElement, string>();

export function renderInterface(container: HTMLElement, company: CompanyController, name: string): void {
	const entry = companyInterface(company, name);
	if (!entry) {
		const key = `missing:${name}`;
		if (shownIn.get(container) === key) return;
		shownIn.set(container, key);
		replace(
			container,
			h(
				"section",
				{ class: "page interface-missing" },
				h("p", null, t("This page isn't available here yet.")),
				h("a", { href: `#/c/${company.profile.profileId}` }, t("Back to the company")),
			),
		);
		return;
	}
	const { file } = entry;
	const now = Date.now();
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const clock = { now, startOfToday: today.getTime() };
	const view = file.views[0];
	const blocks = (view?.blocks ?? []).filter(drawableBlock).map((block) => {
		const source = block.from[0] ?? "";
		const rows = interfaceRows(company, source) ?? [];
		const time = interfaceSourceTime(source);
		const kept = new Set(
			queryInterfaceRows(
				rows.map((row) => row.row),
				block.query,
				{ time, clock },
			),
		);
		return { block, rows: rows.filter((row) => kept.has(row.row)) };
	});
	const key = JSON.stringify([name, file.name, blocks.map(({ block, rows }) => [block.title, rows])]);
	if (shownIn.get(container) === key) return;
	shownIn.set(container, key);

	const nameOf = (column: string, value: unknown) => {
		if (typeof value === "string" && ["agent", "from", "handled_by", "kept_by"].includes(column)) {
			return company.staffById(value)?.displayName ?? plainText(value);
		}
		return plainText(value as never);
	};
	replace(
		container,
		h(
			"section",
			{ class: "interface", "data-interface": name },
			h(
				"header",
				{ class: "interface-head" },
				interfaceEmblem(file.emblem, file.colour, 30),
				h(
					"div",
					{ class: "interface-title" },
					h("h1", null, file.name),
					file.about ? h("small", null, file.about) : null,
				),
				h(
					"span",
					{ class: "interface-live" },
					h("span", { class: "interface-live-dot", "aria-hidden": "true" }),
					t("Live"),
				),
			),
			h(
				"div",
				{ class: "interface-page" },
				...blocks.map(({ block, rows }) =>
					listBlock(block, rows, nameOf, (agentId) =>
						agentFigure(company.staffById(agentId), nameOf("agent", agentId), { size: 30 }),
					),
				),
			),
		),
	);
}

function listBlock(
	block: InterfaceBlock,
	rows: readonly InterfaceRow[],
	nameOf: (column: string, value: unknown) => string,
	figureOf: (agentId: string) => HTMLElement,
): HTMLElement {
	const cards = block.layout === "cards";
	const items = rows.map(({ row, href, live }) => {
		const agentId = block.figure ? row[block.figure] : undefined;
		const line = fillInterfaceText(block.line ?? "{title}", row, nameOf);
		const sub = block.sub ? fillInterfaceText(block.sub, row, nameOf) : "";
		const status = block.status ? nameOf(block.status, row[block.status]) : "";
		const figure = typeof agentId === "string" ? figureOf(agentId) : null;
		const body = [
			figure ? h("span", { class: "interface-item-figure" }, figure) : null,
			h(
				"span",
				{ class: "interface-item-copy" },
				h(
					"strong",
					null,
					typeof agentId === "string" && block.figure === "agent" ? nameOf("agent", agentId) : line,
				),
				typeof agentId === "string" && block.figure === "agent"
					? h("small", null, line)
					: sub
						? h("small", null, sub)
						: null,
			),
			status ? h("span", { class: "interface-item-status" }, status) : null,
			live ? h("span", { class: "interface-dots", "aria-hidden": "true" }, h("i"), h("i"), h("i")) : null,
		];
		return h(
			"li",
			null,
			href ? h("a", { class: "interface-item", href }, ...body) : h("div", { class: "interface-item" }, ...body),
		);
	});
	return h(
		"section",
		{ class: `interface-block interface-width-${block.width}${cards ? " interface-cards" : ""}` },
		block.title ? h("h2", null, block.title) : null,
		items.length
			? h("ul", { class: "interface-list" }, ...items)
			: h("p", { class: "interface-empty" }, t("Nothing here right now.")),
	);
}
