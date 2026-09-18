import { type KeyObject, timingSafeEqual } from "node:crypto";
import {
	readBoundedCloudResponse,
	supabaseServiceHeaders,
	withCloudDeadline,
} from "@qorpera/cloud-client/cloud-request";
import {
	parseRecoveryKeyBinding,
	parseRecoveryReleaseBinding,
	type RecoveryKeyBinding,
	recoveryBase64,
	recoveryDigest,
	recoveryInteger,
	recoveryPossessionProof,
	recoveryPublicKey,
	recoveryPublicKeyDigest,
	recoveryPublicKeyText,
	recoveryRecord,
	recoverySha256,
	recoveryTimestamp,
	recoveryUuid,
	sealRecoveryRelease,
	signRecoveryBackup,
	unwrapRecoveryKey,
	verifyRecoveryBackup,
	verifyRecoveryRelease,
} from "./cloud-identity-recovery-crypto.ts";

export type RecoveryControlOperation =
	| "identity_recovery_service_configuration"
	| "prepare_identity_key_backup"
	| "complete_identity_key_backup"
	| "register_identity_recovery_target"
	| "prepare_identity_key_release"
	| "commit_identity_key_release"
	| "identity_recovery_completion_authority"
	| "complete_identity_recovery";

export interface RecoveryControl {
	call(operation: RecoveryControlOperation, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

/** Implementations must be private, bounded and durable. put never overwrites;
 * it returns the exact existing winner when another process published first. */
export interface RecoveryObjectStore {
	get(address: string, signal: AbortSignal): Promise<Uint8Array | undefined>;
	put(address: string, bytes: Uint8Array, signal: AbortSignal): Promise<Uint8Array>;
}

export interface RecoveryBackupPlan {
	binding: RecoveryKeyBinding;
	status: "prepared" | "ready";
	objectSha256: string | null;
	objectBytes: number | null;
}

export interface IdentityRecoveryReceipt {
	recoveryId: string;
	companyId: string;
	computeIdentityId: string;
	targetId: string;
	backupRevision: number;
	storageSource: "nas" | "supabase";
	status: "completed";
	epoch: number;
	notBefore: string;
	expiresAt: string;
	receiptId: string;
}

export function recoveryCapability(value: unknown): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(value))
		throw new Error("Invalid recovery capability");
	return value;
}

export function recoverySource(value: unknown): "nas" | "supabase" {
	if (value !== "nas" && value !== "supabase") throw new Error("Invalid recovery storage selection");
	return value;
}

function envelopeSize(value: unknown): number {
	const count = recoveryInteger(value);
	if (count > 16_384) throw new Error("Recovery envelope exceeds its bound");
	return count;
}

export function parseRecoveryBackupPlan(value: unknown): RecoveryBackupPlan {
	const input = recoveryRecord(value, ["binding", "status", "objectSha256", "objectBytes"]);
	if (input.status !== "ready" && input.status !== "prepared") throw new Error("Invalid recovery backup state");
	if (input.status === "prepared" && (input.objectSha256 !== null || input.objectBytes !== null))
		throw new Error("Unverified recovery backup has an object receipt");
	return {
		binding: parseRecoveryKeyBinding(input.binding),
		status: input.status,
		objectSha256: input.status === "ready" ? recoverySha256(input.objectSha256) : null,
		objectBytes: input.status === "ready" ? envelopeSize(input.objectBytes) : null,
	};
}

