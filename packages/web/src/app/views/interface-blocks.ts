import type { InterfaceBlock } from "@qorpera/cloud-client/interfaces";
import { h } from "../../ui/dom.ts";
import { markdown } from "../../ui/markdown.ts";
import { t } from "../../ui/preferences.ts";
import type { InterfaceRow } from "../interfaces.ts";

/** What the page gives a block this module draws. */
export interface BlockKit {
	/** The block's frame, with its title, and a class for the block. */
	readonly frame: (extra: string, ...children: (Node | null)[]) => HTMLElement;
	/** Its source's problems, or null. */
	readonly note: HTMLElement | null;
	readonly readable: boolean;
}

const empty = (kit: BlockKit) =>
	kit.readable ? h("p", { class: "interface-empty" }, t("Nothing here right now.")) : null;

/** A text block: its own text, or its file's (`vision` or `file:`), as markdown with no HTML, no link out of the page
 * and no image fetched: a link is drawn as its text and an image as its alt text. */
export function textBlock(
	{ block, rows }: { readonly block: InterfaceBlock; readonly rows: readonly InterfaceRow[] },
	kit: BlockKit,
): HTMLElement {
	const read = rows[0]?.row.text;
	const text = block.text ?? (typeof read === "string" ? read : "");
	const prose = text.trim()
		? markdown(text, { links: false, firstParagraph: block.show === "first-paragraph" })
		: undefined;
	return kit.frame(
		" interface-text",
		kit.note,
		prose?.hasChildNodes() ? prose : block.text === null ? empty(kit) : null,
	);
}
