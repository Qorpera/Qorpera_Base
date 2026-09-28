import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { ServiceHttpFetch } from "./http-transport.ts";

/** One member's Compute Identity volume, attached to the execution host at a
 * fixed per-identity mount. The volume carries the capsule master key, the
 * identity marker and the recovery epoch markers written by the login guest;
 * it never carries a provider credential. The execution host reads the key
 * for one run and hands it to that run's native host as a systemd credential.
 * Nothing here initialises an identity: a missing key or marker is a refusal,
 * exactly as the one-run guest bootstrap refuses it outside a login. */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const IDENTITY_SCHEMA = "qorpera.compute-identity-volume/v1";
const RECOVERY_MARKER_SCHEMA = "qorpera.compute-identity-recovery/v1";
const MAX_MARKER_BYTES = 64 * 1024;
const MAX_KEY_BYTES = 256;

export interface SharedExecutionIdentityState {
	companyId: string;
	computeIdentityId: string;
	epoch: number;
	blocked: boolean;
	keySha256: string | null;
	canInitialize: boolean;
}

export interface SharedExecutionIdentityMaterial {
	/** The 32-byte base64url capsule master key, for one run's native host credential. */
	masterKey: string;
	/** The exact bytes the native host expects as its `qorpera-native-identity-epoch` credential. */
	epochCredential: string;
	epoch: number;
	companyId: string;
}

export type SharedExecutionIdentityAuthority = (
	computeIdentityId: string,
	signal: AbortSignal,
) => Promise<SharedExecutionIdentityState>;

/** Whether an identity's login is kept by the vault (Stateless Compute step 1): then no volume,
 * key or epoch file exists for it on this host, and its run asks the vault for its login. */
export type SharedExecutionLoginCustody = (computeIdentityId: string, signal: AbortSignal) => Promise<boolean>;

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
	return value as Record<string, unknown>;
}

function supabaseServiceHeaders(serviceKey: string): Record<string, string> {
	const headers: Record<string, string> = { apikey: serviceKey };
	if (serviceKey.startsWith("eyJ") && serviceKey.split(".").length === 3) {
		headers.authorization = `Bearer ${serviceKey}`;
	}
	return headers;
}

/** The cloud recovery authority for one identity, read with the service key
 * exactly as the one-run guest bootstrap reads it. */
export function supabaseSharedExecutionIdentityAuthority(
	supabaseUrl: string,
	serviceKey: string,
	fetchImplementation: ServiceHttpFetch = fetch,
): SharedExecutionIdentityAuthority {
	const base = new URL(supabaseUrl);
	if (
		base.protocol !== "https:" ||
		base.pathname !== "/" ||
		base.username ||
		base.password ||
		base.search ||
		base.hash
	)
		throw new Error("Native identity authority requires an HTTPS origin");
	return async (computeIdentityId, signal) => {
		if (!UUID_PATTERN.test(computeIdentityId)) throw new Error("Compute Identity id is invalid");
		const response = await fetchImplementation(
			new URL("/rest/v1/rpc/qorpera_identity_recovery_runtime_state", base),
			{
				method: "POST",
				redirect: "error",
				headers: { ...supabaseServiceHeaders(serviceKey), "content-type": "application/json" },
				body: JSON.stringify({ p_compute_identity_id: computeIdentityId }),
				signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
			},
		);
		if (!response.ok) {
			void response.body?.cancel().catch(() => undefined);
			throw new Error(`Native identity authority rejected the run (${response.status})`);
		}
		return parseSharedExecutionIdentityState(await response.json());
	};
}

export function supabaseSharedExecutionLoginCustody(
	supabaseUrl: string,
	serviceKey: string,
	fetchImplementation: ServiceHttpFetch = fetch,
): SharedExecutionLoginCustody {
	const base = new URL(supabaseUrl);
	if (
		base.protocol !== "https:" ||
		base.pathname !== "/" ||
		base.username ||
		base.password ||
		base.search ||
		base.hash
	)
		throw new Error("Native identity authority requires an HTTPS origin");
	return async (computeIdentityId, signal) => {
		if (!UUID_PATTERN.test(computeIdentityId)) throw new Error("Compute Identity id is invalid");
		const response = await fetchImplementation(
			new URL("/rest/v1/rpc/qorpera_compute_identity_login_in_vault", base),
			{
				method: "POST",
				redirect: "error",
				headers: { ...supabaseServiceHeaders(serviceKey), "content-type": "application/json" },
				body: JSON.stringify({ p_compute_identity_id: computeIdentityId }),
				signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
			},
		);
		// A database without the check (this build reached the node before its migration)
		// answers 404: the login is then on a node, as before.
		if (response.status === 404) {
			void response.body?.cancel().catch(() => undefined);
			return false;
		}
		if (!response.ok) {
			void response.body?.cancel().catch(() => undefined);
			throw new Error(`Native identity custody is unavailable (${response.status})`);
		}
		const answer: unknown = await response.json();
		if (typeof answer !== "boolean") throw new Error("Native identity custody is invalid");
		return answer;
	};
}

export function parseSharedExecutionIdentityState(value: unknown): SharedExecutionIdentityState {
	const input = record(value, "Identity recovery runtime state");
	if (
		typeof input.companyId !== "string" ||
		!UUID_PATTERN.test(input.companyId) ||
		typeof input.computeIdentityId !== "string" ||
		!UUID_PATTERN.test(input.computeIdentityId) ||
		!Number.isSafeInteger(input.epoch) ||
		(input.epoch as number) < 0 ||
		typeof input.blocked !== "boolean" ||
		typeof input.canInitialize !== "boolean" ||
		(input.keySha256 !== null && (typeof input.keySha256 !== "string" || !SHA256_PATTERN.test(input.keySha256)))
	)
		throw new Error("Identity recovery runtime state is invalid");
	return {
		companyId: input.companyId,
		computeIdentityId: input.computeIdentityId,
		epoch: input.epoch as number,
		blocked: input.blocked,
		keySha256: input.keySha256 as string | null,
		canInitialize: input.canInitialize,
	};
}

