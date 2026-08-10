const MAX_BROKER_REQUEST_BYTES = 64 * 1024 * 1024;

let installed = false;

function requestHandle(request: Request, handles: string[]): string | undefined {
	const candidates = [request.url, ...request.headers.values()];
	for (const handle of handles) if (candidates.some((candidate) => candidate.includes(handle))) return handle;
	return undefined;
}

/**
 * Route every remote fetch through the desktop kernel. The child holds only
 * an opaque provider handle; the kernel validates the inference endpoint and
 * injects the actual request credential after the request leaves userland.
 */
export function installModelBrokerFetch(): void {
	if (installed) return;
	const brokerUrl = process.env.QORPERA_MODEL_BROKER_URL;
	const brokerToken = process.env.QORPERA_MODEL_BROKER_TOKEN;
	if (!brokerUrl || !brokerToken) return;
	let handles: string[];
	try {
		const parsed = JSON.parse(process.env.QORPERA_MODEL_BROKER_HANDLES ?? "[]") as unknown;
		if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) return;
		handles = parsed;
	} catch {
		return;
	}
	const originalFetch = globalThis.fetch.bind(globalThis);
	globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const request = new Request(input, init);
		const target = new URL(request.url);
		if (target.protocol !== "https:") throw new Error("all child HTTP requests are disabled by the kernel");
		const handle = requestHandle(request, handles);
		if (!handle) throw new Error("remote model request has no kernel broker handle");
		const headers = new Headers(request.headers);
		for (const name of [...headers.keys()]) {
			if (name.toLowerCase().startsWith("x-qorpera-model-")) headers.delete(name);
		}
		headers.set("x-qorpera-model-target", target.href);
		headers.set("x-qorpera-model-token", brokerToken);
		headers.set("x-qorpera-model-handle", handle);
		headers.delete("content-length");
		let body: ArrayBuffer | undefined;
		if (request.method !== "GET" && request.method !== "HEAD") {
			body = await request.arrayBuffer();
			if (body.byteLength > MAX_BROKER_REQUEST_BYTES) throw new Error("model broker request exceeds 64 MiB");
		}
		return originalFetch(brokerUrl, {
			method: request.method,
			headers,
			body,
			signal: request.signal,
			redirect: "manual",
		});
	};
	installed = true;
}
