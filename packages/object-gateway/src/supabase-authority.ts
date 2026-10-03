import {
	companyStateFailure,
	ObjectDependency,
	ObjectDependencyError,
	ObjectLockConflict,
	postgrestError,
	postgrestErrorCode,
	readBoundedObjectResponse,
	unavailableStateFailure,
} from "./dependency.ts";
import type { FolderGcAuthority } from "./folder-gc.ts";
import type { FolderObjectAuthority, FolderRunActor } from "./folder-objects.ts";
import type {
	AuthorizedMemberCompanyObject,
	MemberCompanyObjectAuthority,
	MemberCompanyObjectIdentity,
} from "./member-company-objects.ts";
import type { LegacyObjectMigrationItem } from "./migration.ts";
import type { NativeCompanyObjectAuthority } from "./native-objects.ts";
import { type ObjectReadLease, parseObjectReadLease } from "./read-lease.ts";
import { supabaseRequestHeaders } from "./supabase-headers.ts";

const OBJECT_BUCKET = "qorpera-profile-objects";
/** `qorpera_folder_object_collecting()`'s message (migration 20260928349860). */
const FOLDER_OBJECT_COLLECTING = "Company folder object is being collected; retry";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type ObjectBackend = "nas-object-gateway" | "supabase-storage";

export interface AuthorizedObject {
	backend: ObjectBackend;
	bytes: number;
	readLease?: ObjectReadLease;
}

export type ObjectDeletionAuthorization = { state: "authorized"; authorizationId: string } | { state: "completed" };

export interface ObjectGatewayAuthority {
	authorizeUpload(userToken: string, profileId: string, sha256: string, bytes: number): Promise<void>;
	authorizeDownload(userToken: string, profileId: string, sha256: string): Promise<AuthorizedObject>;
	authorizeServiceDownload(profileId: string, sha256: string): Promise<AuthorizedObject>;
	confirmUpload(profileId: string, sha256: string, bytes: number): Promise<void>;
	authorizeDelete(
		profileId: string,
		sha256: string,
		bytes: number,
		leaseId: string,
	): Promise<ObjectDeletionAuthorization>;
	resumeDelete(
		authorizationId: string,
		profileId: string,
		sha256: string,
		bytes: number,
	): Promise<ObjectDeletionAuthorization>;
	finalizeDelete(authorizationId: string, profileId: string, sha256: string, bytes: number): Promise<void>;
	readLegacyObject(profileId: string, sha256: string): Promise<Uint8Array>;
	health?(): {
		api: ReturnType<ObjectDependency["health"]>;
		storage: ReturnType<ObjectDependency["health"]>;
		auth: ReturnType<ObjectDependency["health"]>;
	};
}

interface SupabaseObjectAuthorityOptions {
	projectUrl: string;
	publishableKey: string;
	secretKey: string;
	fetch?: typeof fetch;
	requestTimeoutMs?: number;
	circuitCooldownMs?: number;
	readLeaseSeconds?: number;
	now?: () => number;
}

/** PostgREST answers classes 40 and 55 with 500, and a check violation with 400. From the folder core those are one
 * company's state, not the database's health: a stopped company (55000) becomes 423, a lock conflict (40001, 40P01,
 * 55P03) 409, so neither opens the dependency circuit for every company, and the company's storage allowance
 * (23514, checked before the NAS write) 413, so the writer can say the storage is full. A statement timeout (57014)
 * follows `companyStateFailure`'s rule. Any other answer keeps its status: another 500 stays a dependency failure. */
function folderStateFailure(code: unknown, status: number): ObjectDependencyError {
	if (code === "23514") return new ObjectDependencyError(413);
	const failure = companyStateFailure(code);
	return failure.status === 500 ? new ObjectDependencyError(status) : failure;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
	return value as Record<string, unknown>;
}

