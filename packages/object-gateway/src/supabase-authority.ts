import { ObjectDependency, ObjectDependencyError, readBoundedObjectResponse } from "./dependency.ts";
import type {
	AuthorizedMemberCompanyObject,
	MemberCompanyObjectAuthority,
	MemberCompanyObjectIdentity,
} from "./member-company-objects.ts";
import type { LegacyObjectMigrationItem } from "./migration.ts";
import type { NativeCompanyObjectAuthority } from "./native-objects.ts";
import { type ObjectReadLease, parseObjectReadLease } from "./read-lease.ts";

const OBJECT_BUCKET = "qorpera-profile-objects";
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
	implements ObjectGatewayAuthority, NativeCompanyObjectAuthority, MemberCompanyObjectAuthority
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
					headers: { apikey: this.#secretKey },
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
	): Promise<AuthorizedMemberCompanyObject> {
		const value = record(
			await this.#rpc(
				"qorpera_authorize_member_company_path_object",
				{
					p_environment_id: identity.environmentId,
					p_path: identity.path,
					p_version: identity.version,
					p_sha256: identity.sha256,
				},
				userToken,
				this.#publishableKey,
			),
			"member Company File authority",
		);
		const keys = ["schema", "companyId", "environmentId", "path", "version", "sha256", "bytes", "backend"];
		if (
			Object.keys(value).length !== keys.length ||
			Object.keys(value).some((key) => !keys.includes(key)) ||
			value.schema !== "qorpera.member-company-object/v1" ||
			typeof value.companyId !== "string" ||
			!UUID_PATTERN.test(value.companyId) ||
			Object.entries(identity).some(([key, expected]) => value[key] !== expected) ||
			!Number.isSafeInteger(value.bytes) ||
			(value.bytes as number) < 0 ||
			(value.bytes as number) > 8 * 1024 * 1024 ||
			(value.backend !== "nas-object-gateway" && value.backend !== "supabase-storage")
		)
			throw new ObjectDependencyError(503);
		return {
			schema: "qorpera.member-company-object/v1",
			companyId: value.companyId,
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
			),
		);
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
				{ headers: { apikey: this.#secretKey }, signal },
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
						apikey: this.#secretKey,
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
				headers: { apikey: this.#secretKey, "content-type": "application/json" },
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

	async #rpc(
		name: string,
		body: Record<string, unknown>,
		bearer: string | undefined,
		apiKey: string,
	): Promise<unknown> {
		const headers: Record<string, string> = {
			apikey: apiKey,
			"content-type": "application/json",
		};
		if (bearer) headers.authorization = `Bearer ${bearer}`;
		return this.#api.run(async (signal) => {
			const response = await this.#fetch(`${this.#projectUrl}/rest/v1/rpc/${name}`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal,
			});
			if (!response.ok) {
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
