import { h } from "../../../ui/dom.ts";
import type { SurfaceBlockPrepared } from "./context.ts";

export function prepareUnknown(): SurfaceBlockPrepared {
	return {
		filled: false,
		pieces: [{ build: () => h("div", { class: "studio-home-quiet", "aria-hidden": "true" }) }],
	};
}
