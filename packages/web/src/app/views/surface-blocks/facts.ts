import { SURFACE_FACT_FIGURE_CHARS, type SurfaceFactsBlock } from "@qorpera/contracts";
import { h } from "../../../ui/dom.ts";
import { t } from "../../../ui/preferences.ts";
import {
	formatScalar,
	isPlainRecord,
	isShownScalar,
	readableName,
	type SurfaceBlockContext,
	type SurfaceBlockPrepared,
	sameValue,
} from "./context.ts";

interface Fact {
	readonly label: string;
	readonly value?: string;
	readonly changed: boolean;
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

export function prepareFacts(block: SurfaceFactsBlock, ctx: SurfaceBlockContext): SurfaceBlockPrepared {
	let facts: readonly Fact[];
	if ("items" in block) {
		facts = block.items.map((item) => {
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
			const isStrategy = ctx.surface.kind === "strategy" || ctx.surface.slug === "strategy";
			const labels = isStrategy
				? [t("North Star"), t("Unit margin"), t("Payback"), t("Break-even")]
				: [t("Size"), t("Weight"), t("Made of"), t("Price")];
			facts = Array.from({ length: block.take }, (_, index) => ({ label: labels[index] ?? "", changed: false }));
		}
	}
	const filled = facts.some((fact) => fact.value !== undefined);
	const isStrategy = ctx.surface.kind === "strategy" || ctx.surface.slug === "strategy";
	const emptyMark = isStrategy ? "–" : "?";
	return {
		filled,
		hero: "facts",
		pieces: [
			{
				build: () => {
					const list = h(
						"dl",
						{ class: `studio-facts${filled ? "" : " is-empty"}` },
						facts.map((fact) =>
							h(
								"div",
								{ class: `studio-fact${fact.changed ? " is-changed" : ""}` },
								h("dt", null, fact.label),
								fact.value !== undefined
									? h("dd", { title: fact.value }, fact.value)
									: h("dd", null, emptyMark),
							),
						),
					);
					if (!block.heading) return list;
					return h(
						"div",
						{ class: "studio-facts-block" },
						h("h3", { class: "studio-subhead" }, ctx.words(block.heading)),
						list,
					);
				},
			},
		],
	};
}
