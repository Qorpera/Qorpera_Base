import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, chown, lstat, mkdir, open, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { createClient } from "@supabase/supabase-js";
import {
	type CloudCompanyComputerScreensConfig,
	parseCloudCompanyComputerScreensConfig,
} from "./cloud-company-computer-screens.ts";
import {
	type CloudCompanyComputerHeadResolver,
	type CloudCompanyComputerSyncConfig,
	type CloudCompanyComputerSyncHead,
	parseCloudCompanyComputerSyncConfig,
} from "./cloud-company-computer-sync.ts";
import { currentCloudCompanyTreeReference } from "./cloud-company-snapshot.ts";
import {
	type CloudObjectTransport,
	HttpCloudObjectTransport,
	SupabaseCloudObjectTransport,
} from "./cloud-object-store.ts";

/** Composition plumbing for the Company Computer guest services. The
 * provider pushes root-owned bootstrap and credential files; the agent
 * units receive them through systemd LoadCredential=, so the standing
 * services never run privileged. The one root step is the bootstrap oneshot
 * below, which prepares the dataset's working world and starts the agents. */

export const COMPANY_COMPUTER_BOOTSTRAP_SCHEMA = "qorpera.company-computer-bootstrap/v1";
export const COMPANY_COMPUTER_SERVICE_SCHEMA = "qorpera.company-computer-service/v1";
export const COMPANY_COMPUTER_SYNC_SERVICE = "qorpera-company-computer-sync.service";
export const COMPANY_COMPUTER_SCREENS_SERVICE = "qorpera-company-computer-screens.service";

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
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
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
	datasetPath: string;
	datasetLayout: {
		companyDirectory: string;
		workbenchDirectory: string;
		profilesDirectory: string;
		stateDirectory: string;
	};
	sync: CloudCompanyComputerSyncConfig;
	screens: CloudCompanyComputerScreensConfig;
	credentialSource: string;
	runnerConfigPath: string;
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

/** Unknown top-level keys are tolerated for the same reason as the sync and
 * screens blocks: an older agent must keep starting under a newer provider. */
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
		datasetPath: absolutePath(input.dataset_path, "Company computer dataset path"),
		datasetLayout: {
			companyDirectory: layoutDirectory(layout.companyDirectory, "Company computer company directory"),
			workbenchDirectory: layoutDirectory(layout.workbenchDirectory, "Company computer workbench directory"),
			profilesDirectory: layoutDirectory(layout.profilesDirectory, "Company computer profiles directory"),
			stateDirectory: layoutDirectory(layout.stateDirectory, "Company computer state directory"),
		},
		sync: parseCloudCompanyComputerSyncConfig(input.sync),
		screens: parseCloudCompanyComputerScreensConfig(input.screens),
		credentialSource: absolutePath(input.credential_source, "Company computer credential source"),
		runnerConfigPath: absolutePath(input.runner_config_path, "Company computer runner config path"),
	};
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

/** Resolves the verified head through the computer-scoped service RPC; the
 * control plane enforces published-only, and the agent re-checks rather than
 * trusting the wire. */
export class SupabaseCompanyComputerSyncHeadResolver implements CloudCompanyComputerHeadResolver {
	readonly #supabaseUrl: string;
	readonly #serviceKey: string;
	readonly #companyComputerId: string;
	readonly #fetch: typeof fetch;

	constructor(
		supabaseUrl: string,
		serviceKey: string,
		companyComputerId: string,
		fetchImplementation: typeof fetch = fetch,
	) {
		this.#supabaseUrl = supabaseUrl;
		this.#serviceKey = serviceKey;
		this.#companyComputerId = companyComputerId;
		this.#fetch = fetchImplementation;
	}

