declare const __QORPERA_EXPLAINER_SRC__: string | undefined;

let cached: Promise<string | undefined> | undefined;
let override: string | undefined;

export function studioExplainerEngineSource(): string | undefined {
	return typeof __QORPERA_EXPLAINER_SRC__ === "string" ? __QORPERA_EXPLAINER_SRC__ : undefined;
}

export function setStudioExplainerEngineForTests(source: string | undefined): void {
	override = source;
	cached = undefined;
}

export function loadStudioExplainerEngine(signal?: AbortSignal): Promise<string | undefined> {
	if (override !== undefined) return Promise.resolve(override);
	const source = studioExplainerEngineSource();
	if (!source || typeof fetch !== "function") return Promise.resolve(undefined);
	cached ??= fetch(new URL(source, import.meta.url).href, { credentials: "omit" })
		.then(async (response) => {
			if (!response.ok) return undefined;
			const text = await response.text();
			return text.trim() ? text : undefined;
		})
		.catch(() => undefined)
		.then((text) => {
			if (text === undefined) cached = undefined;
			return text;
		});
	if (!signal) return cached;
	return new Promise<string | undefined>((resolve) => {
		if (signal.aborted) {
			resolve(undefined);
			return;
		}
		const onAbort = () => resolve(undefined);
		signal.addEventListener("abort", onAbort, { once: true });
		void cached!.then((text) => {
			signal.removeEventListener("abort", onAbort);
			resolve(signal.aborted ? undefined : text);
		});
	});
}
