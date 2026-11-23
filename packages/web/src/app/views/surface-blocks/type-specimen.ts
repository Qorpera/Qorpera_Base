import type { SurfaceTypeSpecimenBlock } from "@qorpera/contracts";
import { h } from "../../../ui/dom.ts";
import { t } from "../../../ui/preferences.ts";
import {
	isPlainRecord,
	readableName,
	type SurfaceBlockContext,
	type SurfaceBlockPrepared,
	sameValue,
	sectionHead,
	sourceKey,
} from "./context.ts";

interface Face {
	readonly key: string;
	readonly label: string;
	readonly name: string;
	readonly stack: string;
	readonly changed: boolean;
}

const EMPTY_FACES = [0, 1, 2];

function stackOf(value: unknown): string | undefined {
	const family = isPlainRecord(value) ? value.family : value;
	return typeof family === "string" && family.trim() ? family.trim() : undefined;
}

function firstFamily(stack: string): string {
	const first = stack.split(",")[0]?.trim() ?? stack;
	return first.replace(/^(["'])(.*)\1$/, "$2") || stack;
}

function facesOf(value: unknown, base: unknown, prefix: string): Face[] {
	if (!isPlainRecord(value)) return [];
	const baseRecord = isPlainRecord(base) ? base : undefined;
	return Object.entries(value).flatMap(([role, item]): Face[] => {
		const stack = stackOf(item);
		if (!stack) return [];
		return [
			{
				key: `${prefix}.${role}`,
				label: readableName(role),
				name: firstFamily(stack),
				stack,
				changed: !sameValue(baseRecord?.[role], item),
			},
		];
	});
}

export function prepareTypeSpecimen(block: SurfaceTypeSpecimenBlock, ctx: SurfaceBlockContext): SurfaceBlockPrepared {
	const read = ctx.read(block.from);
	const faces = read.found ? facesOf(read.value, read.base, sourceKey(read.binding) ?? "type") : [];
	const filled = faces.length > 0;
	const changed = faces.some((face) => face.changed) || (!filled && read.changed);
	const heading = block.heading ? ctx.words(block.heading) : "";
	return {
		filled,
		pieces: [
			{
				build: () =>
					h(
						"section",
						{ class: `studio-section${changed ? " is-changed" : ""}`, "data-block": "type_specimen" },
						heading ? sectionHead(heading, changed) : null,
						filled
							? h(
									"div",
									{ class: "studio-type-list" },
									faces.map((face) => {
										const sample = h("p", { class: "studio-type-sample" }, t("Aa Bb Cc · 123"));
										sample.style.fontFamily = face.stack;
										return h(
											"div",
											{
												class: `studio-type-row${face.changed ? " is-changed" : ""}`,
												"data-token": face.key,
											},
											h(
												"div",
												{ class: "studio-type-meta" },
												h("strong", null, face.label),
												h("code", null, face.name),
											),
											sample,
										);
									}),
								)
							: h(
									"div",
									{ class: "studio-type-list is-empty", "aria-hidden": "true" },
									EMPTY_FACES.map(() =>
										h(
											"div",
											{ class: "studio-type-row" },
											h("div", { class: "studio-type-meta" }, h("span", { class: "studio-pale-bar" })),
											h("span", { class: "studio-pale-bar studio-type-sample" }),
										),
									),
								),
					),
			},
		],
	};
}
