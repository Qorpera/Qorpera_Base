import { constants, realpathSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { CloudContentAddressedStore } from "@qorpera/cloud-client/node/cloud-object-store";
import { createClient } from "@supabase/supabase-js";
import {
	createHttpCompanyComputerSessionFactory,
	parseCompanyComputerNativeUrl,
} from "./cloud-company-computer-native-client.ts";
import { HttpCloudCompanyComputerRegistry } from "./cloud-company-computer-registry-http.ts";
import { HttpCloudCompanyPathControl } from "./cloud-company-path-control.ts";
import { CloudNativeCompanyPresence } from "./cloud-company-path-presence.ts";
import { recoveryBase64, recoveryDigest, recoveryRecord } from "./cloud-identity-recovery-crypto.ts";
import {
	backupNativeIdentityKey,
	fetchIdentityRecoveryRuntimeState,
	HttpIdentityRecoveryGuestTransport,
} from "./cloud-identity-recovery-guest.ts";
import { HttpNativeCompanyObjectTransport } from "./cloud-native-company-objects.ts";
import { CloudNativeCompanyRuntime } from "./cloud-native-company-runtime.ts";
import type { NativeIsolationConfiguration } from "./cloud-native-isolation.ts";
import { NativeProviderHost, OfficialCliNativeHarnessDriver } from "./cloud-native-provider-host.ts";
import {
	HttpNativeProviderHostService,
	SupabaseNativeCredentialCapsuleStore,
	SupabaseNativeProviderControlPlane,
} from "./cloud-native-provider-service.ts";
import { HttpCloudSecretBrokerClient } from "./cloud-secret-broker-http.ts";
import {
	systemdCredentialMetadataIsSafe as credentialMetadataIsSafe,
	type SystemdCredentialMetadata,
} from "./systemd-credential.ts";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_CREDENTIAL_BYTES = 8192;

export function systemdCredentialMetadataIsSafe(
	metadata: SystemdCredentialMetadata,
	currentUid: number | undefined,
	platform: NodeJS.Platform = process.platform,
): boolean {
	return credentialMetadataIsSafe(metadata, currentUid, MAX_CREDENTIAL_BYTES, platform);
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
	const value = environment[name];
	if (!value || value !== value.trim() || /[\0\r\n]/.test(value)) throw new Error(`${name} is required`);
	return value;
}

function optionalPort(value: string | undefined): number {
	const port = Number(value ?? "8082");
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
		throw new Error("QORPERA_NATIVE_PROVIDER_PORT is invalid");
	}
	return port;
}

async function systemdCredential(environment: NodeJS.ProcessEnv, name: string): Promise<string | undefined> {
	const directory = environment.CREDENTIALS_DIRECTORY;
	if (!directory) return undefined;
	if (!isAbsolute(directory)) throw new Error("CREDENTIALS_DIRECTORY must be absolute");
	const path = join(directory, name);
	const flags = process.platform === "linux" ? constants.O_RDONLY | constants.O_NOFOLLOW : constants.O_RDONLY;
	const handle = await open(path, flags);
	try {
		const metadata = await handle.stat();
		const currentUid = process.getuid?.();
		if (
			!systemdCredentialMetadataIsSafe(
				{
					isFile: metadata.isFile(),
					size: metadata.size,
					uid: metadata.uid,
					gid: metadata.gid,
					mode: metadata.mode,
				},
				currentUid,
			)
		) {
			throw new Error(`Systemd credential ${name} is unsafe`);
		}
		const encoded = await handle.readFile({ encoding: "utf-8" });
		if (Buffer.byteLength(encoded) > MAX_CREDENTIAL_BYTES) {
			throw new Error(`Systemd credential ${name} exceeds its byte limit`);
		}
		return encoded.trim();
	} finally {
		await handle.close();
	}
}

async function credentialOrEnvironment(
	environment: NodeJS.ProcessEnv,
	credentialName: string,
	environmentName: string,
): Promise<string> {
	return (await systemdCredential(environment, credentialName)) ?? required(environment, environmentName);
}