	async resolveVerifiedHead(): Promise<CloudCompanyComputerSyncHead | undefined> {
		const headers: Record<string, string> = { apikey: this.#serviceKey, "content-type": "application/json" };
		if (this.#serviceKey.startsWith("eyJ") && this.#serviceKey.split(".").length === 3) {
			headers.authorization = `Bearer ${this.#serviceKey}`;
		}
		const response = await this.#fetch(
			new URL("/rest/v1/rpc/qorpera_company_computer_sync_head", this.#supabaseUrl),
			{
				method: "POST",
				headers,
				body: JSON.stringify({ p_company_computer_id: this.#companyComputerId }),
				signal: AbortSignal.timeout(30_000),
			},
		);
		if (!response.ok) throw new Error(`Company computer sync head request failed (${response.status})`);
		const value: unknown = await response.json();
		if (value === null || value === undefined) return undefined;
		const snapshot = record(value, "Company computer sync head");
		if (snapshot.publication_state !== "published") {
			throw new Error("Company File head is not a published snapshot");
		}
		if (
			typeof snapshot.tree_manifest_sha256 !== "string" ||
			!SHA256_PATTERN.test(snapshot.tree_manifest_sha256) ||
			!Number.isSafeInteger(snapshot.tree_manifest_bytes) ||
			!Number.isSafeInteger(snapshot.tree_contract_version) ||
			!Number.isSafeInteger(snapshot.file_count) ||
			!Number.isSafeInteger(snapshot.total_bytes)
		) {
			throw new Error("Company computer sync head is invalid");
		}
		return {
			snapshotId: uuid(snapshot.snapshot_id, "Company computer sync head snapshot id"),
			tree: currentCloudCompanyTreeReference({
				manifestSha256: snapshot.tree_manifest_sha256,
				manifestBytes: snapshot.tree_manifest_bytes as number,
				contractVersion: snapshot.tree_contract_version as number,
				fileCount: snapshot.file_count as number,
				totalBytes: snapshot.total_bytes as number,
			}),
		};
	}
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
	mountInfo: string;
}

const PRODUCTION_GUEST_PATHS: CompanyComputerGuestBootstrapPaths = {
	bootstrapConfig: "/var/lib/qorpera-bootstrap/company-computer.json",
	credentialSource: "/var/lib/qorpera-bootstrap/credentials",
	mountInfo: "/proc/self/mountinfo",
};

export interface CompanyComputerGuestIdentity {
	uid: number;
	gid: number;
}

export interface RunCompanyComputerGuestBootstrapOptions {
	paths?: CompanyComputerGuestBootstrapPaths;
	expectedRootUid?: number;
	workIdentity?: CompanyComputerGuestIdentity;
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

function verifyMountedDataset(mountInfo: string, expectedPath: string): void {
	for (const line of mountInfo.split("\n")) {
		if (!line) continue;
		const fields = line.split(" ");
		if (fields.length > 5 && mountPoint(fields[4] as string) === expectedPath) return;
	}
	throw new Error("Company computer dataset is not a mounted filesystem");
}

async function ensureOwnedDirectory(path: string, identity: CompanyComputerGuestIdentity): Promise<void> {
	try {
		await mkdir(path, { mode: 0o700 });
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
	}
	const metadata = await lstat(path);
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
		throw new Error("Company computer dataset layout contains an unsupported entry");
	}
	await chown(path, identity.uid, identity.gid);
	await chmod(path, 0o700);
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

async function startGuestService(service: string): Promise<void> {
	await execFileAsync("/usr/bin/systemctl", ["start", service]);
}

/** Root oneshot the provider enables after pushing bootstrap files. It
 * verifies the provider-delivered authority, refuses to fabricate a working
 * world on the VM disk when the NAS dataset is not mounted, hands the
 * dataset's working directories to the work account, and starts the two
 * standing agents. The company checkout itself is initialized by the sync
 * agent as the work account, never by root. */
export async function runCompanyComputerGuestBootstrap(
	options: RunCompanyComputerGuestBootstrapOptions = {},
): Promise<void> {
	const paths = options.paths ?? PRODUCTION_GUEST_PATHS;
	const expectedRootUid = options.expectedRootUid ?? 0;
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
	if (bootstrap.credentialSource !== paths.credentialSource) {
		throw new Error("Company computer bootstrap configuration is inconsistent");
	}
	await verifyGuestCredentialSource(paths.credentialSource, expectedRootUid);
	verifyMountedDataset(await readFile(paths.mountInfo, "utf-8"), bootstrap.datasetPath);
	const datasetMetadata = await lstat(bootstrap.datasetPath);
	if (!datasetMetadata.isDirectory() || datasetMetadata.isSymbolicLink()) {
		throw new Error("Company computer dataset mount is unsafe");
	}
	const identity = options.workIdentity ?? (await serviceIdentity("qorpera-runner"));
	await chown(bootstrap.datasetPath, identity.uid, identity.gid);
	await chmod(bootstrap.datasetPath, 0o700);
	for (const directory of [
		bootstrap.datasetLayout.workbenchDirectory,
		bootstrap.datasetLayout.profilesDirectory,
		bootstrap.datasetLayout.stateDirectory,
	]) {
		await ensureOwnedDirectory(join(bootstrap.datasetPath, directory), identity);
	}
	const start = options.startService ?? startGuestService;
	await start(COMPANY_COMPUTER_SYNC_SERVICE);
	await start(COMPANY_COMPUTER_SCREENS_SERVICE);
}
