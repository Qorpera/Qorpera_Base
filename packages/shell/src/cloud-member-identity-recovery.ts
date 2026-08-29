import { readBoundedCloudResponse, withCloudDeadline } from "./cloud-request.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const ownershipKinds = ["member", "company", "department", "security_boundary"] as const;
const recoveryStatuses = ["awaiting_member", "approved", "released", "completed", "cancelled"] as const;

export interface MemberRecoveryIdentity {
	computeIdentityId: string;
	displayName: string;
	ownershipKind: (typeof ownershipKinds)[number];
	ownerUserId: string | null;
	status: "active" | "disabled" | "retired";
	epoch: number;
	blocked: boolean;
}

export interface MemberRecoveryTargetSummary {
	targetId: string;
	nodeId: string;
	status: "active" | "revoked";
	expiresAt: string;
}

export interface MemberRecoveryReceipt {
	recoveryId: string;
	companyId: string;
	computeIdentityId: string;
	targetId: string;
	backupRevision: number;
	storageSource: "nas" | "supabase";
	status: (typeof recoveryStatuses)[number];
	epoch: number | null;
	notBefore: string | null;
	expiresAt: string;
	receiptId: string | null;
}

export interface MemberRecoveryReview {
	schema: "qorpera.member-identity-recovery-review/v1";
	reviewSha256: string;
	review: {
		companyId: string;
		viewerUserId: string;
		identity: MemberRecoveryIdentity;
		target: MemberRecoveryTargetSummary & {
			authorityId: string;
			imageSha256: string;
			guestManifestSha256: string;
			recipientKeySha256: string;
		};
		backup: {
			revision: number;
			objectSha256: string;
			objectBytes: number;
			authorityId: string;
			policySha256: string;
		} | null;
		recovery: MemberRecoveryReceipt | null;
		canRequest: boolean;
		canConsent: boolean;
		canCancel: boolean;
	};
}

export type MemberRecoveryDecision =
	| { kind: "request"; requestId: string; storageSource: "nas" | "supabase" }
	| { kind: "consent" | "cancel" };

export interface MemberRecoveryClientOptions {
	companyId: string;
	supabaseUrl: string;
	publishableKey: string;
	accessToken(signal: AbortSignal): Promise<string>;
	fetch?: typeof fetch;
	timeoutMs?: number;
}

function record(value: unknown, keys: string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(value, key))
	)
		throw new Error("Cloud recovery returned an invalid response");
	return value as Record<string, unknown>;
}

function uuid(value: unknown): string {
	if (typeof value !== "string" || !UUID.test(value)) throw new Error("Invalid cloud recovery identity");
	return value;
}

function hash(value: unknown): string {
	if (typeof value !== "string" || !SHA.test(value)) throw new Error("Invalid cloud recovery digest");
	return value;
}

function integer(value: unknown, minimum = 0): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum)
		throw new Error("Invalid cloud recovery version");
	return value;
}

function boolean(value: unknown): boolean {
	if (typeof value !== "boolean") throw new Error("Invalid cloud recovery permission");
	return value;
}

function timestamp(value: unknown): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
		throw new Error("Invalid cloud recovery expiry");
	return value;
}

function identity(value: unknown): MemberRecoveryIdentity {
	const input = record(value, [
		"computeIdentityId",
		"displayName",
		"ownershipKind",
		"ownerUserId",
		"status",
		"epoch",
		"blocked",
	]);
	if (
		typeof input.displayName !== "string" ||
		input.displayName.length < 1 ||
		input.displayName.length > 240 ||
		!ownershipKinds.some((kind) => kind === input.ownershipKind) ||
		!["active", "disabled", "retired"].includes(String(input.status)) ||
		(input.ownershipKind === "member") !== (input.ownerUserId !== null)
	)
		throw new Error("Invalid cloud recovery identity");
	return {
		computeIdentityId: uuid(input.computeIdentityId),
		displayName: input.displayName,
		ownershipKind: input.ownershipKind as MemberRecoveryIdentity["ownershipKind"],
		ownerUserId: input.ownerUserId === null ? null : uuid(input.ownerUserId),
		status: input.status as MemberRecoveryIdentity["status"],
		epoch: integer(input.epoch),
		blocked: boolean(input.blocked),
	};
}

