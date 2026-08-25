import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, chown, lstat, mkdir, open, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { parseEphemeralCloudRunnerServiceConfig } from "./cloud-runner-service.ts";

const BOOTSTRAP_SCHEMA = "qorpera.lxd-runner-bootstrap/v1";
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
const execFileAsync = promisify(execFile);

export interface LxdRunnerBootstrapConfig {
	schema: typeof BOOTSTRAP_SCHEMA;
	computeIdentityId: string;
	computeTemplateKey: string;
	computeTemplateVersion: string;
	computePolicySha256: string;
	runnerConfigPath: string;
	nativeProviderEnvironmentPath: string;
	credentialSource: string;
	identityVolumePath: string;
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
}

export interface RunLxdNativeLoginBootstrapOptions {
	paths?: LxdNativeLoginBootstrapPaths;
	expectedRootUid?: number;
	expectedRootGid?: number;
	nativeServiceIdentity?: LxdRunnerBootstrapServiceIdentity;
	startService?: (service: string) => Promise<void>;
}

export interface RunLxdRunnerBootstrapOptions {
	paths?: LxdRunnerBootstrapPaths;
	expectedRootUid?: number;
	expectedRootGid?: number;
	serviceIdentity?: LxdRunnerBootstrapServiceIdentity;
	nativeServiceIdentity?: LxdRunnerBootstrapServiceIdentity;
	runnerSupplementaryGids?: readonly number[];
	startService?: (service: string) => Promise<void>;
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
};

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
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
		],
		"LXD runner bootstrap configuration",
	);
	if (input.schema !== BOOTSTRAP_SCHEMA) throw new Error("LXD runner bootstrap schema is unsupported");
	if (
		input.runner_config_path !== PRODUCTION_PATHS.runnerConfig ||
		input.native_provider_environment_path !== PRODUCTION_PATHS.nativeProviderEnvironment ||
		input.credential_source !== PRODUCTION_PATHS.credentialSource ||
		input.identity_volume_path !== PRODUCTION_PATHS.identityVolume
	) {
		throw new Error("LXD runner bootstrap paths are outside the guest-image contract");
	}
	return {
		schema: BOOTSTRAP_SCHEMA,
		computeIdentityId: text(input.compute_identity_id, "Compute Identity id", UUID_PATTERN),
		computeTemplateKey: text(input.compute_template_key, "Compute template key", TEMPLATE_PATTERN),
		computeTemplateVersion: text(input.compute_template_version, "Compute template version", TEMPLATE_PATTERN),
		computePolicySha256: text(input.compute_policy_sha256, "Compute policy digest", SHA256_PATTERN),
		runnerConfigPath: PRODUCTION_PATHS.runnerConfig,
		nativeProviderEnvironmentPath: PRODUCTION_PATHS.nativeProviderEnvironment,
		credentialSource: PRODUCTION_PATHS.credentialSource,
		identityVolumePath: PRODUCTION_PATHS.identityVolume,
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

async function ensureIdentityMasterKey(path: string, expectedUid: number, expectedGid: number): Promise<void> {
	try {
		const key = (
			await readOwnedFile(path, MAX_CREDENTIAL_BYTES, "Native provider master key", expectedUid, true)
		).trim();
		if (!TOKEN_PATTERN.test(key)) throw new Error("Native provider master key is invalid");
		return;
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
	}
	const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
	await writeFile(temporary, `${randomBytes(32).toString("base64url")}\n`, {
		encoding: "utf-8",
		flag: "wx",
		mode: 0o600,
	});
	await chown(temporary, expectedUid, expectedGid);
	await rename(temporary, path);
	await chmod(path, 0o600);
}

function nativeProviderEnvironment(
	encoded: string,
	baseUrl: string,
	nativeBridgeUrl: string,
	computeIdentityId: string,
	trustedSource?: string,
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
}

async function verifyCredentialSource(
	path: string,
	expectedUid: number,
	boundary: "runner" | "native-login",
): Promise<void> {
	const metadata = await lstat(path);
	if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== expectedUid) {
		throw new Error("LXD runner credential source is unsafe");
	}
	await chmod(path, 0o700);
	const entries = (await readdir(path)).sort();
	const expected =
		boundary === "runner"
			? [
					"qorpera-native-bridge",
					"qorpera-runner-activation",
					"qorpera-runner-assignment",
					"qorpera-supabase-service-key",
				]
			: ["qorpera-native-bridge", "qorpera-supabase-service-key"];
	if (JSON.stringify(entries) !== JSON.stringify(expected)) {
		throw new Error("LXD runner credential source contains unexpected entries");
	}
	for (const name of expected.filter((entry) => entry !== "qorpera-supabase-service-key")) {
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
		runnerConfig.nativeBridgeSharedGid === undefined
	) {
		throw new Error("LXD runner configuration does not enforce the native VM bridge boundary");
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
	);

	await verifyCredentialSource(paths.credentialSource, expectedRootUid, "runner");
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
	await ensureIdentityMarker(paths.identityMarker, bootstrap.computeIdentityId, expectedRootUid, expectedRootGid);
	await ensureIdentityMasterKey(paths.identityMasterKey, expectedRootUid, expectedRootGid);

	const runnerIdentity = options.serviceIdentity ?? (await serviceIdentity("qorpera-runner"));
	const nativeIdentity = options.nativeServiceIdentity ?? (await serviceIdentity("qorpera-native-provider"));
	const runnerGroups = options.runnerSupplementaryGids ?? (await serviceGroups("qorpera-runner"));
	if (
		nativeIdentity.gid !== runnerConfig.nativeBridgeSharedGid ||
		!runnerGroups.includes(runnerConfig.nativeBridgeSharedGid)
	) {
		throw new Error("Native execution group does not match the signed guest-image accounts");
	}
	const runnerHome = paths.runnerHomeDirectory;
	const nativeHome = dirname(paths.nativeProviderTemporaryDirectory);
	await ensureOwnedDirectoryTree(runnerHome, paths.runnerStateDirectory, runnerIdentity);
	await ensureOwnedDirectory(paths.runnerTemporaryDirectory, runnerIdentity);
	await ensureOwnedDirectoryTree(nativeHome, paths.nativeProviderTemporaryDirectory, nativeIdentity);
	await installRunnerConfig(runnerConfigEncoded, paths.runnerConfigDestination, runnerHome, runnerIdentity);
	const start = options.startService ?? startRunnerService;
	await start(NATIVE_PROVIDER_SERVICE);
	await start(RUNNER_SERVICE);
}

export async function runLxdNativeLoginBootstrap(options: RunLxdNativeLoginBootstrapOptions = {}): Promise<void> {
	const paths = options.paths ?? PRODUCTION_LOGIN_PATHS;
	const expectedRootUid = options.expectedRootUid ?? 0;
	const expectedRootGid = options.expectedRootGid ?? 0;
	if ((process.getuid?.() ?? -1) !== expectedRootUid) {
		throw new Error("LXD native login bootstrap must run as root");
	}

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
	await verifyCredentialSource(paths.credentialSource, expectedRootUid, "native-login");

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
	await ensureIdentityMarker(paths.identityMarker, bootstrap.computeIdentityId, expectedRootUid, expectedRootGid);
	await ensureIdentityMasterKey(paths.identityMasterKey, expectedRootUid, expectedRootGid);

	const nativeIdentity = options.nativeServiceIdentity ?? (await serviceIdentity("qorpera-native-provider"));
	const nativeHome = dirname(paths.nativeProviderTemporaryDirectory);
	await ensureOwnedDirectoryTree(nativeHome, paths.nativeProviderTemporaryDirectory, nativeIdentity);
	await (options.startService ?? startRunnerService)(NATIVE_PROVIDER_SERVICE);
}
