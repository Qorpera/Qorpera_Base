import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObjectDependencyError } from "../src/dependency.ts";
import type { MemberCompanyObjectAuthority } from "../src/member-company-objects.ts";
import { createMemberCors } from "../src/member-cors.ts";
import { FileSystemObjectStore } from "../src/object-store.ts";
import { createObjectGatewayHandler } from "../src/service.ts";
import type { ObjectGatewayAuthority } from "../src/supabase-authority.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const origin = "https://web.qorpera.test",
	path = "documents/æble.bin";
const bytes = Buffer.from([0, 255, 128, 1]);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const objectRoute = `/v1/member-company-objects/${id(2)}/${id(3)}/${sha256}`;
const fileRoute = `/v1/member-company-file/${id(2)}`;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const action of cleanup.splice(0)) await action();
});

async function fixture(origins: readonly string[] = [origin]) {
	const root = await mkdtemp(join(tmpdir(), "qorpera-member-cors-"));
	const store = new FileSystemObjectStore(root);
	await store.put(id(1), sha256, bytes);
	let revoked = false;
	const authorize = vi.fn<MemberCompanyObjectAuthority["authorizeMemberCompanyObject"]>(async (token, identity) => {
		if (token !== "member-token" || revoked) throw new ObjectDependencyError(403);
		expect(identity).toEqual({ environmentId: id(2), path, version: id(3), sha256 });
		return {
			...identity,
			schema: "qorpera.member-company-object/v2",
			companyId: id(1),
			actorUserId: id(4),
			resourceId: id(5),
			resourceVersion: id(6),
			bytes: bytes.length,
			backend: "nas-object-gateway",
		};
	});
	const get = vi.spyOn(store, "get");
	const server = createServer(
		createObjectGatewayHandler({
			store,
			authority: {} as ObjectGatewayAuthority,
			controlToken: "control-fixture",
			verifierToken: "verifier-fixture",
			memberObjects: {
				authorizeMemberCompanyObject: authorize,
				readLegacyObject: async () => {
					throw new Error("Unexpected fallback");
				},
			},
			memberClientOrigins: origins,
		}),
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing server address");
	cleanup.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	});
	return {
		authorize,
		get,
		revoke: () => {
			revoked = true;
		},
		request: (route = objectRoute, init: RequestInit = {}) => fetch(`http://127.0.0.1:${address.port}${route}`, init),
	};
}
const memberHeaders = {
	origin,
	authorization: "Bearer member-token",
	"x-qorpera-company-path": Buffer.from(path).toString("base64url"),
};
const preflight = (method = "GET", headers = "authorization,x-qorpera-company-path") => ({
	method: "OPTIONS",
	headers: { origin, "access-control-request-method": method, "access-control-request-headers": headers },
});