function target(value: unknown, full = false): MemberRecoveryTargetSummary {
	const input = record(value, [
		"targetId",
		"nodeId",
		"status",
		"expiresAt",
		...(full ? ["authorityId", "imageSha256", "guestManifestSha256", "recipientKeySha256"] : []),
	]);
	if (input.status !== "active" && input.status !== "revoked") throw new Error("Invalid cloud recovery target");
	return {
		targetId: uuid(input.targetId),
		nodeId: uuid(input.nodeId),
		status: input.status,
		expiresAt: timestamp(input.expiresAt),
	};
}

function receipt(
	value: unknown,
	companyId: string,
	computeIdentityId: string,
	targetId: string,
): MemberRecoveryReceipt {
	const input = record(value, [
		"recoveryId",
		"companyId",
		"computeIdentityId",
		"targetId",
		"backupRevision",
		"storageSource",
		"status",
		"epoch",
		"notBefore",
		"expiresAt",
		"receiptId",
	]);
	if (
		input.companyId !== companyId ||
		input.computeIdentityId !== computeIdentityId ||
		input.targetId !== targetId ||
		!recoveryStatuses.some((status) => status === input.status) ||
		(input.storageSource !== "nas" && input.storageSource !== "supabase") ||
		(input.epoch === null) !== (input.notBefore === null) ||
		(input.status === "completed") !== (input.receiptId !== null)
	)
		throw new Error("Cloud recovery receipt scope changed");
	return {
		companyId,
		computeIdentityId,
		targetId,
		recoveryId: uuid(input.recoveryId),
		backupRevision: integer(input.backupRevision, 1),
		storageSource: input.storageSource,
		status: input.status as MemberRecoveryReceipt["status"],
		epoch: input.epoch === null ? null : integer(input.epoch, 1),
		notBefore: input.notBefore === null ? null : timestamp(input.notBefore),
		expiresAt: timestamp(input.expiresAt),
		receiptId: input.receiptId === null ? null : uuid(input.receiptId),
	};
}

/** Member-JWT transport only. It cannot access backup bytes, private keys or
 * recovery-service capabilities, and never retries an uncertain decision. */
export class CloudMemberIdentityRecoveryClient {
	readonly #options: MemberRecoveryClientOptions;
	readonly #origin: string;
	readonly #fetch: typeof fetch;

	constructor(options: MemberRecoveryClientOptions) {
		const url = new URL(options.supabaseUrl);
		if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
			throw new Error("Cloud recovery requires the configured HTTPS control plane");
		uuid(options.companyId);
		if (
			!/^[A-Za-z0-9._~-]{1,8192}$/.test(options.publishableKey) ||
			(options.timeoutMs !== undefined &&
				(!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000))
		)
			throw new Error("Cloud recovery transport configuration is invalid");
		this.#options = { ...options };
		this.#origin = url.origin;
		this.#fetch = options.fetch ?? fetch;
	}

