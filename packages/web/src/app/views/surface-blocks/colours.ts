import type { SurfaceSwatchRowBlock } from "@qorpera/contracts";
import { h } from "../../../ui/dom.ts";
import { t } from "../../../ui/preferences.ts";
import {
	isPlainRecord,
	lookupPath,
	readableName,
	type SurfaceBlockContext,
	type SurfaceBlockPrepared,
	sourceKey,
} from "./context.ts";

export interface ColorToken {
	readonly key: string;
	readonly label: string;
	readonly value: string;
	readonly changed: boolean;
}

export const COLOR_VALUE =
	/^(?:#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgb|hsl)a?\([^)]+\)|oklch\([^)]+\))$/i;

export function collectColors(
	value: unknown,
	baseRoot: Record<string, unknown> | undefined,
	segments: readonly string[],
	out: ColorToken[],
): void {
	if (typeof value === "string" && COLOR_VALUE.test(value.trim())) {
		const prev = lookupPath(baseRoot, segments);
		const label = segments.slice(-1)[0] ?? "";
		out.push({
			key: segments.join("."),
			label: readableName(label),
			value: value.trim(),
			changed: prev !== value,
		});
		return;
	}
	if (Array.isArray(value)) {
		const prevList = lookupPath(baseRoot, segments);
		for (let index = 0; index < value.length; index++) {
			const item = value[index];
			if (!isPlainRecord(item)) continue;
			const color = [item.hex, item.color, item.value].find(
				(candidate): candidate is string => typeof candidate === "string" && COLOR_VALUE.test(candidate.trim()),
			);
			if (!color) continue;
			const name =
				typeof item.name === "string" ? item.name : typeof item.label === "string" ? item.label : `#${index + 1}`;
			const prevItem = Array.isArray(prevList) ? prevList[index] : undefined;
			const prevColor = isPlainRecord(prevItem) ? (prevItem.hex ?? prevItem.color ?? prevItem.value) : undefined;
			out.push({
				key: `${segments.join(".")}[${index}]`,
				label: name,
				value: color.trim(),
				changed: prevColor !== color,
			});
		}
		return;
	}
	if (!isPlainRecord(value)) return;
	for (const [key, child] of Object.entries(value)) collectColors(child, baseRoot, [...segments, key], out);
}

export function readSwatches(block: SurfaceSwatchRowBlock, ctx: SurfaceBlockContext): ColorToken[] {
	const read = ctx.read(block.from);
	if (!read.found) return [];
	const key = sourceKey(block.from) ?? "colours";
	const out: ColorToken[] = [];
	collectColors(read.value, { [key]: read.base }, [key], out);
	return out;
}

export function prepareSwatchRow(
	blockKey: string,
	colours: readonly ColorToken[],
	selected: number,
): SurfaceBlockPrepared {
	return {
		filled: colours.length > 0,
		hero: "swatch",
		pieces: [
			{
				build: () =>
					colours.length
						? h(
								"div",
								{ class: "studio-dots", role: "radiogroup", "aria-label": t("Colorways") },
								colours.map((color, index) => {
									const dot = h("button", {
										type: "button",
										role: "radio",
										class: `studio-dot${index === selected ? " is-on" : ""}${color.changed ? " is-changed" : ""}`,
										"aria-checked": String(index === selected),
										"aria-label": color.label,
										title: color.label,
										"data-act": "studio-colorway",
										"data-block": blockKey,
										"data-index": String(index),
										"data-token": color.key,
									});
									dot.style.backgroundColor = color.value;
									return dot;
								}),
							)
						: h(
								"div",
								{ class: "studio-dots is-empty", "aria-hidden": "true" },
								[0, 1, 2, 3].map(() => h("span", { class: "studio-dot" })),
							),
			},
		],
	};
}
