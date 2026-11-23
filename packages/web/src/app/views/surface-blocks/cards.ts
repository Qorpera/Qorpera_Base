import type { SurfaceCardsBlock, SurfaceCardsFromBlock, SurfaceCardsItemsBlock } from "@qorpera/contracts";
import { h } from "../../../ui/dom.ts";
import {
	formatScalar,
	isPlainRecord,
	isShownScalar,
	readableName,
	type SurfaceBlockContext,
	type SurfaceBlockPrepared,
	sameValue,
	sectionHead,
	sourceFile,
} from "./context.ts";

interface Card {
	readonly title: string;
	readonly badge?: string;
	readonly lines: readonly { readonly key: string; readonly value: string }[];
	readonly changed: boolean;
}

const ABBREVIATION_CHARS = 3;

function lineText(key: string, value: string): string {
	return key.length <= ABBREVIATION_CHARS ? `${key.toUpperCase()} ${value}` : value;
}

function shown(value: unknown): string | undefined {
	if (isShownScalar(value)) return formatScalar(value);
	if (Array.isArray(value) && value.length > 0 && value.every(isShownScalar)) return formatScalar(value);
	return undefined;
}

const EMPTY_LINES = [0, 1];

interface NamedCard {
	readonly title: string;
	readonly text?: string;
	readonly lines?: readonly string[];
	readonly changed: boolean;
}

function namedCard(title: string, value: unknown, found: boolean, changed: boolean): NamedCard {
	if (found && isShownScalar(value)) return { title, text: formatScalar(value), changed };
	if (found && Array.isArray(value)) {
		const lines = value.flatMap((item) => (isShownScalar(item) ? [formatScalar(item)] : []));
		if (lines.length) return { title, lines, changed };
	}
	return { title, changed };
}

function prepareNamedCards(block: SurfaceCardsItemsBlock, ctx: SurfaceBlockContext): SurfaceBlockPrepared {
	const cards = block.items.map((item) => {
		const read = ctx.read(item.from);
		return namedCard(ctx.words(item.title), read.value, read.found, read.changed);
	});
	const filled = cards.some((card) => card.text !== undefined || card.lines !== undefined);
	const heading = block.heading ? ctx.words(block.heading) : "";
	const changed = cards.some((card) => card.changed);
	return {
		filled,
		pieces: [
			{
				build: () =>
					h(
						"section",
						{ class: "studio-section studio-vendors", "data-block": "cards" },
						heading ? sectionHead(heading, changed) : null,
						h(
							"div",
							{ class: "studio-vendor-grid" },
							cards.map((card) => {
								const empty = card.text === undefined && card.lines === undefined;
								return h(
									"article",
									{
										class: `studio-vendor-card studio-named-card${empty ? " is-empty" : ""}${card.changed ? " is-changed" : ""}`,
									},
									h("div", { class: "studio-vendor-top" }, h("strong", null, card.title)),
									card.text !== undefined
										? h("p", { class: "studio-card-text" }, card.text)
										: card.lines
											? h(
													"ul",
													{ class: "studio-card-lines" },
													card.lines.map((line) => h("li", null, line)),
												)
											: h(
													"div",
													{ class: "studio-card-lines is-empty", "aria-hidden": "true" },
													EMPTY_LINES.map(() => h("span", { class: "studio-pale-bar" })),
												),
								);
							}),
						),
					),
			},
		],
	};
}

export function prepareCards(block: SurfaceCardsBlock, ctx: SurfaceBlockContext): SurfaceBlockPrepared {
	return "items" in block ? prepareNamedCards(block, ctx) : prepareListCards(block, ctx);
}

function prepareListCards(block: SurfaceCardsFromBlock, ctx: SurfaceBlockContext): SurfaceBlockPrepared {
	const read = ctx.read(block.from);
	const baseList = Array.isArray(read.base) ? read.base : [];
	const cards: Card[] = Array.isArray(read.value)
		? read.value.flatMap((item, index): Card[] => {
				if (!isPlainRecord(item)) return [];
				const title = shown(item[block.title]);
				if (title === undefined) return [];
				const badge = block.badge ? shown(item[block.badge]) : undefined;
				return [
					{
						title,
						...(badge !== undefined ? { badge } : {}),
						lines: block.lines.flatMap((key) => {
							const value = shown(item[key]);
							return value === undefined ? [] : [{ key, value }];
						}),
						changed: !sameValue(baseList[index], item),
					},
				];
			})
		: [];
	const file = sourceFile(read.binding);
	const heading = block.heading ? ctx.words(block.heading) : file ? readableName(file) : "";
	return {
		filled: cards.length > 0,
		pieces: [
			{
				build: () =>
					h(
						"section",
						{ class: "studio-section studio-vendors", "data-block": "cards" },
						heading ? sectionHead(heading, false) : null,
						h(
							"div",
							{ class: "studio-vendor-grid" },
							cards.length
								? cards.map((card) => {
										const first = card.lines[0]?.key === block.lines[0] ? card.lines[0] : undefined;
										const rest = first ? card.lines.slice(1) : card.lines;
										return h(
											"article",
											{ class: `studio-vendor-card${card.changed ? " is-changed" : ""}` },
											h(
												"div",
												{ class: "studio-vendor-top" },
												h("strong", null, card.title),
												card.badge !== undefined
													? h("span", { class: "studio-vendor-status" }, card.badge)
													: null,
											),
											first ? h("p", { class: "studio-vendor-comp" }, first.value) : null,
											rest.length
												? h(
														"div",
														{ class: "studio-vendor-meta" },
														rest.map((line) => h("span", null, lineText(line.key, line.value))),
													)
												: null,
										);
									})
								: [0, 1].map(() =>
										h("article", { class: "studio-vendor-card is-empty", "aria-hidden": "true" }),
									),
						),
					),
			},
		],
	};
}
