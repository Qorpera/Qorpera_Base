import { type KeyObject, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
	readBoundedCloudResponse,
	supabaseServiceHeaders,
	withCloudDeadline,
} from "@qorpera/cloud-client/cloud-request";
import {
	type IdentityRecoveryReceipt,
	parseIdentityRecoveryReceipt,
	parseRecoveryBackupPlan,
	recoveryCapability,
} from "./cloud-identity-recovery.ts";
import {
	openRecoveryRelease,
	parseRecoveryReleaseBinding,
	recoveryBase64,
	recoveryDigest,
	recoveryInteger,
	recoveryPossessionProof,
	recoveryPublicKey,
	recoveryPublicKeyDigest,
	recoveryRecord,
	recoverySha256,
	recoveryUuid,
	verifyRecoveryRelease,
	wrapRecoveryKey,
} from "./cloud-identity-recovery-crypto.ts";
import { FileRecoveryObjectStore } from "./cloud-identity-recovery-store.ts";

export interface IdentityRecoveryConfiguration {
	authorityId: string;
	serviceOrigin: string;
	signingPublicKey: string;
	wrappingPublicKey: string;
}

export interface IdentityRecoveryRuntimeState {
	companyId: string;
	computeIdentityId: string;
	epoch: number;
	blocked: boolean;
	policySha256: string;
	keySha256: string | null;
	canInitialize: boolean;
	recoveryConfiguration: IdentityRecoveryConfiguration | null;
}

export function parseIdentityRecoveryRuntimeState(value: unknown): IdentityRecoveryRuntimeState {
	const input = recoveryRecord(value, [
		"companyId",
		"computeIdentityId",
		"epoch",
		"blocked",
		"policySha256",
		"keySha256",
		"canInitialize",
		"recoveryConfiguration",
	]);
	if (typeof input.blocked !== "boolean" || typeof input.canInitialize !== "boolean")
		throw new Error("Invalid identity recovery runtime state");
	let recoveryConfiguration: IdentityRecoveryConfiguration | null = null;
	if (input.recoveryConfiguration !== null) {
		const config = recoveryRecord(input.recoveryConfiguration, [
			"authorityId",
			"serviceOrigin",
			"signingPublicKey",
			"wrappingPublicKey",
		]);
		const origin = new URL(String(config.serviceOrigin));
		if (origin.protocol !== "https:" || origin.origin !== config.serviceOrigin)
			throw new Error("Recovery requires a pinned HTTPS service origin");
		recoveryPublicKey(String(config.signingPublicKey), "ed25519");
		recoveryPublicKey(String(config.wrappingPublicKey), "rsa");
		recoveryConfiguration = {
			authorityId: recoveryUuid(config.authorityId),
			serviceOrigin: origin.origin,
			signingPublicKey: String(config.signingPublicKey),
			wrappingPublicKey: String(config.wrappingPublicKey),
		};
	}
	const state: IdentityRecoveryRuntimeState = {
		companyId: recoveryUuid(input.companyId),
		computeIdentityId: recoveryUuid(input.computeIdentityId),
		epoch: recoveryInteger(input.epoch, 0),
		blocked: input.blocked,
		policySha256: recoverySha256(input.policySha256),
		keySha256: input.keySha256 === null ? null : recoverySha256(input.keySha256),
		canInitialize: input.canInitialize,
		recoveryConfiguration,
	};
	if (state.canInitialize && (state.blocked || state.epoch !== 0 || state.keySha256 !== null))
		throw new Error("Conflicting identity initialization authority");
	return state;
}

export async function fetchIdentityRecoveryRuntimeState(
	baseUrl: string,
	serviceKey: string,
	computeIdentityId: string,
	signal?: AbortSignal,
	fetcher = fetch,
): Promise<IdentityRecoveryRuntimeState> {
	const base = new URL(baseUrl);
	if (
		base.protocol !== "https:" ||
		base.pathname !== "/" ||
		base.username ||
		base.password ||
		base.search ||
		base.hash
	)
		throw new Error("Native identity authority requires an HTTPS origin");
	return withCloudDeadline(
		async (deadline) => {
			const response = await fetcher(new URL("/rest/v1/rpc/qorpera_identity_recovery_runtime_state", base), {
				method: "POST",
				redirect: "error",
				signal: deadline,
				headers: { ...supabaseServiceHeaders(serviceKey), "content-type": "application/json" },
				body: JSON.stringify({ p_compute_identity_id: recoveryUuid(computeIdentityId) }),
			});
			if (!response.ok) {
				void response.body?.cancel().catch(() => undefined);
				throw new Error(`Native identity authority rejected startup (${response.status})`);
			}
			const state = parseIdentityRecoveryRuntimeState(
				JSON.parse(
					new TextDecoder("utf8", { fatal: true }).decode(
						await readBoundedCloudResponse(response, 16_384, deadline),
					),
				),
			);
			if (state.computeIdentityId !== computeIdentityId) throw new Error("Native identity authority differs");
			return state;
		},
		10_000,
		signal,
	);
}

export function identityRecoveryEpochFilename(epoch: number): string {
	return `qorpera-identity-recovery-${recoveryInteger(epoch)}.json`;
}