	async identities(
		after: string | null,
		signal: AbortSignal,
	): Promise<{
		companyId: string;
		viewerUserId: string;
		isOwner: boolean;
		items: MemberRecoveryIdentity[];
		nextAfter: string | null;
	}> {
		if (after !== null) uuid(after);
		const input = record(
			await this.#rpc("list_member_recovery_identities", { p_after: after, p_limit: 25 }, signal),
			["companyId", "viewerUserId", "isOwner", "items", "nextAfter"],
		);
		if (input.companyId !== this.#options.companyId || !Array.isArray(input.items) || input.items.length > 25)
			throw new Error("Cloud recovery page scope changed");
		const items = input.items.map(identity);
		let previous = after;
		for (const item of items) {
			if (previous !== null && item.computeIdentityId <= previous)
				throw new Error("Invalid cloud recovery page order");
			previous = item.computeIdentityId;
		}
		const nextAfter = input.nextAfter === null ? null : uuid(input.nextAfter);
		if (nextAfter !== null && (items.length !== 25 || nextAfter !== previous))
			throw new Error("Invalid cloud recovery cursor");
		return {
			companyId: this.#options.companyId,
			viewerUserId: uuid(input.viewerUserId),
			isOwner: boolean(input.isOwner),
			items,
			nextAfter,
		};
	}

	async targets(
		computeIdentityId: string,
		after: string | null,
		signal: AbortSignal,
	): Promise<{
		items: MemberRecoveryTargetSummary[];
		nextAfter: string | null;
	}> {
		uuid(computeIdentityId);
		if (after !== null) uuid(after);
		const input = record(
			await this.#rpc(
				"list_member_recovery_targets",
				{
					p_compute_identity_id: computeIdentityId,
					p_after: after,
					p_limit: 25,
				},
				signal,
			),
			["companyId", "computeIdentityId", "items", "nextAfter"],
		);
		if (
			input.companyId !== this.#options.companyId ||
			input.computeIdentityId !== computeIdentityId ||
			!Array.isArray(input.items) ||
			input.items.length > 25
		)
			throw new Error("Cloud recovery target page changed");
		const items = input.items.map((item) => target(item));
		let previous = after;
		for (const item of items) {
			if (previous !== null && item.targetId <= previous) throw new Error("Invalid cloud recovery target order");
			previous = item.targetId;
		}
		const nextAfter = input.nextAfter === null ? null : uuid(input.nextAfter);
		if (nextAfter !== null && (items.length !== 25 || nextAfter !== previous))
			throw new Error("Invalid cloud recovery cursor");
		return { items, nextAfter };
	}

	async review(computeIdentityId: string, targetId: string, signal: AbortSignal): Promise<MemberRecoveryReview> {
		uuid(computeIdentityId);
		uuid(targetId);
		const response = record(
			await this.#rpc(
				"review_member_identity_recovery",
				{
					p_compute_identity_id: computeIdentityId,
					p_target_id: targetId,
				},
				signal,
			),
			["schema", "review", "reviewSha256"],
		);
		if (response.schema !== "qorpera.member-identity-recovery-review/v1")
			throw new Error("Unsupported cloud recovery review");
		const input = record(response.review, [
			"companyId",
			"viewerUserId",
			"identity",
			"target",
			"backup",
			"recovery",
			"canRequest",
			"canConsent",
			"canCancel",
		]);
		const reviewedIdentity = identity(input.identity);
		const targetSummary = target(input.target, true);
		const targetDetails = input.target as Record<string, unknown>;
		if (
			input.companyId !== this.#options.companyId ||
			reviewedIdentity.computeIdentityId !== computeIdentityId ||
			targetSummary.targetId !== targetId
		)
			throw new Error("Cloud recovery review scope changed");
		let backup: MemberRecoveryReview["review"]["backup"] = null;
		if (input.backup !== null) {
			const source = record(input.backup, [
				"revision",
				"objectSha256",
				"objectBytes",
				"authorityId",
				"policySha256",
			]);
			const objectBytes = integer(source.objectBytes, 1);
			if (objectBytes > 16384) throw new Error("Invalid cloud recovery backup size");
			backup = {
				revision: integer(source.revision, 1),
				objectSha256: hash(source.objectSha256),
				objectBytes,
				authorityId: uuid(source.authorityId),
				policySha256: hash(source.policySha256),
			};
		}
		const recovery =
			input.recovery === null ? null : receipt(input.recovery, this.#options.companyId, computeIdentityId, targetId);
		if (recovery && backup && recovery.backupRevision !== backup.revision)
			throw new Error("Recovery review substituted its approved backup");
		return {
			schema: response.schema,
			reviewSha256: hash(response.reviewSha256),
			review: {
				companyId: this.#options.companyId,
				viewerUserId: uuid(input.viewerUserId),
				identity: reviewedIdentity,
				target: {
					...targetSummary,
					authorityId: uuid(targetDetails.authorityId),
					imageSha256: hash(targetDetails.imageSha256),
					guestManifestSha256: hash(targetDetails.guestManifestSha256),
					recipientKeySha256: hash(targetDetails.recipientKeySha256),
				},
				backup,
				recovery,
				canRequest: boolean(input.canRequest),
				canConsent: boolean(input.canConsent),
				canCancel: boolean(input.canCancel),
			},
		};
	}

