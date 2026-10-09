import { describe, expect, it } from "vitest";
import { ObjectDependencyError } from "../src/dependency.ts";
import { type MemberCompanyPublisherRpc, SupabaseMemberCompanyAuthority } from "../src/member-company-authority.ts";
import { SupabaseObjectAuthority } from "../src/supabase-authority.ts";

const projectUrl = "https://project.example.test";
const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const authorizationId = "83dc6943-b71c-4ba4-a38d-78da0861e0dc";
const sha256 = "a".repeat(64);
// Unsigned synthetic fixtures, never provider credentials.
const legacyServiceKey = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c3ludGhldGlj";
const legacyPublicKey = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.c3ludGhldGlj";
const credentials = [
	{ name: "JWT", secretKey: legacyServiceKey, publishableKey: legacyPublicKey, bearer: `Bearer ${legacyServiceKey}` },
	{ name: "opaque", secretKey: "sb_secret_fixture", publishableKey: "sb_publishable_fixture", bearer: null },
];

const objectOperations: Array<{ name: string; call: (authority: SupabaseObjectAuthority) => Promise<unknown> }> = [
	{ name: "service download", call: (authority) => authority.authorizeServiceDownload(profileId, sha256) },
	{ name: "upload receipt", call: (authority) => authority.confirmUpload(profileId, sha256, 7) },
	{
		name: "delete authorization",
		call: (authority) => authority.authorizeDelete(profileId, sha256, 7, authorizationId),
	},
	{ name: "delete recovery", call: (authority) => authority.resumeDelete(authorizationId, profileId, sha256, 7) },
	{ name: "delete receipt", call: (authority) => authority.finalizeDelete(authorizationId, profileId, sha256, 7) },
	{ name: "replication authorization", call: (authority) => authority.authorizeReplication(profileId, sha256, 7) },
	{ name: "replication receipt", call: (authority) => authority.confirmReplica(profileId, sha256, 7) },
	{ name: "migration catalog", call: (authority) => authority.listLegacyObjects(undefined, 1) },
	{ name: "Storage download", call: (authority) => authority.readLegacyObject(profileId, sha256) },
	{ name: "Storage upload", call: (authority) => authority.writeReplica(profileId, sha256, Buffer.from("fixture")) },
	{ name: "Storage delete", call: (authority) => authority.removeReplica(profileId, sha256) },
];

const publisherOperations = [
	"qorpera_stage_member_session_attachment",
	"qorpera_claim_connection_file",
	"qorpera_finish_connection_file",
	"qorpera_claim_coding_results_file",
	"qorpera_finish_coding_results_file",
	"qorpera_folder_authorize_object_download",
	"qorpera_folder_open_upload",
	"qorpera_folder_authorize_object_upload",
	"qorpera_folder_confirm_object",
	"qorpera_folder_seal_upload",
	"qorpera_folder_commit",
] as const satisfies readonly MemberCompanyPublisherRpc[];

describe.each(credentials)("$name gateway service authority", ({ secretKey, publishableKey, bearer }) => {
	function transport(requests: Request[]): typeof fetch {
		return async (input, init) => {
			const request = new Request(input, init);
			requests.push(request);
			const url = new URL(request.url);
			expect(url.origin).toBe(projectUrl);
			expect(request.redirect).toBe("error");
			const authHealth = url.pathname === "/auth/v1/health";
			if (
				request.headers.get("apikey") !== (authHealth ? publishableKey : secretKey) ||
				request.headers.get("authorization") !== (authHealth ? null : bearer)
			)
				return Response.json({ code: "42501" }, { status: 403 });
			if (url.pathname.endsWith("_object_download"))
				return Response.json({ backend: "nas-object-gateway", bytes: 7 });
			if (url.pathname.endsWith("qorpera_list_profile_objects_for_migration")) return Response.json([]);
			if (url.pathname.endsWith("_object_deletion") || url.pathname.endsWith("_deletion_authorization"))
				return Response.json({ state: "authorized", authorization_id: authorizationId });
			if (url.pathname.includes("/storage/v1/object/authenticated/")) return new Response("fixture");
			return Response.json(true);
		};
	}

	it.each(objectOperations)("authenticates $name with configured service authority", async ({ call }) => {
		const requests: Request[] = [];
		const authority = new SupabaseObjectAuthority({
			projectUrl,
			secretKey,
			publishableKey,
			fetch: transport(requests),
		});
		await expect(call(authority)).resolves.not.toThrow();
		expect(requests).toHaveLength(1);
		expect(requests[0]?.headers.get("apikey")).toBe(secretKey);
		expect(requests[0]?.headers.get("authorization")).toBe(bearer);
	});

	it.each(publisherOperations)("authenticates publisher %s without a member bearer", async (method) => {
		const requests: Request[] = [];
		const authority = new SupabaseMemberCompanyAuthority({
			projectUrl,
			secretKey,
			publishableKey,
			fetch: transport(requests),
		});
		// The answer is the transport's for that path (a download authorization's shape, or true).
		await expect(authority.publisher(method, {}, new AbortController().signal)).resolves.toEqual(
			method.endsWith("_object_download") ? { backend: "nas-object-gateway", bytes: 7 } : true,
		);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.headers.get("apikey")).toBe(secretKey);
		expect(requests[0]?.headers.get("authorization")).toBe(bearer);
	});

	it("authenticates API and Storage health probes without adding service authority to Auth health", async () => {
		const requests: Request[] = [];
		const authority = new SupabaseObjectAuthority({
			projectUrl,
			secretKey,
			publishableKey,
			fetch: transport(requests),
		});
		await authority.probeHealth();
		expect(requests).toHaveLength(3);
		expect(authority.health()).toMatchObject({
			api: { status: "healthy" },
			storage: { status: "healthy" },
			auth: { status: "healthy" },
		});
	});

	it("never replaces a member bearer with the configured application or service identity", async () => {
		const requests: Request[] = [];
		const options = {
			projectUrl,
			secretKey,
			publishableKey,
			fetch: (async (input, init) => {
				requests.push(new Request(input, init));
				return Response.json(true);
			}) satisfies typeof fetch,
		};
		await new SupabaseObjectAuthority(options).authorizeUpload("member-jwt", profileId, sha256, 7);
		await new SupabaseMemberCompanyAuthority(options).member(
			"qorpera_member_folder_writer",
			"member-jwt",
			{},
			new AbortController().signal,
		);
		expect(requests).toHaveLength(2);
		for (const request of requests) {
			expect(request.headers.get("apikey")).toBe(publishableKey);
			expect(request.headers.get("authorization")).toBe("Bearer member-jwt");
			expect(request.redirect).toBe("error");
		}
	});

	it.each([401, 403])(
		"does not retry denied member status %s with service authority or expose its body",
		async (status) => {
			const requests: Request[] = [];
			const authority = new SupabaseMemberCompanyAuthority({
				projectUrl,
				secretKey,
				publishableKey,
				fetch: async (input, init) => {
					requests.push(new Request(input, init));
					return Response.json({ message: secretKey }, { status });
				},
			});
			const error: unknown = await authority
				.member("qorpera_member_folder_writer", "member-jwt", {}, new AbortController().signal)
				.catch((failure: unknown) => failure);
			expect(error).toBeInstanceOf(ObjectDependencyError);
			expect(error).toMatchObject({ status });
			expect(String(error)).not.toContain(secretKey);
			expect(requests).toHaveLength(1);
			expect(requests[0]?.headers.get("apikey")).toBe(publishableKey);
			expect(requests[0]?.headers.get("authorization")).toBe("Bearer member-jwt");
		},
	);
});
