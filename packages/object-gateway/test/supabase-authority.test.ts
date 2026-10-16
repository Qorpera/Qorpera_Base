import { describe, expect, it } from "vitest";
import { SupabaseObjectAuthority } from "../src/supabase-authority.ts";

const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const environmentId = "5c1d0b8e-6d4f-4a43-9e8b-2f7a1c3d9e10";
const sha256 = "a".repeat(64);
type FetchInput = Parameters<typeof fetch>[0];

function header(request: FetchInput, init: RequestInit | undefined, name: string): string | null {
	return new Request(request, init).headers.get(name);
}

describe("Supabase object authority", () => {
	it("keeps the user JWT in Authorization and the publishable key in apikey", async () => {
		const calls: Array<{ request: FetchInput; init: RequestInit | undefined }> = [];
		const authority = new SupabaseObjectAuthority({
			projectUrl: "https://project.supabase.co",
			publishableKey: "sb_publishable_public",
			secretKey: "sb_secret_private",
			fetch: async (request, init) => {
				calls.push({ request, init });
				return Response.json({ schema: "qorpera.folder-object-download/v1", profileId, bytes: 12 });
			},
		});

		await authority.authorizeMemberFolderObject("member-jwt", environmentId, sha256);

		expect(calls).toHaveLength(1);
		expect(header(calls[0]!.request, calls[0]!.init, "apikey")).toBe("sb_publishable_public");
		expect(header(calls[0]!.request, calls[0]!.init, "authorization")).toBe("Bearer member-jwt");
	});

	it("sends modern secret keys only in apikey for privileged operations", async () => {
		const calls: Array<{ request: FetchInput; init: RequestInit | undefined }> = [];
		const authority = new SupabaseObjectAuthority({
			projectUrl: "https://project.supabase.co",
			publishableKey: "sb_publishable_public",
			secretKey: "sb_secret_private",
			fetch: async (request, init) => {
				calls.push({ request, init });
				return new Response(null, { status: 204 });
			},
		});

		await authority.confirmUpload(profileId, sha256, 12);

		expect(calls).toHaveLength(1);
		expect(header(calls[0]!.request, calls[0]!.init, "apikey")).toBe("sb_secret_private");
		expect(header(calls[0]!.request, calls[0]!.init, "authorization")).toBeNull();
	});

	it("authorizes and finalizes deletion in separate privileged calls", async () => {
		const calls: Array<{ request: FetchInput; init: RequestInit | undefined }> = [];
		const authority = new SupabaseObjectAuthority({
			projectUrl: "https://project.supabase.co",
			publishableKey: "sb_publishable_public",
			secretKey: "sb_secret_private",
			fetch: async (request, init) => {
				calls.push({ request, init });
				return Response.json(
					calls.length === 1
						? { state: "authorized", authorization_id: "83dc6943-b71c-4ba4-a38d-78da0861e0dc" }
						: true,
				);
			},
		});

		const authorization = await authority.authorizeDelete(
			profileId,
			sha256,
			12,
			"73dc6943-b71c-4ba4-a38d-78da0861e0dc",
		);
		expect(authorization).toEqual({
			state: "authorized",
			authorizationId: "83dc6943-b71c-4ba4-a38d-78da0861e0dc",
		});
		await authority.finalizeDelete("83dc6943-b71c-4ba4-a38d-78da0861e0dc", profileId, sha256, 12);

		expect(calls.map((call) => String(call.request))).toEqual([
			"https://project.supabase.co/rest/v1/rpc/qorpera_authorize_profile_object_deletion",
			"https://project.supabase.co/rest/v1/rpc/qorpera_finalize_profile_object_deletion",
		]);
		for (const call of calls) {
			expect(header(call.request, call.init, "apikey")).toBe("sb_secret_private");
			expect(header(call.request, call.init, "authorization")).toBeNull();
		}
	});

	it("does not mislabel a modern secret key as a storage bearer token", async () => {
		const calls: Array<{ request: FetchInput; init: RequestInit | undefined }> = [];
		const authority = new SupabaseObjectAuthority({
			projectUrl: "https://project.supabase.co",
			publishableKey: "sb_publishable_public",
			secretKey: "sb_secret_private",
			fetch: async (request, init) => {
				calls.push({ request, init });
				return new Response(Uint8Array.from([1, 2, 3]));
			},
		});

		await authority.readLegacyObject(profileId, sha256);

		expect(calls).toHaveLength(1);
		expect(header(calls[0]!.request, calls[0]!.init, "apikey")).toBe("sb_secret_private");
		expect(header(calls[0]!.request, calls[0]!.init, "authorization")).toBeNull();
	});
});