	async decide(
		review: MemberRecoveryReview,
		decision: MemberRecoveryDecision,
		signal: AbortSignal,
	): Promise<MemberRecoveryReceipt> {
		const body = review.review;
		if (body.companyId !== this.#options.companyId) throw new Error("Cloud recovery company changed");
		const permitted =
			decision.kind === "request"
				? body.canRequest
				: decision.kind === "consent"
					? body.canConsent
					: decision.kind === "cancel" && body.canCancel;
		if (!permitted) throw new Error("This cloud recovery decision is unavailable");
		if (decision.kind === "request") {
			uuid(decision.requestId);
			if (decision.storageSource !== "nas" && decision.storageSource !== "supabase")
				throw new Error("Select the recovery backup source");
		}
		const result = receipt(
			await this.#rpc(
				"decide_member_identity_recovery",
				{
					p_compute_identity_id: uuid(body.identity.computeIdentityId),
					p_target_id: uuid(body.target.targetId),
					p_review_sha256: hash(review.reviewSha256),
					p_decision: decision.kind,
					p_client_request_id: decision.kind === "request" ? decision.requestId : null,
					p_storage_source: decision.kind === "request" ? decision.storageSource : null,
				},
				signal,
			),
			this.#options.companyId,
			body.identity.computeIdentityId,
			body.target.targetId,
		);
		if (
			(decision.kind === "cancel" && result.status !== "cancelled") ||
			(decision.kind === "consent" && result.status !== "approved") ||
			(decision.kind === "request" && !["approved", "awaiting_member"].includes(result.status)) ||
			(body.backup && result.backupRevision !== body.backup.revision) ||
			(body.recovery && body.recovery.recoveryId !== result.recoveryId) ||
			(decision.kind === "request" && result.storageSource !== decision.storageSource)
		)
			throw new Error("Cloud recovery decision receipt changed; refresh its status");
		return result;
	}

	#rpc(
		method:
			| "list_member_recovery_identities"
			| "list_member_recovery_targets"
			| "review_member_identity_recovery"
			| "decide_member_identity_recovery",
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown> {
		return withCloudDeadline(
			async (deadline) => {
				const token = await this.#options.accessToken(deadline);
				deadline.throwIfAborted();
				if (!/^[A-Za-z0-9._~-]{1,8192}$/.test(token)) throw new Error("Member sign-in is unavailable");
				const response = await this.#fetch(`${this.#origin}/rest/v1/rpc/qorpera_${method}`, {
					method: "POST",
					redirect: "error",
					signal: deadline,
					headers: {
						authorization: `Bearer ${token}`,
						apikey: this.#options.publishableKey,
						"content-type": "application/json",
					},
					body: JSON.stringify({ ...args, p_company_id: this.#options.companyId }),
				});
				if (response.status !== 200) {
					void response.body?.cancel().catch(() => undefined);
					if (response.status === 401 || response.status === 403)
						throw new Error("Cloud recovery access was denied. Check your membership or sign in again.");
					if (response.status === 409) throw new Error("The recovery review changed. Refresh before deciding.");
					throw new Error(
						"Cloud recovery is unavailable. A submitted decision may have completed; refresh its status before trying again.",
					);
				}
				const bytes = await readBoundedCloudResponse(response, 128 * 1024, deadline);
				deadline.throwIfAborted();
				try {
					return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
				} catch {
					throw new Error("Cloud recovery returned an invalid response");
				}
			},
			this.#options.timeoutMs ?? 15_000,
			signal,
		);
	}
}
