import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObjectDependencyError } from "../src/dependency.ts";
import { ObjectGatewayJournal } from "../src/journal.ts";
import type { MemberCompanyAuthority } from "../src/member-company-authority.ts";
import { FileSystemObjectStore } from "../src/object-store.ts";
import { ObjectGatewayReplication } from "../src/replication.ts";
import { createObjectGatewayHandler } from "../src/service.ts";
import { SupabaseObjectAuthority } from "../src/supabase-authority.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture(size = 6) {
	const root = await mkdtemp(join(tmpdir(), "qorpera-member-export-")),
		bytes = Buffer.alloc(size, 128),
		sha256 = createHash("sha256").update(bytes).digest("hex");
	const store = new FileSystemObjectStore(join(root, "objects"));
	if (size) await store.put(id(1), sha256, bytes);
	const asset = {
		schema: "qorpera.file-transfer-asset/v1",
		assetId: id(3),
		sha256,
		bytes: size,
		mediaType: "application/octet-stream",
		source: { realm: "company_computer", companyComputerId: id(4), screenId: id(5), path: "reports/output.bin" },
		destination: { realm: "object_storage" },
	};
	const state = { denied: false, descriptor: { companyId: id(1), environmentId: id(2), asset } };
	const member = vi.fn<MemberCompanyAuthority["member"]>(async (method, token, args) => {
		expect(method).toBe("qorpera_member_file_export_source");
		expect(token).toBe("member");
		expect(args).toEqual({ p_environment_id: id(2), p_source: { realm: "object_storage", assetId: id(3), sha256 } });
		if (state.denied) throw new ObjectDependencyError(403);
		return structuredClone(state.descriptor);
	});
	const authority = new SupabaseObjectAuthority({
		projectUrl: "https://authority.test",
		publishableKey: "public",
		secretKey: "private",
		fetch: async () => {
			throw new Error("Unexpected raw object authority");
		},
	});
	const replication = new ObjectGatewayReplication(new ObjectGatewayJournal(join(root, "journal")), store, authority);
	const server = createServer(
		createObjectGatewayHandler({
			store,
			authority,
			replication,
			memberFiles: {
				member,
				publisher: async () => {
					throw new Error("No member export mutation");
				},
			},
			controlToken: "control",
			verifierToken: "verifier",
			memberClientOrigins: ["https://member.test"],
		}),
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No port");
	const url = `http://127.0.0.1:${address.port}/v1/member-file-exports/${id(2)}/${id(3)}/${sha256}`;
	cleanups.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	});
	return {
		store,
		state,
		member,
		bytes,
		url,
		read: () => fetch(url, { headers: { authorization: "Bearer member", origin: "https://member.test" } }),
	};
}
describe("member completed export gateway", () => {
	it.each([0, 6, 8388608])("serves %i verified bytes under exact member export authority", async (size) => {
		const f = await fixture(size),
			response = await f.read();
		expect(response.status).toBe(200);
		expect(Buffer.from(await response.arrayBuffer()).equals(f.bytes)).toBe(true);
		expect(f.member).toHaveBeenCalledTimes(2);
		expect(response.headers.get("x-qorpera-access-mode")).toBe("live-export-authority");
		expect(response.headers.get("access-control-allow-origin")).toBe("https://member.test");
	});
	it("uses a native CORS preflight without consulting authority", async () => {
		const f = await fixture(),
			response = await fetch(f.url, {
				method: "OPTIONS",
				headers: {
					origin: "https://member.test",
					"access-control-request-method": "GET",
					"access-control-request-headers": "authorization",
				},
			});
		expect(response.status).toBe(204);
		expect(f.member).not.toHaveBeenCalled();
	});
	it.each(["denied", "revoked", "corrupt", "substituted"])("refuses %s export content", async (mode) => {
		const f = await fixture(),
			get = f.store.get.bind(f.store);
		if (mode === "denied") f.state.denied = true;
		vi.spyOn(f.store, "get").mockImplementation(async (...args) => {
			const bytes = await get(...args);
			if (mode === "revoked") f.state.denied = true;
			if (mode === "substituted") f.state.descriptor.asset.source.path = "different.bin";
			return mode === "corrupt" ? new Uint8Array(bytes.length) : bytes;
		});
		expect((await f.read()).status).toBeGreaterThanOrEqual(400);
	});
});
