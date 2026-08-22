import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import {
	parseArtifactGcWorkerJobs,
	parseArtifactGcWorkerObjects,
	parseAuthorizedArtifactGcWorkerObjects,
	parseCompanyObjectGcWorkerJob,
	createRoutedArtifactGcStorageProvider,
	resolveArtifactGcWorkerAuthorization,
	runArtifactGcWorkerBatch,
	runCompanyObjectGcWorkerJob,
	reconcileAuthorizedArtifactGcWorkerObjects,
	type ArtifactGcStorageProvider,
	type ArtifactGcWorkerStore,
	type CompanyObjectGcWorkerStore,
} from "./artifact-gc-worker.ts";

const OBJECT_BUCKET = "qorpera-profile-objects";

function jsonResponse(value: unknown, status = 200): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function configuredServiceKeys(): string[] {
	const explicitServiceKey = Deno.env.get("QORPERA_ARTIFACT_GC_SERVICE_KEY");
	const legacyServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
	try {
		const parsed: unknown = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return [explicitServiceKey, legacyServiceRoleKey].filter((value): value is string =>
				Boolean(value),
			);
		}
		const keys = Object.values(parsed).filter(
			(value): value is string => typeof value === "string" && value.length > 20,
		);
		if (explicitServiceKey) keys.unshift(explicitServiceKey);
		if (legacyServiceRoleKey) keys.push(legacyServiceRoleKey);
		return [...new Set(keys)];
	} catch {
		return [explicitServiceKey, legacyServiceRoleKey].filter((value): value is string =>
			Boolean(value),
		);
	}
}

function configuration(request: Request): { supabaseUrl: string; secretKey: string } | Response {
	const apiKey = request.headers.get("apikey")?.trim();
	const authorization = request.headers.get("authorization")?.trim();
	const presentedKey =
		apiKey || (authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "");
	const resolved = resolveArtifactGcWorkerAuthorization({
		presentedKey: presentedKey || undefined,
		workerKey: Deno.env.get("QORPERA_ARTIFACT_GC_WORKER_KEY")?.trim(),
		serviceKeys: configuredServiceKeys(),
	});
	if (resolved.status === "unauthorized") return jsonResponse({ error: "Unauthorized" }, 401);
	if (resolved.status === "unconfigured") {
		return jsonResponse({ error: "Artifact cleanup is not configured" }, 503);
	}
	const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
	if (!supabaseUrl) return jsonResponse({ error: "Artifact cleanup is not configured" }, 503);
	return { supabaseUrl, secretKey: resolved.serviceKey };
}

