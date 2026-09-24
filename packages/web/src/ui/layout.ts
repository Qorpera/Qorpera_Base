import { uiScale } from "./scale.ts";

/** The phone layout, where the rail becomes a drawer and dialogs become sheets. The
 * stylesheets' phone media queries use the same width: 760 design pixels, which the
 * build writes out for each scale (ui/scale.ts). Scripts ask the query itself:
 * window.innerWidth is a whole number, so near the edge at some zoom levels it could
 * disagree with the CSS, which sees the exact width. */
const PHONE_WIDTH = 760;

export const isPhoneLayout = (): boolean => window.matchMedia(`(max-width: ${PHONE_WIDTH * uiScale()}px)`).matches;