/** Explicit deployment selection. Unknown or partially configured modes fail
 * closed; they cannot silently fall back to the legacy native tool surface. */
export function nativeCompanyRuntimeConfiguration(environment: NodeJS.ProcessEnv):
	| {
			command: readonly [string];
			binarySha256: string;
			objectGatewayUrl: string;
			isolation: NativeIsolationConfiguration;
	  }
	| undefined {
	if (environment.QORPERA_NATIVE_RUNTIME === undefined) return undefined;
	if (environment.QORPERA_NATIVE_RUNTIME !== "company-path-v1") throw new Error("Unsupported native cloud runtime");
	const command = required(environment, "QORPERA_NATIVE_CODEX_FENCE_PATH");
	const binarySha256 = required(environment, "QORPERA_NATIVE_CODEX_FENCE_SHA256");
	const objectGatewayUrl = required(environment, "QORPERA_NATIVE_OBJECT_GATEWAY_URL");
	const url = new URL(objectGatewayUrl);
	if (
		!isAbsolute(command) ||
		!/^[0-9a-f]{64}$/.test(binarySha256) ||
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/"
	)
		throw new Error("Invalid native cloud runtime configuration");
	return {
		command: [command],
		binarySha256,
		objectGatewayUrl: url.origin,
		isolation: { entryPoint: "/opt/qorpera-runner/qorpera-native-isolation-child.mjs" },
	};
}

/** Per-connection concurrency policy consented at native login (contract section 17); the cloud caps it by the global provider policy. */
function optionalConcurrency(value: string | undefined): number | undefined {
	if (value === undefined || value === "") return undefined;
	if (!/^[1-9][0-9]?$/.test(value) || Number(value) > 64)
		throw new Error("QORPERA_NATIVE_CONNECTION_CONCURRENCY is invalid");
	return Number(value);
}

/** The office endpoint is deployment configuration, never a model or desktop
 * input. A partial selection must not disappear into legacy/local execution. */
export function nativeCompanyComputerConfiguration(environment: NodeJS.ProcessEnv): { url: string } | undefined {
	if (environment.QORPERA_COMPANY_COMPUTER_TOKEN !== undefined)
		throw new Error("Company Computer transport requires a systemd credential");
	if (environment.QORPERA_COMPANY_COMPUTER_URL === undefined) return undefined;
	if (environment.QORPERA_NATIVE_RUNTIME !== "company-path-v1")
		throw new Error("Company Computer requires the cloud-native Company File runtime");
	return { url: parseCompanyComputerNativeUrl(required(environment, "QORPERA_COMPANY_COMPUTER_URL")).url };
}

