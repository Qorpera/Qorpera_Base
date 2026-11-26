import {
	isSurfaceAskSource,
	SURFACE_FACT_FIGURE_CHARS,
	type SurfaceAskSource,
	type SurfaceFactsBlock,
	type SurfaceFactsFromBlock,
} from "@qorpera/contracts";
import { h, icon } from "../../../ui/dom.ts";
import { t } from "../../../ui/preferences.ts";
import {
	formatScalar,
	homeLocked,
	isPlainRecord,
	isShownScalar,
	readableName,
	type SurfaceBlockContext,
	type SurfaceBlockPrepared,
	sameValue,
} from "./context.ts";
import {
	answerAge,
	figureText,
	lastRecord,
	pickFigure,
	type SurfaceAskHandle,
	type SurfaceAskState,
	withUnit,
} from "./live.ts";

interface Fact {
	readonly label: string;
	readonly value?: string;
	readonly changed: boolean;
	readonly live?: SurfaceAskHandle | undefined;
	readonly pick?: string;
	readonly unit?: string | undefined;
}

function factsFrom(value: unknown, base: unknown, skip: readonly string[]): Fact[] {
	const skipped = new Set(skip.map((key) => key.toLowerCase()));
	if (isPlainRecord(value)) {
		const baseRecord = isPlainRecord(base) ? base : undefined;
		return Object.entries(value).flatMap(([key, item]): Fact[] =>
			skipped.has(key.toLowerCase()) || !isShownScalar(item)
				? []
				: [{ label: readableName(key), value: formatScalar(item), changed: !sameValue(baseRecord?.[key], item) }],
		);
	}
	if (!Array.isArray(value)) return [];
	const baseList = Array.isArray(base) ? base : [];
	return value.flatMap((item, index): Fact[] => {
		if (!isPlainRecord(item) || typeof item.label !== "string" || !isShownScalar(item.value)) return [];
		if (skipped.has(item.label.toLowerCase())) return [];
		return [{ label: item.label, value: formatScalar(item.value), changed: !sameValue(baseList[index], item) }];
	});
}

function fitsAsFigure(fact: Fact): boolean {
	return fact.value !== undefined && fact.value.length <= SURFACE_FACT_FIGURE_CHARS;
}

function loadingMark(): HTMLElement {
	return h("span", { class: "studio-pale-bar" });
}

function lockedMark(): HTMLElement {
	return h("span", { class: "studio-fact-lock", role: "img", "aria-label": t("Not shared with you") }, icon("lock"));
}

function drawFigure(dd: HTMLElement, state: SurfaceAskState, pick: string, unit: string | undefined): void {
	dd.classList.remove("is-loading", "is-locked", "is-unknown");
	dd.removeAttribute("title");
	if (state.state === "loading") {
		dd.classList.add("is-loading");
		dd.replaceChildren(loadingMark());
		return;
	}
	if (state.state === "refused") {
		dd.classList.add("is-locked");
		dd.title = t("Not shared with you");
		dd.replaceChildren(lockedMark());
		return;
	}
	if (state.state === "unavailable") {
		dd.classList.add("is-unknown");
		dd.replaceChildren("?");
		return;
	}
	const figure = figureText(pickFigure(state.answer, pick));
	const text = figure === undefined ? "–" : withUnit(figure, unit);
	const age = answerAge(state.answer);
	dd.title = age ? `${text} · ${age}` : text;
	dd.replaceChildren(text);
}