Deno.serve(async (request) => {
	if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
	const config = configuration(request);
	if (config instanceof Response) return config;
	const client = createClient(config.supabaseUrl, config.secretKey, {
		auth: { autoRefreshToken: false, persistSession: false },
	});
	const gatewayUrl = Deno.env.get("QORPERA_OBJECT_GATEWAY_URL")?.replace(/\/$/, "");
	const gatewayControlToken = Deno.env.get("QORPERA_OBJECT_GATEWAY_CONTROL_TOKEN")?.trim();
	const finalizeDeletion = async (input: {
		authorizationId: string;
		profileId: string;
		sha256: string;
		bytes: number;
		backend: "nas-object-gateway" | "supabase-storage";
	}): Promise<void> => {
		const { error } = await client.rpc("qorpera_finalize_profile_object_deletion", {
			p_authorization_id: input.authorizationId,
			p_profile_id: input.profileId,
			p_sha256: input.sha256,
			p_bytes: input.bytes,
			p_backend: input.backend,
		});
		if (error) throw new Error("Object deletion finalization failed");
	};
	const removeAuthorizedSupabaseObject = async (input: {
		authorizationId: string;
		profileId: string;
		sha256: string;
		bytes: number;
		path: string;
	}): Promise<void> => {
		const { error } = await client.storage.from(OBJECT_BUCKET).remove([input.path]);
		if (error) throw new Error("Storage object removal failed");
		await finalizeDeletion({ ...input, backend: "supabase-storage" });
	};
	const removeAuthorizedNasObject = async (input: {
		authorizationId: string;
		profileId: string;
		sha256: string;
		bytes: number;
		path: string;
	}): Promise<void> => {
		if (!gatewayUrl || !gatewayControlToken) throw new Error("NAS object cleanup is not configured");
		const response = await fetch(`${gatewayUrl}/v1/profile-objects/${input.path}`, {
			method: "DELETE",
			headers: {
				authorization: `Bearer ${gatewayControlToken}`,
				"x-qorpera-deletion-authorization-id": input.authorizationId,
				"x-qorpera-object-bytes": String(input.bytes),
			},
		});
		if (!response.ok) throw new Error("NAS object removal failed");
	};
	const { data: pendingDeletions, error: pendingDeletionError } = await client.rpc(
		"qorpera_list_authorized_profile_object_deletions",
		{ p_limit: 100 },
	);
	if (pendingDeletionError) return jsonResponse({ error: "Authorized object reconciliation failed" }, 503);
	try {
		await reconcileAuthorizedArtifactGcWorkerObjects(
			parseAuthorizedArtifactGcWorkerObjects(pendingDeletions),
			async (object) => {
				if (object.backend === "supabase-storage") await removeAuthorizedSupabaseObject(object);
				else if (object.backend === "nas-object-gateway") await removeAuthorizedNasObject(object);
			},
		);
	} catch {
		return jsonResponse({ error: "Authorized object reconciliation failed" }, 503);
	}
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
			const { data, error } = await client.rpc("qorpera_fail_artifact_gc_plan_v2", {
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
	const storage: ArtifactGcStorageProvider = createRoutedArtifactGcStorageProvider({
		removeSupabase: async (object, gcLeaseId) => {
			const { data, error } = await client.rpc("qorpera_authorize_profile_object_deletion", {
				p_profile_id: object.path.slice(0, 36),
				p_sha256: object.sha256,
				p_bytes: object.bytes,
				p_backend: "supabase-storage",
				p_lease_id: gcLeaseId,
			});
			if (error || !data || typeof data !== "object" || Array.isArray(data)) {
				throw new Error("Storage object deletion authorization failed");
			}
			const authorization = data as Record<string, unknown>;
			if (authorization.state === "completed") return;
			if (typeof authorization.authorization_id !== "string") {
				throw new Error("Storage object deletion authorization was invalid");
			}
			await removeAuthorizedSupabaseObject({
				authorizationId: authorization.authorization_id,
				profileId: object.path.slice(0, 36),
				sha256: object.sha256,
				bytes: object.bytes,
				path: object.path,
			});
		},
		removeNas: async (object, gcLeaseId) => {
			if (!gatewayUrl || !gatewayControlToken) throw new Error("NAS object cleanup is not configured");
			const response = await fetch(`${gatewayUrl}/v1/profile-objects/${object.path}`, {
				method: "DELETE",
				headers: {
					authorization: `Bearer ${gatewayControlToken}`,
					"x-qorpera-gc-lease-id": gcLeaseId,
					"x-qorpera-object-bytes": String(object.bytes),
				},
			});
			if (!response.ok) throw new Error("NAS object removal failed");
		},
	});
	const artifactResult = await runArtifactGcWorkerBatch(jobs, storage, store);
	const companyLeaseId = crypto.randomUUID();
	const { data: companyClaim, error: companyClaimError } = await client.rpc("qorpera_claim_company_object_gc", {
		p_limit: 100,
		p_lease_id: companyLeaseId,
	});
	let companyObjects = { claimed: 0, completed: 0, failed: 0 };
	if (!companyClaimError) {
		let companyJob;
		try {
			companyJob = parseCompanyObjectGcWorkerJob(companyClaim);
		} catch {
			return jsonResponse({ error: "Company object cleanup claim was invalid" }, 503);
		}
		const companyStore: CompanyObjectGcWorkerStore = {
			renewLease: async (job) => {
				const { error } = await client.rpc("qorpera_renew_company_object_gc", {
					p_profile_id: job.profileId,
					p_lease_id: job.leaseId,
					p_object_sha256s: job.objects.map((object) => object.sha256),
				});
				if (error) throw new Error("Company object cleanup lease renewal failed");
			},
			complete: async (job) => {
				const { error } = await client.rpc("qorpera_complete_company_object_gc", {
					p_profile_id: job.profileId,
					p_lease_id: job.leaseId,
					p_object_sha256s: job.objects.map((object) => object.sha256),
				});
				if (error) throw new Error("Company object cleanup completion failed");
			},
			release: async (job) => {
				const { error } = await client.rpc("qorpera_release_company_object_gc_v2", {
					p_profile_id: job.profileId,
					p_lease_id: job.leaseId,
				});
				if (error) throw new Error("Company object cleanup release failed");
			},
		};
		companyObjects = await runCompanyObjectGcWorkerJob(companyJob, storage, companyStore);
	}

	const deletedProfileLeaseId = crypto.randomUUID();
	const { data: deletedProfileClaim, error: deletedProfileClaimError } = await client.rpc(
		"qorpera_claim_deleted_profile_object_gc",
		{ p_limit: 100, p_lease_id: deletedProfileLeaseId },
	);
	let deletedProfileObjects = { claimed: 0, completed: 0, failed: 0 };
	if (!deletedProfileClaimError) {
		let deletedProfileJob;
		try {
			deletedProfileJob = parseCompanyObjectGcWorkerJob(deletedProfileClaim);
		} catch {
			return jsonResponse({ error: "Deleted profile object cleanup claim was invalid" }, 503);
		}
		const deletedProfileStore: CompanyObjectGcWorkerStore = {
			renewLease: async (job) => {
				const { error } = await client.rpc("qorpera_renew_deleted_profile_object_gc", {
					p_profile_id: job.profileId,
					p_lease_id: job.leaseId,
					p_object_sha256s: job.objects.map((object) => object.sha256),
				});
				if (error) throw new Error("Deleted profile object cleanup lease renewal failed");
			},
			complete: async (job) => {
				const { error } = await client.rpc("qorpera_complete_deleted_profile_object_gc", {
					p_profile_id: job.profileId,
					p_lease_id: job.leaseId,
					p_object_sha256s: job.objects.map((object) => object.sha256),
				});
				if (error) throw new Error("Deleted profile object cleanup completion failed");
			},
			release: async (job) => {
				const { error } = await client.rpc("qorpera_release_deleted_profile_object_gc_v2", {
					p_profile_id: job.profileId,
					p_lease_id: job.leaseId,
				});
				if (error) throw new Error("Deleted profile object cleanup release failed");
			},
		};
		deletedProfileObjects = await runCompanyObjectGcWorkerJob(
			deletedProfileJob,
			storage,
			deletedProfileStore,
		);
	}
	return jsonResponse({ ...artifactResult, companyObjects, deletedProfileObjects });
});
