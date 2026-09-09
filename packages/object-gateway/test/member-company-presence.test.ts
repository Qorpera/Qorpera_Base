import { createServer, request as httpRequest } from "node:http";
import { type CompanyPathPresenceStatement, companyPresenceBytes } from "@qorpera/cloud-client/company-path-presence";
import { PresenceSignatures } from "@qorpera/cloud-client/presence-signatures";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemberCompanyAuthority } from "../src/member-company-authority.ts";
import { observeMemberCompanyPresence } from "../src/member-company-presence.ts";
import { createObjectGatewayHandler } from "../src/service.ts";

const id = (n: number) => `37000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const companyId = id(1),
	environmentId = id(2),
	clientId = id(3),
	path = "projects/report.md",
	token = "a".repeat(64);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const action of cleanup.splice(0)) await action();
});
async function fixture() {
	const keys = new PresenceSignatures(),
		now = Date.now();
	const routes = [{ path, routes: [{ path, token }] }];
	const scope = { schema: "qorpera.company-presence-scope/v1", companyId, environmentId, paths: routes };
	const subject = {
		schema: "qorpera.native-presence-subject/v1",
		identity: {
			schema: "qorpera.native-presence-identity/v1",
			companyId,
			environmentId,
			clientId,
			runId: id(4),
			staffAgentId: id(5),
			publicKey: await keys.publicKey(),
			expiresAt: now + 30000,
		},
		paths: structuredClone(routes),
	};
	const member = vi.fn<MemberCompanyAuthority["member"]>(async () => structuredClone(scope));
	const publisher = vi.fn<MemberCompanyAuthority["publisher"]>(async () => structuredClone(subject));
	const sign = async (patch: Partial<CompanyPathPresenceStatement> = {}) => {
		const statement: CompanyPathPresenceStatement = {
			schema: "qorpera.company-path-presence/v1",
			companyId,
			environmentId,
			clientId,
			sequence: 1,
			issuedAt: now,
			expiresAt: now + 25000,
			routes: [{ token, relation: "self", extent: "object", activity: "writing" }],
			...patch,
		};
		return { ...statement, signature: await keys.sign(companyPresenceBytes(statement)) };
	};
	const input = { paths: [path], candidates: [await sign()], truncated: false };
	const observe = (value: unknown = input) =>
		observeMemberCompanyPresence({
			authority: { member, publisher },
			token: "member-token",
			companyId,
			environmentId,
			input: value,
			signal: new AbortController().signal,
		});
	return { member, publisher, scope, subject, sign, input, observe };
}
async function server(f: Awaited<ReturnType<typeof fixture>>) {
	const handler = createObjectGatewayHandler({
		store: {} as never,
		authority: {} as never,
		controlToken: "control",
		verifierToken: "verifier",
		memberPresence: { member: f.member, publisher: f.publisher },
		memberClientOrigins: ["https://web.test"],
	});
	const server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No address");
	cleanup.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return `http://127.0.0.1:${address.port}/v1/member-company-presence/${companyId}/${environmentId}`;
}
describe("member-visible native activity", () => {
	it("verifies native signatures through separate member and publisher authorities", async () => {
		const f = await fixture(),
			view = await f.observe();
		expect(view.view).toMatchObject({
			state: "available",
			paths: [
				{
					path,
					participants: [{ runId: id(4), staffAgentId: id(5), activity: "writing", overlap: "same_object" }],
				},
			],
		});
		expect(view.confirmed).toEqual([{ clientId, sequence: 1 }]);
		expect(f.member).toHaveBeenCalledTimes(2);
		expect(f.member).toHaveBeenNthCalledWith(
			1,
			"qorpera_company_presence_scope",
			"member-token",
			{ p_environment_id: environmentId, p_binding: null, p_paths: [path] },
			expect.any(AbortSignal),
		);
		expect(f.publisher).toHaveBeenCalledExactlyOnceWith(
			"qorpera_native_presence_subject",
			{ p_environment_id: environmentId, p_client_id: clientId, p_paths: [path] },
			expect.any(AbortSignal),
		);
		for (const secret of [token, "publicKey", "binding", "leaseId"])
			expect(JSON.stringify(view)).not.toContain(secret);
	});
	it("resolves the newest verified statement before checking overlap", async () => {
		const f = await fixture();
		f.input.candidates.push(await f.sign({ sequence: 2, routes: [] }));
		expect(await f.observe()).toMatchObject({
			confirmed: [{ clientId, sequence: 2 }],
			view: { paths: [{ participants: [] }] },
		});
		f.input.candidates[1].signature = `${"A".repeat(86)}==`;
		expect(await f.observe()).toMatchObject({
			confirmed: [{ sequence: 1 }],
			view: { paths: [{ participants: [{ activity: "writing" }] }] },
		});
	});
	it("intersects native path authority and current member permissions", async () => {
		const f = await fixture();
		f.subject.paths[0].routes = [];
		expect((await f.observe()).view.paths[0].participants).toEqual([]);
		f.member
			.mockResolvedValueOnce(f.scope)
			.mockResolvedValueOnce({ ...f.scope, paths: [{ path, routes: [{ path, token: "b".repeat(64) }] }] });
		await expect(f.observe()).rejects.toMatchObject({ status: 403 });
	});
	it("denies members before resolving any native identity", async () => {
		const f = await fixture();
		f.member.mockRejectedValue(new Error("revoked"));
		await expect(f.observe()).rejects.toThrow();
		expect(f.publisher).not.toHaveBeenCalled();
	});
	it("omits revoked, expired, foreign and forged statements", async () => {
		const f = await fixture();
		f.publisher.mockResolvedValueOnce(null);
		expect((await f.observe()).view.paths[0].participants).toEqual([]);
		f.input.candidates = [
			await f.sign({ issuedAt: Date.now() - 31000, expiresAt: Date.now() - 1000 }),
			await f.sign({ companyId: id(99) }),
			{ ...(await f.sign()), signature: `${"A".repeat(86)}==` },
		];
		expect((await f.observe()).view.paths[0].participants).toEqual([]);
	});
	it("reports subject outages and truncated state as partial observations", async () => {
		const f = await fixture();
		f.publisher.mockRejectedValueOnce(new Error("private diagnostics"));
		expect(await f.observe()).toMatchObject({ view: { state: "partial", paths: [{ participants: [] }] } });
		expect(await f.observe({ ...f.input, truncated: true })).toMatchObject({ view: { state: "partial" } });
	});
	it("rejects malformed or oversized inputs before authority work", async () => {
		const f = await fixture();
		for (const patch of [
			{ paths: ["../secret"] },
			{ candidates: [{ ...f.input.candidates[0], binding: "private" }] },
			{ candidates: Array(33).fill(f.input.candidates[0]) },
			{ extra: true },
			{ truncated: 1 },
		])
			await expect(f.observe({ ...f.input, ...patch })).rejects.toMatchObject({ status: 400 });
		expect(f.member).not.toHaveBeenCalled();
		expect(f.publisher).not.toHaveBeenCalled();
	});
	it("bounds simultaneous subject lookups to four", async () => {
		const f = await fixture();
		let active = 0,
			maximum = 0;
		f.publisher.mockImplementation(async () => {
			active++;
			maximum = Math.max(maximum, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active--;
			return null;
		});
		f.input.candidates = await Promise.all(Array.from({ length: 10 }, (_, n) => f.sign({ clientId: id(n + 10) })));
		await f.observe();
		expect(maximum).toBe(4);
		expect(active).toBe(0);
	});
	it("serves a closed no-store member response and exact CORS preflight", async () => {
		const f = await fixture(),
			url = await server(f);
		const preflight = await fetch(url, {
			method: "OPTIONS",
			headers: {
				origin: "https://web.test",
				"access-control-request-method": "POST",
				"access-control-request-headers": "authorization,content-type",
			},
		});
		expect(preflight.status).toBe(204);
		expect(f.member).not.toHaveBeenCalled();
		const response = await fetch(url, {
			method: "POST",
			headers: {
				authorization: "Bearer member-token",
				"content-type": "application/json",
				origin: "https://web.test",
			},
			body: JSON.stringify(f.input),
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(await response.json()).toMatchObject({ view: { state: "available" } });
		expect((await fetch(url, { method: "POST", body: JSON.stringify(f.input) })).status).toBe(401);
	});
	it("disconnects a stalled inbound body without invoking authority", async () => {
		const f = await fixture(),
			url = await server(f);
		await new Promise<void>((resolve, reject) => {
			const request = httpRequest(
				url,
				{
					method: "POST",
					headers: {
						authorization: "Bearer member-token",
						"content-type": "application/json",
						"content-length": "100",
					},
				},
				(response) => {
					response.resume();
					reject(new Error(`Unexpected response ${response.statusCode}`));
				},
			);
			request.once("error", () => resolve());
			request.write("{");
		});
		expect(f.member).not.toHaveBeenCalled();
	}, 5000);
	it("cancels a stalled authority and never returns late display data", async () => {
		const f = await fixture(),
			url = await server(f);
		f.member.mockImplementation(() => new Promise(() => undefined));
		const response = await fetch(url, {
			method: "POST",
			headers: { authorization: "Bearer member-token", "content-type": "application/json" },
			body: JSON.stringify(f.input),
		});
		expect(response.status).toBe(503);
		expect(f.member.mock.calls[0][3]?.aborted).toBe(true);
		expect(f.publisher).not.toHaveBeenCalled();
	}, 5000);
});
