import { interfaceCell } from "@qorpera/cloud-client/interface-query";
import {
	INTERFACE_OUTSIDE_VALUES_MAX,
	INTERFACE_QUOTE_SOURCES,
	type InterfaceBlock,
	type InterfaceFile,
	interfaceOutsideColumns,
	type TableRow,
} from "@qorpera/cloud-client/interfaces";
import { type MessageQuote, QUOTE_MAX_CHARACTERS, quoteRefFits } from "../../cloud/quotes.ts";
import { button, h, notice, replace, spinner } from "../../ui/dom.ts";
import { interfaceEmblem } from "../../ui/interface-emblem.ts";
import { markdown } from "../../ui/markdown.ts";
import { presentationLocale, t } from "../../ui/preferences.ts";
import type { CompanyController } from "../company.ts";
import { DATA_PAGE } from "../data-page.ts";
import type { InterfaceWrites } from "../interface-claims.ts";
import { companyInterface, interfaceViews, QUOTE_RECORD_COLUMNS, viewBlocks } from "../interfaces.ts";
import type { QuotedText } from "../quotes.ts";
import { renderBank } from "./bank.ts";
import { disposeData, renderData } from "./data.ts";
import { renderMailbox } from "./mailbox.ts";
import { renderMembers } from "./members.ts";

/** What each container last showed, and the element that shows it. The page area is shared with every other
 * page, so a redraw is skipped only while that element is still the one on screen. */
const shownIn = new WeakMap<HTMLElement, { key: string; element: Element }>();

export function shownKey(container: HTMLElement, key: string): void {
	const shown = shownIn.get(container);
	if (shown && container.firstElementChild === shown.element) shown.key = key;
}

/** A block's title (`blockFrame`). It takes the focus from a control that went when the page has none left (`show`),
 * so it can be focused, though not tabbed to. */
const BLOCK_TITLE = ".interface-block > h2";

/** Draws `build()` unless the same key is on screen. Every control names itself with `data-focus-key`, so the
 * one that had keyboard focus (and a text field's caret) has it again after the redraw; `moveFocus` names another. In a
 * redraw of the same view, a focused control that is gone hands the focus on: to the first of its `data-focus-then`
 * keys (a JSON list) still drawn, else to the nearest control after it that is still there, else before it, else to
 * its block's title (a page left with no control). Whatever scrolls names itself with `data-scroll-key` and is
 * where the member left it after the redraw; the first on the page is the page's own, and names its view. */
export function show(container: HTMLElement, key: string, build: () => HTMLElement, moveFocus?: string): void {
	const shown = shownIn.get(container);
	if (shown?.key === key && container.firstElementChild === shown.element && shown.element.isConnected) return;
	const active = document.activeElement;
	const focused = active instanceof HTMLElement && container.contains(active) ? active : null;
	const focusKey = focused?.dataset.focusKey;
	const caret =
		active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
			? ([active.selectionStart, active.selectionEnd] as const)
			: undefined;
	const scrollers = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>("[data-scroll-key]")];
	// Read while that page is still on screen: once it has left, a browser says each is at its top.
	const scrolled =
		shown && container.firstElementChild === shown.element
			? scrollers(shown.element).map((each) => [each.dataset.scrollKey, each.scrollTop] as const)
			: [];
	const element = build();
	const drawn = scrollers(element);
	const sameView = scrolled[0] !== undefined && drawn[0]?.dataset.scrollKey === scrolled[0][0];
	const keyed = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>("[data-focus-key]")];
	const controls = new Map<string, HTMLElement>();
	for (const each of keyed(element)) {
		const named = each.dataset.focusKey;
		if (named !== undefined && !controls.has(named)) controls.set(named, each);
	}
	const control = (named: string | undefined) => (named === undefined ? undefined : controls.get(named));
	let again = control(moveFocus) ?? control(focusKey);
	if (!again && focused && focusKey !== undefined && sameView) {
		// Read from the page still on screen, before it goes.
		const then = focused.dataset.focusThen ? (JSON.parse(focused.dataset.focusThen) as string[]) : [];
		const old = keyed(container);
		const at = old.indexOf(focused);
		const near = [...old.slice(at + 1), ...old.slice(0, at).reverse()]
			.filter((each) => !each.matches(BLOCK_TITLE))
			.map((each) => each.dataset.focusKey);
		const block = focused.closest(".interface-block");
		const title = old.find((each) => each.parentElement === block && each.matches(BLOCK_TITLE))?.dataset.focusKey;
		again = [...then, ...near, title].map(control).find((each) => each !== undefined && !each.matches(":disabled"));
	}
	replace(container, element);
	shownIn.set(container, { key, element });
	again?.focus({ preventScroll: true });
	// The caret goes back only into the field that had it.
	const same = again?.dataset.focusKey === focusKey;
	const field = again instanceof HTMLInputElement || again instanceof HTMLTextAreaElement ? again : undefined;
	if (field && same && caret && field === document.activeElement) field.setSelectionRange(caret[0], caret[1]);
	// Last, so that the focus and the caret move nothing after it.
	for (const each of drawn) {
		const was = scrolled.find(([named]) => named === each.dataset.scrollKey);
		if (was) each.scrollTop = was[1];
	}
}