function liveFacts(
	block: SurfaceFactsFromBlock,
	source: SurfaceAskSource,
	ctx: SurfaceBlockContext,
	emptyMark: string,
): HTMLElement {
	const list = h("dl", { class: "studio-facts is-live" });
	const holder = h("div", { class: "studio-facts-live" }, list);
	const placeholders = (mark: () => HTMLElement | string, kind: string) =>
		Array.from({ length: block.take }, () =>
			h(
				"div",
				{ class: "studio-fact" },
				h("dt", null, h("span", { class: "studio-pale-bar" })),
				h("dd", { class: kind }, mark()),
			),
		);
	const draw = (state: SurfaceAskState) => {
		holder.removeAttribute("title");
		if (state.state === "refused") {
			holder.replaceChildren(homeLocked());
			return;
		}
		holder.replaceChildren(list);
		if (state.state === "loading") {
			list.replaceChildren(...placeholders(loadingMark, "is-loading"));
			return;
		}
		if (state.state === "unavailable") {
			list.replaceChildren(...placeholders(() => "?", "is-unknown"));
			return;
		}
		const record = lastRecord(state.answer);
		const facts = factsFrom(
			record &&
				Object.fromEntries(
					Object.entries(record).map(([key, value]) => {
						const figure = figureText(value);
						return [key, figure === undefined ? value : withUnit(figure, source.unit)];
					}),
				),
			record,
			block.skip,
		)
			.filter(fitsAsFigure)
			.slice(0, block.take);
		const age = answerAge(state.answer);
		if (age) holder.title = age;
		list.replaceChildren(
			...(facts.length > 0
				? facts.map((fact) =>
						h("div", { class: "studio-fact" }, h("dt", null, fact.label), h("dd", null, fact.value ?? "")),
					)
				: placeholders(() => emptyMark, "is-unknown")),
		);
	};
	const handle = ctx.ask?.(source);
	if (handle) handle.follow(draw, ctx.renderSignal ?? ctx.signal);
	else draw({ state: "unavailable" });
	return holder;
}

function withHeading(block: SurfaceFactsBlock, ctx: SurfaceBlockContext, list: HTMLElement): HTMLElement {
	if (!block.heading) return list;
	return h(
		"div",
		{ class: "studio-facts-block" },
		h("h3", { class: "studio-subhead" }, ctx.words(block.heading)),
		list,
	);
}

export function prepareFacts(block: SurfaceFactsBlock, ctx: SurfaceBlockContext): SurfaceBlockPrepared {
	const isStrategy = ctx.surface.kind === "strategy" || ctx.surface.slug === "strategy";
	const emptyMark = isStrategy ? "–" : "?";
	if (!("items" in block) && isSurfaceAskSource(block.from)) {
		const source = block.from;
		ctx.ask?.(source);
		return {
			filled: true,
			hero: "facts",
			pieces: [{ build: () => withHeading(block, ctx, liveFacts(block, source, ctx, emptyMark)) }],
		};
	}
	let facts: readonly Fact[];
	if ("items" in block) {
		facts = block.items.map((item): Fact => {
			if (isSurfaceAskSource(item.from)) {
				return {
					label: ctx.words(item.label),
					changed: false,
					live: ctx.ask?.(item.from),
					pick: item.from.pick ?? "",
					unit: item.from.unit,
				};
			}
			const read = ctx.read(item.from);
			const shown = read.found && isShownScalar(read.value);
			return {
				label: ctx.words(item.label),
				...(shown ? { value: formatScalar(read.value) } : {}),
				changed: shown && read.changed,
			};
		});
	} else {
		const read = ctx.read(block.from);
		facts = factsFrom(read.value, read.base, block.skip).filter(fitsAsFigure).slice(0, block.take);
		if (facts.length === 0) {
			const labels = isStrategy
				? [t("North Star"), t("Unit margin"), t("Payback"), t("Break-even")]
				: [t("Size"), t("Weight"), t("Made of"), t("Price")];
			facts = Array.from({ length: block.take }, (_, index) => ({ label: labels[index] ?? "", changed: false }));
		}
	}
	const live = facts.some((fact) => fact.pick !== undefined);
	const filled = live || facts.some((fact) => fact.value !== undefined);
	return {
		filled,
		hero: "facts",
		pieces: [
			{
				build: () => {
					const signal = ctx.renderSignal ?? ctx.signal;
					const list = h(
						"dl",
						{ class: `studio-facts${filled ? "" : " is-empty"}${live ? " is-live" : ""}` },
						facts.map((fact) => {
							let dd: HTMLElement;
							if (fact.pick !== undefined) {
								dd = h("dd");
								const { pick, unit } = fact;
								if (fact.live) fact.live.follow((state) => drawFigure(dd, state, pick, unit), signal);
								else drawFigure(dd, { state: "unavailable" }, pick, unit);
							} else {
								dd =
									fact.value !== undefined
										? h("dd", { title: fact.value }, fact.value)
										: h("dd", null, emptyMark);
							}
							return h(
								"div",
								{ class: `studio-fact${fact.changed ? " is-changed" : ""}` },
								h("dt", null, fact.label),
								dd,
							);
						}),
					);
					return withHeading(block, ctx, list);
				},
			},
		],
	};
}
