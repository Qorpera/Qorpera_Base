import { createHash, createHmac, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
	type NativeCredentialGenerationStore,
	type NativeProviderExecutionRequest,
	openNativeCredentialCapsule,
	sealNativeCredentialCapsule,
} from "./cloud-native-provider-host.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const PATHS = new Set(["codex/auth.json"]);

export class NativeCredentialUnavailableError extends Error {
	readonly code = "native_credential_busy";
	constructor() {
		super("Native credential owner unavailable; concurrent dispatch not started");
	}
}

export interface NativeCredentialGeneration {
	schema: "qorpera.native-credential-generation/v1";
	capsuleId: string;
	generation: number;
	reference: string;
	ciphertextSha256: string | null;
	state: "ready" | "refreshing" | "recovery-required";
	ownerId: string | null;
}
export interface NativeCredentialRefreshClaim {
	ownerId: string;
	ownerTokenSha256: string;
	expectedGeneration: number;
	candidateReference: string;
}
export interface NativeCredentialGenerationControl {
	readCredentialGeneration(request: NativeProviderExecutionRequest, signal: AbortSignal): Promise<unknown>;
	claimCredentialRefresh(
		request: NativeProviderExecutionRequest,
		claim: NativeCredentialRefreshClaim,
		signal: AbortSignal,
	): Promise<unknown>;
	publishCredentialGeneration(
		request: NativeProviderExecutionRequest,
		claim: NativeCredentialRefreshClaim,
		ciphertextSha256: string,
		signal: AbortSignal,
	): Promise<unknown>;
	failCredentialRefresh(
		request: NativeProviderExecutionRequest,
		claim: NativeCredentialRefreshClaim,
		signal: AbortSignal,
	): Promise<void>;
}
export function parseNativeCredentialGeneration(value: unknown, capsuleId: string): NativeCredentialGeneration {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid credential generation");
	const v = value as Record<string, unknown>;
	if (
		Object.keys(v).sort().join() !== "capsuleId,ciphertextSha256,generation,ownerId,reference,schema,state" ||
		v.schema !== "qorpera.native-credential-generation/v1" ||
		v.capsuleId !== capsuleId ||
		!UUID.test(capsuleId) ||
		!Number.isSafeInteger(v.generation) ||
		Number(v.generation) < 0 ||
		(v.state !== "ready" && v.state !== "refreshing" && v.state !== "recovery-required") ||
		(v.ownerId !== null && (typeof v.ownerId !== "string" || !UUID.test(v.ownerId))) ||
		(v.state === "ready" ? v.ownerId !== null : v.ownerId === null) ||
		(v.ciphertextSha256 !== null && (typeof v.ciphertextSha256 !== "string" || !SHA.test(v.ciphertextSha256))) ||
		(Number(v.generation) > 0 && v.ciphertextSha256 === null) ||
		typeof v.reference !== "string" ||
		!(Number(v.generation) === 0
			? v.reference === `native-capsule/${capsuleId}`
			: v.reference.startsWith(`native-capsule/${capsuleId}/generations/`) &&
				UUID.test(v.reference.slice(`native-capsule/${capsuleId}/generations/`.length)))
	)
		throw new Error("Invalid credential generation");
	return v as unknown as NativeCredentialGeneration;
}

/** One upstream managed-auth owner. The SQL
 * intent has NO expiry takeover. A missing candidate after owner loss requires
 * recovery; it is never permission to repeat a possibly completed refresh. */