export async function runNativeProviderHostServiceMain(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
	const runtimeConfiguration = nativeCompanyRuntimeConfiguration(environment);
	const computerConfiguration = nativeCompanyComputerConfiguration(environment);
	const baseUrl = required(environment, "QORPERA_SUPABASE_URL");
	const serviceKey = await credentialOrEnvironment(
		environment,
		"qorpera-supabase-service-key",
		"QORPERA_SUPABASE_SERVICE_KEY",
	);
	const credentialMasterKey = await systemdCredential(environment, "qorpera-native-provider-master-key");
	const masterKey =
		credentialMasterKey ??
		(await readFile(resolve(required(environment, "QORPERA_NATIVE_PROVIDER_MASTER_KEY_FILE")), "utf-8")).trim();
	const bridgeToken = await credentialOrEnvironment(
		environment,
		"qorpera-native-bridge",
		"QORPERA_NATIVE_PROVIDER_BRIDGE_TOKEN",
	);
	const executionBoundary = required(environment, "QORPERA_NATIVE_PROVIDER_EXECUTION_BOUNDARY");
	const computeIdentityId = required(environment, "QORPERA_NATIVE_PROVIDER_COMPUTE_IDENTITY_ID");
	if (executionBoundary !== "virtual_machine" && executionBoundary !== "microvm") {
		throw new Error("QORPERA_NATIVE_PROVIDER_EXECUTION_BOUNDARY must name the dedicated machine boundary");
	}
	if (!TOKEN_PATTERN.test(masterKey) || !TOKEN_PATTERN.test(bridgeToken)) {
		throw new Error("Native provider credentials must contain 32 base64url bytes");
	}
	const state = await fetchIdentityRecoveryRuntimeState(baseUrl, serviceKey, computeIdentityId);
	const epochCredential =
		(await systemdCredential(environment, "qorpera-native-identity-epoch")) ??
		(await readFile(resolve(required(environment, "QORPERA_NATIVE_IDENTITY_EPOCH_FILE")), "utf8"));
	const localEpoch = recoveryRecord(JSON.parse(epochCredential), [
		"computeIdentityId",
		"companyId",
		"epoch",
		"keySha256",
	]);
	const keyBytes = recoveryBase64(masterKey, 32);
	let keySha256: string;
	try {
		keySha256 = recoveryDigest(keyBytes);
	} finally {
		keyBytes.fill(0);
	}
	if (
		state.blocked ||
		localEpoch.computeIdentityId !== computeIdentityId ||
		localEpoch.companyId !== state.companyId ||
		localEpoch.epoch !== state.epoch ||
		localEpoch.keySha256 !== keySha256 ||
		(state.keySha256 !== null && state.keySha256 !== keySha256)
	)
		throw new Error("Native identity volume does not match current cloud recovery authority");
	const controlPlane = new SupabaseNativeProviderControlPlane(
		baseUrl,
		serviceKey,
		fetch,
		{ computeIdentityId, epoch: state.epoch },
		{ connectionConcurrency: optionalConcurrency(environment.QORPERA_NATIVE_CONNECTION_CONCURRENCY) },
	);
	let cloudRuntime: CloudNativeCompanyRuntime | undefined;
	if (runtimeConfiguration) {
		const objectToken = await credentialOrEnvironment(
			environment,
			"qorpera-native-object-token",
			"QORPERA_NATIVE_OBJECT_TOKEN",
		);
		if (!TOKEN_PATTERN.test(objectToken) || objectToken === masterKey || objectToken === bridgeToken)
			throw new Error("Native object staging requires a distinct private credential");
		if (environment.QORPERA_CLOUD_SECRET_BROKER_TOKEN !== undefined) {
			throw new Error("Cloud secret broker runtime authority must use a systemd credential");
		}
		const secretBrokerOrigin =
			environment.QORPERA_CLOUD_SECRET_BROKER_URL === undefined
				? undefined
				: required(environment, "QORPERA_CLOUD_SECRET_BROKER_URL");
		const secretBrokerToken = secretBrokerOrigin
			? await systemdCredential(environment, "qorpera-cloud-secret-runtime")
			: undefined;
		if (
			secretBrokerOrigin &&
			(!secretBrokerToken ||
				!TOKEN_PATTERN.test(secretBrokerToken) ||
				[masterKey, bridgeToken, objectToken].includes(secretBrokerToken))
		)
			throw new Error("Cloud secret broker requires a distinct private systemd credential");
		const computerToken = computerConfiguration
			? await systemdCredential(environment, "qorpera-office-native")
			: undefined;
		if (
			computerConfiguration &&
			(!computerToken ||
				!TOKEN_PATTERN.test(computerToken) ||
				[masterKey, bridgeToken, objectToken, serviceKey, secretBrokerToken].includes(computerToken))
		)
			throw new Error("Company Computer requires a distinct private systemd credential");
		const pathControl = new HttpCloudCompanyPathControl({ supabaseUrl: baseUrl, serviceRoleKey: serviceKey });
		cloudRuntime = new CloudNativeCompanyRuntime({
			controlPlane,
			pathControl,
			presence: (binding, identity, signal) =>
				identity.audienceKind === "company"
					? new CloudNativeCompanyPresence({
							binding,
							identity,
							signal,
							control: pathControl,
							client: createClient(baseUrl, serviceKey, {
								auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
							}),
						})
					: undefined,
			command: runtimeConfiguration.command,
			binarySha256: runtimeConfiguration.binarySha256,
			isolation: runtimeConfiguration.isolation,
			...(computerConfiguration && computerToken
				? {
						computerSession: createHttpCompanyComputerSessionFactory({
							url: computerConfiguration.url,
							token: computerToken,
							objectGateway: { baseUrl: runtimeConfiguration.objectGatewayUrl, token: objectToken },
							registry: new HttpCloudCompanyComputerRegistry({
								supabaseUrl: baseUrl,
								serviceRoleKey: serviceKey,
							}),
						}),
					}
				: {}),
			objectStore: (companyId, binding, signal) =>
				new CloudContentAddressedStore(
					new HttpNativeCompanyObjectTransport({
						baseUrl: runtimeConfiguration.objectGatewayUrl,
						token: objectToken,
						companyId,
						binding,
						signal,
					}),
				),
			...(secretBrokerOrigin && secretBrokerToken
				? {
						secretBroker: new HttpCloudSecretBrokerClient({
							origin: secretBrokerOrigin,
							runtimeToken: secretBrokerToken,
						}),
					}
				: {}),
		});
	} else if (environment.QORPERA_CLOUD_SECRET_BROKER_URL || environment.QORPERA_CLOUD_SECRET_BROKER_TOKEN) {
		throw new Error("Cloud secret broker requires the cloud-native Company File runtime");
	}
	const host = new NativeProviderHost({
		controlPlane,
		capsules: new SupabaseNativeCredentialCapsuleStore(baseUrl, serviceKey),
		harness: new OfficialCliNativeHarnessDriver(
			runtimeConfiguration?.command[0] ?? environment.QORPERA_CODEX_PATH ?? "codex",
			environment.QORPERA_CLAUDE_PATH ?? "claude",
			runtimeConfiguration?.isolation,
		),
		masterKey,
		computeIdentityId,
		backupIdentityKey: async (request) => {
			const current = await fetchIdentityRecoveryRuntimeState(baseUrl, serviceKey, computeIdentityId);
			if (current.epoch !== state.epoch || !current.recoveryConfiguration)
				throw new Error("Native login requires the current cloud recovery authority");
			await backupNativeIdentityKey({
				state: current,
				masterKey,
				loginId: request.loginId,
				loginCapability: request.capability,
				transport: new HttpIdentityRecoveryGuestTransport(current.recoveryConfiguration.serviceOrigin),
				signal: AbortSignal.timeout(60_000),
			});
		},
		...(cloudRuntime ? { cloudRuntime } : {}),
		...(environment.QORPERA_NATIVE_PROVIDER_TEMPORARY_ROOT
			? { temporaryRoot: environment.QORPERA_NATIVE_PROVIDER_TEMPORARY_ROOT }
			: {}),
	});
	const service = new HttpNativeProviderHostService(
		host,
		bridgeToken,
		environment.QORPERA_NATIVE_PROVIDER_HOST ?? "127.0.0.1",
		optionalPort(environment.QORPERA_NATIVE_PROVIDER_PORT),
		environment.QORPERA_NATIVE_PROVIDER_TRUSTED_SOURCE,
	);
	const shutdown = new AbortController();
	const stop = (): void => shutdown.abort();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		await service.start();
		while (!shutdown.signal.aborted) {
			await host.refreshAccountMetadata(shutdown.signal);
			await delay(60_000, undefined, { signal: shutdown.signal }).catch(() => undefined);
		}
	} finally {
		shutdown.abort();
		await host.stopAccountMetadataRefresh();
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
		await service.close();
	}
}

const executablePath = process.argv[1];
if (executablePath && realpathSync(resolve(executablePath)) === realpathSync(fileURLToPath(import.meta.url))) {
	runNativeProviderHostServiceMain().catch((error: unknown) => {
		const message = (error instanceof Error ? error.message : String(error))
			.replace(/[A-Za-z0-9_-]{43}/g, "[redacted]")
			.slice(0, 1000);
		console.error(message);
		process.exitCode = 1;
	});
}
