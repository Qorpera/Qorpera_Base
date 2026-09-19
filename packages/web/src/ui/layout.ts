/** The phone layout, where the rail becomes a drawer and dialogs become sheets. The
 * stylesheets' phone media queries use the same width. Scripts ask the query itself:
 * window.innerWidth is a whole number, so near 760px at some zoom levels it could
 * disagree with the CSS, which sees the exact width. */
const PHONE_LAYOUT = "(max-width: 760px)";

export const isPhoneLayout = (): boolean => window.matchMedia(PHONE_LAYOUT).matches;
