import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, chown, lstat, mkdir, open, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createClient } from "@supabase/supabase-js";
import {
	type CloudCompanyComputerScreensConfig,
	parseCloudCompanyComputerScreensConfig,
} from "./cloud-company-computer-screens.ts";
import {
	type CloudObjectTransport,
	HttpCloudObjectTransport,
	SupabaseCloudObjectTransport,
} from "./cloud-object-store.ts";
import {
	type EphemeralCloudRunnerServiceConfig,
	parseEphemeralCloudRunnerServiceConfig,
} from "./cloud-runner-service.ts";

/** Composition plumbing for the Company Computer guest services. The
 * provider pushes root-owned bootstrap and credential files; the agent
 * units receive them through systemd LoadCredential=, so the standing
 * services never run privileged. The one root step is the bootstrap oneshot
 * below, which prepares the dataset's working world and starts the agents. */

export const COMPANY_COMPUTER_BOOTSTRAP_SCHEMA = "qorpera.company-computer-bootstrap/v2";
export const COMPANY_COMPUTER_SERVICE_SCHEMA = "qorpera.company-computer-service/v2";
export const COMPANY_COMPUTER_SCREENS_SERVICE = "qorpera-company-computer-screens.service";
export const COMPANY_COMPUTER_RUNNER_SERVICE = "qorpera-company-computer-runner.service";
export const COMPANY_COMPUTER_NATIVE_PROVIDER_SERVICE = "qorpera-native-provider-host.service";

/** The provider delivers exactly this credential set; the bootstrap refuses
 * a drifted directory instead of guessing which secrets a stranger added. */
export const COMPANY_COMPUTER_GUEST_CREDENTIALS = [
	"qorpera-native-bridge",
	"qorpera-runner-activation",
	"qorpera-runner-assignment",
	"qorpera-screen-viewer",
	"qorpera-supabase-service-key",
] as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const REDACTED_TOKEN_PATTERN = /[A-Za-z0-9_-]{43}/g;
const LAYOUT_DIRECTORY_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_BOOTSTRAP_BYTES = 64 * 1024;
const MAX_CREDENTIAL_BYTES = 256;
const MAX_SERVICE_CREDENTIAL_BYTES = 8_192;
const execFileAsync = promisify(execFile);

export interface CompanyComputerGuestBootstrap {
	companyComputerId: string;
	logicalComputerId: string;
	profileId: string;
	environmentId: string;
	computeIdentityId: string;
	datasetPath: string;
	nasSharedGid: number;
	datasetLayout: {
		liveDirectory: string;
		profilesDirectory: string;
		stateDirectory: string;
	};
	screens: CloudCompanyComputerScreensConfig;
	credentialSource: string;
	runnerConfigPath: string;
	nativeProviderEnvironmentPath: string;
	identityVolumePath: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function uuid(value: unknown, label: string): string {
	if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error(`${label} is invalid`);
	return value;
}

function absolutePath(value: unknown, label: string): string {
	if (typeof value !== "string" || !isAbsolute(value) || /[\0\r\n]/.test(value) || value.includes("..")) {
		throw new Error(`${label} is invalid`);
	}
	return value;
}

function layoutDirectory(value: unknown, label: string): string {
	if (typeof value !== "string" || !LAYOUT_DIRECTORY_PATTERN.test(value) || value === "." || value === "..") {
		throw new Error(`${label} is invalid`);
	}
	return value;
}

function sharedGid(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 65_535) {
		throw new Error("Company computer NAS shared group is invalid");
	}
	return value as number;
}

/** Unknown top-level keys are tolerated so an older guest can keep starting
 * under a provider that adds unrelated forward-compatible fields. */
