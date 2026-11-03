import { button, confirmDialog, h, notice } from "../ui/dom.ts";
import { t } from "../ui/preferences.ts";

/* A tab left open keeps the build it loaded, and a deploy changes nothing in it until it is reloaded (3 Nov 2026: the
 * live test ran an old build for hours). The site serves web-deployment.json (scripts/build.mjs) with its
 * `sourceCommit` and a checksum for every file of the build. The commit changes with every merge, also one that
 * changes nothing in the web app (the site is built again for each), so the tab compares files instead: when a file
 * it loaded from build/ (main.js, its preloaded chunks, the stylesheet; each named by its content's hash) is no longer
 * served, the build has changed, and a quiet line offers to reload. It never reloads by itself: a message not sent
 * yet would be lost. */

/** How often an open tab asks which build is served. Coming back to the tab asks too, at most once a minute. */
export const NEW_VERSION_CHECK_MS = 10 * 60_000;
const NEW_VERSION_MIN_GAP_MS = 60_000;

/** The build's own files this page loaded, as web-deployment.json names them (`build/main-….js`). None in
 * development (the dev server's names carry no hash) and tests. */
export function runningBuildFiles(page: Document = document): string[] {
	const base = new URL(".", page.baseURI);
	const files = new Set<string>();
	for (const element of page.querySelectorAll<HTMLScriptElement | HTMLLinkElement>(
		"script[src], link[rel=stylesheet][href], link[rel=modulepreload][href]",
	)) {
		const url = new URL(element instanceof HTMLScriptElement ? element.src : element.href, base);
		if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) continue;
		const path = url.pathname.slice(base.pathname.length);
		if (/^build\/[\w-]+-[A-Z0-9]{8}\.(?:js|css)$/.test(path)) files.add(path);
	}
	return [...files].sort();
}

/** The files the site serves now (web-deployment.json's `files`), or undefined when that can't be told. */
async function servedFiles(signal: AbortSignal): Promise<Set<string> | undefined> {
	const response = await fetch(new URL("web-deployment.json", document.baseURI), {
		cache: "no-store",
		credentials: "omit",
		redirect: "error",
		signal,
	});
	if (!response.ok) return undefined;
	const manifest: unknown = await response.json();
	const files = manifest && typeof manifest === "object" ? (manifest as { files?: unknown }).files : undefined;
	return files && typeof files === "object" && !Array.isArray(files) ? new Set(Object.keys(files)) : undefined;
}

/** Asks which build is served every NEW_VERSION_CHECK_MS and when the tab is shown or focused again; calls
 * `onNewVersion` once, the first time a file in `running` is no longer served. Nothing is asked without files. */
export function watchNewVersion(running: readonly string[], onNewVersion: () => void, signal: AbortSignal): void {
	if (running.length === 0 || signal.aborted) return;
	let askedAt = Number.NEGATIVE_INFINITY;
	let asking = false;
	let found = false;
	const ask = async (): Promise<void> => {
		if (signal.aborted || found || asking || document.visibilityState === "hidden") return;
		if (Date.now() - askedAt < NEW_VERSION_MIN_GAP_MS) return;
		askedAt = Date.now();
		asking = true;
		let served: Set<string> | undefined;
		try {
			served = await servedFiles(signal);
		} catch {
			// Offline or a deploy under way: the next turn asks again.
		} finally {
			asking = false;
		}
		// A manifest that lists no file at all is not one to judge by.
		if (signal.aborted || found || !served?.size || running.every((file) => served.has(file))) return;
		found = true;
		onNewVersion();
	};
	const timer = setInterval(() => void ask(), NEW_VERSION_CHECK_MS);
	signal.addEventListener("abort", () => clearInterval(timer), { once: true });
	window.addEventListener("focus", () => void ask(), { signal });
	document.addEventListener(
		"visibilitychange",
		() => {
			if (document.visibilityState === "visible") void ask();
		},
		{ signal },
	);
}

/** The line that offers the new build. Reload asks first when words are not sent yet: in a text box in `root`, or
 * (`unsent`) in a draft kept for a conversation not on screen. */
export function newVersionNotice(
	root: HTMLElement,
	unsent: () => boolean = () => false,
	load: () => void = () => location.reload(),
): HTMLElement {
	const reload = async () => {
		const typed = [
			...root.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>(
				"textarea, input[type=text], input:not([type])",
			),
		].some((field) => !field.disabled && field.value.trim() !== "");
		if (
			(typed || unsent()) &&
			!(await confirmDialog(t("Text you have not sent will be lost. Reload anyway?"), t("Reload")))
		)
			return;
		load();
	};
	return notice(
		"accent",
		h("span", null, t("A new version is available.")),
		button(t("Reload"), () => void reload(), { small: true }),
	);
}