export function assertIdentityRecoveryMarker(value: unknown, state: IdentityRecoveryRuntimeState): void {
	const input = recoveryRecord(value, [
		"schema",
		"companyId",
		"computeIdentityId",
		"epoch",
		"keySha256",
		"recoveryId",
		"receiptId",
		"releaseSha256",
	]);
	if (
		input.schema !== "qorpera.compute-identity-recovery/v1" ||
		input.companyId !== state.companyId ||
		input.computeIdentityId !== state.computeIdentityId ||
		input.epoch !== state.epoch ||
		input.keySha256 !== state.keySha256
	)
		throw new Error("Local identity recovery generation differs from current cloud authority");
	recoveryUuid(input.recoveryId);
	recoveryUuid(input.receiptId);
	recoverySha256(input.releaseSha256);
}

export interface IdentityRecoveryGuestTransport {
	post(
		path: "backup/prepare" | "backup" | "release" | "complete",
		body: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}

export class HttpIdentityRecoveryGuestTransport implements IdentityRecoveryGuestTransport {
	readonly #origin: URL;
	readonly #fetch: typeof fetch;

	constructor(origin: string, fetcher = fetch) {
		this.#origin = new URL(origin);
		if (this.#origin.protocol !== "https:" || this.#origin.origin !== origin)
			throw new Error("Recovery requires a pinned HTTPS service origin");
		this.#fetch = fetcher;
	}

	post(
		path: "backup/prepare" | "backup" | "release" | "complete",
		body: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown> {
		return withCloudDeadline(
			async (deadline) => {
				const response = await this.#fetch(new URL(`/v1/${path}`, this.#origin), {
					method: "POST",
					redirect: "error",
					signal: deadline,
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				});
				if (!response.ok) {
					void response.body?.cancel().catch(() => undefined);
					throw new Error(`Cloud recovery rejected the operation (${response.status})`);
				}
				return JSON.parse(
					new TextDecoder("utf8", { fatal: true }).decode(
						await readBoundedCloudResponse(response, 24_576, deadline),
					),
				);
			},
			30_000,
			signal,
		);
	}
}

export async function backupNativeIdentityKey(options: {
	state: IdentityRecoveryRuntimeState;
	masterKey: string;
	loginId: string;
	loginCapability: string;
	transport: IdentityRecoveryGuestTransport;
	signal: AbortSignal;
}): Promise<void> {
	const { state, transport, signal } = options;
	const config = state.recoveryConfiguration;
	if (state.blocked || !config) throw new Error("Cloud recovery authority is unavailable");
	const key = recoveryBase64(options.masterKey, 32);
	try {
		const keySha256 = recoveryDigest(key);
		if (state.keySha256 !== null && state.keySha256 !== keySha256)
			throw new Error("Native identity key differs from cloud history");
		const input = {
			loginId: recoveryUuid(options.loginId),
			loginCapability: recoveryCapability(options.loginCapability),
			keySha256,
		};
		const plan = parseRecoveryBackupPlan(await transport.post("backup/prepare", input, signal));
		if (
			plan.binding.companyId !== state.companyId ||
			plan.binding.computeIdentityId !== state.computeIdentityId ||
			plan.binding.authorityId !== config.authorityId ||
			plan.binding.policySha256 !== state.policySha256 ||
			plan.binding.keySha256 !== keySha256
		)
			throw new Error("Cloud recovery backup authority differs");
		const wrappedKey = wrapRecoveryKey(key, plan.binding, recoveryPublicKey(config.wrappingPublicKey, "rsa"));
		const receipt = parseRecoveryBackupPlan(
			await transport.post(
				"backup",
				{
					loginId: input.loginId,
					loginCapability: input.loginCapability,
					binding: plan.binding,
					wrappedKey,
				},
				signal,
			),
		);
		if (receipt.status !== "ready" || JSON.stringify(receipt.binding) !== JSON.stringify(plan.binding))
			throw new Error("Cloud recovery backup was not confirmed");
	} finally {
		key.fill(0);
	}
}

async function installPrivateFile(directory: string, filename: string, bytes: Uint8Array): Promise<void> {
	const path = join(directory, filename);
	const temporary = join(directory, `.recovery-install-${randomUUID()}`);
	const handle = await open(
		temporary,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		await handle.writeFile(bytes);
		await handle.sync();
		await handle.close();
		try {
			await link(temporary, path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const installed = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const info = await installed.stat();
			if (
				!info.isFile() ||
				info.uid !== process.geteuid?.() ||
				(info.mode & 0o077) !== 0 ||
				info.size !== bytes.byteLength
			)
				throw new Error("Recovery installation conflicts with existing private state");
			const content = Buffer.alloc(bytes.byteLength + 1);
			const result = await installed.read(content, 0, content.byteLength, 0);
			if (result.bytesRead !== bytes.byteLength || !content.subarray(0, result.bytesRead).equals(Buffer.from(bytes)))
				throw new Error("Recovery installation cannot replace an existing identity");
		} finally {
			await installed.close();
		}
		const root = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		try {
			await root.sync();
		} finally {
			await root.close();
		}
	} finally {
		await handle.close();
		await unlink(temporary);
	}
}

/** Runs in the trusted replacement guest, never the member's Mac or model UID.
 * Epoch records are immutable, so a delayed old completion cannot overwrite a
 * newer generation. A partial install resumes the same durable release. */
export async function restoreNativeIdentityKey(options: {
	directory: string;
	companyId: string;
	computeIdentityId: string;
	authorityId: string;
	recoveryId: string;
	targetId: string;
	epoch: number;
	backupSha256: string;
	recipientKey: KeyObject;
	signingKey: KeyObject;
	targetCapability: string;
	transport: IdentityRecoveryGuestTransport;
	signal: AbortSignal;
}): Promise<IdentityRecoveryReceipt> {
	const { signal, transport } = options;
	recoveryUuid(options.companyId);
	recoveryUuid(options.computeIdentityId);
	recoveryUuid(options.authorityId);
	recoveryUuid(options.targetId);
	recoveryInteger(options.epoch);
	recoverySha256(options.backupSha256);
	const args = {
		recoveryId: recoveryUuid(options.recoveryId),
		targetCapability: recoveryCapability(options.targetCapability),
	};
	const journal = new FileRecoveryObjectStore(options.directory);
	const address = recoveryDigest(`guest-release\0${options.recoveryId}`);
	let bytes = await journal.get(address, signal);
	if (!bytes) {
		const response = recoveryRecord(await transport.post("release", args, signal), ["release"]);
		if (typeof response.release !== "string" || response.release.length > 22_000)
			throw new Error("Invalid cloud recovery release");
		const candidate = Buffer.from(response.release, "base64url");
		if (candidate.toString("base64url") !== response.release)
			throw new Error("Invalid cloud recovery release encoding");
		bytes = await journal.put(address, candidate, signal);
	}
	const raw = recoveryRecord(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)), [
		"schema",
		"binding",
		"wrappedKey",
		"signature",
	]);
	const binding = parseRecoveryReleaseBinding(raw.binding);
	if (
		binding.key.companyId !== options.companyId ||
		binding.key.computeIdentityId !== options.computeIdentityId ||
		binding.key.authorityId !== options.authorityId ||
		binding.recoveryId !== options.recoveryId ||
		binding.targetId !== options.targetId ||
		binding.epoch !== options.epoch ||
		binding.backupSha256 !== options.backupSha256 ||
		binding.recipientKeySha256 !== recoveryPublicKeyDigest(options.recipientKey)
	)
		throw new Error("Recovery release does not match the approved replacement");
	verifyRecoveryRelease(bytes, binding, options.signingKey);
	const masterPath = join(options.directory, "qorpera-native-provider-master-key");
	let key: Buffer;
	try {
		const installed = await open(masterPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const info = await installed.stat();
			if (!info.isFile() || info.size !== 44 || info.uid !== process.geteuid?.() || (info.mode & 0o077) !== 0)
				throw new Error("Existing recovery master key is unsafe");
			key = recoveryBase64((await installed.readFile("utf8")).trim(), 32);
		} finally {
			await installed.close();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		key = openRecoveryRelease(bytes, binding, options.recipientKey, options.signingKey);
	}
	try {
		if (recoveryDigest(key) !== binding.key.keySha256) throw new Error("Existing identity key differs from recovery");
		await installPrivateFile(
			options.directory,
			"qorpera-native-provider-master-key",
			Buffer.from(`${key.toString("base64url")}\n`),
		);
		const releaseSha256 = recoveryDigest(bytes);
		const receipt = parseIdentityRecoveryReceipt(
			await transport.post(
				"complete",
				{
					...args,
					releaseSha256,
					proof: recoveryPossessionProof(key, options.recoveryId, releaseSha256).toString("base64url"),
				},
				signal,
			),
		);
		if (
			receipt.companyId !== options.companyId ||
			receipt.computeIdentityId !== options.computeIdentityId ||
			receipt.recoveryId !== options.recoveryId ||
			receipt.targetId !== options.targetId ||
			receipt.epoch !== options.epoch ||
			receipt.backupRevision !== binding.key.revision
		)
			throw new Error("Recovery completion receipt differs");
		await installPrivateFile(
			options.directory,
			identityRecoveryEpochFilename(receipt.epoch),
			Buffer.from(
				JSON.stringify({
					schema: "qorpera.compute-identity-recovery/v1",
					companyId: receipt.companyId,
					computeIdentityId: receipt.computeIdentityId,
					epoch: receipt.epoch,
					keySha256: binding.key.keySha256,
					recoveryId: receipt.recoveryId,
					receiptId: receipt.receiptId,
					releaseSha256,
				}),
			),
		);
		await installPrivateFile(
			options.directory,
			"qorpera-compute-identity.json",
			Buffer.from(
				`${JSON.stringify(
					{
						schema: "qorpera.compute-identity-volume/v1",
						compute_identity_id: options.computeIdentityId,
					},
					null,
					2,
				)}\n`,
			),
		);
		return receipt;
	} finally {
		key.fill(0);
	}
}