export function parseCompanyComputerGuestBootstrap(value: unknown): CompanyComputerGuestBootstrap {
	const input = record(value, "Company computer bootstrap");
	if (input.schema !== COMPANY_COMPUTER_BOOTSTRAP_SCHEMA) {
		throw new Error("Company computer bootstrap schema is not supported");
	}
	const layout = record(input.dataset_layout, "Company computer dataset layout");
	return {
		companyComputerId: uuid(input.company_computer_id, "Company computer id"),
		logicalComputerId: uuid(input.logical_computer_id, "Company computer logical computer id"),
		profileId: uuid(input.profile_id, "Company computer profile id"),
		environmentId: uuid(input.environment_id, "Company computer environment id"),
		computeIdentityId: uuid(input.compute_identity_id, "Company computer compute identity id"),
		datasetPath: absolutePath(input.dataset_path, "Company computer dataset path"),
		nasSharedGid: sharedGid(input.nas_shared_gid),
		datasetLayout: {
			liveDirectory: layoutDirectory(layout.liveDirectory, "Company computer live directory"),
			profilesDirectory: layoutDirectory(layout.profilesDirectory, "Company computer profiles directory"),
			stateDirectory: layoutDirectory(layout.stateDirectory, "Company computer state directory"),
		},
		screens: parseCloudCompanyComputerScreensConfig(input.screens),
		credentialSource: absolutePath(input.credential_source, "Company computer credential source"),
		runnerConfigPath: absolutePath(input.runner_config_path, "Company computer runner config path"),
		nativeProviderEnvironmentPath: absolutePath(
			input.native_provider_environment_path,
			"Company computer native provider environment path",
		),
		identityVolumePath: absolutePath(input.identity_volume_path, "Company computer identity volume path"),
	};
}

/** The runner lane keeps its small disposable execution metadata under the
 * NAS state directory, while QORPERA_LIVE_COMPANY_ROOT points execution at
 * the one shared company tree. The generic runner therefore retains its
 * reviewed isolation machinery without copying the Company File per turn. */
export function parseCompanyComputerRunnerServiceConfig(value: unknown): EphemeralCloudRunnerServiceConfig {
	const input = record(value, "Company computer runner service configuration");
	if (input.schema !== COMPANY_COMPUTER_SERVICE_SCHEMA) {
		throw new Error("Company computer runner service configuration schema is not supported");
	}
	const carried = [
		"base_url",
		"publishable_key",
		"runner_id",
		"authority_state_path",
		"image",
		"podman_path",
		"entrypoint",
		"capabilities",
		"platform",
		"runner_version",
		"native_bridge_url",
		"native_bridge_boundary",
		"native_bridge_shared_gid",
		"assignment_host",
		"assignment_port",
		"assignment_trusted_source",
		"max_assignments",
		"environment",
	] as const;
	const transformed: Record<string, unknown> = {
		schema: "qorpera.ephemeral-runner-service/v1",
		temporary_root: input.temporary_root,
		job_types: input.job_types ?? ["agent_turn"],
	};
	for (const key of carried) {
		if (input[key] !== undefined) transformed[key] = input[key];
	}
	return parseEphemeralCloudRunnerServiceConfig(transformed);
}

export function parseCompanyComputerServiceBaseUrl(value: unknown): string {
	const input = record(value, "Company computer service configuration");
	if (input.schema !== COMPANY_COMPUTER_SERVICE_SCHEMA) {
		throw new Error("Company computer service configuration schema is not supported");
	}
	const baseUrl = input.base_url;
	if (typeof baseUrl !== "string") throw new Error("Company computer service base URL is invalid");
	const parsed = new URL(baseUrl);
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error("Company computer service base URL is invalid");
	}
	return baseUrl;
}

export function guestServiceKey(value: string): string {
	const key = value.trim();
	if (!key || /[\0\r\n]/.test(key) || Buffer.byteLength(key) > MAX_SERVICE_CREDENTIAL_BYTES) {
		throw new Error("Company computer service credential is invalid");
	}
	return key;
}

export function guestToken(value: string, label: string): string {
	const token = value.trim();
	if (!TOKEN_PATTERN.test(token)) throw new Error(`${label} is invalid`);
	return token;
}

export function safeCompanyComputerGuestError(error: unknown): string {
	return (
		(error instanceof Error ? error.message : String(error))
			.replace(REDACTED_TOKEN_PATTERN, "[redacted]")
			.slice(0, 1_000)
			.trim() || "Company computer guest service failed"
	);
}

export interface CompanyComputerObjectTransportInput {
	storagePrimary: string;
	supabaseUrl: string;
	supabaseServiceKey: string;
	objectGatewayUrl?: string;
	objectGatewayToken?: string;
}

