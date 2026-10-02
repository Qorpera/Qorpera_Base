/* An interface page (`#/c/{id}/i/{name}`): the library's definition drawn from the fixed blocks with the
 * company's live state. Every value is read with the member's own authority through the store the rest of the
 * app reads; the file only arranges blocks and names sources. Text from a file is set as text, never markup. */

import { fillInterfaceText, plainText, queryInterfaceRows } from "@qorpera/cloud-client/interface-query";
import type { InterfaceBlock, TableRow } from "@qorpera/cloud-client/interfaces";
import { agentFigure } from "../../ui/avatar.ts";
import { button, h, notice, replace, spinner } from "../../ui/dom.ts";
import { interfaceEmblem } from "../../ui/interface-emblem.ts";
import { presentationLocale, t } from "../../ui/preferences.ts";
import type { CompanyController } from "../company.ts";
import {
	companyInterface,
	drawableBlock,
	type InterfaceRow,
	interfaceRows,
	interfaceSourceTime,
} from "../interfaces.ts";

/** What each container last showed, and the element that shows it. The page area is shared with every other
 * page, so a redraw is skipped only while that element is still the one on screen. */
const shownIn = new WeakMap<HTMLElement, { key: string; element: Element }>();

function show(container: HTMLElement, key: string, build: () => HTMLElement): void {
	const shown = shownIn.get(container);
	if (shown?.key === key && container.firstElementChild === shown.element && shown.element.isConnected) return;
	const element = build();
	replace(container, element);
	shownIn.set(container, { key, element });
}

export function renderInterface(container: HTMLElement, company: CompanyController, name: string): void {
	const state = company.store.get();
	const profileId = company.profile.profileId;
	const locale = presentationLocale();
	if (state.loading && !state.staff.length) {
		show(container, JSON.stringify(["loading", profileId, locale]), () =>
			h("section", { class: "page interface-waiting" }, spinner(t("Opening company"))),
		);
		return;
	}
	if (state.error && !state.staff.length) {
		show(container, JSON.stringify(["error", profileId, locale, state.error]), () =>
			h(
				"section",
				{ class: "page interface-waiting" },
				notice(
					"danger",
					state.error ?? "",
					button(t("Retry company"), () => void company.refreshAll(), { small: true }),
				),
			),
		);
		return;
	}
	const entry = companyInterface(company, name);
	if (!entry) {
		show(container, JSON.stringify(["missing", profileId, locale, name]), () =>
			h(
				"section",
				{ class: "page interface-missing" },
				h("p", null, t("This page isn't available here yet.")),
				h("a", { href: `#/c/${profileId}` }, t("Back to the company")),
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
		// The query decides which rows show and in what order; each row keeps the link it came with.
		const byRow = new Map<TableRow, InterfaceRow>(rows.map((row) => [row.row, row]));
		const shownRows = queryInterfaceRows(
			rows.map((row) => row.row),
			block.query,
			{ time: interfaceSourceTime(source), clock },
		).flatMap((row) => byRow.get(row) ?? []);
		return { block, rows: shownRows };
	});
	// A part-width block whose neighbours have no source today stands alone, so it takes the whole row.
	const widths = blocks.map(({ block }, index) => {
		if (block.width === "full") return "full";
		const partner = (at: number) => blocks[at] !== undefined && blocks[at]?.block.width !== "full";
		return partner(index - 1) || partner(index + 1) ? block.width : "full";
	});
	const nameOf = (column: string, value: unknown) => {
		if (typeof value === "string" && ["agent", "from", "handled_by", "kept_by"].includes(column)) {
			return company.staffById(value)?.displayName ?? plainText(value);
		}
		return plainText(value as never);
	};
	// The agents a page shows, by how they look, so a rename or a new figure redraws it.
	const agentLooks = [
		...new Set(blocks.flatMap(({ block, rows }) => rows.map(({ row }) => (block.figure ? row[block.figure] : null)))),
	]
		.filter((id): id is string => typeof id === "string")
		.map((id) => {
			const agent = company.staffById(id);
			return [id, agent?.displayName, agent?.appearance];
		});
	const live = state.realtime === "connected";
	const key = JSON.stringify([
		profileId,
		locale,
		name,
		file.name,
		file.about,
		live ? "live" : [state.realtime, state.realtimeError ?? ""],
		widths,
		agentLooks,
		blocks.map(({ block, rows }) => [block.title, rows]),
	]);
	show(container, key, () =>
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
					{ class: `interface-live${live ? "" : " is-degraded"}`, role: "status" },
					h("span", { class: "interface-live-dot", "aria-hidden": "true" }),
					live ? t("Live") : state.realtime === "connecting" ? t("connecting") : t("live updates degraded"),
				),
			),
			h(
				"div",
				{ class: "interface-page" },
				...blocks.map(({ block, rows }, index) =>
					listBlock({ ...block, width: widths[index] ?? "full" }, rows, nameOf, (agentId) =>
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
		const byAgent = typeof agentId === "string" && block.figure === "agent";
		const body = [
			typeof agentId === "string" ? h("span", { class: "interface-item-figure" }, figureOf(agentId)) : null,
			h(
				"span",
				{ class: "interface-item-copy" },
				h("strong", null, byAgent ? nameOf("agent", agentId) : line),
				byAgent ? h("small", null, line) : sub ? h("small", null, sub) : null,
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
