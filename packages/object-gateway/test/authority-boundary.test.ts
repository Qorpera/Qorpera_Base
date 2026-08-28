import { describe, expect, it, vi } from "vitest";
import { SupabaseObjectAuthority } from "../src/supabase-authority.ts";

const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const sha256 = "a".repeat(64);
const settings = {
	projectUrl: "https://project.example.test",
	publishableKey: "synthetic-public",
	secretKey: "synthetic-secret",
};

describe("object authority transport boundary", () => {
	it.each([
		"http://project.example.test",
		"https://secret@project.example.test",
		"https://project.example.test/api",
		"https://project.example.test/?secret=value",
		"https://project.example.test/#other",
		"invalid",
	])("rejects ambiguous or insecure authority origins (%#)", (projectUrl) => {
		expect(() => new SupabaseObjectAuthority({ ...settings, projectUrl })).toThrow("exact HTTPS origin");
	});

	it("refuses redirects on RPC, Auth, and Storage requests", async () => {
		const calls: string[] = [];
		const authority = new SupabaseObjectAuthority({
			...settings,
			fetch: async (input, init) => {
				expect(init?.redirect).toBe("error");
				const url = String(input);
				calls.push(url);
				if (url.endsWith("qorpera_list_profile_objects_for_migration")) return Response.json([]);
				if (url.includes("/storage/v1/object/authenticated/")) return new Response("immutable fixture");
				return Response.json(true);
			},
		});
		await authority.authorizeUpload("synthetic-human-token", profileId, sha256, 17);
		await authority.readLegacyObject(profileId, sha256);
		await authority.writeReplica(profileId, sha256, Buffer.from("immutable fixture"));
		await authority.removeReplica(profileId, sha256);
		await authority.probeHealth();
		expect(calls).toHaveLength(7);
		expect(calls.every((url) => new URL(url).origin === settings.projectUrl)).toBe(true);
		expect(authority.health()).toMatchObject({
			auth: { status: "healthy" },
			api: { status: "healthy" },
			storage: { status: "healthy" },
		});
	});

	it.each(["declared", "streamed"] as const)("rejects oversized %s RPC responses before parsing", async (kind) => {
		const cancel = vi.fn();
		const authority = new SupabaseObjectAuthority({
			...settings,
			fetch: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							if (kind === "streamed") controller.enqueue(new Uint8Array(1024 * 1024 + 1));
						},
						cancel,
					}),
					{ headers: kind === "declared" ? { "content-length": "1048577" } : {} },
				),
		});
		await expect(authority.authorizeUpload("synthetic-human-token", profileId, sha256, 1)).rejects.toMatchObject({
			status: 503,
		});
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("rejects oversized storage objects before buffering them", async () => {
		const cancel = vi.fn();
		const authority = new SupabaseObjectAuthority({
			...settings,
			fetch: async () =>
				new Response(new ReadableStream<Uint8Array>({ cancel }), {
					headers: { "content-length": "8388609" },
				}),
		});
		await expect(authority.readLegacyObject(profileId, sha256)).rejects.toMatchObject({ status: 503 });
		expect(cancel).toHaveBeenCalledOnce();
	});

	it.each([401, 403])("preserves denial %s even if its body and cleanup stall", async (status) => {
		const cancel = vi.fn(() => new Promise<void>(() => {}));
		const authority = new SupabaseObjectAuthority({
			...settings,
			requestTimeoutMs: 20,
			fetch: async () => new Response(new ReadableStream<Uint8Array>({ cancel }), { status }),
		});
		await expect(authority.authorizeUpload("synthetic-human-token", profileId, sha256, 1)).rejects.toMatchObject({
			status,
			unavailable: false,
		});
		await expect(authority.readLegacyObject(profileId, sha256)).rejects.toMatchObject({ status, unavailable: false });
		await expect(authority.writeReplica(profileId, sha256, new Uint8Array([1]))).rejects.toMatchObject({
			status,
			unavailable: false,
		});
		expect(cancel).toHaveBeenCalledTimes(3);
	});

	it("bounds stalled successful bodies and their cleanup", async () => {
		const cancel = vi.fn(() => new Promise<void>(() => {}));
		const authority = new SupabaseObjectAuthority({
			...settings,
			requestTimeoutMs: 20,
			fetch: async () => new Response(new ReadableStream<Uint8Array>({ cancel })),
		});
		await expect(authority.readLegacyObject(profileId, sha256)).rejects.toMatchObject({ status: 503 });
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("does not parse a late response after the request has lost its deadline", async () => {
		let resolveFetch: (response: Response) => void = () => {};
		const transport = new Promise<Response>((resolve) => {
			resolveFetch = resolve;
		});
		const authority = new SupabaseObjectAuthority({
			...settings,
			requestTimeoutMs: 20,
			fetch: async () => transport,
		});
		await expect(authority.authorizeUpload("synthetic-human-token", profileId, sha256, 1)).rejects.toMatchObject({
			status: 503,
		});
		const cancel = vi.fn();
		resolveFetch(new Response(new ReadableStream<Uint8Array>({ cancel })));
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(cancel).toHaveBeenCalledOnce();
		expect(authority.health().api.status).toBe("unavailable");
	});
});