function deletionAuthorization(value: unknown): ObjectDeletionAuthorization {
	const authorization = record(value, "object deletion authorization");
	if (authorization.state === "completed") return { state: "completed" };
	if (
		authorization.state !== "authorized" ||
		typeof authorization.authorization_id !== "string" ||
		!UUID_PATTERN.test(authorization.authorization_id)
	) {
		throw new Error("Invalid object deletion authorization");
	}
	return { state: "authorized", authorizationId: authorization.authorization_id };
}

export class SupabaseObjectAuthority
	implements
		ObjectGatewayAuthority,
		NativeCompanyObjectAuthority,
		FolderObjectAuthority,
		FolderGcAuthority,
		MemberCompanyObjectAuthority
{
	readonly #projectUrl: string;
	readonly #publishableKey: string;
	readonly #secretKey: string;
	readonly #fetch: typeof fetch;
	readonly #api: ObjectDependency;
	readonly #storage: ObjectDependency;
	readonly #auth: ObjectDependency;
	readonly #readLeaseSeconds: number;
	readonly #failedProbes = new Set<"api" | "storage" | "auth">();

	constructor(options: SupabaseObjectAuthorityOptions) {
		let url: URL;
		try {
			url = new URL(options.projectUrl);
		} catch {
			throw new Error("Object authority requires an exact HTTPS origin");
		}
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			url.pathname !== "/" ||
			![url.origin, `${url.origin}/`].includes(options.projectUrl)
		) {
			throw new Error("Object authority requires an exact HTTPS origin");
		}
		if (
			[options.publishableKey, options.secretKey].some((key) => !key || key.length > 8192 || /[\0\r\n]/.test(key))
		) {
			throw new Error("Object authority credential configuration is invalid");
		}
		this.#projectUrl = url.origin;
		this.#publishableKey = options.publishableKey;
		this.#secretKey = options.secretKey;
		const transport = options.fetch ?? fetch;
		this.#fetch = (input, init) => transport(input, { ...init, redirect: "error" });
		this.#api = new ObjectDependency(options.requestTimeoutMs, options.circuitCooldownMs, options.now);
		this.#storage = new ObjectDependency(options.requestTimeoutMs, options.circuitCooldownMs, options.now);
		this.#auth = new ObjectDependency(options.requestTimeoutMs, options.circuitCooldownMs, options.now);
		this.#readLeaseSeconds = options.readLeaseSeconds ?? 0;
		if (!Number.isSafeInteger(this.#readLeaseSeconds) || this.#readLeaseSeconds < 0 || this.#readLeaseSeconds > 60) {
			throw new Error("Object read delegation must be disabled or between 1 and 60 seconds");
		}
	}

	health() {
		const health = { api: this.#api.health(), storage: this.#storage.health(), auth: this.#auth.health() };
		// A reachable endpoint that rejects our service credential is not ready.
		// Ordinary user denials do not make the whole dependency unhealthy.
		for (const dependency of this.#failedProbes) health[dependency].status = "unavailable";
		return health;
	}

	async probeHealth(): Promise<void> {
		const probes = await Promise.allSettled([
			this.listLegacyObjects(undefined, 1),
			this.#storage.run(async (signal) => {
				const response = await this.#fetch(`${this.#projectUrl}/storage/v1/bucket/${OBJECT_BUCKET}`, {
					headers: supabaseRequestHeaders(this.#secretKey),
					signal,
				});
				if (!response.ok) {
					void response.body?.cancel().catch(() => undefined);
					throw new ObjectDependencyError(response.status);
				}
				await readBoundedObjectResponse(response, 16 * 1024, signal);
			}),
			this.#auth.run(async (signal) => {
				const response = await this.#fetch(`${this.#projectUrl}/auth/v1/health`, {
					headers: { apikey: this.#publishableKey },
					signal,
				});
				if (!response.ok) {
					void response.body?.cancel().catch(() => undefined);
					throw new ObjectDependencyError(response.status);
				}
				await readBoundedObjectResponse(response, 16 * 1024, signal);
			}),
		]);
		for (const [index, dependency] of (["api", "storage", "auth"] as const).entries()) {
			if (probes[index]?.status === "fulfilled") this.#failedProbes.delete(dependency);
			else this.#failedProbes.add(dependency);
		}
	}

	async authorizeUpload(userToken: string, profileId: string, sha256: string, bytes: number): Promise<void> {
		await this.#rpc(
			"qorpera_authorize_profile_object_upload",
			{ p_profile_id: profileId, p_sha256: sha256, p_bytes: bytes },
			userToken,
			this.#publishableKey,
		);
	}

	async authorizeDownload(userToken: string, profileId: string, sha256: string): Promise<AuthorizedObject> {
		return this.#authorizedObject(
			await this.#rpc(
				this.#readLeaseSeconds > 0
					? "qorpera_issue_profile_object_read_lease"
					: "qorpera_authorize_profile_object_download",
				{
					p_profile_id: profileId,
					p_sha256: sha256,
					...(this.#readLeaseSeconds > 0 ? { p_lease_seconds: this.#readLeaseSeconds } : {}),
				},
				userToken,
				this.#publishableKey,
			),
		);
	}

	async authorizeServiceDownload(profileId: string, sha256: string): Promise<AuthorizedObject> {
		return this.#authorizedObject(
			await this.#rpc(
				"qorpera_authorize_profile_object_download",
				{ p_profile_id: profileId, p_sha256: sha256 },
				undefined,
				this.#secretKey,
			),
		);
	}

	async authorizeMemberCompanyObject(
		userToken: string,
		identity: MemberCompanyObjectIdentity,
		mode?: "snapshot",
	): Promise<AuthorizedMemberCompanyObject> {
		const value = record(
			await this.#rpc(
				mode === "snapshot"
					? "qorpera_authorize_member_company_snapshot_object"
					: "qorpera_authorize_member_company_path_object",
				{
					p_environment_id: identity.environmentId,
					p_path: identity.path,
					...(mode === "snapshot" ? { p_snapshot_id: identity.version } : { p_version: identity.version }),
					p_sha256: identity.sha256,
				},
				userToken,
				this.#publishableKey,
				true,
			),
			"member Company File authority",
		);
		const keys = [
			"schema",
			"companyId",
			"environmentId",
			"path",
			"version",
			"sha256",
			"bytes",
			"backend",
			"actorUserId",
			"resourceId",
			"resourceVersion",
		];
		if (
			Object.keys(value).length !== keys.length ||
			Object.keys(value).some((key) => !keys.includes(key)) ||
			value.schema !== "qorpera.member-company-object/v2" ||
			typeof value.companyId !== "string" ||
			!UUID_PATTERN.test(value.companyId) ||
			["actorUserId", "resourceId", "resourceVersion"].some(
				(key) => typeof value[key] !== "string" || !UUID_PATTERN.test(value[key]),
			) ||
			Object.entries(identity).some(([key, expected]) => value[key] !== expected) ||
			!Number.isSafeInteger(value.bytes) ||
			(value.bytes as number) < 0 ||
			(value.bytes as number) > 8 * 1024 * 1024 ||
			(value.backend !== "nas-object-gateway" && value.backend !== "supabase-storage")
		)
			throw new ObjectDependencyError(503);
		return {
			schema: "qorpera.member-company-object/v2",
			companyId: value.companyId,
			actorUserId: value.actorUserId as string,
			resourceId: value.resourceId as string,
			resourceVersion: value.resourceVersion as string,
			...identity,
			bytes: value.bytes as number,
			backend: value.backend,
		};
	}

	#authorizedObject(value: unknown): AuthorizedObject {
		const object = record(value, "object download authority");
		if (
			(object.backend !== "nas-object-gateway" && object.backend !== "supabase-storage") ||
			!Number.isSafeInteger(object.bytes) ||
			(object.bytes as number) < 0 ||
			(object.bytes as number) > 8 * 1024 * 1024
		) {
			throw new Error("Invalid object download authority");
		}
		return {
			backend: object.backend,
			bytes: object.bytes as number,
			...(object.read_lease !== undefined ? { readLease: parseObjectReadLease(object.read_lease) } : {}),
		};
	}

	async confirmUpload(profileId: string, sha256: string, bytes: number): Promise<void> {
		await this.#rpc(
			"qorpera_confirm_profile_object_upload",
			{ p_profile_id: profileId, p_sha256: sha256, p_bytes: bytes, p_backend: "nas-object-gateway" },
			undefined,
			this.#secretKey,
		);
	}

	async authorizeNativeUpload(
		binding: Record<string, unknown>,
		profileId: string,
		sha256: string,
		bytes: number,
	): Promise<void> {
		if (
			(await this.#rpc(
				"qorpera_authorize_native_company_object_upload",
				{
					p_binding: binding,
					p_profile_id: profileId,
					p_sha256: sha256,
					p_bytes: bytes,
				},
				undefined,
				this.#secretKey,
				true,
			)) !== true
		)
			throw new ObjectDependencyError(403);
	}

	async confirmNativeUpload(
		binding: Record<string, unknown>,
		profileId: string,
		sha256: string,
		bytes: number,
	): Promise<void> {
		if (
			(await this.#rpc(
				"qorpera_confirm_native_company_object_upload",
				{
					p_binding: binding,
					p_profile_id: profileId,
					p_sha256: sha256,
					p_bytes: bytes,
				},
				undefined,
				this.#secretKey,
				true,
			)) !== true
		)
			throw new ObjectDependencyError(403);
	}

	async authorizeNativeDownload(
		binding: Record<string, unknown>,
		profileId: string,
		sha256: string,
	): Promise<AuthorizedObject> {
		return this.#authorizedObject(
			await this.#rpc(
				"qorpera_authorize_native_company_object_download",
				{
					p_binding: binding,
					p_profile_id: profileId,
					p_sha256: sha256,
				},
				undefined,
				this.#secretKey,
				true,
			),
		);
	}

	async authorizeFolderUpload(
		environmentId: string,
		actor: FolderRunActor,
		intentId: string,
		sha256: string,
		bytes: number,
	): Promise<{ profileId: string }> {
		const value = await this.#rpc(
			"qorpera_folder_authorize_object_upload",
			{ p_environment_id: environmentId, p_actor: actor, p_intent: intentId, p_sha256: sha256, p_bytes: bytes },
			undefined,
			this.#secretKey,
			"folder",
		);
		const receipt = value as Record<string, unknown> | null;
		if (
			!receipt ||
			typeof receipt !== "object" ||
			receipt.schema !== "qorpera.folder-object-upload/v1" ||
			typeof receipt.profileId !== "string" ||
			!UUID_PATTERN.test(receipt.profileId)
		)
			throw new ObjectDependencyError(403);
		return { profileId: receipt.profileId };
	}

	async confirmFolderObject(
		environmentId: string,
		actor: FolderRunActor,
		intentId: string,
		sha256: string,
		bytes: number,
	): Promise<void> {
		const value = (await this.#rpc(
			"qorpera_folder_confirm_object",
			{ p_environment_id: environmentId, p_actor: actor, p_intent: intentId, p_sha256: sha256, p_bytes: bytes },
			undefined,
			this.#secretKey,
			"folder",
		)) as Record<string, unknown> | null;
		if (!value || value.schema !== "qorpera.folder-object/v1" || value.sha256 !== sha256 || value.bytes !== bytes)
			throw new ObjectDependencyError(403);
	}

	async authorizeFolderDownload(
		environmentId: string,
		actor: FolderRunActor,
		sha256: string,
	): Promise<{ profileId: string; bytes: number }> {
		const value = (await this.#rpc(
			"qorpera_folder_authorize_object_download",
			{ p_environment_id: environmentId, p_actor: actor, p_sha256: sha256 },
			undefined,
			this.#secretKey,
			"folder",
		)) as Record<string, unknown> | null;
		if (
			!value ||
			value.schema !== "qorpera.folder-object-download/v1" ||
			typeof value.profileId !== "string" ||
			!UUID_PATTERN.test(value.profileId) ||
			!Number.isSafeInteger(value.bytes) ||
			(value.bytes as number) < 0 ||
			(value.bytes as number) > 8 * 1024 * 1024
		)
			throw new ObjectDependencyError(403);
		return { profileId: value.profileId, bytes: value.bytes as number };
	}

	/** The folder GC RPCs act on one company's object under a GC lease, so their 500s are read as that company's state
	 * (`companyStateFailure`): a lock wait past their 2 s budget is 409, never the circuit. */
	async beginFolderUnlink(
		profileId: string,
		sha256: string,
		leaseId: string,
	): Promise<{ bytes: number; backend: ObjectBackend } | "stale"> {
		let value: unknown;
		try {
			value = await this.#rpc(
				"qorpera_folder_gc_unlink_begin",
				{ p_profile_id: profileId, p_sha256: sha256, p_lease: leaseId },
				undefined,
				this.#secretKey,
				true,
			);
		} catch (error) {
			// 55000: the mark is gone, expired, or another lease's.
			if (error instanceof ObjectDependencyError && error.status === 423) return "stale";
			throw error;
		}
		const answer = record(value, "folder GC unlink");
		if (
			answer.schema !== "qorpera.folder-object-gc-unlink/v1" ||
			!Number.isSafeInteger(answer.bytes) ||
			(answer.bytes as number) < 0 ||
			(answer.bytes as number) > 8 * 1024 * 1024 ||
			(answer.backend !== "nas-object-gateway" && answer.backend !== "supabase-storage")
		)
			throw new Error("Invalid folder GC unlink");
		return { bytes: answer.bytes as number, backend: answer.backend };
	}

	async finishFolderUnlink(
		profileId: string,
		sha256: string,
		leaseId: string,
	): Promise<"removed" | "restore" | "stale"> {
		const value = await this.#rpc(
			"qorpera_folder_gc_unlink_finish",
			{ p_profile_id: profileId, p_sha256: sha256, p_lease: leaseId },
			undefined,
			this.#secretKey,
			true,
		);
		if (value !== "removed" && value !== "restore" && value !== "stale") throw new Error("Invalid folder GC finish");
		return value;
	}

	async abandonFolderUnlink(profileId: string, sha256: string, leaseId: string): Promise<boolean> {
		const value = await this.#rpc(
			"qorpera_folder_gc_unlink_abandon",
			{ p_profile_id: profileId, p_sha256: sha256, p_lease: leaseId },
			undefined,
			this.#secretKey,
			true,
		);
		if (typeof value !== "boolean") throw new Error("Invalid folder GC abandon");
		return value;
	}

	async folderQuarantineState(
		profileId: string,
		sha256: string,
		leaseId: string,
	): Promise<"live" | "restore" | "remove"> {
		const value = await this.#rpc(
			"qorpera_folder_gc_quarantine_state",
			{ p_profile_id: profileId, p_sha256: sha256, p_lease: leaseId },
			undefined,
			this.#secretKey,
			true,
		);
		if (value !== "live" && value !== "restore" && value !== "remove")
			throw new Error("Invalid folder GC quarantine state");
		return value;
	}

	async folderCatalogState(profileId: string, sha256: string): Promise<"catalogued" | "listed" | "missing" | "other"> {
		const value = await this.#rpc(
			"qorpera_folder_gc_catalog_state",
			{ p_profile_id: profileId, p_sha256: sha256 },
			undefined,
			this.#secretKey,
			true,
		);
		if (value !== "catalogued" && value !== "listed" && value !== "missing" && value !== "other")
			throw new Error("Invalid folder GC catalog state");
		return value;
	}

	async authorizeDelete(
		profileId: string,
		sha256: string,
		bytes: number,
		leaseId: string,
	): Promise<ObjectDeletionAuthorization> {
		return deletionAuthorization(
			await this.#rpc(
				"qorpera_authorize_profile_object_deletion",
				{
					p_profile_id: profileId,
					p_sha256: sha256,
					p_bytes: bytes,
					p_backend: "nas-object-gateway",
					p_lease_id: leaseId,
				},
				undefined,
				this.#secretKey,
			),
		);
	}

	async resumeDelete(
		authorizationId: string,
		profileId: string,
		sha256: string,
		bytes: number,
	): Promise<ObjectDeletionAuthorization> {
		return deletionAuthorization(
			await this.#rpc(
				"qorpera_describe_profile_object_deletion_authorization",
				{
					p_authorization_id: authorizationId,
					p_profile_id: profileId,
					p_sha256: sha256,
					p_bytes: bytes,
					p_backend: "nas-object-gateway",
				},
				undefined,
				this.#secretKey,
			),
		);
	}

	async finalizeDelete(authorizationId: string, profileId: string, sha256: string, bytes: number): Promise<void> {
		await this.#rpc(
			"qorpera_finalize_profile_object_deletion",
			{
				p_authorization_id: authorizationId,
				p_profile_id: profileId,
				p_sha256: sha256,
				p_bytes: bytes,
				p_backend: "nas-object-gateway",
			},
			undefined,
			this.#secretKey,
		);
	}

	async readLegacyObject(profileId: string, sha256: string): Promise<Uint8Array> {
		const path = `${profileId}/${sha256}`;
		return this.#storage.run(async (signal) => {
			const response = await this.#fetch(
				`${this.#projectUrl}/storage/v1/object/authenticated/${OBJECT_BUCKET}/${path}`,
				{ headers: supabaseRequestHeaders(this.#secretKey), signal },
			);
			if (!response.ok) {
				void response.body?.cancel().catch(() => undefined);
				throw new ObjectDependencyError(response.status);
			}
			return readBoundedObjectResponse(response, 8 * 1024 * 1024, signal);
		});
	}

	async authorizeReplication(profileId: string, sha256: string, bytes: number): Promise<void> {
		const value = await this.#rpc(
			"qorpera_authorize_profile_object_replication",
			{ p_profile_id: profileId, p_sha256: sha256, p_bytes: bytes },
			undefined,
			this.#secretKey,
			"replication",
		);
		if (value !== true) throw new ObjectDependencyError(403);
	}

	async confirmReplica(profileId: string, sha256: string, bytes: number): Promise<void> {
		const value = await this.#rpc(
			"qorpera_confirm_profile_object_replica",
			{ p_profile_id: profileId, p_sha256: sha256, p_bytes: bytes },
			undefined,
			this.#secretKey,
		);
		if (value !== true) throw new ObjectDependencyError(403);
	}

	async writeReplica(profileId: string, sha256: string, bytes: Uint8Array): Promise<void> {
		await this.#storage.run(async (signal) => {
			const response = await this.#fetch(
				`${this.#projectUrl}/storage/v1/object/${OBJECT_BUCKET}/${profileId}/${sha256}`,
				{
					method: "POST",
					headers: {
						...supabaseRequestHeaders(this.#secretKey),
						"content-type": "application/octet-stream",
						"content-length": String(bytes.byteLength),
						"x-upsert": "false",
						"x-metadata": Buffer.from(
							JSON.stringify({ qorpera_nas_replica: true, qorpera_nas_replica_bytes: bytes.byteLength }),
						).toString("base64"),
					},
					body: Uint8Array.from(bytes),
					signal,
				},
			);
			if (!response.ok && response.status !== 400 && response.status !== 409) {
				void response.body?.cancel().catch(() => undefined);
				throw new ObjectDependencyError(response.status);
			}
			const text = new TextDecoder("utf-8", { fatal: true }).decode(
				await readBoundedObjectResponse(response, 16 * 1024, signal),
			);
			if (!response.ok && response.status !== 409) {
				// Storage can report an immutable duplicate as HTTP 400 with its own 409 code.
				let duplicate = false;
				if (response.status === 400) {
					try {
						duplicate = (JSON.parse(text) as { statusCode?: string }).statusCode === "409";
					} catch {
						/* Not a duplicate receipt. */
					}
				}
				if (!duplicate) throw new ObjectDependencyError(response.status);
			}
		});
	}

	async removeReplica(profileId: string, sha256: string): Promise<void> {
		await this.#storage.run(async (signal) => {
			const response = await this.#fetch(`${this.#projectUrl}/storage/v1/object/${OBJECT_BUCKET}`, {
				method: "DELETE",
				headers: { ...supabaseRequestHeaders(this.#secretKey), "content-type": "application/json" },
				body: JSON.stringify({ prefixes: [`${profileId}/${sha256}`] }),
				signal,
			});
			if (!response.ok) {
				void response.body?.cancel().catch(() => undefined);
				throw new ObjectDependencyError(response.status);
			}
			await readBoundedObjectResponse(response, 16 * 1024, signal);
		});
	}

	async listLegacyObjects(
		after: { profileId: string; sha256: string } | undefined,
		limit: number,
	): Promise<LegacyObjectMigrationItem[]> {
		const value = await this.#rpc(
			"qorpera_list_profile_objects_for_migration",
			{
				p_after_profile_id: after?.profileId ?? null,
				p_after_sha256: after?.sha256 ?? null,
				p_limit: limit,
			},
			undefined,
			this.#secretKey,
		);
		if (!Array.isArray(value) || value.length > limit) throw new Error("Invalid legacy object migration list");
		return value.map((entry) => {
			const object = record(entry, "legacy object migration item");
			if (
				typeof object.profile_id !== "string" ||
				!UUID_PATTERN.test(object.profile_id) ||
				typeof object.sha256 !== "string" ||
				!SHA256_PATTERN.test(object.sha256) ||
				!Number.isSafeInteger(object.bytes) ||
				(object.bytes as number) < 0
			) {
				throw new Error("Invalid legacy object migration item");
			}
			return { profileId: object.profile_id, sha256: object.sha256, bytes: object.bytes as number };
		});
	}

	/** `companyState`: the RPC acts for one company, so its 500s are read with `companyStateFailure` (409, 423);
	 * `"folder"`, a folder core byte RPC, also reads its 400s, with `folderStateFailure` (and 413). Profile,
	 * replication, deletion and migration RPCs must stay "unavailable" to their callers (the replication reconciler
	 * blocks an object on any other refusal, and a profile read drops its member's read leases on one), so theirs
	 * are read with `unavailableStateFailure`: a lock conflict is still 503 but leaves the circuit alone.
	 * `"replication"` is read the same way, and also reads folder GC's conflict as a lock conflict. */
	async #rpc(
		name: string,
		body: Record<string, unknown>,
		bearer: string | undefined,
		apiKey: string,
		companyState: boolean | "folder" | "replication" = false,
	): Promise<unknown> {
		const headers: Record<string, string> = {
			...supabaseRequestHeaders(apiKey, bearer),
			"content-type": "application/json",
		};
		return this.#api.run(async (signal) => {
			const response = await this.#fetch(`${this.#projectUrl}/rest/v1/rpc/${name}`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal,
			});
			if (!response.ok) {
				if (companyState === "folder" && (response.status === 500 || response.status === 400))
					throw folderStateFailure(await postgrestErrorCode(response, signal), response.status);
				if (response.status === 500)
					throw (companyState === true ? companyStateFailure : unavailableStateFailure)(
						await postgrestErrorCode(response, signal),
					);
				// Replication meeting an object folder GC holds (C1D §9.7): the folder core's conflict envelope with its
				// own message. To the reconciler it is a lock conflict, so the folder entry stays pending, not blocked.
				// snapshot-v1's cleanup fence answers QRC01 too, with another message, and keeps its 409 (core §8 G3).
				if (response.status === 409 && companyState === "replication") {
					const error = await postgrestError(response, signal);
					throw error.code === "QRC01" && error.message === FOLDER_OBJECT_COLLECTING
						? new ObjectLockConflict()
						: new ObjectDependencyError(409);
				}
				void response.body?.cancel().catch(() => undefined);
				throw new ObjectDependencyError(response.status);
			}
			if (response.status === 204) return null;
			const text = new TextDecoder("utf-8", { fatal: true }).decode(
				await readBoundedObjectResponse(response, 1024 * 1024, signal),
			);
			return text ? (JSON.parse(text) as unknown) : null;
		});
	}
}