/** Storage selection is explicit deployment configuration and fails closed:
 * an unknown or missing mode must never silently change which backend is
 * treated as authoritative for working bytes. */
export function companyComputerObjectTransport(input: CompanyComputerObjectTransportInput): CloudObjectTransport {
	if (input.storagePrimary === "supabase") {
		return new SupabaseCloudObjectTransport(
			createClient(input.supabaseUrl, input.supabaseServiceKey, {
				auth: { persistSession: false, autoRefreshToken: false },
			}),
		);
	}
	if (input.storagePrimary === "nas") {
		if (!input.objectGatewayUrl || !input.objectGatewayToken) {
			throw new Error("NAS-primary object storage requires the gateway URL and access token");
		}
		const token = input.objectGatewayToken;
		return new HttpCloudObjectTransport({
			baseUrl: input.objectGatewayUrl,
			accessToken: async () => token,
		});
	}
	throw new Error("Company computer object storage selection is missing or unsupported");
}

export interface CompanyComputerGuestBootstrapPaths {
	bootstrapConfig: string;
	credentialSource: string;
	runnerConfig: string;
	nativeProviderEnvironment: string;
	identityVolume: string;
	identityMarker: string;
	identityMasterKey: string;
	runnerHomeDirectory: string;
	runnerConfigDestination: string;
	nativeProviderTemporaryDirectory: string;
	mountInfo: string;
}

const PRODUCTION_GUEST_PATHS: CompanyComputerGuestBootstrapPaths = {
	bootstrapConfig: "/var/lib/qorpera-bootstrap/company-computer.json",
	credentialSource: "/var/lib/qorpera-bootstrap/credentials",
	runnerConfig: "/var/lib/qorpera-bootstrap/runner-config.json",
	nativeProviderEnvironment: "/var/lib/qorpera-bootstrap/native-provider.env",
	identityVolume: "/var/lib/qorpera/identity",
	identityMarker: "/var/lib/qorpera/identity/qorpera-compute-identity.json",
	identityMasterKey: "/var/lib/qorpera/identity/qorpera-native-provider-master-key",
	runnerHomeDirectory: "/var/lib/qorpera-runner",
	runnerConfigDestination: "/var/lib/qorpera-runner/.config/qorpera-runner/config.json",
	nativeProviderTemporaryDirectory: "/var/lib/qorpera-native-provider/tmp",
	mountInfo: "/proc/self/mountinfo",
};

export interface CompanyComputerGuestIdentity {
	uid: number;
	gid: number;
}

export interface RunCompanyComputerGuestBootstrapOptions {
	paths?: CompanyComputerGuestBootstrapPaths;
	expectedRootUid?: number;
	expectedRootGid?: number;
	workIdentity?: CompanyComputerGuestIdentity;
	alignWorkIdentity?: (account: string, datasetUid: number) => Promise<CompanyComputerGuestIdentity>;
	nativeIdentity?: CompanyComputerGuestIdentity;
	workSupplementaryGids?: readonly number[];
	startService?: (service: string) => Promise<void>;
}

function secureOpenFlags(): number {
	return process.platform === "linux" ? constants.O_RDONLY | constants.O_NOFOLLOW : constants.O_RDONLY;
}

