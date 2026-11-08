/* index.html's #app holds a static copy of the app's first screens (`.boot`): the sign-in page, the company list and a
 * company's thread, each as the grey shapes the app itself shows while it loads (ui/skeleton.ts). The head script
 * (theme.ts) picks the one the app will draw, before the first paint, so the page shows it as soon as the stylesheet is
 * in, not an empty page until main.js has run. The app's first draw replaces it (app/application.ts). It reads only
 * whether a session is stored, never the session. Anything it cannot tell shows no placeholder, as before. */
import { parseRoute } from "../app/router.ts";

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

export type BootView = "sign-in" | "hub" | "thread";

/** The first screen for this address, as application.ts draw() chooses it before any read (its route from
 * app/router.ts); undefined where the placeholder could be wrong: a sign-in callback, qorpera.com's idea, the
 * new-company box, the account page, a founding table, a company page other than a thread. */
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
	const route = parseRoute(url.hash);
	if (route.name === "hub") return "hub";
	// A company opening shows the thread's placeholder for its home, a chat and a new chat; a page's otherwise.
	if (route.name !== "company") return undefined;
	const section = route.section;
	return section === "home" || section === "chat" || section === "staff" || section === "new" ? "thread" : undefined;
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
