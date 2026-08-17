import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import {
	parseArtifactGcWorkerJobs,
	parseArtifactGcWorkerObjects,
	runArtifactGcWorkerBatch,
	type ArtifactGcStorageProvider,
	type ArtifactGcWorkerStore,
} from "./artifact-gc-worker.ts";

const OBJECT_BUCKET = "qorpera-profile-objects";

function jsonResponse(value: unknown, status = 200): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function configuredSecretKeys(): string[] {
	const legacyServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
	try {
		const parsed: unknown = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return legacyServiceRoleKey ? [legacyServiceRoleKey] : [];
		}
		const keys = Object.values(parsed).filter(
			(value): value is string => typeof value === "string" && value.length > 20,
		);
		if (legacyServiceRoleKey) keys.push(legacyServiceRoleKey);
		return [...new Set(keys)];
	} catch {
		return legacyServiceRoleKey ? [legacyServiceRoleKey] : [];
	}
}

function configuration(request: Request): { supabaseUrl: string; secretKey: string } | Response {
	const secretKeys = configuredSecretKeys();
	const apiKey = request.headers.get("apikey")?.trim();
	const authorization = request.headers.get("authorization")?.trim();
	const presentedKey =
		apiKey || (authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "");
	if (!presentedKey || !secretKeys.includes(presentedKey)) return jsonResponse({ error: "Unauthorized" }, 401);
	const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
	if (!supabaseUrl) return jsonResponse({ error: "Artifact cleanup is not configured" }, 503);
	return { supabaseUrl, secretKey: presentedKey };
}

Deno.serve(async (request) => {
	if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
	const config = configuration(request);
	if (config instanceof Response) return config;
	const client = createClient(config.supabaseUrl, config.secretKey, {
		auth: { autoRefreshToken: false, persistSession: false },
	});
	const leaseId = crypto.randomUUID();
	const { data: claimed, error: claimError } = await client.rpc("qorpera_claim_artifact_gc_plans", {
		p_limit: 5,
		p_lease_id: leaseId,
	});
	if (claimError) return jsonResponse({ error: "Artifact cleanup claim failed" }, 503);

	let jobs;
	try {
		jobs = parseArtifactGcWorkerJobs(claimed);
	} catch {
		return jsonResponse({ error: "Artifact cleanup claim was invalid" }, 503);
	}
	const store: ArtifactGcWorkerStore = {
		claimObjects: async (job) => {
			const { data, error } = await client.rpc("qorpera_claim_artifact_gc_objects", {
				p_plan_id: job.planId,
				p_lease_id: job.leaseId,
				p_limit: 100,
			});
			if (error) throw new Error("Artifact cleanup object claim failed");
			return parseArtifactGcWorkerObjects(data, job);
		},
		renewLease: async (job, sha256s) => {
			const { error } = await client.rpc("qorpera_renew_artifact_gc_lease", {
				p_plan_id: job.planId,
				p_lease_id: job.leaseId,
				p_object_sha256s: sha256s,
			});
			if (error) throw new Error("Artifact cleanup lease renewal failed");
		},
		acknowledgeObjects: async (job, sha256s) => {
			const { error } = await client.rpc("qorpera_complete_artifact_gc_objects", {
				p_plan_id: job.planId,
				p_lease_id: job.leaseId,
				p_object_sha256s: sha256s,
			});
			if (error) throw new Error("Artifact cleanup acknowledgement failed");
		},
		complete: async (job) => {
			const { error } = await client.rpc("qorpera_complete_artifact_gc_plan", {
				p_plan_id: job.planId,
				p_lease_id: job.leaseId,
			});
			if (error) throw new Error("Artifact cleanup completion failed");
		},
		fail: async (job, message) => {
			const { data, error } = await client.rpc("qorpera_fail_artifact_gc_plan", {
				p_plan_id: job.planId,
				p_lease_id: job.leaseId,
				p_error: message,
			});
			if (error || !data || typeof data !== "object" || Array.isArray(data)) {
				throw new Error("Artifact cleanup failure could not be recorded");
			}
			const status = (data as Record<string, unknown>).status;
			if (status !== "retrying" && status !== "failed") {
				throw new Error("Artifact cleanup failure returned an invalid state");
			}
			return status;
		},
	};
	const storage: ArtifactGcStorageProvider = {
		remove: async (objects) => {
			const { error } = await client.storage.from(OBJECT_BUCKET).remove(objects.map((object) => object.path));
			if (error) throw new Error("Storage object removal failed");
		},
	};
	return jsonResponse(await runArtifactGcWorkerBatch(jobs, storage, store));
});