async function readOwnedFile(path: string, maximum: number, label: string, expectedUid: number): Promise<string> {
	const handle = await open(path, secureOpenFlags());
	try {
		const metadata = await handle.stat();
		if (
			!metadata.isFile() ||
			metadata.uid !== expectedUid ||
			metadata.size > maximum ||
			(metadata.mode & 0o077) !== 0
		) {
			throw new Error(`${label} has unsafe ownership, permissions, or size`);
		}
		return await handle.readFile({ encoding: "utf-8" });
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

async function verifyGuestCredentialSource(path: string, expectedUid: number): Promise<void> {
	const metadata = await lstat(path);
	if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== expectedUid) {
		throw new Error("Company computer credential source is unsafe");
	}
	await chmod(path, 0o700);
	const entries = (await readdir(path)).sort();
	if (JSON.stringify(entries) !== JSON.stringify([...COMPANY_COMPUTER_GUEST_CREDENTIALS])) {
		throw new Error("Company computer credential source contains unexpected entries");
	}
	for (const name of COMPANY_COMPUTER_GUEST_CREDENTIALS) {
		const maximum = name === "qorpera-supabase-service-key" ? MAX_SERVICE_CREDENTIAL_BYTES : MAX_CREDENTIAL_BYTES;
		const content = await readOwnedFile(
			join(path, name),
			maximum,
			`Company computer credential ${name}`,
			expectedUid,
		);
		if (name === "qorpera-supabase-service-key") guestServiceKey(content);
		else guestToken(content, `Company computer credential ${name}`);
	}
}

function mountPoint(value: string): string {
	return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function verifyMountedPath(mountInfo: string, expectedPath: string, label: string): void {
	for (const line of mountInfo.split("\n")) {
		if (!line) continue;
		const fields = line.split(" ");
		if (fields.length > 5 && mountPoint(fields[4] as string) === expectedPath) return;
	}
	throw new Error(`${label} is not a mounted filesystem`);
}

async function ensureSharedDirectory(path: string, gid: number, create: boolean): Promise<void> {
	try {
		if (create) await mkdir(path, { mode: 0o2770 });
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
	}
	const metadata = await lstat(path);
	if (
		!metadata.isDirectory() ||
		metadata.isSymbolicLink() ||
		metadata.gid !== gid ||
		(!create && (metadata.mode & 0o070) !== 0o070)
	) {
		throw new Error("Company computer dataset layout contains an unsupported entry");
	}
	// The existing live tree is Step 2's storage authority. Validate it but do
	// not rewrite its NAS-owned root metadata during every guest boot. Hidden
	// state created by this contract uses an explicit setgid sharing mode.
	if (create) await chmod(path, 0o2770);
}

async function ensureOwnedDirectory(path: string, identity: CompanyComputerGuestIdentity): Promise<void> {
	try {
		await mkdir(path, { mode: 0o700 });
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
	}
	const metadata = await lstat(path);
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
		throw new Error("Company computer service state contains an unsupported entry");
	}
	await chown(path, identity.uid, identity.gid);
	await chmod(path, 0o700);
}

async function ensureOwnedDirectoryTree(
	root: string,
	target: string,
	identity: CompanyComputerGuestIdentity,
): Promise<void> {
	const physicalRoot = resolve(root);
	const child = relative(physicalRoot, resolve(target));
	if (child === ".." || child.startsWith(`..${sep}`)) {
		throw new Error("Company computer service state directory escapes its approved home");
	}
	let current = physicalRoot;
	for (const component of ["", ...child.split(sep).filter(Boolean)]) {
		if (component) current = join(current, component);
		await ensureOwnedDirectory(current, identity);
	}
}

function parseNativeProviderEnvironment(encoded: string): Map<string, string> {
	const environment = new Map<string, string>();
	for (const line of encoded.split(/\r?\n/)) {
		if (!line) continue;
		const separator = line.indexOf("=");
		if (separator < 1) throw new Error("Native provider environment is invalid");
		const key = line.slice(0, separator);
		const value = line.slice(separator + 1);
		if (environment.has(key) || /[\0\r\n]/.test(value)) throw new Error("Native provider environment is invalid");
		environment.set(key, value);
	}
	return environment;
}

/** Mirrors the ephemeral guest's native-provider boundary check for the
 * company flavor: the sealed-capsule bridge stays loopback-only inside the
 * VM boundary and pinned to the computer's own compute identity. */
function verifyNativeProviderEnvironment(
	encoded: string,
	baseUrl: string,
	nativeBridgeUrl: string,
	computeIdentityId: string,
	nativeProviderTemporaryDirectory: string,
): void {
	const environment = parseNativeProviderEnvironment(encoded);
	const expectedKeys = [
		"QORPERA_CLAUDE_PATH",
		"QORPERA_CODEX_PATH",
		"QORPERA_NATIVE_PROVIDER_COMPUTE_IDENTITY_ID",
		"QORPERA_NATIVE_PROVIDER_EXECUTION_BOUNDARY",
		"QORPERA_NATIVE_PROVIDER_HOST",
		"QORPERA_NATIVE_PROVIDER_PORT",
		"QORPERA_NATIVE_PROVIDER_TEMPORARY_ROOT",
		"QORPERA_SUPABASE_URL",
	];
	if (JSON.stringify([...environment.keys()].sort()) !== JSON.stringify(expectedKeys)) {
		throw new Error("Native provider environment contains unexpected settings");
	}
	const bridge = new URL(nativeBridgeUrl);
	if (
		environment.get("QORPERA_SUPABASE_URL") !== baseUrl ||
		environment.get("QORPERA_NATIVE_PROVIDER_COMPUTE_IDENTITY_ID") !== computeIdentityId ||
		environment.get("QORPERA_NATIVE_PROVIDER_EXECUTION_BOUNDARY") !== "virtual_machine" ||
		environment.get("QORPERA_NATIVE_PROVIDER_HOST") !== "127.0.0.1" ||
		environment.get("QORPERA_NATIVE_PROVIDER_PORT") !== bridge.port ||
		environment.get("QORPERA_NATIVE_PROVIDER_TEMPORARY_ROOT") !== nativeProviderTemporaryDirectory ||
		bridge.protocol !== "http:" ||
		bridge.hostname !== "127.0.0.1" ||
		bridge.pathname !== "/"
	) {
		throw new Error("Native provider environment does not match the company computer boundary");
	}
	for (const name of ["QORPERA_CODEX_PATH", "QORPERA_CLAUDE_PATH"] as const) {
		const path = environment.get(name);
		if (!path?.startsWith("/") || !/^[A-Za-z0-9._/-]+$/.test(path)) {
			throw new Error("Native provider executable path is invalid");
		}
	}
}

const IDENTITY_VOLUME_SCHEMA = "qorpera.compute-identity-volume/v1";

async function ensureIdentityMarker(
	path: string,
	computeIdentityId: string,
	expectedRootUid: number,
	expectedRootGid: number,
): Promise<void> {
	try {
		const encoded = await readOwnedFile(path, MAX_BOOTSTRAP_BYTES, "Compute Identity volume marker", expectedRootUid);
		const marker = record(parseJson(encoded, "Compute Identity volume marker"), "Compute Identity volume marker");
		if (marker.schema !== IDENTITY_VOLUME_SCHEMA || marker.compute_identity_id !== computeIdentityId) {
			throw new Error("Compute Identity volume marker does not match bootstrap authority");
		}
		return;
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
	}
	const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
	await writeFile(
		temporary,
		`${JSON.stringify({ schema: IDENTITY_VOLUME_SCHEMA, compute_identity_id: computeIdentityId }, null, 2)}\n`,
		{ encoding: "utf-8", flag: "wx", mode: 0o600 },
	);
	await chown(temporary, expectedRootUid, expectedRootGid);
	await rename(temporary, path);
	await chmod(path, 0o600);
}

async function ensureIdentityMasterKey(path: string, expectedRootUid: number, expectedRootGid: number): Promise<void> {
	try {
		const key = (
			await readOwnedFile(path, MAX_CREDENTIAL_BYTES, "Native provider master key", expectedRootUid)
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
	await chown(temporary, expectedRootUid, expectedRootGid);
	await rename(temporary, path);
	await chmod(path, 0o600);
}

async function installRunnerConfig(
	encoded: string,
	path: string,
	home: string,
	identity: CompanyComputerGuestIdentity,
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

async function serviceIdentity(account: string): Promise<CompanyComputerGuestIdentity> {
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

const COMPANY_COMPUTER_LOCAL_WORK_ROOTS = [
	"/var/lib/qorpera-runner",
	"/var/lib/qorpera-native-workspace",
	"/run/qorpera-runner",
] as const;

/** VirtioFS presents the NAS server's numeric owner unchanged inside a VM.
 * The work account must therefore use that same non-privileged UID: group
 * access is enough for Company File entries, but desktop applications also
 * create private 0600 state that only its numeric owner can reopen. */
async function alignServiceAccountWithDatasetOwner(
	account: string,
	datasetUid: number,
): Promise<CompanyComputerGuestIdentity> {
	if (!Number.isSafeInteger(datasetUid) || datasetUid < 1_000 || datasetUid > 65_535) {
		throw new Error("Company computer NAS dataset owner is not a safe work-account UID");
	}
	const current = await serviceIdentity(account);
	if (current.uid === datasetUid) return current;
	await execFileAsync("/usr/sbin/usermod", ["--uid", String(datasetUid), account]);
	for (const root of COMPANY_COMPUTER_LOCAL_WORK_ROOTS) {
		try {
			await lstat(root);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
			throw error;
		}
		await execFileAsync("/usr/bin/chown", ["--recursive", `--from=${current.uid}`, String(datasetUid), root]);
	}
	const aligned = await serviceIdentity(account);
	if (aligned.uid !== datasetUid || aligned.gid !== current.gid) {
		throw new Error("Company computer work account did not align with the NAS dataset owner");
	}
	return aligned;
}

async function startGuestService(service: string): Promise<void> {
	await execFileAsync("/usr/bin/systemctl", ["start", "--no-block", service]);
}

async function serviceGroups(account: string): Promise<readonly number[]> {
	const { stdout } = await execFileAsync("/usr/bin/id", ["-G", account]);
	const groups = stdout.trim().split(/\s+/).filter(Boolean).map(Number);
	if (groups.length < 1 || groups.some((gid) => !Number.isSafeInteger(gid) || gid < 1)) {
		throw new Error(`The ${account} service groups are invalid`);
	}
	return groups;
}

/** Root oneshot the provider enables after pushing bootstrap files. It
 * verifies the provider-delivered authority, refuses to fabricate a working
 * world on the VM disk when the NAS dataset is not mounted, hands the
 * dataset's shared directories, prepares the runner lane (company-flavor
 * runner config, native-provider boundary, Compute Identity volume), and
 * starts the standing services. The existing `live` tree is never fabricated
 * on the VM disk or replaced from a publication head. */
export async function runCompanyComputerGuestBootstrap(
	options: RunCompanyComputerGuestBootstrapOptions = {},
): Promise<void> {
	const paths = options.paths ?? PRODUCTION_GUEST_PATHS;
	const expectedRootUid = options.expectedRootUid ?? 0;
	const expectedRootGid = options.expectedRootGid ?? 0;
	if ((process.getuid?.() ?? -1) !== expectedRootUid) {
		throw new Error("Company computer guest bootstrap must run as root");
	}
	const bootstrap = parseCompanyComputerGuestBootstrap(
		parseJson(
			await readOwnedFile(
				paths.bootstrapConfig,
				MAX_BOOTSTRAP_BYTES,
				"Company computer bootstrap configuration",
				expectedRootUid,
			),
			"Company computer bootstrap configuration",
		),
	);
	if (
		bootstrap.credentialSource !== paths.credentialSource ||
		bootstrap.runnerConfigPath !== paths.runnerConfig ||
		bootstrap.nativeProviderEnvironmentPath !== paths.nativeProviderEnvironment ||
		bootstrap.identityVolumePath !== paths.identityVolume
	) {
		throw new Error("Company computer bootstrap configuration is inconsistent");
	}
	await verifyGuestCredentialSource(paths.credentialSource, expectedRootUid);
	const mountInfo = await readFile(paths.mountInfo, "utf-8");
	verifyMountedPath(mountInfo, bootstrap.datasetPath, "Company computer dataset");
	const datasetMetadata = await lstat(bootstrap.datasetPath);
	if (!datasetMetadata.isDirectory() || datasetMetadata.isSymbolicLink()) {
		throw new Error("Company computer dataset mount is unsafe");
	}

	const runnerConfigEncoded = await readOwnedFile(
		paths.runnerConfig,
		MAX_BOOTSTRAP_BYTES,
		"Company computer runner configuration",
		expectedRootUid,
	);
	const runnerConfig = parseCompanyComputerRunnerServiceConfig(
		parseJson(runnerConfigEncoded, "Company computer runner configuration"),
	);
	if (
		runnerConfig.assignmentHost !== "0.0.0.0" ||
		!runnerConfig.assignmentTrustedSource ||
		runnerConfig.maxAssignments !== 1
	) {
		throw new Error("Company computer runner configuration does not enforce the private assignment boundary");
	}
	if (
		!runnerConfig.nativeBridgeUrl ||
		runnerConfig.nativeBridgeBoundary !== "virtual_machine" ||
		runnerConfig.nativeBridgeSharedGid === undefined
	) {
		throw new Error("Company computer runner configuration does not enforce the native VM bridge boundary");
	}
	const liveCompanyRoot = join(bootstrap.datasetPath, bootstrap.datasetLayout.liveDirectory);
	const stateRoot = join(bootstrap.datasetPath, bootstrap.datasetLayout.stateDirectory);
	if (
		runnerConfig.temporaryRoot !== join(stateRoot, "runner") ||
		runnerConfig.environment.QORPERA_LIVE_COMPANY_ROOT !== liveCompanyRoot ||
		runnerConfig.environment.QORPERA_LIVE_COMPANY_PROFILE_ID !== bootstrap.profileId
	) {
		throw new Error("Company computer runner does not use the declared live Company File");
	}
	verifyNativeProviderEnvironment(
		await readOwnedFile(
			paths.nativeProviderEnvironment,
			MAX_BOOTSTRAP_BYTES,
			"Native provider environment",
			expectedRootUid,
		),
		runnerConfig.baseUrl,
		runnerConfig.nativeBridgeUrl,
		bootstrap.computeIdentityId,
		paths.nativeProviderTemporaryDirectory,
	);

	const identityMetadata = await lstat(paths.identityVolume);
	if (
		!identityMetadata.isDirectory() ||
		identityMetadata.isSymbolicLink() ||
		identityMetadata.uid !== expectedRootUid
	) {
		throw new Error("Compute Identity volume mount is unsafe");
	}
	verifyMountedPath(mountInfo, paths.identityVolume, "Compute Identity volume");
	await chmod(paths.identityVolume, 0o700);
	await ensureIdentityMarker(paths.identityMarker, bootstrap.computeIdentityId, expectedRootUid, expectedRootGid);
	await ensureIdentityMasterKey(paths.identityMasterKey, expectedRootUid, expectedRootGid);

	const identity =
		options.workIdentity ??
		(await (options.alignWorkIdentity ?? alignServiceAccountWithDatasetOwner)("qorpera-runner", datasetMetadata.uid));
	const nativeIdentity = options.nativeIdentity ?? (await serviceIdentity("qorpera-native-provider"));
	const workGroups = options.workSupplementaryGids ?? (await serviceGroups("qorpera-runner"));
	if (
		identity.uid !== datasetMetadata.uid ||
		nativeIdentity.gid !== runnerConfig.nativeBridgeSharedGid ||
		!workGroups.includes(runnerConfig.nativeBridgeSharedGid) ||
		!workGroups.includes(bootstrap.nasSharedGid)
	) {
		throw new Error("Company computer shared groups do not match the signed guest-image accounts");
	}
	await ensureSharedDirectory(liveCompanyRoot, bootstrap.nasSharedGid, false);
	await ensureSharedDirectory(
		join(bootstrap.datasetPath, bootstrap.datasetLayout.profilesDirectory),
		bootstrap.nasSharedGid,
		true,
	);
	await ensureSharedDirectory(stateRoot, bootstrap.nasSharedGid, true);
	await ensureSharedDirectory(join(stateRoot, "desktop-home"), bootstrap.nasSharedGid, true);
	await ensureSharedDirectory(join(stateRoot, "runner"), bootstrap.nasSharedGid, true);
	await ensureSharedDirectory(join(stateRoot, "screens"), bootstrap.nasSharedGid, true);
	if (
		runnerConfig.authorityStatePath !== paths.runnerHomeDirectory &&
		!runnerConfig.authorityStatePath.startsWith(`${paths.runnerHomeDirectory}/`)
	) {
		throw new Error("Company computer runner authority state must live in the runner home");
	}
	await ensureOwnedDirectoryTree(paths.runnerHomeDirectory, dirname(runnerConfig.authorityStatePath), identity);
	await ensureOwnedDirectoryTree(
		dirname(paths.nativeProviderTemporaryDirectory),
		paths.nativeProviderTemporaryDirectory,
		nativeIdentity,
	);
	await installRunnerConfig(runnerConfigEncoded, paths.runnerConfigDestination, paths.runnerHomeDirectory, identity);

	const start = options.startService ?? startGuestService;
	await start(COMPANY_COMPUTER_NATIVE_PROVIDER_SERVICE);
	await start(COMPANY_COMPUTER_RUNNER_SERVICE);
	await start(COMPANY_COMPUTER_SCREENS_SERVICE);
}
