import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { constants } from "node:fs";
import { chmod, chown, link, lstat, mkdir, open, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { parseCompanyComputerNativeUrl } from "@qorpera/contracts";
import { recoveryBase64, recoveryDigest } from "./cloud-identity-recovery-crypto.ts";
import {
	assertIdentityRecoveryMarker,
	fetchIdentityRecoveryRuntimeState,
	type IdentityRecoveryRuntimeState,
	identityRecoveryEpochFilename,
} from "./cloud-identity-recovery-guest.ts";
import { parseEphemeralCloudRunnerServiceConfig } from "./cloud-runner-service.ts";
import { assertGuestImageSelfUpdateMasked } from "./lxd-guest-image-updates.ts";

const BOOTSTRAP_SCHEMA = "qorpera.lxd-runner-bootstrap/v1";
const COMPANY_BOOTSTRAP_SCHEMA = "qorpera.lxd-company-runner-bootstrap/v1";
const LOGIN_BOOTSTRAP_SCHEMA = "qorpera.lxd-native-login-bootstrap/v1";
const IDENTITY_SCHEMA = "qorpera.compute-identity-volume/v1";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TEMPLATE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_BOOTSTRAP_BYTES = 64 * 1024;
const MAX_CREDENTIAL_BYTES = 256;
const MAX_SERVICE_CREDENTIAL_BYTES = 8192;
const RUNNER_SERVICE = "qorpera-ephemeral-runner.service";
const NATIVE_PROVIDER_SERVICE = "qorpera-native-provider-host.service";
const NATIVE_LOGIN_PROVIDER_SERVICE = "qorpera-native-login-provider-host.service";
const execFileAsync = promisify(execFile);

export interface LxdRunnerBootstrapConfig {
	schema: typeof BOOTSTRAP_SCHEMA | typeof COMPANY_BOOTSTRAP_SCHEMA;
	computeIdentityId: string;
	computeTemplateKey: string;
	computeTemplateVersion: string;
	computePolicySha256: string;
	runnerConfigPath: string;
	nativeProviderEnvironmentPath: string;
	credentialSource: string;
	identityVolumePath: string;
	companyRuntime?: {
		mode: "company-path-v1";
		runId: string;
		profileId: string;
		runnerId: string;
		codexPath: string;
		binarySha256: string;
		objectGatewayUrl: string;
		secretBrokerUrl: string;
		secretBrokerCaSha256: string;
		office?: { environmentId: string; url: string; tokenSha256: string };
		codingCommand?: { url: string; tokenSha256: string };
	};
}

export interface LxdRunnerBootstrapPaths {
	bootstrapConfig: string;
	runnerConfig: string;
	nativeProviderEnvironment: string;
	credentialSource: string;
	identityVolume: string;
	identityMarker: string;
	identityMasterKey: string;
	runnerHomeDirectory: string;
	runnerConfigDestination: string;
	runnerStateDirectory: string;
	runnerTemporaryDirectory: string;
	nativeProviderTemporaryDirectory: string;
	mountInfo: string;
	systemUnitDirectory: string;
}

export interface LxdRunnerBootstrapServiceIdentity {
	uid: number;
	gid: number;
}

export interface LxdNativeLoginBootstrapConfig {
	schema: typeof LOGIN_BOOTSTRAP_SCHEMA;
	computeIdentityId: string;
	supabaseUrl: string;
	nativeBridgeUrl: string;
	trustedSource: string;
	identityRecoveryCaSha256: string;
	nativeProviderEnvironmentPath: string;
	credentialSource: string;
	identityVolumePath: string;
}

export interface LxdNativeLoginBootstrapPaths {
	bootstrapConfig: string;
	nativeProviderEnvironment: string;
	credentialSource: string;
	identityVolume: string;
	identityMarker: string;
	identityMasterKey: string;
	nativeProviderTemporaryDirectory: string;
	mountInfo: string;
	systemUnitDirectory: string;
}

export interface RunLxdNativeLoginBootstrapOptions {
	paths?: LxdNativeLoginBootstrapPaths;
	expectedRootUid?: number;
	expectedRootGid?: number;
	nativeServiceIdentity?: LxdRunnerBootstrapServiceIdentity;
	startService?: (service: string) => Promise<void>;
	identityRuntimeState?: (computeIdentityId: string) => Promise<IdentityRecoveryRuntimeState>;
}

export interface RunLxdRunnerBootstrapOptions {
	paths?: LxdRunnerBootstrapPaths;
	expectedRootUid?: number;
	expectedRootGid?: number;
	serviceIdentity?: LxdRunnerBootstrapServiceIdentity;
	nativeServiceIdentity?: LxdRunnerBootstrapServiceIdentity;
	runnerSupplementaryGids?: readonly number[];
	startService?: (service: string) => Promise<void>;
	identityRuntimeState?: (computeIdentityId: string) => Promise<IdentityRecoveryRuntimeState>;
}

const PRODUCTION_PATHS: LxdRunnerBootstrapPaths = {
	bootstrapConfig: "/var/lib/qorpera-bootstrap/bootstrap.json",
	runnerConfig: "/var/lib/qorpera-bootstrap/runner-config.json",
	nativeProviderEnvironment: "/var/lib/qorpera-bootstrap/native-provider.env",
	credentialSource: "/var/lib/qorpera-bootstrap/credentials",
	identityVolume: "/var/lib/qorpera/identity",
	identityMarker: "/var/lib/qorpera/identity/qorpera-compute-identity.json",
	identityMasterKey: "/var/lib/qorpera/identity/qorpera-native-provider-master-key",
	runnerHomeDirectory: "/var/lib/qorpera-runner",
	runnerConfigDestination: "/var/lib/qorpera-runner/.config/qorpera-runner/config.json",
	runnerStateDirectory: "/var/lib/qorpera-runner/.local/state/qorpera-runner",
	runnerTemporaryDirectory: "/var/lib/qorpera-native-workspace",
	nativeProviderTemporaryDirectory: "/var/lib/qorpera-native-provider/tmp",
	mountInfo: "/proc/self/mountinfo",
	systemUnitDirectory: "/etc/systemd/system",
};

const PRODUCTION_LOGIN_PATHS: LxdNativeLoginBootstrapPaths = {
	bootstrapConfig: "/var/lib/qorpera-bootstrap/login-bootstrap.json",
	nativeProviderEnvironment: "/var/lib/qorpera-bootstrap/native-provider.env",
	credentialSource: "/var/lib/qorpera-bootstrap/credentials",
	identityVolume: "/var/lib/qorpera/identity",
	identityMarker: "/var/lib/qorpera/identity/qorpera-compute-identity.json",
	identityMasterKey: "/var/lib/qorpera/identity/qorpera-native-provider-master-key",
	nativeProviderTemporaryDirectory: "/var/lib/qorpera-native-provider/tmp",
	mountInfo: "/proc/self/mountinfo",
	systemUnitDirectory: "/etc/systemd/system",
};

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

/** The coding command gateway as the provider service parses it: an exact HTTPS
 * origin, nothing else (the bootstrap bundle does not import the gateway client). */
function codingCommandOrigin(value: string): string {
	const url = new URL(value);
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/")
		throw new Error("Coding command URL is invalid");
	return url.origin;
}

function exactKeys(input: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const expected = new Set(allowed);
	if (Object.keys(input).some((key) => !expected.has(key))) throw new Error(`${label} contains an unknown field`);
}

function text(value: unknown, label: string, pattern: RegExp): string {
	if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
	return value;
}

export function parseLxdRunnerBootstrapConfig(value: unknown): LxdRunnerBootstrapConfig {
	const input = record(value, "LXD runner bootstrap configuration");
	exactKeys(
		input,
		[
			"schema",
			"compute_identity_id",
			"compute_template_key",
			"compute_template_version",
			"compute_policy_sha256",
			"runner_config_path",
			"native_provider_environment_path",
			"credential_source",
			"identity_volume_path",
			...(input.schema === COMPANY_BOOTSTRAP_SCHEMA ? ["company_runtime"] : []),
		],
		"LXD runner bootstrap configuration",
	);
	if (input.schema !== BOOTSTRAP_SCHEMA && input.schema !== COMPANY_BOOTSTRAP_SCHEMA) {
		throw new Error("LXD runner bootstrap schema is unsupported");
	}
	if (
		input.runner_config_path !== PRODUCTION_PATHS.runnerConfig ||
		input.native_provider_environment_path !== PRODUCTION_PATHS.nativeProviderEnvironment ||
		input.credential_source !== PRODUCTION_PATHS.credentialSource ||
		input.identity_volume_path !== PRODUCTION_PATHS.identityVolume
	) {
		throw new Error("LXD runner bootstrap paths are outside the guest-image contract");
	}
	let companyRuntime: LxdRunnerBootstrapConfig["companyRuntime"];
	if (input.schema === COMPANY_BOOTSTRAP_SCHEMA) {
		const company = record(input.company_runtime, "Governed native bootstrap");
		exactKeys(
			company,
			[
				"mode",
				"run_id",
				"profile_id",
				"runner_id",
				"codex_path",
				"binary_sha256",
				"object_gateway_url",
				"secret_broker_url",
				"secret_broker_ca_sha256",
				"recovery_volume_path",
				"office",
				"coding_command",
			],
			"Governed native bootstrap",
		);
		if (company.mode !== "company-path-v1" || company.recovery_volume_path !== PRODUCTION_PATHS.runnerHomeDirectory) {
			throw new Error("Governed native bootstrap mode or recovery path is invalid");
		}
		const codexPath = text(company.codex_path, "Pinned native executable", /^\/[A-Za-z0-9._/-]+$/);
		if (resolve(codexPath) !== codexPath) throw new Error("Pinned native executable path is not canonical");
		const gateway = text(
			company.object_gateway_url,
			"Native object gateway",
			/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?\/?$/,
		);
		const gatewayUrl = new URL(gateway);
		if (![gatewayUrl.origin, `${gatewayUrl.origin}/`].includes(gateway))
			throw new Error("Native object gateway is invalid");
		const encodedSecretBroker = text(
			company.secret_broker_url,
			"Cloud secret broker",
			/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?\/?$/,
		);
		const secretBroker = new URL(encodedSecretBroker);
		if (![secretBroker.origin, `${secretBroker.origin}/`].includes(encodedSecretBroker)) {
			throw new Error("Cloud secret broker is invalid");
		}
		let office: NonNullable<LxdRunnerBootstrapConfig["companyRuntime"]>["office"];
		if (company.office !== undefined) {
			const route = record(company.office, "Governed office endpoint");
			exactKeys(route, ["environment_id", "url", "token_sha256"], "Governed office endpoint");
			office = {
				environmentId: text(route.environment_id, "Office environment", UUID_PATTERN),
				url: parseCompanyComputerNativeUrl(text(route.url, "Office URL", /^https:\/\//)).url,
				tokenSha256: text(route.token_sha256, "Office token digest", SHA256_PATTERN),
			};
		}
		let codingCommand: NonNullable<LxdRunnerBootstrapConfig["companyRuntime"]>["codingCommand"];
		if (company.coding_command !== undefined) {
			const gateway = record(company.coding_command, "Governed coding command gateway");
			exactKeys(gateway, ["url", "token_sha256"], "Governed coding command gateway");
			codingCommand = {
				url: codingCommandOrigin(text(gateway.url, "Coding command URL", /^https:\/\//)),
				tokenSha256: text(gateway.token_sha256, "Coding command token digest", SHA256_PATTERN),
			};
		}
		companyRuntime = {
			mode: "company-path-v1",
			runId: text(company.run_id, "Native run id", UUID_PATTERN),
			profileId: text(company.profile_id, "Native company id", UUID_PATTERN),
			runnerId: text(company.runner_id, "Native runner id", UUID_PATTERN),
			codexPath,
			binarySha256: text(company.binary_sha256, "Native binary digest", SHA256_PATTERN),
			objectGatewayUrl: gateway,
			secretBrokerUrl: secretBroker.origin,
			secretBrokerCaSha256: text(company.secret_broker_ca_sha256, "Cloud secret broker CA digest", SHA256_PATTERN),
			...(office ? { office } : {}),
			...(codingCommand ? { codingCommand } : {}),
		};
	}
	return {
		schema: input.schema,
		computeIdentityId: text(input.compute_identity_id, "Compute Identity id", UUID_PATTERN),
		computeTemplateKey: text(input.compute_template_key, "Compute template key", TEMPLATE_PATTERN),
		computeTemplateVersion: text(input.compute_template_version, "Compute template version", TEMPLATE_PATTERN),
		computePolicySha256: text(input.compute_policy_sha256, "Compute policy digest", SHA256_PATTERN),
		runnerConfigPath: PRODUCTION_PATHS.runnerConfig,
		nativeProviderEnvironmentPath: PRODUCTION_PATHS.nativeProviderEnvironment,
		credentialSource: PRODUCTION_PATHS.credentialSource,
		identityVolumePath: PRODUCTION_PATHS.identityVolume,
		...(companyRuntime ? { companyRuntime } : {}),
	};
}

export function parseLxdNativeLoginBootstrapConfig(value: unknown): LxdNativeLoginBootstrapConfig {
	const input = record(value, "LXD native login bootstrap configuration");
	exactKeys(
		input,
		[
			"schema",
			"compute_identity_id",
			"supabase_url",
			"native_bridge_url",
			"trusted_source",
			"identity_recovery_ca_sha256",
			"native_provider_environment_path",
			"credential_source",
			"identity_volume_path",
		],
		"LXD native login bootstrap configuration",
	);
	if (input.schema !== LOGIN_BOOTSTRAP_SCHEMA) {
		throw new Error("LXD native login bootstrap schema is unsupported");
	}
	if (
		input.native_provider_environment_path !== PRODUCTION_LOGIN_PATHS.nativeProviderEnvironment ||
		input.credential_source !== PRODUCTION_LOGIN_PATHS.credentialSource ||
		input.identity_volume_path !== PRODUCTION_LOGIN_PATHS.identityVolume
	) {
		throw new Error("LXD native login bootstrap paths are outside the guest-image contract");
	}
	const supabaseUrl = text(input.supabase_url, "Supabase URL", /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?\/?$/);
	const nativeBridgeUrl = text(
		input.native_bridge_url,
		"Native bridge URL",
		/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/,
	);
	const nativePort = Number(new URL(nativeBridgeUrl).port);
	if (!Number.isSafeInteger(nativePort) || nativePort < 1024 || nativePort > 65_535) {
		throw new Error("Native bridge URL is invalid");
	}
	const trustedSource = text(input.trusted_source, "Native login trusted source", /^[0-9.]+$/);
	if (isIP(trustedSource) !== 4) throw new Error("Native login trusted source is invalid");
	return {
		schema: LOGIN_BOOTSTRAP_SCHEMA,
		computeIdentityId: text(input.compute_identity_id, "Compute Identity id", UUID_PATTERN),
		supabaseUrl: new URL(supabaseUrl).origin,
		nativeBridgeUrl,
		trustedSource,
		identityRecoveryCaSha256: text(input.identity_recovery_ca_sha256, "Identity recovery CA digest", SHA256_PATTERN),
		nativeProviderEnvironmentPath: PRODUCTION_LOGIN_PATHS.nativeProviderEnvironment,
		credentialSource: PRODUCTION_LOGIN_PATHS.credentialSource,
		identityVolumePath: PRODUCTION_LOGIN_PATHS.identityVolume,
	};
}

function secureOpenFlags(): number {
	return process.platform === "linux" ? constants.O_RDONLY | constants.O_NOFOLLOW : constants.O_RDONLY;
}

async function readOwnedFile(
	path: string,
	maximum: number,
	label: string,
	expectedUid: number,
	privateFile: boolean,
): Promise<string> {
	const handle = await open(path, secureOpenFlags());
	try {
		const metadata = await handle.stat();
		if (
			!metadata.isFile() ||
			metadata.uid !== expectedUid ||
			metadata.size > maximum ||
			(privateFile && (metadata.mode & 0o077) !== 0) ||
			(!privateFile && (metadata.mode & 0o022) !== 0)
		) {
			throw new Error(`${label} has unsafe ownership, permissions, or size`);
		}
		const encoded = await handle.readFile({ encoding: "utf-8" });
		if (Buffer.byteLength(encoded) > maximum) throw new Error(`${label} exceeds its byte limit`);
		return encoded;
	} finally {
		await handle.close();
	}
}

function parseJson(encoded: string, label: string): unknown {
	try {
		return JSON.parse(encoded) as unknown;
	} catch (error) {
		throw new Error(`${label} contains invalid JSON`, { cause: error });
	}
}

function mountPoint(value: string): string {
	return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function verifyMountedIdentityVolume(mountInfo: string, expectedPath: string): void {
	for (const line of mountInfo.split("\n")) {
		if (!line) continue;
		const fields = line.split(" ");
		if (fields.length > 5 && mountPoint(fields[4] as string) === expectedPath) return;
	}
	throw new Error("Compute Identity volume is not a distinct mounted filesystem");
}

function parseIdentityMarker(value: unknown, computeIdentityId: string): void {
	const input = record(value, "Compute Identity volume marker");
	exactKeys(input, ["schema", "compute_identity_id"], "Compute Identity volume marker");
	if (input.schema !== IDENTITY_SCHEMA || input.compute_identity_id !== computeIdentityId) {
		throw new Error("Compute Identity volume marker does not match bootstrap authority");
	}
}

async function ensureIdentityMarker(
	path: string,
	computeIdentityId: string,
	expectedUid: number,
	expectedGid: number,
	canInitialize: boolean,
): Promise<void> {
	try {
		const encoded = await readOwnedFile(
			path,
			MAX_BOOTSTRAP_BYTES,
			"Compute Identity volume marker",
			expectedUid,
			true,
		);
		parseIdentityMarker(parseJson(encoded, "Compute Identity volume marker"), computeIdentityId);
		return;
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
	}
	if (!canInitialize) throw new Error("Established Compute Identity marker is missing; recovery is required");
	const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
	await writeFile(
		temporary,
		`${JSON.stringify({ schema: IDENTITY_SCHEMA, compute_identity_id: computeIdentityId }, null, 2)}\n`,
		{ encoding: "utf-8", flag: "wx", mode: 0o600 },
	);
	await chown(temporary, expectedUid, expectedGid);
	await rename(temporary, path);
	await chmod(path, 0o600);
}

async function ensureIdentityMasterKey(
	path: string,
	expectedUid: number,
	expectedGid: number,
	canInitialize: boolean,
): Promise<void> {
	try {
		const key = (
			await readOwnedFile(path, MAX_CREDENTIAL_BYTES, "Native provider master key", expectedUid, true)
		).trim();
		if (!TOKEN_PATTERN.test(key)) throw new Error("Native provider master key is invalid");
		return;
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
	}
	if (!canInitialize) throw new Error("Established native identity master key is missing; recovery is required");
	const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
	const handle = await open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(`${randomBytes(32).toString("base64url")}\n`);
		await handle.chown(expectedUid, expectedGid);
		await handle.sync();
		await handle.close();
		try {
			await link(temporary, path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const directory = await open(dirname(path), constants.O_RDONLY);
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	} finally {
		await handle.close();
		await unlink(temporary);
	}
}

async function verifyIdentityRecovery(
	paths: LxdNativeLoginBootstrapPaths | LxdRunnerBootstrapPaths,
	computeIdentityId: string,
	baseUrl: string,
	expectedUid: number,
	expectedGid: number,
	login: boolean,
	stateReader?: (computeIdentityId: string) => Promise<IdentityRecoveryRuntimeState>,
): Promise<void> {
	const state = stateReader
		? await stateReader(computeIdentityId)
		: await fetchIdentityRecoveryRuntimeState(
				baseUrl,
				(
					await readOwnedFile(
						join(paths.credentialSource, "qorpera-supabase-service-key"),
						MAX_SERVICE_CREDENTIAL_BYTES,
						"Native authority credential",
						expectedUid,
						true,
					)
				).trim(),
				computeIdentityId,
			);
	if (state.computeIdentityId !== computeIdentityId || state.blocked)
		throw new Error("Compute Identity is fenced by cloud recovery authority");
	if (login && !state.recoveryConfiguration)
		throw new Error("Native login requires a configured cloud recovery authority");
	const canInitialize = login && state.canInitialize;
	await ensureIdentityMasterKey(paths.identityMasterKey, expectedUid, expectedGid, canInitialize);
	await ensureIdentityMarker(paths.identityMarker, computeIdentityId, expectedUid, expectedGid, canInitialize);
	const key = recoveryBase64(
		(
			await readOwnedFile(
				paths.identityMasterKey,
				MAX_CREDENTIAL_BYTES,
				"Native provider master key",
				expectedUid,
				true,
			)
		).trim(),
		32,
	);
	let keySha256: string;
	try {
		keySha256 = recoveryDigest(key);
	} finally {
		key.fill(0);
	}
	if (state.keySha256 !== null && state.keySha256 !== keySha256)
		throw new Error("Local identity key differs from cloud recovery history");
	if (state.epoch > 0) {
		assertIdentityRecoveryMarker(
			parseJson(
				await readOwnedFile(
					join(paths.identityVolume, identityRecoveryEpochFilename(state.epoch)),
					MAX_BOOTSTRAP_BYTES,
					"Native identity recovery marker",
					expectedUid,
					true,
				),
				"Native identity recovery marker",
			),
			state,
		);
	}
	const credential = join(dirname(paths.nativeProviderEnvironment), "native-identity-epoch.json");
	const temporary = `${credential}.${randomUUID()}.tmp`;
	const handle = await open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(
			JSON.stringify({ computeIdentityId, companyId: state.companyId, epoch: state.epoch, keySha256 }),
		);
		await handle.chown(expectedUid, expectedGid);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(temporary, credential);
	const directory = await open(dirname(credential), constants.O_RDONLY);
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

function nativeProviderEnvironment(
	encoded: string,
	baseUrl: string,
	nativeBridgeUrl: string,
	computeIdentityId: string,
	trustedSource?: string,
	companyRuntime?: LxdRunnerBootstrapConfig["companyRuntime"],
): void {
	const environment = new Map<string, string>();
	for (const line of encoded.split(/\r?\n/)) {
		if (!line) continue;
		const separator = line.indexOf("=");
		if (separator < 1) throw new Error("Native provider environment is invalid");
		const key = line.slice(0, separator);
		const value = line.slice(separator + 1);
		if (environment.has(key) || /[\0\r\n]/.test(value)) {
			throw new Error("Native provider environment is invalid");
		}
		environment.set(key, value);
	}
	const expectedKeys = [
		"QORPERA_CLAUDE_PATH",
		"QORPERA_CODEX_PATH",
		"QORPERA_NATIVE_PROVIDER_COMPUTE_IDENTITY_ID",
		"QORPERA_NATIVE_PROVIDER_EXECUTION_BOUNDARY",
		"QORPERA_NATIVE_PROVIDER_HOST",
		"QORPERA_NATIVE_PROVIDER_PORT",
		"QORPERA_NATIVE_PROVIDER_TEMPORARY_ROOT",
		"QORPERA_SUPABASE_URL",
		...(trustedSource ? ["QORPERA_NATIVE_PROVIDER_TRUSTED_SOURCE"] : []),
		...(companyRuntime
			? [
					"QORPERA_NATIVE_RUNTIME",
					"QORPERA_NATIVE_CODEX_FENCE_PATH",
					"QORPERA_NATIVE_CODEX_FENCE_SHA256",
					"QORPERA_NATIVE_OBJECT_GATEWAY_URL",
					"QORPERA_CLOUD_SECRET_BROKER_URL",
					...(companyRuntime.office ? ["QORPERA_COMPANY_COMPUTER_URL"] : []),
					...(companyRuntime.codingCommand ? ["QORPERA_CODING_COMMAND_URL"] : []),
				]
			: []),
	];
	if (JSON.stringify([...environment.keys()].sort()) !== JSON.stringify(expectedKeys.sort())) {
		throw new Error("Native provider environment contains unexpected settings");
	}
	const bridge = new URL(nativeBridgeUrl);
	if (
		environment.get("QORPERA_SUPABASE_URL") !== baseUrl ||
		environment.get("QORPERA_NATIVE_PROVIDER_COMPUTE_IDENTITY_ID") !== computeIdentityId ||
		environment.get("QORPERA_NATIVE_PROVIDER_EXECUTION_BOUNDARY") !== "virtual_machine" ||
		environment.get("QORPERA_NATIVE_PROVIDER_HOST") !== (trustedSource ? "0.0.0.0" : "127.0.0.1") ||
		(trustedSource !== undefined && environment.get("QORPERA_NATIVE_PROVIDER_TRUSTED_SOURCE") !== trustedSource) ||
		environment.get("QORPERA_NATIVE_PROVIDER_PORT") !== bridge.port ||
		environment.get("QORPERA_NATIVE_PROVIDER_TEMPORARY_ROOT") !== PRODUCTION_PATHS.nativeProviderTemporaryDirectory ||
		bridge.protocol !== "http:" ||
		bridge.hostname !== "127.0.0.1" ||
		bridge.pathname !== "/"
	) {
		throw new Error("Native provider environment does not match the runner boundary");
	}
	for (const name of ["QORPERA_CODEX_PATH", "QORPERA_CLAUDE_PATH"] as const) {
		const path = environment.get(name);
		if (!path?.startsWith("/") || !/^[A-Za-z0-9._/-]+$/.test(path)) {
			throw new Error("Native provider executable path is invalid");
		}
	}
	if (
		companyRuntime &&
		(environment.get("QORPERA_NATIVE_RUNTIME") !== "company-path-v1" ||
			environment.get("QORPERA_NATIVE_CODEX_FENCE_PATH") !== companyRuntime.codexPath ||
			environment.get("QORPERA_NATIVE_CODEX_FENCE_SHA256") !== companyRuntime.binarySha256 ||
			environment.get("QORPERA_NATIVE_OBJECT_GATEWAY_URL") !== companyRuntime.objectGatewayUrl ||
			environment.get("QORPERA_CLOUD_SECRET_BROKER_URL") !== companyRuntime.secretBrokerUrl ||
			environment.get("QORPERA_COMPANY_COMPUTER_URL") !== companyRuntime.office?.url ||
			environment.get("QORPERA_CODING_COMMAND_URL") !== companyRuntime.codingCommand?.url)
	) {
		throw new Error("Governed native environment does not match immutable bootstrap authority");
	}
}

async function verifyPinnedCaCertificate(
	path: string,
	expectedUid: number,
	expectedSha256: string,
	label: string,
): Promise<void> {
	const certificateEncoded = await readOwnedFile(path, 16 * 1024, `${label} certificate`, expectedUid, true);
	if (createHash("sha256").update(certificateEncoded).digest("hex") !== expectedSha256) {
		throw new Error(`${label} certificate does not match immutable bootstrap authority`);
	}
	let certificate: X509Certificate;
	try {
		certificate = new X509Certificate(certificateEncoded);
	} catch {
		throw new Error(`${label} certificate is invalid`);
	}
	if (!certificate.ca) throw new Error(`${label} certificate is not a certificate authority`);
}

async function verifyCredentialSource(
	path: string,
	expectedUid: number,
	boundary: "runner" | "native-login" | "company-runner",
	companyRuntime?: LxdRunnerBootstrapConfig["companyRuntime"],
	identityRecoveryCaSha256?: string,
): Promise<void> {
	const metadata = await lstat(path);
	if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== expectedUid) {
		throw new Error("LXD runner credential source is unsafe");
	}
	await chmod(path, 0o700);
	const entries = (await readdir(path)).sort();
	const expected =
		boundary !== "native-login"
			? [
					...(boundary === "company-runner" && companyRuntime
						? ["qorpera-cloud-secret-ca", "qorpera-cloud-secret-runtime"]
						: []),
					...(boundary === "company-runner" ? ["qorpera-coding-command"] : []),
					"qorpera-native-bridge",
					...(boundary === "company-runner" ? ["qorpera-native-object-token"] : []),
					...(boundary === "company-runner" ? ["qorpera-office-native"] : []),
					"qorpera-runner-activation",
					"qorpera-runner-assignment",
					"qorpera-supabase-service-key",
				]
			: ["qorpera-identity-recovery-ca", "qorpera-native-bridge", "qorpera-supabase-service-key"];
	if (JSON.stringify(entries) !== JSON.stringify(expected)) {
		throw new Error("LXD runner credential source contains unexpected entries");
	}
	const tokens = new Set<string>();
	for (const name of expected.filter(
		(entry) =>
			entry !== "qorpera-supabase-service-key" &&
			entry !== "qorpera-cloud-secret-ca" &&
			entry !== "qorpera-office-native" &&
			entry !== "qorpera-coding-command" &&
			entry !== "qorpera-identity-recovery-ca",
	)) {
		const token = (
			await readOwnedFile(
				`${path}/${name}`,
				MAX_CREDENTIAL_BYTES,
				`LXD runner credential ${name}`,
				expectedUid,
				true,
			)
		).trim();
		if (!TOKEN_PATTERN.test(token)) throw new Error(`LXD runner credential ${name} is invalid`);
		if (boundary === "company-runner" && tokens.has(token))
			throw new Error("Governed credentials must be independent");
		tokens.add(token);
	}
	if (companyRuntime) {
		await verifyPinnedCaCertificate(
			`${path}/qorpera-cloud-secret-ca`,
			expectedUid,
			companyRuntime.secretBrokerCaSha256,
			"Cloud secret broker CA",
		);
		const encoded = await readOwnedFile(
			`${path}/qorpera-office-native`,
			MAX_CREDENTIAL_BYTES,
			"Native office credential",
			expectedUid,
			true,
		);
		if (companyRuntime.office) {
			const token = encoded.trim();
			if (
				!TOKEN_PATTERN.test(token) ||
				tokens.has(token) ||
				createHash("sha256").update(token).digest("hex") !== companyRuntime.office.tokenSha256
			)
				throw new Error("Native office credential differs from immutable bootstrap authority");
			tokens.add(token);
		} else if (encoded !== "") throw new Error("Unconfigured native office credential must be empty");
		const codingEncoded = await readOwnedFile(
			`${path}/qorpera-coding-command`,
			MAX_CREDENTIAL_BYTES,
			"Coding command credential",
			expectedUid,
			true,
		);
		if (companyRuntime.codingCommand) {
			const token = codingEncoded.trim();
			if (
				!TOKEN_PATTERN.test(token) ||
				tokens.has(token) ||
				createHash("sha256").update(token).digest("hex") !== companyRuntime.codingCommand.tokenSha256
			)
				throw new Error("Coding command credential differs from immutable bootstrap authority");
			tokens.add(token);
		} else if (codingEncoded !== "") throw new Error("Unconfigured coding command credential must be empty");
	}
	if (boundary === "native-login") {
		if (!identityRecoveryCaSha256) throw new Error("Identity recovery CA authority is missing");
		await verifyPinnedCaCertificate(
			`${path}/qorpera-identity-recovery-ca`,
			expectedUid,
			identityRecoveryCaSha256,
			"Identity recovery CA",
		);
	}
	const serviceKey = (
		await readOwnedFile(
			`${path}/qorpera-supabase-service-key`,
			MAX_SERVICE_CREDENTIAL_BYTES,
			"LXD native provider service credential",
			expectedUid,
			true,
		)
	).trim();
	if (!serviceKey || /[\0\r\n]/.test(serviceKey)) {
		throw new Error("LXD native provider service credential is invalid");
	}
	if (boundary === "company-runner" && tokens.has(serviceKey))
		throw new Error("Governed credentials must be independent");
}

async function verifyCompanyGuest(
	bootstrap: LxdRunnerBootstrapConfig,
	paths: LxdRunnerBootstrapPaths,
	mountInfo: string,
	expectedUid: number,
	expectedGid: number,
): Promise<void> {
	const company = bootstrap.companyRuntime;
	if (!company) return;
	const mounts = mountInfo
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [before, after] = line.split(" - ");
			const fields = before?.split(" ");
			const filesystem = after?.split(" ")[0];
			if (!fields || fields.length < 6 || !filesystem) throw new Error("Guest mount table is invalid");
			return { path: mountPoint(fields[4] as string), device: fields[2], filesystem };
		});
	const roots = mounts.filter((mount) => mount.path === "/");
	const identities = mounts.filter((mount) => mount.path === paths.identityVolume);
	const recoveries = mounts.filter((mount) => mount.path === paths.runnerHomeDirectory);
	if (
		roots.length !== 1 ||
		identities.length !== 1 ||
		recoveries.length !== 1 ||
		identities[0]?.filesystem !== "virtiofs" ||
		recoveries[0]?.filesystem !== "virtiofs" ||
		new Set([roots[0]?.device, identities[0]?.device, recoveries[0]?.device]).size !== 3
	) {
		throw new Error("Governed native recovery and identity require distinct persistent volume mounts");
	}
	for (const mount of mounts) {
		const allowedVolume = mount.path === paths.identityVolume || mount.path === paths.runnerHomeDirectory;
		if (
			(!allowedVolume && /^(virtiofs|9p|nfs4?|cifs|smb3|fuse(?:\..*)?)$/.test(mount.filesystem)) ||
			mount.path === "/qorpera/company-live" ||
			mount.path.startsWith("/qorpera/company-live/") ||
			mount.path.startsWith(`${paths.identityVolume}/`) ||
			mount.path.startsWith(`${paths.runnerHomeDirectory}/`)
		) {
			throw new Error("Governed native guest contains an unexpected shared or nested mount");
		}
	}
	const binary = await open(company.codexPath, secureOpenFlags());
	try {
		const metadata = await binary.stat();
		if (
			!metadata.isFile() ||
			metadata.uid !== expectedUid ||
			(metadata.mode & 0o022) !== 0 ||
			(metadata.mode & 0o111) === 0 ||
			metadata.size < 1 ||
			metadata.size > 1024 ** 3
		) {
			throw new Error("Pinned governed native binary has unsafe ownership, permissions, or size");
		}
		const digest = createHash("sha256");
		const buffer = Buffer.alloc(512 * 1024);
		let length = 0;
		for (;;) {
			const { bytesRead } = await binary.read(buffer);
			if (bytesRead === 0) break;
			length += bytesRead;
			if (length > metadata.size) throw new Error("Pinned governed native binary changed while verifying");
			digest.update(buffer.subarray(0, bytesRead));
		}
		if (length !== metadata.size || digest.digest("hex") !== company.binarySha256) {
			throw new Error("Pinned governed native binary checksum mismatch");
		}
	} finally {
		await binary.close();
	}
	const marker = join(paths.runnerHomeDirectory, ".qorpera-native-company-recovery.json");
	const expected = {
		schema: "qorpera.native-company-recovery-volume/v1",
		run_id: company.runId,
		profile_id: company.profileId,
		runner_id: company.runnerId,
		compute_identity_id: bootstrap.computeIdentityId,
	};
	try {
		const saved = record(
			parseJson(
				await readOwnedFile(marker, MAX_BOOTSTRAP_BYTES, "Native recovery marker", expectedUid, true),
				"Native recovery marker",
			),
			"Native recovery marker",
		);
		exactKeys(saved, Object.keys(expected), "Native recovery marker");
		if (Object.entries(expected).some(([key, value]) => saved[key] !== value)) {
			throw new Error("Native recovery volume does not match immutable company and run authority");
		}
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
		if ((await readdir(paths.runnerHomeDirectory)).length !== 0) {
			throw new Error("Unmarked native recovery volume is not empty; operator reconciliation is required");
		}
		const temporary = `${marker}.${randomUUID()}.tmp`;
		const handle = await open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(expected)}\n`);
			await handle.chown(expectedUid, expectedGid);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, marker);
		const directory = await open(paths.runnerHomeDirectory, constants.O_RDONLY);
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	}
}

async function serviceIdentity(account: string): Promise<LxdRunnerBootstrapServiceIdentity> {
	const [{ stdout: uid }, { stdout: gid }] = await Promise.all([
		execFileAsync("/usr/bin/id", ["-u", account]),
		execFileAsync("/usr/bin/id", ["-g", account]),
	]);
	const parsed = { uid: Number(uid.trim()), gid: Number(gid.trim()) };
	if (!Number.isSafeInteger(parsed.uid) || parsed.uid < 1 || !Number.isSafeInteger(parsed.gid) || parsed.gid < 1) {
		throw new Error(`The ${account} service account is invalid`);
	}
	return parsed;
}

async function serviceGroups(account: string): Promise<readonly number[]> {
	const { stdout } = await execFileAsync("/usr/bin/id", ["-G", account]);
	const groups = stdout.trim().split(/\s+/).filter(Boolean).map(Number);
	if (groups.length < 1 || groups.some((gid) => !Number.isSafeInteger(gid) || gid < 1)) {
		throw new Error(`The ${account} service groups are invalid`);
	}
	return groups;
}

async function ensureOwnedDirectoryTree(
	root: string,
	target: string,
	identity: LxdRunnerBootstrapServiceIdentity,
): Promise<void> {
	const physicalRoot = resolve(root);
	const child = relative(physicalRoot, resolve(target));
	if (child === ".." || child.startsWith(`..${sep}`)) {
		throw new Error("Service state directory escapes its approved home");
	}
	let current = physicalRoot;
	for (const component of ["", ...child.split(sep).filter(Boolean)]) {
		if (component) current = join(current, component);
		try {
			await mkdir(current, { mode: 0o700 });
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
				throw error;
			}
		}
		const metadata = await lstat(current);
		if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
			throw new Error("Service state path contains an unsupported entry");
		}
		await chown(current, identity.uid, identity.gid);
		await chmod(current, 0o700);
	}
}

async function ensureOwnedDirectory(path: string, identity: LxdRunnerBootstrapServiceIdentity): Promise<void> {
	try {
		await mkdir(path, { mode: 0o700 });
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
	}
	const metadata = await lstat(path);
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
		throw new Error("Service state path contains an unsupported entry");
	}
	await chown(path, identity.uid, identity.gid);
	await chmod(path, 0o700);
}

async function installRunnerConfig(
	encoded: string,
	path: string,
	home: string,
	identity: LxdRunnerBootstrapServiceIdentity,
): Promise<void> {
	await ensureOwnedDirectoryTree(home, dirname(path), identity);
	const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
	await writeFile(temporary, encoded.endsWith("\n") ? encoded : `${encoded}\n`, {
		encoding: "utf-8",
		flag: "wx",
		mode: 0o600,
	});
	await chown(temporary, identity.uid, identity.gid);
	await rename(temporary, path);
	await chmod(path, 0o600);
}

async function startRunnerService(service: string): Promise<void> {
	await execFileAsync("/usr/bin/systemctl", ["start", service]);
}

export async function runLxdRunnerBootstrap(options: RunLxdRunnerBootstrapOptions = {}): Promise<void> {
	const paths = options.paths ?? PRODUCTION_PATHS;
	const expectedRootUid = options.expectedRootUid ?? 0;
	const expectedRootGid = options.expectedRootGid ?? 0;
	if ((process.getuid?.() ?? -1) !== expectedRootUid) throw new Error("LXD runner bootstrap must run as root");
	// Before any run authority is read: an image that can upgrade itself
	// restarts the runner mid-turn and then refuses its own poweroff.
	await assertGuestImageSelfUpdateMasked(paths.systemUnitDirectory);

	const bootstrapEncoded = await readOwnedFile(
		paths.bootstrapConfig,
		MAX_BOOTSTRAP_BYTES,
		"LXD runner bootstrap configuration",
		expectedRootUid,
		true,
	);
	const bootstrap = parseLxdRunnerBootstrapConfig(parseJson(bootstrapEncoded, "LXD runner bootstrap configuration"));
	if (
		bootstrap.runnerConfigPath !== PRODUCTION_PATHS.runnerConfig ||
		bootstrap.nativeProviderEnvironmentPath !== PRODUCTION_PATHS.nativeProviderEnvironment ||
		bootstrap.credentialSource !== PRODUCTION_PATHS.credentialSource ||
		bootstrap.identityVolumePath !== PRODUCTION_PATHS.identityVolume
	) {
		throw new Error("LXD runner bootstrap configuration is inconsistent");
	}

	const runnerConfigEncoded = await readOwnedFile(
		paths.runnerConfig,
		MAX_BOOTSTRAP_BYTES,
		"LXD runner configuration",
		expectedRootUid,
		true,
	);
	const runnerConfig = parseEphemeralCloudRunnerServiceConfig(
		parseJson(runnerConfigEncoded, "LXD runner configuration"),
	);
	if (
		runnerConfig.assignmentHost !== "0.0.0.0" ||
		!runnerConfig.assignmentTrustedSource ||
		runnerConfig.maxAssignments !== 1 ||
		runnerConfig.temporaryRoot !== paths.runnerTemporaryDirectory
	) {
		throw new Error("LXD runner configuration does not enforce the single-lane private assignment boundary");
	}
	if (
		!runnerConfig.nativeBridgeUrl ||
		runnerConfig.nativeBridgeBoundary !== "virtual_machine" ||
		(!bootstrap.companyRuntime && runnerConfig.nativeBridgeSharedGid === undefined)
	) {
		throw new Error("LXD runner configuration does not enforce the native VM bridge boundary");
	}
	if (
		bootstrap.companyRuntime &&
		(runnerConfig.nativeBridgeSharedGid !== undefined ||
			runnerConfig.runnerId !== bootstrap.companyRuntime.runnerId ||
			runnerConfig.authorityStatePath !== join(paths.runnerStateDirectory, "authority.json") ||
			Object.keys(runnerConfig.environment).length !== 0)
	) {
		throw new Error("Governed runner must use private retained state without a shared workspace or environment");
	}
	const nativeProviderEnvironmentEncoded = await readOwnedFile(
		paths.nativeProviderEnvironment,
		MAX_BOOTSTRAP_BYTES,
		"Native provider environment",
		expectedRootUid,
		true,
	);
	nativeProviderEnvironment(
		nativeProviderEnvironmentEncoded,
		runnerConfig.baseUrl,
		runnerConfig.nativeBridgeUrl,
		bootstrap.computeIdentityId,
		undefined,
		bootstrap.companyRuntime,
	);

	await verifyCredentialSource(
		paths.credentialSource,
		expectedRootUid,
		bootstrap.companyRuntime ? "company-runner" : "runner",
		bootstrap.companyRuntime,
	);
	const identityMetadata = await lstat(paths.identityVolume);
	if (
		!identityMetadata.isDirectory() ||
		identityMetadata.isSymbolicLink() ||
		identityMetadata.uid !== expectedRootUid
	) {
		throw new Error("Compute Identity volume mount is unsafe");
	}
	const mountInfo = await readFile(paths.mountInfo, "utf-8");
	verifyMountedIdentityVolume(mountInfo, paths.identityVolume);
	await verifyCompanyGuest(bootstrap, paths, mountInfo, expectedRootUid, expectedRootGid);
	await chmod(paths.identityVolume, 0o700);
	await verifyIdentityRecovery(
		paths,
		bootstrap.computeIdentityId,
		runnerConfig.baseUrl,
		expectedRootUid,
		expectedRootGid,
		false,
		options.identityRuntimeState,
	);

	const runnerIdentity =
		options.serviceIdentity ??
		(await serviceIdentity(bootstrap.companyRuntime ? "qorpera-company-runner" : "qorpera-runner"));
	const nativeIdentity =
		options.nativeServiceIdentity ??
		(await serviceIdentity(bootstrap.companyRuntime ? "qorpera-native-company" : "qorpera-native-provider"));
	if (!bootstrap.companyRuntime) {
		const runnerGroups = options.runnerSupplementaryGids ?? (await serviceGroups("qorpera-runner"));
		if (
			runnerConfig.nativeBridgeSharedGid === undefined ||
			nativeIdentity.gid !== runnerConfig.nativeBridgeSharedGid ||
			!runnerGroups.includes(runnerConfig.nativeBridgeSharedGid)
		) {
			throw new Error("Native execution group does not match the signed guest-image accounts");
		}
	}
	const runnerHome = paths.runnerHomeDirectory;
	const nativeHome = dirname(paths.nativeProviderTemporaryDirectory);
	await ensureOwnedDirectoryTree(runnerHome, paths.runnerStateDirectory, runnerIdentity);
	await ensureOwnedDirectory(paths.runnerTemporaryDirectory, runnerIdentity);
	await ensureOwnedDirectoryTree(nativeHome, paths.nativeProviderTemporaryDirectory, nativeIdentity);
	await installRunnerConfig(runnerConfigEncoded, paths.runnerConfigDestination, runnerHome, runnerIdentity);
	const start = options.startService ?? startRunnerService;
	await start(bootstrap.companyRuntime ? "qorpera-native-company-host.service" : NATIVE_PROVIDER_SERVICE);
	await start(bootstrap.companyRuntime ? "qorpera-company-runner.service" : RUNNER_SERVICE);
}

export async function runLxdNativeLoginBootstrap(options: RunLxdNativeLoginBootstrapOptions = {}): Promise<void> {
	const paths = options.paths ?? PRODUCTION_LOGIN_PATHS;
	const expectedRootUid = options.expectedRootUid ?? 0;
	const expectedRootGid = options.expectedRootGid ?? 0;
	if ((process.getuid?.() ?? -1) !== expectedRootUid) {
		throw new Error("LXD native login bootstrap must run as root");
	}
	await assertGuestImageSelfUpdateMasked(paths.systemUnitDirectory);

	const bootstrapEncoded = await readOwnedFile(
		paths.bootstrapConfig,
		MAX_BOOTSTRAP_BYTES,
		"LXD native login bootstrap configuration",
		expectedRootUid,
		true,
	);
	const bootstrap = parseLxdNativeLoginBootstrapConfig(
		parseJson(bootstrapEncoded, "LXD native login bootstrap configuration"),
	);
	if (
		bootstrap.nativeProviderEnvironmentPath !== PRODUCTION_LOGIN_PATHS.nativeProviderEnvironment ||
		bootstrap.credentialSource !== PRODUCTION_LOGIN_PATHS.credentialSource ||
		bootstrap.identityVolumePath !== PRODUCTION_LOGIN_PATHS.identityVolume
	) {
		throw new Error("LXD native login bootstrap configuration is inconsistent");
	}

	const nativeProviderEnvironmentEncoded = await readOwnedFile(
		paths.nativeProviderEnvironment,
		MAX_BOOTSTRAP_BYTES,
		"Native provider environment",
		expectedRootUid,
		true,
	);
	nativeProviderEnvironment(
		nativeProviderEnvironmentEncoded,
		bootstrap.supabaseUrl,
		bootstrap.nativeBridgeUrl,
		bootstrap.computeIdentityId,
		bootstrap.trustedSource,
	);
	await verifyCredentialSource(
		paths.credentialSource,
		expectedRootUid,
		"native-login",
		undefined,
		bootstrap.identityRecoveryCaSha256,
	);

	const identityMetadata = await lstat(paths.identityVolume);
	if (
		!identityMetadata.isDirectory() ||
		identityMetadata.isSymbolicLink() ||
		identityMetadata.uid !== expectedRootUid
	) {
		throw new Error("Compute Identity volume mount is unsafe");
	}
	verifyMountedIdentityVolume(await readFile(paths.mountInfo, "utf-8"), paths.identityVolume);
	await chmod(paths.identityVolume, 0o700);
	await verifyIdentityRecovery(
		paths,
		bootstrap.computeIdentityId,
		bootstrap.supabaseUrl,
		expectedRootUid,
		expectedRootGid,
		true,
		options.identityRuntimeState,
	);

	const nativeIdentity = options.nativeServiceIdentity ?? (await serviceIdentity("qorpera-native-provider"));
	const nativeHome = dirname(paths.nativeProviderTemporaryDirectory);
	await ensureOwnedDirectoryTree(nativeHome, paths.nativeProviderTemporaryDirectory, nativeIdentity);
	await (options.startService ?? startRunnerService)(NATIVE_LOGIN_PROVIDER_SERVICE);
}
