import type { SurfaceTitleBlock } from "@qorpera/contracts";
import { h } from "../../../ui/dom.ts";
import { t } from "../../../ui/preferences.ts";
import { formatScalar, isShownScalar, type SurfaceBlockContext, type SurfaceBlockPrepared } from "./context.ts";

export function prepareTitle(block: SurfaceTitleBlock, ctx: SurfaceBlockContext): SurfaceBlockPrepared {
	const name = ctx.read(block.name);
	const ownName = name.found && isShownScalar(name.value);
	const line = ctx.read(block.line);
	const ownLine = line.found && isShownScalar(line.value);
	const lineText = ownLine ? formatScalar(line.value) : ctx.briefSummary;
	return {
		filled: true,
		hero: "title",
		pieces: [
			{
				build: () =>
					h(
						"div",
						{ class: "studio-product-head" },
						h(
							"h2",
							ownName && name.changed ? { class: "is-changed" } : null,
							ownName ? formatScalar(name.value) : ctx.surface.title,
						),
						lineText
							? h(
									"p",
									{ class: `studio-product-line${ownLine ? "" : " is-brief"}${ownLine && line.changed ? " is-changed" : ""}` },
									lineText,
								)
							: h("p", { class: "studio-product-line is-empty" }, t("One line about what it is")),
					),
			},
		],
	};
}
