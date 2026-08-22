import type { LegacyObjectMigrationItem } from "./migration.ts";

const OBJECT_BUCKET = "qorpera-profile-objects";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type ObjectBackend = "nas-object-gateway" | "supabase-storage";

export interface AuthorizedObject {
	backend: ObjectBackend;
	bytes: number;
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
}

interface SupabaseObjectAuthorityOptions {
	projectUrl: string;
	publishableKey: string;
	secretKey: string;
	fetch?: typeof fetch;
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

export class SupabaseObjectAuthority implements ObjectGatewayAuthority {
	readonly #projectUrl: string;
	readonly #publishableKey: string;
	readonly #secretKey: string;
	readonly #fetch: typeof fetch;

	constructor(options: SupabaseObjectAuthorityOptions) {
		this.#projectUrl = new URL(options.projectUrl).href.replace(/\/$/, "");
		this.#publishableKey = options.publishableKey;
		this.#secretKey = options.secretKey;
		this.#fetch = options.fetch ?? fetch;
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
				"qorpera_authorize_profile_object_download",
				{ p_profile_id: profileId, p_sha256: sha256 },
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

	#authorizedObject(value: unknown): AuthorizedObject {
		const object = record(value, "object download authority");
		if (
			(object.backend !== "nas-object-gateway" && object.backend !== "supabase-storage") ||
			!Number.isSafeInteger(object.bytes) ||
			(object.bytes as number) < 0
		) {
			throw new Error("Invalid object download authority");
		}
		return { backend: object.backend, bytes: object.bytes as number };
	}

	async confirmUpload(profileId: string, sha256: string, bytes: number): Promise<void> {
		await this.#rpc(
			"qorpera_confirm_profile_object_upload",
			{ p_profile_id: profileId, p_sha256: sha256, p_bytes: bytes, p_backend: "nas-object-gateway" },
			undefined,
			this.#secretKey,
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
		const response = await this.#fetch(
			`${this.#projectUrl}/storage/v1/object/authenticated/${OBJECT_BUCKET}/${path}`,
			{ headers: { apikey: this.#secretKey } },
		);
		if (!response.ok) throw new Error("Legacy object storage read failed");
		return new Uint8Array(await response.arrayBuffer());
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
		const response = await this.#fetch(`${this.#projectUrl}/rest/v1/rpc/${name}`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
		if (!response.ok) throw new Error("Supabase object authority rejected the operation");
		if (response.status === 204) return null;
		const text = await response.text();
		return text ? (JSON.parse(text) as unknown) : null;
	}
}