export function parseIdentityRecoveryReceipt(value: unknown): IdentityRecoveryReceipt {
	const input = recoveryRecord(value, [
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
	if (input.status !== "completed") throw new Error("Identity recovery is not complete");
	return {
		recoveryId: recoveryUuid(input.recoveryId),
		companyId: recoveryUuid(input.companyId),
		computeIdentityId: recoveryUuid(input.computeIdentityId),
		targetId: recoveryUuid(input.targetId),
		backupRevision: recoveryInteger(input.backupRevision),
		storageSource: recoverySource(input.storageSource),
		status: "completed",
		epoch: recoveryInteger(input.epoch),
		notBefore: recoveryTimestamp(input.notBefore),
		expiresAt: recoveryTimestamp(input.expiresAt),
		receiptId: recoveryUuid(input.receiptId),
	};
}

export class SupabaseRecoveryControl implements RecoveryControl {
	readonly #base: URL;
	readonly #serviceKey: string;
	readonly #authorityId: string;
	readonly #capabilitySha256: string;
	readonly #fetch: typeof fetch;

	constructor(baseUrl: string, serviceKey: string, authorityId: string, capability: string, fetcher = fetch) {
		this.#base = new URL(baseUrl);
		if (
			this.#base.protocol !== "https:" ||
			this.#base.username ||
			this.#base.password ||
			this.#base.search ||
			this.#base.hash ||
			this.#base.pathname !== "/"
		)
			throw new Error("Recovery control requires an HTTPS origin");
		if (!serviceKey.trim()) throw new Error("Recovery control credential is missing");
		this.#serviceKey = serviceKey;
		this.#authorityId = recoveryUuid(authorityId);
		this.#capabilitySha256 = recoveryDigest(recoveryCapability(capability));
		this.#fetch = fetcher;
	}

	async call(
		operation: RecoveryControlOperation,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown> {
		return withCloudDeadline(
			async (deadline) => {
				const response = await this.#fetch(new URL(`/rest/v1/rpc/qorpera_${operation}`, this.#base), {
					method: "POST",
					redirect: "error",
					signal: deadline,
					headers: {
						...supabaseServiceHeaders(this.#serviceKey),
						"content-type": "application/json",
					},
					body: JSON.stringify({
						...args,
						p_authority_id: this.#authorityId,
						p_service_capability_sha256: this.#capabilitySha256,
					}),
				});
				if (!response.ok) {
					void response.body?.cancel().catch(() => undefined);
					throw new Error(`Recovery control rejected the operation (${response.status})`);
				}
				return JSON.parse(
					new TextDecoder("utf8", { fatal: true }).decode(
						await readBoundedCloudResponse(response, 16_384, deadline),
					),
				);
			},
			10_000,
			signal,
		);
	}
}

export class CloudIdentityRecoveryAuthority {
	readonly #companyId: string;
	readonly #authorityId: string;
	readonly #signer: KeyObject;
	readonly #wrapper: KeyObject;
	readonly #control: RecoveryControl;
	readonly #journal: RecoveryObjectStore;
	readonly #replicas: Readonly<Record<"nas" | "supabase", RecoveryObjectStore>>;

	constructor(options: {
		companyId: string;
		authorityId: string;
		signer: KeyObject;
		wrapper: KeyObject;
		control: RecoveryControl;
		journal: RecoveryObjectStore;
		nas: RecoveryObjectStore;
		supabase: RecoveryObjectStore;
	}) {
		this.#companyId = recoveryUuid(options.companyId);
		this.#authorityId = recoveryUuid(options.authorityId);
		recoveryPublicKey(recoveryPublicKeyText(options.signer), "ed25519");
		recoveryPublicKey(recoveryPublicKeyText(options.wrapper), "rsa");
		if (options.signer.type !== "private" || options.wrapper.type !== "private")
			throw new Error("Recovery authority keys must be private");
		if (options.journal === options.nas || options.journal === options.supabase || options.nas === options.supabase)
			throw new Error("Recovery storage authorities must be distinct");
		this.#signer = options.signer;
		this.#wrapper = options.wrapper;
		this.#control = options.control;
		this.#journal = options.journal;
		this.#replicas = { nas: options.nas, supabase: options.supabase };
	}

	#assertBinding(binding: RecoveryKeyBinding): void {
		if (
			binding.companyId !== this.#companyId ||
			binding.authorityId !== this.#authorityId ||
			binding.wrappingKeySha256 !== recoveryPublicKeyDigest(this.#wrapper)
		)
			throw new Error("Recovery authority does not match this service");
	}

	async prepareBackup(
		loginId: string,
		loginCapability: string,
		keySha256: string,
		signal: AbortSignal,
	): Promise<RecoveryBackupPlan> {
		const plan = parseRecoveryBackupPlan(
			await this.#control.call(
				"prepare_identity_key_backup",
				{
					p_login_id: recoveryUuid(loginId),
					p_login_capability_sha256: recoveryDigest(recoveryCapability(loginCapability)),
					p_key_sha256: recoverySha256(keySha256),
				},
				signal,
			),
		);
		this.#assertBinding(plan.binding);
		if (plan.binding.keySha256 !== keySha256) throw new Error("Recovery key commitment differs");
		return plan;
	}

	async backup(
		input: {
			loginId: string;
			loginCapability: string;
			binding: RecoveryKeyBinding;
			wrappedKey: string;
		},
		signal: AbortSignal,
	): Promise<RecoveryBackupPlan> {
		const binding = parseRecoveryKeyBinding(input.binding);
		const plan = await this.prepareBackup(input.loginId, input.loginCapability, binding.keySha256, signal);
		if (JSON.stringify(plan.binding) !== JSON.stringify(binding)) throw new Error("Recovery backup plan changed");
		// Validate encrypted input before signing or writing anything. Never return
		// or persist the unwrapped key; only the independent service sees it here.
		const key = unwrapRecoveryKey(input.wrappedKey, binding, this.#wrapper);
		key.fill(0);
		const address = recoveryDigest(`backup\0${binding.companyId}\0${binding.computeIdentityId}\0${binding.revision}`);
		let bytes = await this.#journal.get(address, signal);
		if (!bytes) {
			const candidate =
				plan.status === "ready"
					? await this.#replicas.nas.get(recoverySha256(plan.objectSha256), signal)
					: Buffer.from(JSON.stringify(signRecoveryBackup(binding, input.wrappedKey, this.#signer)));
			if (!candidate) throw new Error("Verified recovery backup is missing; explicit repair is required");
			bytes = await this.#journal.put(address, candidate, signal);
		}
		verifyRecoveryBackup(bytes, binding, this.#signer);
		const digest = recoveryDigest(bytes);
		if (plan.status === "ready" && (digest !== plan.objectSha256 || bytes.byteLength !== plan.objectBytes))
			throw new Error("Recovery backup receipt differs");
		for (const store of Object.values(this.#replicas)) {
			const stored = await store.put(digest, bytes, signal);
			if (recoveryDigest(stored) !== digest) throw new Error("Recovery replica conflicts with its address");
			const reread = await store.get(digest, signal);
			if (!reread || reread.byteLength !== bytes.byteLength || recoveryDigest(reread) !== digest)
				throw new Error("Recovery replica verification failed");
		}
		signal.throwIfAborted();
		const receipt = parseRecoveryBackupPlan(
			await this.#control.call(
				"complete_identity_key_backup",
				{
					p_login_id: input.loginId,
					p_login_capability_sha256: recoveryDigest(input.loginCapability),
					p_key_sha256: binding.keySha256,
					p_revision: binding.revision,
					p_object_sha256: digest,
					p_object_bytes: bytes.byteLength,
				},
				signal,
			),
		);
		if (
			receipt.status !== "ready" ||
			receipt.objectSha256 !== digest ||
			receipt.objectBytes !== bytes.byteLength ||
			JSON.stringify(receipt.binding) !== JSON.stringify(binding)
		)
			throw new Error("Recovery backup receipt differs");
		return receipt;
	}

	async registerTarget(
		input: {
			targetId: string;
			computeIdentityId: string;
			nodeId: string;
			imageSha256: string;
			guestManifestSha256: string;
			recipientPublicKey: string;
			targetCapability: string;
		},
		signal: AbortSignal,
	): Promise<unknown> {
		recoveryPublicKey(input.recipientPublicKey, "rsa");
		return this.#control.call(
			"register_identity_recovery_target",
			{
				p_target_id: recoveryUuid(input.targetId),
				p_compute_identity_id: recoveryUuid(input.computeIdentityId),
				p_node_id: recoveryUuid(input.nodeId),
				p_image_sha256: recoverySha256(input.imageSha256),
				p_guest_manifest_sha256: recoverySha256(input.guestManifestSha256),
				p_recipient_public_key: input.recipientPublicKey,
				p_target_capability_sha256: recoveryDigest(recoveryCapability(input.targetCapability)),
			},
			signal,
		);
	}

	/** Node registrar registration (2026-09-17 amendment): SQL binds the target
	 * to the registrar's own node and checks the enrolled capability digest. */
	async registerTargetByRegistrar(
		input: {
			registrarNodeId: string;
			registrarCapability: string;
			targetId: string;
			computeIdentityId: string;
			nodeId: string;
			imageSha256: string;
			guestManifestSha256: string;
			recipientPublicKey: string;
			targetCapability: string;
		},
		signal: AbortSignal,
	): Promise<unknown> {
		recoveryPublicKey(input.recipientPublicKey, "rsa");
		return this.#control.call(
			"register_identity_recovery_target",
			{
				p_target_id: recoveryUuid(input.targetId),
				p_compute_identity_id: recoveryUuid(input.computeIdentityId),
				p_node_id: recoveryUuid(input.nodeId),
				p_image_sha256: recoverySha256(input.imageSha256),
				p_guest_manifest_sha256: recoverySha256(input.guestManifestSha256),
				p_recipient_public_key: input.recipientPublicKey,
				p_target_capability_sha256: recoveryDigest(recoveryCapability(input.targetCapability)),
				p_registrar_node_id: recoveryUuid(input.registrarNodeId),
				p_registrar_capability_sha256: recoveryDigest(recoveryCapability(input.registrarCapability)),
			},
			signal,
		);
	}

	async #backupKey(plan: RecoveryBackupPlan, source: "nas" | "supabase", signal: AbortSignal): Promise<Buffer> {
		this.#assertBinding(plan.binding);
		if (plan.status !== "ready") throw new Error("Recovery backup is unverified");
		const bytes = await this.#replicas[source].get(recoverySha256(plan.objectSha256), signal);
		if (!bytes || bytes.byteLength !== plan.objectBytes || recoveryDigest(bytes) !== plan.objectSha256)
			throw new Error("Selected recovery backup is missing or corrupt");
		const backup = verifyRecoveryBackup(bytes, plan.binding, this.#signer);
		return unwrapRecoveryKey(backup.wrappedKey, plan.binding, this.#wrapper);
	}

	async release(
		recoveryId: string,
		targetCapability: string,
		signal: AbortSignal,
	): Promise<Uint8Array | IdentityRecoveryReceipt> {
		const args = {
			p_recovery_id: recoveryUuid(recoveryId),
			p_target_capability_sha256: recoveryDigest(recoveryCapability(targetCapability)),
		};
		const raw = await this.#control.call("prepare_identity_key_release", args, signal);
		if (raw && typeof raw === "object" && "status" in raw && raw.status === "completed") {
			const input = recoveryRecord(raw, ["status", "receipt"]);
			return this.#receipt(input.receipt, recoveryId);
		}
		const plan = recoveryRecord(raw, [
			"status",
			"binding",
			"backupBytes",
			"storageSource",
			"recipientPublicKey",
			"releaseSha256",
			"releaseBytes",
		]);
		if (plan.status !== "approved" && plan.status !== "released") throw new Error("Recovery is not approved");
		const binding = parseRecoveryReleaseBinding(plan.binding);
		this.#assertBinding(binding.key);
		if (binding.recoveryId !== recoveryId) throw new Error("Recovery release intent differs");
		const recipient = recoveryPublicKey(String(plan.recipientPublicKey), "rsa");
		if (recoveryPublicKeyDigest(recipient) !== binding.recipientKeySha256)
			throw new Error("Recovery recipient differs");
		const source = recoverySource(plan.storageSource);
		const address = recoveryDigest(`release\0${this.#companyId}\0${recoveryId}`);
		let bytes = await this.#journal.get(address, signal);
		if (!bytes) {
			if (plan.status === "released")
				throw new Error("Committed release journal is missing; operator recovery is required");
			const key = await this.#backupKey(
				{
					binding: binding.key,
					status: "ready",
					objectSha256: binding.backupSha256,
					objectBytes: envelopeSize(plan.backupBytes),
				},
				source,
				signal,
			);
			try {
				bytes = await this.#journal.put(
					address,
					Buffer.from(JSON.stringify(sealRecoveryRelease(key, binding, recipient, this.#signer))),
					signal,
				);
			} finally {
				key.fill(0);
			}
		}
		verifyRecoveryRelease(bytes, binding, this.#signer);
		const digest = recoveryDigest(bytes);
		if (plan.status === "released" && (plan.releaseSha256 !== digest || plan.releaseBytes !== bytes.byteLength))
			throw new Error("Recovery release journal differs from committed authority");
		if (Date.now() < Date.parse(binding.issuedAt) || Date.now() >= Date.parse(binding.expiresAt))
			throw new Error("Recovery release expired");
		signal.throwIfAborted();
		const committed = recoveryRecord(
			await this.#control.call(
				"commit_identity_key_release",
				{
					...args,
					p_release_sha256: digest,
					p_release_bytes: bytes.byteLength,
				},
				signal,
			),
			["releaseSha256", "releaseBytes"],
		);
		if (committed.releaseSha256 !== digest || committed.releaseBytes !== bytes.byteLength)
			throw new Error("Recovery release receipt differs");
		signal.throwIfAborted();
		return bytes;
	}

	#receipt(value: unknown, recoveryId: string): IdentityRecoveryReceipt {
		const receipt = parseIdentityRecoveryReceipt(value);
		if (receipt.recoveryId !== recoveryId || receipt.companyId !== this.#companyId)
			throw new Error("Recovery receipt authority differs");
		return receipt;
	}

	async complete(
		recoveryId: string,
		targetCapability: string,
		releaseSha256: string,
		proof: string,
		signal: AbortSignal,
	): Promise<IdentityRecoveryReceipt> {
		const args = {
			p_recovery_id: recoveryUuid(recoveryId),
			p_target_capability_sha256: recoveryDigest(recoveryCapability(targetCapability)),
		};
		const releaseSha = recoverySha256(releaseSha256);
		const proofBytes = recoveryBase64(proof, 32);
		const raw = await this.#control.call("identity_recovery_completion_authority", args, signal);
		if (raw && typeof raw === "object" && "status" in raw && raw.status === "completed") {
			// The SQL completion endpoint compares the submitted proof commitment
			// against the immutable receipt even on a lost-ACK retry.
			recoveryRecord(raw, ["status", "receipt"]);
		} else {
			const plan = recoveryRecord(raw, ["status", "backup", "storageSource", "releaseSha256"]);
			if (plan.status !== "released" || plan.releaseSha256 !== releaseSha)
				throw new Error("Recovery completion intent differs");
			const key = await this.#backupKey(
				parseRecoveryBackupPlan(plan.backup),
				recoverySource(plan.storageSource),
				signal,
			);
			try {
				const expected = recoveryPossessionProof(key, recoveryId, releaseSha);
				if (!timingSafeEqual(expected, proofBytes)) throw new Error("Recovery possession proof rejected");
			} finally {
				key.fill(0);
			}
		}
		signal.throwIfAborted();
		return this.#receipt(
			await this.#control.call(
				"complete_identity_recovery",
				{
					...args,
					p_release_sha256: releaseSha,
					p_proof_sha256: recoveryDigest(proofBytes),
				},
				signal,
			),
			recoveryId,
		);
	}
}