describe("member browser CORS", () => {
	it("preflights snapshot reads and binds both authorizations to snapshot mode", async () => {
		const service = await fixture();
		const route = objectRoute.replace("member-company-objects", "member-company-snapshot-objects");
		expect((await service.request(route, preflight())).status).toBe(204);
		expect(service.authorize).not.toHaveBeenCalled();
		const response = await service.request(route, { headers: memberHeaders });
		expect(response.status).toBe(200);
		expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
		expect(service.authorize).toHaveBeenCalledTimes(2);
		for (const call of service.authorize.mock.calls) expect(call[2]).toBe("snapshot");
		expect((await service.request(route, preflight("PUT"))).status).toBe(403);
		expect(
			(await service.request(route, { headers: { ...memberHeaders, origin: "https://evil.test" } })).status,
		).toBe(403);
		expect(service.authorize).toHaveBeenCalledTimes(2);
	});
	it.each([
		"*",
		"null",
		"file://",
		"https://web.qorpera.test/",
		"https://web.qorpera.test/path",
		"https://web.qorpera.test?x",
		"https://user@web.qorpera.test",
		"http://web.qorpera.test",
		" https://web.qorpera.test",
		"https://WEB.qorpera.test",
		"https://web.qorpera.test:443",
	])("rejects invalid configured origin %s", (value) => {
		expect(() => createMemberCors([value])).toThrow();
	});
	it("bounds and copies the startup allowlist", async () => {
		for (const value of [
			null,
			origin,
			[origin, origin],
			Array.from({ length: 33 }, (_, n) => `https://web${n}.test`),
			[123],
		])
			expect(() => createMemberCors(value as string[])).toThrow();
		expect(() => createMemberCors(["http://127.0.0.1:1234", origin])).not.toThrow();
		const origins = [origin],
			service = await fixture(origins);
		origins.push("https://evil.test");
		const response = await service.request(objectRoute, {
			headers: { ...memberHeaders, origin: "https://evil.test" },
		});
		expect(response.status).toBe(403);
		expect(service.authorize).not.toHaveBeenCalled();
	});
	it("preflights only the member route without bearer, authority or storage I/O", async () => {
		const service = await fixture(),
			response = await service.request(objectRoute, preflight("GET", "Authorization, X-Qorpera-Company-Path"));
		expect(response.status).toBe(204);
		expect(await response.text()).toBe("");
		expect(response.headers.get("access-control-allow-origin")).toBe(origin);
		expect(response.headers.get("access-control-allow-methods")).toBe("GET");
		expect(response.headers.get("access-control-allow-headers")).toBe("authorization, x-qorpera-company-path");
		expect(response.headers.get("access-control-allow-credentials")).toBeNull();
		expect(response.headers.get("access-control-max-age")).toBe("0");
		expect(response.headers.get("vary")).toBe(
			"Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
		);
		expect(service.authorize).not.toHaveBeenCalled();
		expect(service.get).not.toHaveBeenCalled();
	});
	it.each([
		[`/v1/member-folder-commits/${id(7)}`, "POST"],
		[`/v1/member-session-attachments/upload/${id(7)}/${id(8)}/${sha256}`, "PUT"],
		[`/v1/member-session-attachments/input/${id(7)}/${id(8)}/${sha256}`, "GET"],
	])("allows the existing %s %s transport contract", async (route, method) => {
		const service = await fixture(),
			response = await service.request(route, preflight(method, "authorization,content-type"));
		expect(response.status).toBe(204);
		expect(response.headers.get("access-control-allow-methods")).toBe(method);
		expect(service.authorize).not.toHaveBeenCalled();
		expect(service.get).not.toHaveBeenCalled();
	});
	it("allows a member's folder object GET with only authorization", async () => {
		const service = await fixture(),
			response = await service.request(
				`/v1/member-folder-objects/${id(1)}/${sha256}`,
				preflight("GET", "authorization"),
			);
		expect(response.status).toBe(204);
		expect(response.headers.get("access-control-allow-methods")).toBe("GET");
		expect(response.headers.get("access-control-allow-headers")).toBe("authorization");
		expect(service.authorize).not.toHaveBeenCalled();
		expect(service.get).not.toHaveBeenCalled();
	});
	it.each([
		[objectRoute, "PUT", "authorization"],
		[objectRoute, "GET", "authorization,x-qorpera-native-token"],
		[objectRoute, "GET", "authorization,"],
		[objectRoute, "GET", "x".repeat(1025)],
		[`${objectRoute}?x=1`, "GET", "authorization"],
		[`${fileRoute}/edits`, "POST", "authorization,content-type"],
		[`${fileRoute}/edits/${id(7)}/file`, "GET", "authorization"],
		[`${fileRoute}/uploads`, "PUT", "authorization,content-type,x-qorpera-company-upload"],
		["/v1/read-leases/revoke", "POST", "authorization"],
		["/v1/control/member-observations", "GET", "authorization"],
		[`/v1/folder-objects/${id(1)}/${sha256}`, "GET", "authorization"],
		[`/v1/profile-objects/${id(1)}/${sha256}`, "GET", "authorization"],
		["/readyz", "GET", "authorization"],
		[`/v1/member-folder-objects/${id(1)}/${sha256}`, "PUT", "authorization"],
		[`/v1/member-folder-objects/${id(1)}/${sha256}`, "GET", "authorization,content-type"],
		[`/v1/member-folder-objects/${id(1)}/${sha256}`, "GET", "authorization,x-qorpera-company-path"],
		[`/v1/member-folder-objects/${id(1)}/${id(2)}/${sha256}`, "GET", "authorization"],
		[`/v1/member-folder-objects/${id(1)}/${sha256}?x=1`, "GET", "authorization"],
	])("refuses preflight %s %s %s without I/O", async (route, method, headers) => {
		const service = await fixture(),
			response = await service.request(route, preflight(method, headers));
		expect(response.status).toBe(403);
		expect(response.headers.get("access-control-allow-origin")).toBeNull();
		expect(service.authorize).not.toHaveBeenCalled();
		expect(service.get).not.toHaveBeenCalled();
	});
	it.each(["https://evil.test", "https://web.qorpera.test.evil.test", "null"])(
		"refuses actual requests from %s before authority",
		async (value) => {
			const service = await fixture(),
				response = await service.request(objectRoute, { headers: { ...memberHeaders, origin: value } });
			expect(response.status).toBe(403);
			expect(response.headers.get("access-control-allow-origin")).toBeNull();
			expect(service.authorize).not.toHaveBeenCalled();
		},
	);
	it("requires configuration and refuses originless preflight while preserving desktop reads", async () => {
		const service = await fixture([]);
		for (const init of [preflight(), { headers: memberHeaders }, { method: "OPTIONS" }])
			expect((await service.request(objectRoute, init)).status).toBe(403);
		expect(service.authorize).not.toHaveBeenCalled();
		const { origin: _origin, ...headers } = memberHeaders;
		const response = await service.request(objectRoute, { headers });
		expect(response.status).toBe(200);
		expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
		expect(response.headers.get("access-control-allow-origin")).toBeNull();
		expect(response.headers.get("vary")).toBe("Origin");
	});
	it("exposes verified bytes and headers only after both live authorizations", async () => {
		const service = await fixture(),
			response = await service.request(objectRoute, { headers: memberHeaders });
		expect(response.status).toBe(200);
		expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
		expect(response.headers.get("access-control-allow-origin")).toBe(origin);
		expect(response.headers.get("access-control-expose-headers")).toBe("x-qorpera-access-mode, etag");
		expect(response.headers.get("access-control-allow-credentials")).toBeNull();
		expect(response.headers.get("x-qorpera-access-mode")).toBe("live-path-authority");
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(service.authorize).toHaveBeenCalledTimes(2);
		expect(service.get).toHaveBeenCalledOnce();
	});
	it("exposes member failures but never admits a cookie-only request", async () => {
		const service = await fixture();
		const response = await service.request(objectRoute, { headers: { origin, cookie: "session=member-token" } });
		expect(response.status).toBe(401);
		expect(response.headers.get("access-control-allow-origin")).toBe(origin);
		expect(service.authorize).not.toHaveBeenCalled();
		expect(service.get).not.toHaveBeenCalled();
	});
	it("refuses access revoked during storage I/O with CORS headers retained", async () => {
		const service = await fixture();
		service.get.mockImplementation(async () => {
			service.revoke();
			return bytes;
		});
		const response = await service.request(objectRoute, { headers: memberHeaders });
		expect(response.status).toBe(403);
		expect(response.headers.get("access-control-allow-origin")).toBe(origin);
		expect(await response.text()).not.toContain(bytes.toString("base64"));
		expect(service.authorize).toHaveBeenCalledTimes(2);
	});
	it("refuses direct private and wrong-method requests even with an allowed origin", async () => {
		const service = await fixture();
		for (const [route, method] of [
			[objectRoute, "POST"],
			[`/v1/profile-objects/${id(1)}/${sha256}`, "GET"],
		]) {
			const response = await service.request(route, { method, headers: memberHeaders });
			expect(response.status).toBe(403);
			expect(response.headers.get("access-control-allow-origin")).toBeNull();
		}
		expect(service.authorize).not.toHaveBeenCalled();
		expect(service.get).not.toHaveBeenCalled();
	});
});
