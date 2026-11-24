import type { SurfacePaletteBlock } from "@qorpera/contracts";
import { h } from "../../../ui/dom.ts";
import { type ColorToken, collectColors } from "./colours.ts";
import { type SurfaceBlockContext, type SurfaceBlockPrepared, sectionHead, sourceKey } from "./context.ts";

const EMPTY_SWATCHES = [0, 1, 2, 3];

export function renderSwatches(colours: readonly ColorToken[]): HTMLElement {
	return h(
		"div",
		{ class: "studio-swatches" },
		colours.map((colour) => {
			const chip = h("span", { class: "studio-swatch-chip", "aria-hidden": "true" });
			chip.style.backgroundColor = colour.value;
			return h(
				"div",
				{ class: `studio-swatch${colour.changed ? " is-changed" : ""}`, "data-token": colour.key },
				chip,
				h("div", { class: "studio-swatch-meta" }, h("strong", null, colour.label), h("code", null, colour.value)),
			);
		}),
	);
}

export function preparePalette(block: SurfacePaletteBlock, ctx: SurfaceBlockContext): SurfaceBlockPrepared {
	const read = ctx.read(block.from);
	const key = sourceKey(read.binding) ?? "colours";
	const colours: ColorToken[] = [];
	if (read.found) collectColors(read.value, { [key]: read.base }, [key], colours);
	const filled = colours.length > 0;
	const changed = colours.some((colour) => colour.changed) || (!filled && read.changed);
	const heading = block.heading ? ctx.words(block.heading) : "";
	return {
		filled,
		pieces: [
			{
				build: () =>
					h(
						"section",
						{ class: `studio-section${changed ? " is-changed" : ""}`, "data-block": "palette" },
						heading ? sectionHead(heading, changed) : null,
						filled
							? renderSwatches(colours)
							: h(
									"div",
									{ class: "studio-swatches is-empty", "aria-hidden": "true" },
									EMPTY_SWATCHES.map(() =>
										h(
											"div",
											{ class: "studio-swatch" },
											h("span", { class: "studio-swatch-chip" }),
											h("div", { class: "studio-swatch-meta" }, h("span", { class: "studio-pale-bar" })),
										),
									),
								),
					),
			},
		],
	};
}
