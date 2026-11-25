// WHY: Load deferred view stylesheets asynchronously after first paint and let lazy views await them to prevent FOUC.
let activeHref: string | undefined;
let activePromise: Promise<void> | undefined;

export function loadDeferredStyles(): Promise<void> {
	const href = document.querySelector<HTMLMetaElement>('meta[name="qorpera-deferred-css"]')?.content;
	if (!href) return Promise.resolve();
	if (activeHref === href && activePromise) return activePromise;
	activeHref = href;
	const existing = document.querySelector<HTMLLinkElement>(`link[rel="stylesheet"][href="${href}"]`);
	if (existing?.sheet) {
		activePromise = Promise.resolve();
		return activePromise;
	}
	const link = existing ?? document.createElement("link");
	activePromise = new Promise<void>((resolve) => {
		const done = () => resolve();
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
