import { button, confirmDialog, h, notice } from "../ui/dom.ts";
import { t } from "../ui/preferences.ts";

/* A tab left open keeps the build it loaded, and a deploy changes nothing in it until it is reloaded (3 Nov 2026: the
 * live test ran an old build for hours). The site serves web-deployment.json (scripts/build.mjs) with the commit each
 * build is made from; the build knows its own. When they differ, a quiet line offers to reload. It never reloads by
 * itself: a message not sent yet would be lost. */

declare const __QORPERA_WEB_SOURCE_COMMIT__: string;

/** The commit this build was made from (scripts/build.mjs), or undefined where none is compiled in (tests). */
export const RUNNING_SOURCE_COMMIT: string | undefined =
	typeof __QORPERA_WEB_SOURCE_COMMIT__ === "undefined" ? undefined : __QORPERA_WEB_SOURCE_COMMIT__;

/** How often an open tab asks which build is served. Coming back to the tab asks too, at most once a minute. */
export const NEW_VERSION_CHECK_MS = 10 * 60_000;
const NEW_VERSION_MIN_GAP_MS = 60_000;

/** The commit of the build the site serves now, or undefined when that can't be told. */
async function servedCommit(signal: AbortSignal): Promise<string | undefined> {
	const response = await fetch(new URL("web-deployment.json", document.baseURI), {
		cache: "no-store",
		credentials: "omit",
		redirect: "error",
		signal,
	});
	if (!response.ok) return undefined;
	const manifest: unknown = await response.json();
	const commit =
		manifest && typeof manifest === "object" ? (manifest as { sourceCommit?: unknown }).sourceCommit : undefined;
	return typeof commit === "string" && /^[0-9a-f]{40}$/.test(commit) ? commit : undefined;
}

/** Asks which build is served every NEW_VERSION_CHECK_MS and when the tab is shown or focused again; calls
 * `onNewVersion` once, the first time it is another build than `running`. Nothing is asked without `running`. */
export function watchNewVersion(running: string | undefined, onNewVersion: () => void, signal: AbortSignal): void {
	if (!running || signal.aborted) return;
	let askedAt = Number.NEGATIVE_INFINITY;
	let asking = false;
	let found = false;
	const ask = async (): Promise<void> => {
		if (signal.aborted || found || asking || document.visibilityState === "hidden") return;
		if (Date.now() - askedAt < NEW_VERSION_MIN_GAP_MS) return;
		askedAt = Date.now();
		asking = true;
		let served: string | undefined;
		try {
			served = await servedCommit(signal);
		} catch {
			// Offline or a deploy under way: the next turn asks again.
		} finally {
			asking = false;
		}
		if (signal.aborted || found || !served || served === running) return;
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

/** The line that offers the new build. Reload asks first when a text box in `root` holds words not sent yet. */
export function newVersionNotice(root: HTMLElement, load: () => void = () => location.reload()): HTMLElement {
	const reload = async () => {
		const unsent = [
			...root.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>("textarea, input[type=text]"),
		].some((field) => !field.disabled && field.value.trim() !== "");
		if (unsent && !(await confirmDialog(t("Text you have not sent will be lost. Reload anyway?"), t("Reload"))))
			return;
		load();
	};
	return notice(
		"accent",
		h("span", null, t("A new version is available.")),
		button(t("Reload"), () => void reload(), { small: true }),
	);
}