/** An id an element can carry, from any text. */
function domId(...parts: string[]): string {
	return `iface-${parts.join("-").replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

export function disposeInterface(container: HTMLElement): void {
	disposeData(container);
}

export function renderInterface(
	container: HTMLElement,
	company: CompanyController,
	name: string,
	writes?: InterfaceWrites,
): void {
	const state = company.store.get();
	const profileId = company.profile.profileId;
	const locale = presentationLocale();
	if (state.connectionLost && (!state.team || !state.staff.length)) {
		show(container, JSON.stringify(["reconnecting", profileId, locale]), () =>
			h("section", { class: "page interface-waiting" }, spinner(t("Can't reach Qorpera. Trying again…"))),
		);
		return;
	}
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
		disposeData(container);
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
	if (entry.name !== DATA_PAGE) disposeData(container);
	// The Mailbox draws itself from the company's mail as a mail app does (views/mailbox.ts).
	if (entry.name === "mailbox") {
		renderMailbox(container, company, name, writes?.mailManage ? { manage: writes.mailManage } : {});
		return;
	}
	// The Members page draws who each agent works for (views/members.ts; Jonas, 9 November 2026).
	if (entry.name === "members") {
		renderMembers(container, company, writes?.openSettings ? { openSettings: writes.openSettings } : {});
		return;
	}
	// The Bank page draws itself from the company's bank summary (views/bank.ts).
	if (entry.name === "bank") {
		renderBank(container, company, writes?.bankConnection ? { connection: writes.bankConnection } : {});
		return;
	}
	const databases = entry.name === DATA_PAGE ? writes?.data?.() : undefined;
	if (databases) {
		renderData(container, company, databases, writes?.dataAsk);
		return;
	}
	disposeData(container);
	renderInterfaceFile(container, company, name, entry.file);
}

/** Each definition as JSON, made once: a page is drawn again whenever anything it is drawn from changes. */
const definitions = new WeakMap<InterfaceFile, string>();
function definitionKey(file: InterfaceFile): string {
	let key = definitions.get(file);
	if (key === undefined) {
		key = JSON.stringify(file);
		definitions.set(file, key);
	}
	return key;
}

function renderInterfaceFile(
	container: HTMLElement,
	company: CompanyController,
	name: string,
	file: InterfaceFile,
): void {
	const state = company.store.get();
	const profileId = company.profile.profileId;
	const view = interfaceViews(file)
		.map((each) => ({ name: each.name, blocks: viewBlocks(each, company) }))
		.find((each) => each.blocks.length > 0);
	if (!view) return;
	const blocks = view.blocks.flatMap(({ block }, index) =>
		block.kind === "text" && block.text !== null ? [{ block, key: block.id ?? `${view.name}#${index}` }] : [],
	);
	const widths = blocks.map(({ block }, index) => {
		if (block.width === "full") return "full";
		const partner = (at: number) => blocks[at] !== undefined && blocks[at]?.block.width !== "full";
		return partner(index - 1) || partner(index + 1) ? block.width : "full";
	});
	const live = state.realtime === "connected";
	const key = JSON.stringify([
		profileId,
		company.userId,
		presentationLocale(),
		name,
		definitionKey(file),
		live ? "live" : [state.realtime, state.realtimeError ?? ""],
		widths,
	]);
	show(container, key, () =>
		h(
			"section",
			{ class: "interface", "data-interface": name, "data-profile": profileId },
			h(
				"header",
				{ class: "interface-head" },
				interfaceEmblem(file.emblem, 30),
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
				{
					class: "interface-page",
					id: "interface-view-panel",
					"data-scroll-key": JSON.stringify([profileId, name, view.name]),
				},
				...blocks.map(({ block, key }, index) => textBlock({ ...block, width: widths[index] ?? "full" }, key)),
			),
		),
	);
}

