import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import {
	type CachedVerifiedCompanyFile,
	CompanySnapshotVerificationPending,
	verifyCompanySnapshotClosure,
} from "./company-file-verifier.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OBJECT_BUCKET = "qorpera-profile-objects";

function jsonResponse(value: unknown, status = 200): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid verifier payload");
	return value as Record<string, unknown>;
}

function configuredServiceKey(): string {
	const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
	if (legacy) return legacy;
	try {
		const parsed = record(JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"));
		return Object.values(parsed).find((value): value is string => typeof value === "string" && value.length > 20) ?? "";
	} catch {
		return "";
	}
}

Deno.serve(async (request) => {
	if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
	const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
	const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
	const serviceKey = configuredServiceKey();
	const authorization = request.headers.get("authorization")?.trim() ?? "";
	if (!supabaseUrl || !anonKey || !serviceKey) return jsonResponse({ error: "Company File verification is not configured" }, 503);
	if (!authorization.startsWith("Bearer ")) return jsonResponse({ error: "Unauthorized" }, 401);

	let snapshotId: string;
	let graphId: string;
	try {
		const body = record(await request.json());
		if (typeof body.snapshotId !== "string" || !UUID_PATTERN.test(body.snapshotId)) throw new Error();
		if (typeof body.graphId !== "string" || !UUID_PATTERN.test(body.graphId)) throw new Error();
		snapshotId = body.snapshotId;
		graphId = body.graphId;
	} catch {
		return jsonResponse({ error: "Invalid Company File verification request" }, 400);
	}

	const userClient = createClient(supabaseUrl, anonKey, {
		auth: { autoRefreshToken: false, persistSession: false },
		global: { headers: { Authorization: authorization } },
	});
	const { data: userData, error: userError } = await userClient.auth.getUser();
	if (userError || !userData.user) return jsonResponse({ error: "Unauthorized" }, 401);
	const serviceClient = createClient(supabaseUrl, serviceKey, {
		auth: { autoRefreshToken: false, persistSession: false },
	});
	const [snapshotResult, graphResult] = await Promise.all([
		userClient.rpc("qorpera_get_company_snapshot", { p_snapshot_id: snapshotId }),
		userClient.rpc("qorpera_get_object_reachability_graph", { p_graph_id: graphId }),
	]);
	if (snapshotResult.error || graphResult.error) return jsonResponse({ error: "Company File verification access was denied" }, 403);

	try {
		const snapshot = record(snapshotResult.data);
		const graph = record(graphResult.data);
		if (graph.root_kind !== "company_snapshot" || graph.root_id !== snapshotId || graph.status !== "complete") {
			throw new Error("Company File graph is incomplete");
		}
		const profileId = snapshot.profile_id;
		if (typeof profileId !== "string" || !UUID_PATTERN.test(profileId)) throw new Error("Invalid Company File profile");
		const verified = await verifyCompanySnapshotClosure(
			{
				profileId,
				manifestSha256: String(snapshot.tree_manifest_sha256 ?? ""),
				manifestBytes: Number(snapshot.tree_manifest_bytes),
				contractVersion: Number(snapshot.tree_contract_version),
				fileCount: Number(snapshot.file_count),
				totalBytes: Number(snapshot.total_bytes),
			},
			async (objectProfileId, sha256) => {
				const { data, error } = await userClient.storage
					.from(OBJECT_BUCKET)
					.download(`${objectProfileId}/${sha256}`);
				if (error) throw new Error("Company File object is unavailable");
				return new Uint8Array(await data.arrayBuffer());
			},
			{
				maxNewFileBytes: 64 * 1024 * 1024,
				load: async (objectProfileId, manifestSha256) => {
					const { data, error } = await serviceClient
						.from("qorpera_verified_company_file_objects")
						.select("manifest_sha256,manifest_bytes,file_sha256,bytes,media_type,objects")
						.eq("profile_id", objectProfileId)
						.eq("manifest_sha256", manifestSha256)
						.eq("verifier_version", 1)
						.maybeSingle();
					if (error) throw new Error("Company File verification cache is unavailable");
					if (!data) return undefined;
					const cached = record(data);
					return {
						manifestSha256: String(cached.manifest_sha256 ?? ""),
						manifestBytes: Number(cached.manifest_bytes),
						fileSha256: String(cached.file_sha256 ?? ""),
						bytes: Number(cached.bytes),
						mediaType: String(cached.media_type ?? ""),
						objects: cached.objects as CachedVerifiedCompanyFile["objects"],
					};
				},
				save: async (objectProfileId, file) => {
					const { error } = await serviceClient.from("qorpera_verified_company_file_objects").upsert(
						{
							profile_id: objectProfileId,
							manifest_sha256: file.manifestSha256,
							verifier_version: 1,
							manifest_bytes: file.manifestBytes,
							file_sha256: file.fileSha256,
							bytes: file.bytes,
							media_type: file.mediaType,
							objects: file.objects,
							verified_at: new Date().toISOString(),
						},
						{ onConflict: "profile_id,manifest_sha256,verifier_version" },
					);
					if (error) throw new Error("Company File verification cache could not be saved");
				},
			},
		);
		const { error } = await serviceClient.rpc("qorpera_verify_company_snapshot_closure", {
			p_snapshot_id: snapshotId,
			p_graph_id: graphId,
			p_verified_user_id: userData.user.id,
			p_reachable_content_sha256: verified.reachableContentSha256,
			p_object_count: verified.objectCount,
			p_storage_bytes: verified.storageBytes,
			p_restored_content_sha256: verified.restoredContentSha256,
			p_restored_bytes: verified.restoredBytes,
		});
		if (error) throw new Error("Company File graph did not match server verification");
		return jsonResponse({ verified: true });
	} catch (error) {
		if (error instanceof CompanySnapshotVerificationPending) {
			return jsonResponse({ verified: false, pending: true }, 202);
		}
		return jsonResponse({ error: error instanceof Error ? error.message : "Company File verification failed" }, 422);
	}
});
