import { withTimeoutScope } from "../_shared/abort-timeout.ts";
import { configuredSecretKeys, createTimedFetch, jsonResponse, readBoundedJson } from "../_shared/http-guards.ts";
import { createPostgrestClient, type PostgrestClient } from "../_shared/postgrest-rpc.ts";
import {
	parseAuthorizedArtifactGcWorkerObjects,
	parseCompanyObjectGcWorkerJob,
	parseCompanyStorageDeletions,
	createRoutedArtifactGcStorageProvider,
	resolveArtifactGcWorkerAuthorization,
	runCompanyObjectGcWorkerJob,
	runCompanyStorageDeletions,
	runFolderObjectGc,
	reconcileAuthorizedArtifactGcWorkerObjects,
	type ArtifactGcStorageProvider,
	type CompanyObjectGcWorkerStore,
	type FolderObjectGcResult,
} from "./artifact-gc-worker.ts";

const OBJECT_BUCKET = "qorpera-profile-objects";
const WORKER_BUDGET_MS = 110_000;
const GATEWAY_RESPONSE_MAX_BYTES = 64 * 1024;
const RPC_FETCH = createTimedFetch({ timeoutMs: 15_000 });

let cachedClient: { readonly url: string; readonly key: string; readonly client: PostgrestClient } | undefined;

function serviceClient(url: string, key: string): PostgrestClient {
	if (!cachedClient || cachedClient.url !== url || cachedClient.key !== key) {
		cachedClient = {
			url,
			key,
			client: createPostgrestClient(url, key, { timeoutMs: 15_000, fetchImplementation: RPC_FETCH }),
		};
	}
	return cachedClient.client;
}

