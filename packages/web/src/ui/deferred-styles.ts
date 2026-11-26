// WHY: Load deferred view stylesheets asynchronously after first paint and let lazy views await them to prevent FOUC.
const DEFERRED_STYLE_TIMEOUT_MS = 5_000;
let activeHref: string | undefined;
let activePromise: Promise<void> | undefined;
const settledLinks = new WeakSet<HTMLLinkElement>();

export function loadDeferredStyles(): Promise<void> {
	const href = document.querySelector<HTMLMetaElement>('meta[name="qorpera-deferred-css"]')?.content;
	if (!href) return Promise.resolve();
	if (activeHref === href && activePromise) return activePromise;
	activeHref = href;
	const existing = document.querySelector<HTMLLinkElement>(`link[rel="stylesheet"][href="${href}"]`);
	if (existing && (existing.sheet || settledLinks.has(existing))) {
		activePromise = Promise.resolve();
		return activePromise;
	}
	const link = existing ?? document.createElement("link");
	activePromise = new Promise<void>((resolve) => {
		let settled = false;
		const done = (): void => {
			if (settled) return;
			settled = true;
			settledLinks.add(link);
			clearTimeout(timer);
			link.removeEventListener("load", done);
			link.removeEventListener("error", done);
			resolve();
		};
		const timer = setTimeout(done, DEFERRED_STYLE_TIMEOUT_MS);
		link.addEventListener("load", done, { once: true });
		link.addEventListener("error", done, { once: true });
	});
	if (!existing) {
		link.rel = "stylesheet";
		link.href = href;
		document.head.append(link);
	}
	return activePromise;
}

export function waitForDeferredStyles(): Promise<void> {
	return loadDeferredStyles();
}