export class NativeCredentialOwner {
	readonly #control: NativeCredentialGenerationControl;
	readonly #store: NativeCredentialGenerationStore;
	readonly #key: string;
	readonly #root: string;
	constructor(options: {
		control: NativeCredentialGenerationControl;
		store: NativeCredentialGenerationStore;
		masterKey: string;
		temporaryRoot: string;
	}) {
		if (Buffer.from(options.masterKey, "base64url").length !== 32 || !isAbsolute(options.temporaryRoot))
			throw new Error("Invalid native credential owner configuration");
		this.#control = options.control;
		this.#store = options.store;
		this.#key = options.masterKey;
		this.#root = options.temporaryRoot;
	}
	#claim(capsuleId: string, generation: number, ownerId: string): NativeCredentialRefreshClaim {
		// A restarted authorized identity home can finish immutable publication.
		// This capability cannot initiate another refresh or move another capsule.
		const token = createHmac("sha256", Buffer.from(this.#key, "base64url"))
			.update(JSON.stringify(["qorpera.native-refresh-owner/v1", capsuleId, generation, ownerId]))
			.digest();
		return {
			ownerId,
			expectedGeneration: generation,
			ownerTokenSha256: createHash("sha256").update(token).digest("hex"),
			candidateReference: `native-capsule/${capsuleId}/generations/${ownerId}`,
		};
	}
	async #opened<T>(
		snapshot: NativeCredentialGeneration,
		use: (root: string) => Promise<T>,
		signal: AbortSignal,
	): Promise<T> {
		const root = await mkdtemp(join(this.#root, "qorpera-credential-owner-"));
		try {
			const bytes = await this.#store.get(snapshot.reference, signal);
			if (
				snapshot.ciphertextSha256 !== null &&
				createHash("sha256").update(bytes).digest("hex") !== snapshot.ciphertextSha256
			)
				throw new Error("Native credential digest differs");
			await openNativeCredentialCapsule(
				bytes,
				root,
				this.#key,
				snapshot.capsuleId,
				PATHS,
				snapshot.generation === 0 ? undefined : snapshot.generation,
			);
			return await use(root);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}
	async #read(request: NativeProviderExecutionRequest, signal: AbortSignal): Promise<NativeCredentialGeneration> {
		signal.throwIfAborted();
		return parseNativeCredentialGeneration(
			await this.#control.readCredentialGeneration(request, signal),
			request.authority.credentialCapsuleId,
		);
	}
	async #publish(
		request: NativeProviderExecutionRequest,
		claim: NativeCredentialRefreshClaim,
		bytes: Uint8Array,
		signal: AbortSignal,
	): Promise<void> {
		const digest = createHash("sha256").update(bytes).digest("hex");
		await this.#store.putImmutable(claim.candidateReference, bytes, signal);
		try {
			await this.#control.publishCredentialGeneration(request, claim, digest, signal);
		} catch {
			// Lost response is reconciled against durable exact generation; never retry refresh.
			const durable = await this.#read(request, signal);
			if (
				durable.generation !== claim.expectedGeneration + 1 ||
				durable.reference !== claim.candidateReference ||
				durable.ciphertextSha256 !== digest ||
				durable.state !== "ready"
			)
				throw new Error("Native credential publication unconfirmed");
		}
		const durable = await this.#read(request, signal);
		if (
			durable.generation !== claim.expectedGeneration + 1 ||
			durable.reference !== claim.candidateReference ||
			durable.ciphertextSha256 !== digest ||
			durable.state !== "ready"
		)
			throw new Error("Native credential publication unconfirmed");
	}
	async #recover(
		request: NativeProviderExecutionRequest,
		current: NativeCredentialGeneration,
		signal: AbortSignal,
	): Promise<void> {
		if (current.state === "recovery-required") throw new Error("Native credential requires reconnection");
		const claim = this.#claim(current.capsuleId, current.generation, current.ownerId as string);
		let bytes: Uint8Array;
		try {
			bytes = await this.#store.get(claim.candidateReference, signal);
		} catch {
			throw new NativeCredentialUnavailableError();
		}
		await this.#opened(
			{
				...current,
				reference: claim.candidateReference,
				generation: current.generation + 1,
				ciphertextSha256: createHash("sha256").update(bytes).digest("hex"),
			},
			async () => undefined,
			signal,
		);
		await this.#publish(request, claim, bytes, signal);
	}
	/** Managed clients own automatic refresh for their whole lifetime. Until a
	 * supported access-only adapter is pinned, one such lifetime owns a capsule.
	 * Busy callers fail closed; this is deliberately NOT concurrent-model support. */
	async restore(
		request: NativeProviderExecutionRequest,
		root: string,
		signal: AbortSignal,
	): Promise<NativeCredentialRefreshClaim> {
		if (
			request.runtime !== "company-path-v1" ||
			request.authority.provider !== "openai" ||
			request.authority.nativeHarness !== "codex-cli"
		)
			throw new Error("Credential generations require the governed Codex runtime");
		let current = await this.#read(request, signal);
		if (current.state !== "ready") {
			await this.#recover(request, current, signal);
			current = await this.#read(request, signal);
		}
		const claim = this.#claim(current.capsuleId, current.generation, randomUUID());
		let admitted: NativeCredentialGeneration;
		try {
			admitted = parseNativeCredentialGeneration(
				await this.#control.claimCredentialRefresh(request, claim, signal),
				current.capsuleId,
			);
		} catch (error) {
			// Read-only reconciliation never repeats a claim or launches the client
			// after an uncertain acknowledgement. A competing owner is retryable.
			const latest = await this.#read(request, signal).catch(() => undefined);
			if (latest?.state === "refreshing") throw new NativeCredentialUnavailableError();
			throw error;
		}
		if (
			admitted.state !== "refreshing" ||
			admitted.ownerId !== claim.ownerId ||
			admitted.generation !== current.generation
		)
			throw new Error("Native credential owner differs");
		const metadata = await open(
			join(root, "qorpera-credential-owner.json"),
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			await metadata.writeFile(
				JSON.stringify({
					schema: "qorpera.native-credential-owner-location/v1",
					computeIdentityId: request.authority.computeIdentityId,
					capsuleId: current.capsuleId,
					runId: request.authority.runId,
					leaseId: request.authority.leaseId,
					ownerId: claim.ownerId,
					expectedGeneration: claim.expectedGeneration,
					candidateReference: claim.candidateReference,
				}),
			);
			await metadata.sync();
		} finally {
			await metadata.close();
		}
		const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
		// Claim confirmation precedes giving rotating credentials to a process.
		// An ambiguous claim reply is never retried into an upstream effect.
		const bytes = await this.#store.get(current.reference, signal);
		if (
			current.ciphertextSha256 !== null &&
			createHash("sha256").update(bytes).digest("hex") !== current.ciphertextSha256
		)
			throw new Error("Native credential digest differs");
		await openNativeCredentialCapsule(
			bytes,
			root,
			this.#key,
			current.capsuleId,
			PATHS,
			current.generation === 0 ? undefined : current.generation,
		);
		return claim;
	}
	/** Only call after the isolated official client and descendants have settled.
	 * Store the encrypted candidate even after cancellation; publishing still
	 * requires current SQL authority. A later authorized owner can reconcile it. */
	async publish(
		request: NativeProviderExecutionRequest,
		claim: NativeCredentialRefreshClaim,
		root: string,
	): Promise<void> {
		const signal = AbortSignal.timeout(30_000);
		const bytes = await sealNativeCredentialCapsule(
			root,
			this.#key,
			request.authority.credentialCapsuleId,
			PATHS,
			claim.expectedGeneration + 1,
		);
		// The settled client's latest credentials remain recoverable locally if
		// cloud upload fails. Neither this file nor its metadata is model-mounted.
		const auth = await open(join(root, "codex/auth.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			await auth.sync();
		} finally {
			await auth.close();
		}
		const directory = await open(
			join(root, "codex"),
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
		);
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
		await this.#publish(request, claim, bytes, signal);
	}
}