function textBlock(block: InterfaceBlock, key: string): HTMLElement {
	const text = block.text ?? "";
	const prose = text.trim()
		? markdown(text, { links: false, firstParagraph: block.show === "first-paragraph" })
		: undefined;
	return blockFrame(block, key, " interface-text", block.title, prose?.hasChildNodes() ? prose : null);
}

function blockFrame(
	block: InterfaceBlock,
	key: string,
	extra: string,
	title: string | HTMLElement | null,
	...children: (Node | null)[]
): HTMLElement {
	return h(
		"section",
		{ class: `interface-block interface-width-${block.width}${extra}` },
		title ? h("h2", { id: domId("title", key), tabindex: "-1", "data-focus-key": `title:${key}` }, title) : null,
		...children,
	);
}

/** The `{column}` names a button's text fills in, as the cloud client's fill reads them. */
const TEMPLATE_COLUMN = /\{([a-z][a-z0-9_]{0,39})\}/g;

/** An outside value as quoted words: it can't close or open the marks, start a line of its own (a fake quote line,
 * an instruction set apart), or hide text with control or direction characters, and it is cut to the longest a quote
 * may be, between characters, never inside one (an emoji is two UTF-16 units). */
function quotedWords(shown: string): string {
	const flat = shown
		.replace(/«/g, "‹")
		.replace(/»/g, "›")
		.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	const characters = [...flat];
	return characters.length > QUOTE_MAX_CHARACTERS
		? `${characters
				.slice(0, QUOTE_MAX_CHARACTERS - 1)
				.join("")
				.trimEnd()}…`
		: flat;
}

/** The text a `message` button puts in the composer, with its quotes. A value from a column that carries outside
 * content (RUNTIME-INTERFACES.md §4) goes as a quote (contract, the 2026-10-02 amendment "quoted outside content in
 * a member's message"): in «» marks on the same line, with where it came from, so the platform fences those words
 * and the review never reads them as the member's own. An empty value fills in nothing. */
export function messageText(
	text: string,
	row: TableRow,
	source: string,
	nameOf: (column: string, value: unknown) => string,
	quotable: (ref: string) => boolean = () => true,
): QuotedText | undefined {
	const outside = interfaceOutsideColumns(source);
	const recordColumn = Object.hasOwn(QUOTE_RECORD_COLUMNS, source) ? QUOTE_RECORD_COLUMNS[source] : undefined;
	const ref = recordColumn === undefined ? undefined : interfaceCell(row, recordColumn);
	const quotes: MessageQuote[] = [];
	let filled = "";
	// Characters (code points) of `filled`, which the quotes count in.
	let characters = 0;
	const add = (words: string) => {
		filled += words;
		characters += [...words].length;
	};
	let last = 0;
	for (const match of text.matchAll(TEMPLATE_COLUMN)) {
		add(text.slice(last, match.index));
		last = match.index + match[0].length;
		const column = match[1] ?? "";
		const value = interfaceCell(row, column);
		if (value === undefined) continue;
		if (!outside.includes(column)) {
			add(nameOf(column, value));
			continue;
		}
		const words = quotedWords(nameOf(column, value));
		if (!words) continue;
		if (
			!INTERFACE_QUOTE_SOURCES.includes(source) ||
			typeof ref !== "string" ||
			!quoteRefFits(source, ref) ||
			!quotable(ref) ||
			quotes.length >= INTERFACE_OUTSIDE_VALUES_MAX
		)
			return undefined;
		add("«");
		const start = characters;
		add(words);
		quotes.push({ start, end: characters, source, ref });
		add("»");
	}
	add(text.slice(last));
	return { text: filled, quotes };
}