function mountPoint(value: string): string {
	return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

/** True when `path` is itself a mount point in this mount namespace. */
export function mountInfoHasMountPoint(mountInfo: string, path: string): boolean {
	for (const line of mountInfo.split("\n")) {
		if (!line) continue;
		const fields = line.split(" ");
		if (fields.length > 5 && mountPoint(fields[4] as string) === path) return true;
	}
	return false;
}

async function readRootPrivateFile(path: string, maximum: number, label: string, expectedUid: number): Promise<string> {
	const flags = process.platform === "linux" ? constants.O_RDONLY | constants.O_NOFOLLOW : constants.O_RDONLY;
	const handle = await open(path, flags);
	try {
		const metadata = await handle.stat();
		if (
			!metadata.isFile() ||
			metadata.size > maximum ||
			(process.platform === "linux" && (metadata.uid !== expectedUid || (metadata.mode & 0o077) !== 0))
		)
			throw new Error(`${label} has unsafe ownership, permissions, or size`);
		const encoded = await handle.readFile({ encoding: "utf-8" });
		if (Buffer.byteLength(encoded) > maximum) throw new Error(`${label} exceeds its byte limit`);
		return encoded;
	} finally {
		await handle.close();
	}
}

export interface ReadSharedExecutionIdentityOptions {
	/** Directory holding one mount per identity: `<identityRoot>/<computeIdentityId>`. */
	identityRoot: string;
	computeIdentityId: string;
	authority: SharedExecutionIdentityAuthority;
	signal: AbortSignal;
	mountInfoPath?: string;
	/** Tests only: skip the mount-point requirement on non-Linux hosts. */
	requireMount?: boolean;
	/** Owner of the volume files; root in production, the test user in tests. */
	expectedUid?: number;
}

/** Verify one identity volume against the current cloud recovery authority and
 * return the material one run's native host receives. Refuses a blocked or
 * fenced identity, a missing or foreign key, and any epoch the volume has not
 * recovered to; it never creates key or marker. */
export async function readSharedExecutionIdentity(
	options: ReadSharedExecutionIdentityOptions,
): Promise<SharedExecutionIdentityMaterial> {
	const { computeIdentityId } = options;
	if (!UUID_PATTERN.test(computeIdentityId)) throw new Error("Compute Identity id is invalid");
	if (!isAbsolute(options.identityRoot) || resolve(options.identityRoot) !== options.identityRoot)
		throw new Error("Identity root must be an absolute physical path");
	const volume = join(options.identityRoot, computeIdentityId);
	const expectedUid = options.expectedUid ?? 0;
	const state = await options.authority(computeIdentityId, options.signal);
	if (state.computeIdentityId !== computeIdentityId || state.blocked)
		throw new Error("Compute Identity is fenced by cloud recovery authority");
	if (options.requireMount ?? process.platform === "linux") {
		const mountInfo = await readFile(options.mountInfoPath ?? "/proc/self/mountinfo", "utf-8");
		if (!mountInfoHasMountPoint(mountInfo, volume))
			throw new Error("Compute Identity volume is not a distinct mounted filesystem");
	}
	const marker = record(
		JSON.parse(
			await readRootPrivateFile(
				join(volume, "qorpera-compute-identity.json"),
				MAX_MARKER_BYTES,
				"Compute Identity volume marker",
				expectedUid,
			),
		),
		"Compute Identity volume marker",
	);
	if (
		Object.keys(marker).sort().join() !== "compute_identity_id,schema" ||
		marker.schema !== IDENTITY_SCHEMA ||
		marker.compute_identity_id !== computeIdentityId
	)
		throw new Error("Compute Identity volume marker does not match the run's identity");
	const masterKey = (
		await readRootPrivateFile(
			join(volume, "qorpera-native-provider-master-key"),
			MAX_KEY_BYTES,
			"Native provider master key",
			expectedUid,
		)
	).trim();
	if (!TOKEN_PATTERN.test(masterKey)) throw new Error("Native provider master key is invalid");
	const keyBytes = Buffer.from(masterKey, "base64url");
	let keySha256: string;
	try {
		if (keyBytes.byteLength !== 32) throw new Error("Native provider master key is invalid");
		keySha256 = createHash("sha256").update(keyBytes).digest("hex");
	} finally {
		keyBytes.fill(0);
	}
	if (state.keySha256 !== null && state.keySha256 !== keySha256)
		throw new Error("Local identity key differs from cloud recovery history");
	if (state.epoch > 0) {
		const recovery = record(
			JSON.parse(
				await readRootPrivateFile(
					join(volume, `qorpera-identity-recovery-${state.epoch}.json`),
					MAX_MARKER_BYTES,
					"Native identity recovery marker",
					expectedUid,
				),
			),
			"Native identity recovery marker",
		);
		if (
			recovery.schema !== RECOVERY_MARKER_SCHEMA ||
			recovery.companyId !== state.companyId ||
			recovery.computeIdentityId !== computeIdentityId ||
			recovery.epoch !== state.epoch ||
			recovery.keySha256 !== state.keySha256
		)
			throw new Error("Local identity recovery generation differs from current cloud authority");
	}
	return {
		masterKey,
		epochCredential: JSON.stringify({ computeIdentityId, companyId: state.companyId, epoch: state.epoch, keySha256 }),
		epoch: state.epoch,
		companyId: state.companyId,
	};
}
