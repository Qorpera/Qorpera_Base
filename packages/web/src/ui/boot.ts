/* index.html's #app holds a static copy of the app's first screens (`.boot`): the sign-in page, the company list and a
 * company's thread, each as the grey shapes the app itself shows while it loads (ui/skeleton.ts). The head script
 * (theme.ts) picks the one the app will draw, before the first paint, so the page shows it as soon as the stylesheet is
 * in, not an empty page until main.js has run. The app's first draw replaces it (app/application.ts). It reads only
 * whether a session is stored, never the session. Anything it cannot tell shows no placeholder, as before. */

/** Auth's storage key (cloud/client.ts AUTH_STORAGE_KEY), here so the head script stays free of the SDK. */
export const STORED_SESSION_KEY = "qorpera-web-auth/v1";
/** RailLayout's stored width (ui/rail-layout.ts). */
const RAIL_WIDTH_KEY = "qorpera.web.rail-width.v4";
/** What a sign-in callback carries (app/auth.ts); Auth finishes it before the app knows which screen comes. */
const CALLBACK = [
	"code",
	"access_token",
	"refresh_token",
	"provider_token",
	"provider_refresh_token",
	"error",
	"error_code",
	"error_description",
];
/** qorpera.com's idea (application.ts WEBSITE_KEYS): the page goes to the new-company box. */
const WEBSITE = ["ide", "idea", "kind"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTERFACE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type BootView = "sign-in" | "hub" | "thread";

/** The first screen for this address, as app/router.ts parseRoute and application.ts draw() choose it; undefined
 * where the placeholder could be wrong (a sign-in callback, the new-company box, the account page, a founding table,
 * a company page other than a thread). */
export function bootView(href: string, signedIn: boolean): BootView | undefined {
	const url = new URL(href);
	const fragment = new URLSearchParams(url.hash.slice(1));
	if (
		CALLBACK.some((key) => url.searchParams.has(key)) ||
		(!url.hash.startsWith("#/") && CALLBACK.some((key) => fragment.has(key)))
	)
		return undefined;
	if (!signedIn) return "sign-in";
	if (WEBSITE.some((key) => url.searchParams.has(key))) return undefined;
	const parts = (url.hash.replace(/^#\/?/, "").split("?")[0] ?? "").split("/").filter(Boolean);
	const [first, second, section, id] = parts;
	if (first === "c" && second && UUID.test(second)) {
		// application.ts draws the thread's placeholder for a company's home, a chat and a new chat; a page's or the
		// meeting's for the rest. A section parseRoute does not know is the home.
		const page =
			(section === "i" && id && id.length <= 64 && INTERFACE_NAME.test(id)) ||
			section === "file" ||
			section === "team" ||
			section === "meet";
		return page ? undefined : "thread";
	}
	if (
		first === "account" ||
		(first === "new" && parts.length === 1) ||
		(first === "found" && second && UUID.test(second))
	)
		return undefined;
	return "hub";
}

/** Runs in the head script before the first paint. */
export function applyBoot(): void {
	const root = document.documentElement;
	let signedIn = false;
	let rail = 0;
	let view: BootView | undefined;
	try {
		signedIn = localStorage.getItem(STORED_SESSION_KEY) !== null;
		// RailLayout's own reading: compact (80), or a width from 240 up; anything else is its default.
		rail = Number(localStorage.getItem(RAIL_WIDTH_KEY));
	} catch {
		/* No storage: nothing is stored, as Auth sees it too. */
	}
	try {
		view = bootView(location.href, signedIn);
	} catch {
		return;
	}
	// A compact rail has shapes of its own (app.css .rail-compact): that one placeholder is left out.
	if (!view || (view === "thread" && rail === 80)) return;
	root.dataset.boot = view;
	if (view === "thread" && Number.isFinite(rail) && rail >= 240) root.style.setProperty("--boot-rail", String(rail));
}