function configuredServiceKeys(): string[] {
	const explicitServiceKey = Deno.env.get("QORPERA_ARTIFACT_GC_SERVICE_KEY")?.trim();
	const keys = configuredSecretKeys((name) => Deno.env.get(name));
	if (explicitServiceKey) return [...new Set([explicitServiceKey, ...keys])];
	return keys;
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
	const client = serviceClient(config.supabaseUrl, config.secretKey);
	// WHY: Share a 110 s total wall-clock budget across all four GC phases so slow upstream storage never blows past the Edge Function timeout.
	const workerDeadline = Date.now() + WORKER_BUDGET_MS;
	const remainingMs = () => Math.max(0, workerDeadline - Date.now());
	// A deleted company's capsules and recovery backups, recorded before its purge (company delete D5a).
	// First, so a failure in another phase never holds it up. An invalid claim skips it; its lease
	// expires and the entries are offered again.
	const { data: storageClaim, error: storageClaimError } = await client.rpc(
		"qorpera_claim_company_storage_deletions",
		{ p_limit: 100 },
	);
	let companyStorage: {
		claimed: number;
		completed: number;
		failed: number;
		deferred?: number;
		invalid?: true;
		claimError?: true;
	} = {
		claimed: 0,
		completed: 0,
		failed: 0,
	};
	if (storageClaimError) {
		companyStorage = { ...companyStorage, claimError: true };
	} else {
		let entries;
		try {
			entries = parseCompanyStorageDeletions(storageClaim);
		} catch {
			entries = undefined;
			companyStorage = { ...companyStorage, invalid: true };
		}
		if (entries)
			companyStorage = await runCompanyStorageDeletions(
				entries,
				{
					list: async (bucket, prefix) => {
						const { data, error } = await client.storage.from(bucket).list(prefix.slice(0, -1), { limit: 100 });
						if (error || !Array.isArray(data)) throw new Error("Storage listing failed");
						// A folder (no id) is listed with a trailing slash, so it is never taken for an object.
						return data.map((item) => (item.id === null ? `${item.name}/` : item.name));
					},
					remove: async (bucket, paths) => {
						const { error } = await client.storage.from(bucket).remove(paths);
						if (error) throw new Error("Storage object removal failed");
					},
					complete: async (entry, message) => {
						const { error } = await client.rpc("qorpera_complete_company_storage_deletion", {
							p_bucket: entry.bucket,
							p_path: entry.path,
							p_error: message ?? null,
						});
						if (error) throw new Error("Company storage cleanup completion failed");
					},
				},
				{ budgetMs: Math.min(35_000, remainingMs()), concurrency: 4 },
			);
	}
	const gatewayUrl = Deno.env.get("QORPERA_OBJECT_GATEWAY_URL")?.replace(/\/$/, "");
	const gatewayControlToken = Deno.env.get("QORPERA_OBJECT_GATEWAY_CONTROL_TOKEN")?.trim();
	// WHY: Keep folder-v2 GC inside 45 s of the shared 110 s run budget and mark budget skips as deferred rather than disabled.
	let folderObjects: FolderObjectGcResult | { error: true } | { deferred: true };
	const folderBudgetMs = Math.min(45_000, remainingMs());
	if (folderBudgetMs <= 2_000) {
		folderObjects = { deferred: true };
	} else {
		const folderPhaseDeadline = Date.now() + folderBudgetMs;
		try {
			folderObjects = await runFolderObjectGc(
				{
					enabled: async () => {
						// No gateway, no lane: claiming would only mark objects for nothing.
						if (!gatewayUrl || !gatewayControlToken) return false;
						const { data, error } = await client.rpc("qorpera_folder_gc_enabled");
						if (error || typeof data !== "boolean") throw new Error("Folder object cleanup switch is unreadable");
						return data;
					},
					sweep: async (limit) => {
						const { data, error } = await client.rpc("qorpera_folder_sweep_upload_intents", { p_limit: limit });
						if (error || !Number.isSafeInteger(data)) throw new Error("Folder upload intent sweep failed");
						return data as number;
					},
					claim: async (limit, leaseId) => {
						const { data, error } = await client.rpc("qorpera_folder_claim_object_gc", {
							p_limit: limit,
							p_lease: leaseId,
						});
						if (error) throw new Error("Folder object cleanup claim failed");
						return data;
					},
					collect: async (object) => {
						const callBudgetMs = Math.min(20_000, Math.max(0, folderPhaseDeadline - Date.now()));
						if (callBudgetMs < 500) return "busy";
						return withTimeoutScope(callBudgetMs, async (signal) => {
							let response: Response;
							try {
								response = await fetch(`${gatewayUrl}/v1/folder-gc/${object.profileId}/${object.sha256}`, {
									method: "DELETE",
									headers: {
										authorization: `Bearer ${gatewayControlToken}`,
										"x-qorpera-gc-lease-id": object.leaseId,
									},
									redirect: "error",
									signal,
								});
							} catch {
								// An unreachable or hung gateway is a busy one: stop for this run.
								return "busy";
							}
							if (response.status === 503) {
								void response.body?.cancel().catch(() => undefined);
								return "busy";
							}
							if (!response.ok) {
								void response.body?.cancel().catch(() => undefined);
								throw new Error("Folder object cleanup failed");
							}
							let payload: unknown;
							try {
								payload = await readBoundedJson(response, GATEWAY_RESPONSE_MAX_BYTES, { signal });
							} catch {
								if (signal.aborted) return "busy";
								throw new Error("Folder object cleanup answer is invalid");
							}
							const outcome =
								payload && typeof payload === "object" && !Array.isArray(payload)
									? (payload as { outcome?: unknown }).outcome
									: undefined;
							if (outcome !== "removed" && outcome !== "restored" && outcome !== "stale")
								throw new Error("Folder object cleanup answer is invalid");
							return outcome;
						});
					},
				},
				crypto.randomUUID(),
				{ sweep: 100, claim: 100, budgetMs: folderBudgetMs },
			);
		} catch {
			folderObjects = { error: true };
		}
	}
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
		await withTimeoutScope(Math.min(15_000, Math.max(1_000, remainingMs())), async (signal) => {
			const response = await fetch(`${gatewayUrl}/v1/profile-objects/${input.path}`, {
				method: "DELETE",
				headers: {
					authorization: `Bearer ${gatewayControlToken}`,
					"x-qorpera-deletion-authorization-id": input.authorizationId,
					"x-qorpera-object-bytes": String(input.bytes),
				},
				redirect: "error",
				signal,
			});
			void response.body?.cancel().catch(() => undefined);
			if (!response.ok) throw new Error("NAS object removal failed");
		});
	};
	let reconciliationFailed = 0;
	if (remainingMs() > 2_000) {
		const { data: pendingDeletions, error: pendingDeletionError } = await client.rpc(
			"qorpera_list_authorized_profile_object_deletions",
			{ p_limit: 100 },
		);
		if (pendingDeletionError) {
			reconciliationFailed = 1;
		} else {
			try {
				await reconcileAuthorizedArtifactGcWorkerObjects(
					parseAuthorizedArtifactGcWorkerObjects(pendingDeletions),
					async (object) => {
						try {
							if (object.backend === "supabase-storage") await removeAuthorizedSupabaseObject(object);
							else if (object.backend === "nas-object-gateway") await removeAuthorizedNasObject(object);
						} catch {
							reconciliationFailed += 1;
						}
					},
					{ budgetMs: Math.min(30_000, remainingMs()), concurrency: 4 },
				);
			} catch {
				reconciliationFailed += 1;
			}
		}
	}
	const storage: ArtifactGcStorageProvider = createRoutedArtifactGcStorageProvider({
		concurrency: 4,
		hasBudget: () => remainingMs() > 2_000,
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
			await withTimeoutScope(Math.min(15_000, Math.max(1_000, remainingMs())), async (signal) => {
				const response = await fetch(`${gatewayUrl}/v1/profile-objects/${object.path}`, {
					method: "DELETE",
					headers: {
						authorization: `Bearer ${gatewayControlToken}`,
						"x-qorpera-gc-lease-id": gcLeaseId,
						"x-qorpera-object-bytes": String(object.bytes),
					},
					redirect: "error",
					signal,
				});
				void response.body?.cancel().catch(() => undefined);
				if (!response.ok) throw new Error("NAS object removal failed");
			});
		},
	});

	let deletedProfileObjects: {
		claimed: number;
		completed: number;
		failed: number;
		claimError?: true;
		deferred?: true;
	} = { claimed: 0, completed: 0, failed: 0 };
	if (remainingMs() <= 5_000) {
		deletedProfileObjects = { ...deletedProfileObjects, deferred: true };
	} else {
		const deletedProfileLeaseId = crypto.randomUUID();
		const { data: deletedProfileClaim, error: deletedProfileClaimError } = await client.rpc(
			"qorpera_claim_deleted_profile_object_gc",
			{ p_limit: 100, p_lease_id: deletedProfileLeaseId },
		);
		if (deletedProfileClaimError) {
			deletedProfileObjects = { ...deletedProfileObjects, claimError: true };
		} else {
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
	}
	return jsonResponse({
		deletedProfileObjects,
		companyStorage,
		folderObjects,
		...(reconciliationFailed > 0 ? { reconciliationFailed } : {}),
	});
});
