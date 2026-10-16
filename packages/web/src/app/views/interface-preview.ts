/* A review card's preview (Interfaces step I10; deploy/first-node/RUNTIME-INTERFACES.md §7 and §10): the pages a save
 * an agent asks to make would leave, drawn under its card while the card waits, as the Interfaces tab would draw them
 * (views/interface.ts). They are drawn from the folder as last read, with each table the save changes read by its new
 * definition and each table it makes empty (app/interfaces.ts `withPreview`), and drawn again with the thread, so they
 * stay live. Nothing in a preview can be used: it is inert, and its ids are dropped so they never clash with the page
 * itself. A page's mail blocks are not previewed. */

import {
	type InterfaceFile,
	isInterfaceName,
	parseInterfaceFile,
	parseTableFile,
} from "@qorpera/cloud-client/interfaces";
import { record } from "../../cloud/parse.ts";
import type { ActionReviewCard } from "../../cloud/review-rules.ts";
import { h, replace } from "../../ui/dom.ts";
import { presentationLocale, t } from "../../ui/preferences.ts";
import type { CompanyController } from "../company.ts";
import { interfaceViews, type ProposedTable, viewBlocks, withPreview } from "../interfaces.ts";
import { forgetInterfacePage, renderInterfaceFile } from "./interface.ts";

/** What a save an agent asks to make would leave: the pages and tables it saves, by folder name. */
export interface ProposedSave {
	readonly pages: readonly { readonly name: string; readonly file: InterfaceFile }[];
	readonly tables: ReadonlyMap<string, ProposedTable>;
}

const PAGE = /^interfaces\/([^/]+)\/interface\.toml$/;
const TABLE = /^tables\/([^/]+)\/table\.toml$/;
/** The attributes that name or point at an id. */
const ID_ATTRIBUTES = ["id", "for", "aria-labelledby", "aria-describedby", "aria-controls"];

/** The pages and tables a review card's `save_interface` call would save, read from the exact call the card covers; or
 * null when it saves no page that parses. A file the save makes has no version yet (`expectedVersion` null). A file
 * that doesn't parse is left out: the save refuses it before it is ever reviewed. */
export function proposedSave(card: ActionReviewCard): ProposedSave | null {
	if (card.tool !== "save_interface") return null;
	let files: unknown;
	try {
		const call = record(JSON.parse(card.arguments ?? ""), "save_interface call");
		files = record(call.input ?? call, "save_interface input").files;
	} catch {
		return null;
	}
	const pages: { name: string; file: InterfaceFile }[] = [];
	const tables = new Map<string, ProposedTable>();
	for (const item of Array.isArray(files) ? files : []) {
		const { path, text, expectedVersion } = (item ?? {}) as Record<string, unknown>;
		if (typeof path !== "string" || typeof text !== "string") continue;
		const page = PAGE.exec(path)?.[1];
		const table = TABLE.exec(path)?.[1];
		if (page !== undefined && isInterfaceName(page)) {
			const read = parseInterfaceFile(text);
			if (read.ok) pages.push({ name: page, file: read.file });
		} else if (table !== undefined && isInterfaceName(table)) {
			const read = parseTableFile(text);
			if (read.ok) tables.set(table, { table: read.file, created: expectedVersion === null });
		}
	}
	return pages.length > 0 ? { pages, tables } : null;
}

/** A save's pages as they would look, which the thread keeps for its card while it waits and draws again with the
 * thread. */
export class InterfacePreview {
	readonly element: HTMLElement;
	readonly #company: CompanyController;
	readonly #save: ProposedSave;
	readonly #pages: readonly { readonly name: string; readonly file: InterfaceFile; readonly container: HTMLElement }[];
	/** What the last draw read: the company's state and the language. */
	#drawn: readonly [unknown, string] | undefined;

	constructor(company: CompanyController, reviewId: string, save: ProposedSave) {
		this.#company = company;
		this.#save = save;
		// Drawn under its own name, so what is chosen on the page itself is never the preview's.
		this.#pages = save.pages.map((page) => ({
			name: `preview:${reviewId}:${page.name}`,
			file: page.file,
			container: h("div", { class: "review-preview-page" }),
		}));
		this.element = h(
			"figure",
			{ class: "review-preview", inert: true, hidden: true },
			h("figcaption", null, t("How the page will look")),
			...this.#pages.map((page) => page.container),
		);
		this.draw();
	}

	/** The pages it draws: the folder reader reads what they read too (app/interface-folder.ts `preview`). */
	get pages(): readonly InterfaceFile[] {
		return this.#save.pages.map((page) => page.file);
	}

	/** Draws the pages again when what they read may have changed since the last draw: the company's state (the folder
	 * as last read among it) or the language. Not for each key the member types in the thread. */
	refresh(): void {
		const [state, locale] = this.#drawn ?? [];
		if (state !== this.#company.store.get() || locale !== presentationLocale()) this.draw();
	}

	/** Draws the pages again from the folder as last read. A page with nothing to draw yet (its tables not read) is
	 * left out, and the preview is hidden while none has. */
	draw(): void {
		this.#drawn = [this.#company.store.get(), presentationLocale()];
		withPreview(this.#save.tables, () => {
			for (const page of this.#pages) {
				if (interfaceViews(page.file).some((view) => viewBlocks(view, this.#company).length > 0))
					renderInterfaceFile(page.container, this.#company, page.name, page.file, () => this.draw());
				else replace(page.container);
			}
		});
		for (const named of this.element.querySelectorAll(ID_ATTRIBUTES.map((name) => `[${name}]`).join(", ")))
			for (const name of ID_ATTRIBUTES) named.removeAttribute(name);
		this.element.hidden = this.#pages.every((page) => page.container.childElementCount === 0);
	}

	/** Forgets what was chosen on its pages, once its card is answered or gone. */
	dispose(): void {
		for (const page of this.#pages) forgetInterfacePage(this.#company, page.name);
	}
}
