import { afterEach, describe, expect, it, vi } from "vitest";
import { installModelBrokerFetch } from "../src/core/model-broker-client.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	delete process.env.QORPERA_MODEL_BROKER_URL;
	delete process.env.QORPERA_MODEL_BROKER_TOKEN;
	delete process.env.QORPERA_MODEL_BROKER_HANDLES;
});

describe("model broker client", () => {
	it("rewrites authenticated HTTPS inference into one opaque local broker operation", async () => {
		const handle = "qorpera-model-11111111-1111-4111-8111-111111111111";
		process.env.QORPERA_MODEL_BROKER_URL = "http://127.0.0.1:32123/inference";
		process.env.QORPERA_MODEL_BROKER_TOKEN = "session-token";
		process.env.QORPERA_MODEL_BROKER_HANDLES = JSON.stringify([handle]);
		const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response("ok"));
		globalThis.fetch = fetchMock;
		installModelBrokerFetch();

		await fetch("https://api.openai.com/v1/responses", {
			method: "POST",
			headers: { authorization: `Bearer ${handle}`, "content-type": "application/json" },
			body: "{}",
		});

		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("http://127.0.0.1:32123/inference");
		const headers = new Headers(init?.headers);
		expect(headers.get("x-qorpera-model-target")).toBe("https://api.openai.com/v1/responses");
		expect(headers.get("x-qorpera-model-token")).toBe("session-token");
		expect(headers.get("x-qorpera-model-handle")).toBe(handle);
		await expect(fetch("http://example.com/unbrokered")).rejects.toThrow("all child HTTP requests are disabled");
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});
