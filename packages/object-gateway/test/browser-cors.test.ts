import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { handleMemberBrowserRequest } from "../src/browser-cors.ts";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function endpoint() {
	const server = createServer((request, response) => {
		if (handleMemberBrowserRequest(request, response)) return;
		response.writeHead(401);
		response.end("Member authorization required");
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
describe("member browser CORS", () => {
	it.each(["https://app.qorpera.com", "https://41fe840d.qorpera-web.pages.dev"])(
		"admits preflight from %s while keeping actual authorization",
		async (origin) => {
			const base = await endpoint(),
				path = "/v1/member-company-file/fixture/edits";
			const preflight = await fetch(base + path, {
				method: "OPTIONS",
				headers: {
					origin,
					"access-control-request-method": "POST",
					"access-control-request-headers": "authorization,content-type",
				},
			});
			expect(preflight.status).toBe(204);
			expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
			const actual = await fetch(base + path, { method: "POST", headers: { origin } });
			expect(actual.status).toBe(401);
			expect(actual.headers.get("access-control-allow-origin")).toBe(origin);
		},
	);
	it("does not admit another Pages project, private routes, or private headers", async () => {
		const base = await endpoint();
		for (const origin of ["https://qorpera-web.pages.dev.evil.invalid", "https://elsewhere.pages.dev", "null"]) {
			const response = await fetch(`${base}/v1/member-company-objects/fixture`, { headers: { origin } });
			expect(response.status).toBe(403);
			expect(response.headers.has("access-control-allow-origin")).toBe(false);
		}
		const response = await fetch(`${base}/v1/native-company-objects/fixture`, {
			method: "OPTIONS",
			headers: { origin: "https://app.qorpera.com", "access-control-request-method": "POST" },
		});
		expect(response.headers.has("access-control-allow-origin")).toBe(false);
		const badHeader = await fetch(`${base}/v1/member-company-file/fixture`, {
			method: "OPTIONS",
			headers: {
				origin: "https://app.qorpera.com",
				"access-control-request-method": "POST",
				"access-control-request-headers": "x-qorpera-gc-lease-id",
			},
		});
		expect(badHeader.status).toBe(403);
	});
});
