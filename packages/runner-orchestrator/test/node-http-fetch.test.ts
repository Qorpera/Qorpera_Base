import { createServer, type RequestListener } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { nodeHttpFetch } from "../src/node-http-fetch.ts";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
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
	it("sends buffered JSON requests and returns a web Response", async () => {
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

	it("honors an aborted request signal", async () => {
		const baseUrl = await listen((_request, response) => {
			setTimeout(() => response.end("late"), 1_000);
		});
		await expect(nodeHttpFetch(`${baseUrl}/slow`, { signal: AbortSignal.timeout(10) })).rejects.toBeDefined();
	});
});
