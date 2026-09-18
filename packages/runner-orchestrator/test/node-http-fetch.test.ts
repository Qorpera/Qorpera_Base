import { createServer, type RequestListener } from "node:http";
import { Request as NodeHttpRequest } from "@whatwg-node/node-fetch";
import { afterEach, describe, expect, it } from "vitest";
import { nodeHttpFetch } from "../src/node-http-fetch.ts";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
	for (const server of servers) server.closeAllConnections();
	await Promise.all(
		servers
			.splice(0)
			.map(
				(server) =>
					new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
			),
	);
});

async function listen(handler: RequestListener): Promise<string> {
	const server = createServer(handler);
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Test server address is unavailable");
	return `http://127.0.0.1:${address.port}`;
}

describe("jitless Node HTTP transport", () => {
	it("normalizes each supported header input and rejects malformed pairs before dispatch", async () => {
		let calls = 0;
		const base = await listen((request, response) => {
			calls++;
			response.end(JSON.stringify({ header: request.headers["x-test"] }));
		});
		for (const headers of [{ "X-Test": "value" }, [["X-Test", "value"]], new Headers({ "X-Test": "value" })]) {
			expect(await (await nodeHttpFetch(base, { headers })).json()).toEqual({ header: "value" });
		}
		await expect(nodeHttpFetch(base, { headers: [["X-Test"]] })).rejects.toThrow("must be pairs");
		expect(calls).toBe(3);
	});
	it("accepts ponyfill and native Request inputs without mutating their credentials during redirects", async () => {
		const seen: Array<{ method: string | undefined; authorization?: string; apikey?: string; body: string }> = [];
		const target = await listen((request, response) => {
			let body = "";
			request.on("data", (chunk) => {
				body += chunk;
			});
			request.on("end", () => {
				seen.push({
					method: request.method,
					authorization: request.headers.authorization,
					apikey: request.headers.apikey as string | undefined,
					body,
				});
				response.writeHead(200, { "content-type": "application/json" });
				response.end('{"ok":true}');
			});
		});
		const source = await listen((_request, response) => {
			response.writeHead(303, { location: target }).end();
		});
		for (const Constructor of [NodeHttpRequest, Request]) {
			const input = new Constructor(source, {
				method: "POST",
				headers: { authorization: "Bearer original", apikey: "original" },
				body: "private request",
			});
			const result = await nodeHttpFetch(input, { headers: { authorization: "Bearer override" } });
			expect(await result.json()).toEqual({ ok: true });
			expect(input.headers.get("authorization")).toBe("Bearer original");
			expect(input.headers.get("apikey")).toBe("original");
		}
		expect(seen).toEqual([
			{ method: "GET", authorization: undefined, apikey: undefined, body: "" },
			{ method: "GET", authorization: undefined, apikey: undefined, body: "" },
		]);
	});
	it("honors the Request's own cancellation signal and closes its connection", async () => {
		let connected!: () => void, closed!: () => void;
		const started = new Promise<void>((resolve) => {
			connected = resolve;
		});
		const ended = new Promise<void>((resolve) => {
			closed = resolve;
		});
		const base = await listen((_request, response) => {
			response.once("close", closed);
			response.writeHead(200);
			response.flushHeaders();
			connected();
		});
		const controller = new AbortController();
		const result = nodeHttpFetch(new NodeHttpRequest(base, { signal: controller.signal }));
		await started;
		controller.abort();
		await expect(result).rejects.toBeDefined();
		await ended;
	});
	it("offers readable/cancellable response bodies and handles an empty 204 response", async () => {
		const base = await listen((_request, response) => {
			response.writeHead(204).end();
		});
		const response = await nodeHttpFetch(base);
		expect(response.status).toBe(204);
		expect(await response.text()).toBe("");
		const populated = await listen((_request, response) => {
			response.end("bytes");
		});
		const readable = await nodeHttpFetch(populated);
		const reader = readable.body!.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toBe("bytes");
		await reader.cancel();
		const cancelled = await nodeHttpFetch(populated);
		await cancelled.body!.cancel();
	});
	it("sends buffered JSON requests and returns JSON response data", async () => {
		const baseUrl = await listen((request, response) => {
			let encoded = "";
			request.setEncoding("utf-8");
			request.on("data", (chunk: string) => {
				encoded += chunk;
			});
			request.on("end", () => {
				response.writeHead(201, { "content-type": "application/json" });
				response.end(JSON.stringify({ authorization: request.headers.authorization, encoded }));
			});
		});
		const response = await nodeHttpFetch(`${baseUrl}/rpc`, {
			method: "POST",
			headers: { authorization: "Bearer test", "content-type": "application/json" },
			body: '{"ok":true}',
		});
		expect(response.status).toBe(201);
		expect(await response.json()).toEqual({ authorization: "Bearer test", encoded: '{"ok":true}' });
	});

	it("rejects redirects when the caller requires an exact authority endpoint", async () => {
		const baseUrl = await listen((_request, response) => {
			response.writeHead(302, { location: "/elsewhere" }).end();
		});
		await expect(nodeHttpFetch(`${baseUrl}/redirect`, { redirect: "error" })).rejects.toThrow("rejected a redirect");
	});

	it("closes a refused redirect without draining a stalled body or forwarding credentials", async () => {
		let resolveClosed = (): void => {};
		const closed = new Promise<void>((resolve) => {
			resolveClosed = resolve;
		});
		const requests: string[] = [];
		const baseUrl = await listen((request, response) => {
			requests.push(request.url ?? "");
			response.on("close", resolveClosed);
			response.writeHead(307, { location: "/untrusted" });
			response.flushHeaders();
		});
		await expect(
			nodeHttpFetch(`${baseUrl}/assignment`, {
				method: "POST",
				redirect: "error",
				headers: { authorization: "Bearer synthetic-test-capability" },
				body: "synthetic assignment",
			}),
		).rejects.toThrow("rejected a redirect");
		await closed;
		expect(requests).toEqual(["/assignment"]);
	}, 2_000);

	it("honors an aborted request signal", async () => {
		const baseUrl = await listen((_request, response) => {
			setTimeout(() => response.end("late"), 1_000);
		});
		await expect(nodeHttpFetch(`${baseUrl}/slow`, { signal: AbortSignal.timeout(10) })).rejects.toBeDefined();
	});
});
