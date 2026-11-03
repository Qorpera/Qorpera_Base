import { type ChildProcessByStdio, type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { CloudRequestTimeoutError } from "@qorpera/cloud-client/cloud-request";
import {
	NATIVE_ACCOUNT_REFRESH_RESULT_SCHEMA,
	type NativeAccountRefreshRequest,
} from "@qorpera/cloud-client/native-account-refresh";
import type { JsonValue } from "@qorpera/contracts";
import type { CloudAgentSendInput, CloudAgentSendReceipt } from "./cloud-agent-mouth.ts";
import { cloudControlBackoffMs, cloudControlPause, cloudControlRetryable } from "./cloud-control-errors.ts";
import type { ModelLoginIssue, ModelLoginIssueRequest, ModelLoginRunBinding } from "./cloud-model-login-vault.ts";
import { nativeRuntimeFailureMetadata } from "./cloud-native-failure.ts";
import {
	CHATGPT_PLAN_DIRECTORY,
	CHATGPT_PLAN_TOKEN_FILE,
	launchIsolatedNativeProcess,
	type NativeIsolationConfiguration,
} from "./cloud-native-isolation.ts";
import { NATIVE_AUTHORITY_LEASE_SECONDS } from "./cloud-runner-broker.ts";
import type { CloudInteractionRequestInput, CloudInteractionRequestReceipt } from "./cloud-thread-interactions.ts";
import { CloudSecretBrokerBusyError } from "./cloud-vault-database-failure.ts";
import { nativeProviderAccountEmail, nativeProviderAccountIdentity } from "./native-provider-account.ts";
import { type NativeProviderAccountUsage, readNativeProviderAccountUsage } from "./native-provider-usage.ts";

const CAPSULE_SCHEMA = "qorpera.native-credential-capsule/v1";
const LOGIN_RESULT_SCHEMA = "qorpera.native-provider-login-result/v1";
const HARNESS_RESULT_SCHEMA = "qorpera.native-harness-result/v2";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_CAPSULE_PLAINTEXT_BYTES = 64 * 1024 * 1024;
const MAX_CAPSULE_FILES = 4096;
const MAX_HARNESS_OUTPUT_BYTES = 16 * 1024 * 1024;
const EXECUTION_AUTHORITY_RECHECK_MS = 15_000;
/** A run whose login is in the vault asks it for a newer pass this often. */
const MODEL_LOGIN_RECHECK_MS = 60_000;
/** A capsule reference that names a login kept by the vault (Stateless Compute step 1). */
const MODEL_LOGIN_REFERENCE = /^model-login\/[0-9a-f-]{36}$/;
const CODEX_CREDENTIAL_PATHS: ReadonlySet<string> = new Set(["codex/auth.json"]);
/** A ChatGPT plan run's token file (`<root>/chatgpt-plan/access-token`, read by the run's Codex). */
const CHATGPT_PLAN_CREDENTIAL_PATHS: ReadonlySet<string> = new Set([
	`${CHATGPT_PLAN_DIRECTORY}/${CHATGPT_PLAN_TOKEN_FILE}`,
]);

export type NativeHarnessKind = "codex-cli" | "claude-code";
export type NativeComputeOwnershipKind = "member" | "company" | "department" | "security_boundary";

export interface NativeProviderLoginRequest {
	loginId: string;
	clientConnectionId: string;
	computeIdentityId: string;
	computeIdentityOwnershipKind: NativeComputeOwnershipKind;
	computeIdentityOwnerUserId?: string;
	computeIdentityOwnerScopeKey?: string;
	provider: "openai" | "anthropic";
	nativeHarness: NativeHarnessKind;
	capability: string;
	expiresAt: string;
}

export interface NativeProviderLoginDescription extends Omit<NativeProviderLoginRequest, "capability"> {
	profileId: string;
}

export interface CompleteNativeProviderLoginInput {
	loginId: string;
	capability: string;
	capsuleId: string;
	encryptedCapsuleReference: string;
	attestationPolicySha256: string;
	providerAccountReference?: string;
	providerAccountEmail?: string;
}

export interface NativeProviderAccountRefresh {
	connectionId: string;
	connectionVersion: number;
	capsuleId: string;
	encryptedCapsuleReference: string;
	nativeHarness: NativeHarnessKind;
}

export interface NativeProviderAccountMetadata {
	providerAccountEmail?: string;
	providerAccountUsage?: NativeProviderAccountUsage;
	providerAccountIdentity?: string;
}

export interface NativeProviderControlPlane {
	describeAccountRefresh?(
		requestId: string,
		capability: string,
		signal?: AbortSignal,
	): Promise<{
		computeIdentityId: string;
		requestedByUserId: string;
		expiresAt: string;
		status: "pending" | "completed";
	}>;
	completeAccountRefresh?(requestId: string, capability: string, signal?: AbortSignal): Promise<boolean>;
	listAccountRefreshes?(computeIdentityId: string, signal?: AbortSignal): Promise<NativeProviderAccountRefresh[]>;
	recordAccountMetadata?(
		computeIdentityId: string,
		account: NativeProviderAccountRefresh,
		metadata: NativeProviderAccountMetadata,
		signal?: AbortSignal,
	): Promise<void>;
	describeLogin(loginId: string, capability: string, signal?: AbortSignal): Promise<NativeProviderLoginDescription>;
	completeLogin(input: CompleteNativeProviderLoginInput, signal?: AbortSignal): Promise<void>;
	validateExecution(request: NativeCompanyExecutionRequest, signal?: AbortSignal): Promise<void>;
	sendMessage(
		request: NativeCompanyExecutionRequest,
		input: CloudAgentSendInput,
		signal?: AbortSignal,
	): Promise<CloudAgentSendReceipt>;
	/** A typed card for the member, appended to the run's thread under the same lease
	 * authority as a send. Optional so older control planes keep their shape; a
	 * runtime without it refuses ask_member instead of guessing. */
	appendInteractionRequest?(
		request: NativeCompanyExecutionRequest,
		input: CloudInteractionRequestInput,
		signal?: AbortSignal,
	): Promise<CloudInteractionRequestReceipt>;
}

export interface NativeCredentialCapsuleStore {
	put(reference: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
	get(reference: string, signal?: AbortSignal): Promise<Uint8Array>;
}

export interface NativeHarnessLoginPrompt {
	interactionUrl?: string;
	userCode?: string;
}

export interface NativeHarnessLoginHandle {
	prompt: Promise<NativeHarnessLoginPrompt>;
	completed: Promise<{ providerAccountReference?: string; providerAccountEmail?: string }>;
	cancel(): Promise<void>;
}

/** The official CLI's login driver. Executions run through the cloud runtime (`NativeCloudExecutionDriver`). */
export interface NativeHarnessDriver {
	beginLogin(
		harness: NativeHarnessKind,
		identityRoot: string,
		signal?: AbortSignal,
	): Promise<NativeHarnessLoginHandle>;
}

/** Cloud-selected execution, distinct from the official CLI's login driver. */
export interface NativeCloudExecutionDriver {
	execute(
		request: NativeCompanyExecutionRequest,
		identityRoot: string,
		signal: AbortSignal,
	): Promise<{
		providerSessionId: string;
		delivery: { messageCount: number; finalMessageId: string | null };
	}>;
	/** Warm conversations: start a spare harness for the next run that uses this identity root. */
	prepareSpare?(identityRoot: string, idleMs: number): void;
	/** Stop the spares that use this identity root before it is wiped. */
	disposeSpares?(identityRoot: string): Promise<void>;
}

/** Removes everything under `root` except the capsule's own credential files. */
async function pruneToCredentialFiles(
	root: string,
	durablePaths: ReadonlySet<string>,
	directory = root,
): Promise<boolean> {
	let kept = false;
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		const name = relative(root, path).split(sep).join("/");
		if (entry.isDirectory() && !entry.isSymbolicLink()) {
			if (await pruneToCredentialFiles(root, durablePaths, path)) kept = true;
			else await rm(path, { recursive: true, force: true });
		} else if (entry.isFile() && durablePaths.has(name)) kept = true;
		else await rm(path, { force: true });
	}
	return kept;
}

/** The run host's client of the vault's model logins (`POST /v1/model-logins`). */
export interface NativeModelLoginClient {
	issue(request: ModelLoginIssueRequest, signal: AbortSignal): Promise<ModelLoginIssue>;
}

/** A run's copy of a vault login never carries the renewal token: only the vault renews. */
function assertAccessOnlyModelLogin(authJson: string): void {
	let login: unknown;
	try {
		login = JSON.parse(authJson);
	} catch {
		throw new Error("Native login vault returned an invalid login");
	}
	if (!login || typeof login !== "object" || Array.isArray(login))
		throw new Error("Native login vault returned an invalid login");
	const tokens = (login as { tokens?: unknown }).tokens;
	if (tokens === undefined || tokens === null) return;
	if (typeof tokens !== "object" || Array.isArray(tokens))
		throw new Error("Native login vault returned an invalid login");
	const renewal = (tokens as { refresh_token?: unknown }).refresh_token;
	if (renewal !== undefined && renewal !== "") throw new Error("Native login vault handed a run a renewal token");
}

/** Puts a login copy from the vault in the run's Codex home in one step: Codex, which re-reads
 * the file before it would renew, sees the old copy or the new one, never half of either. The
 * copy is staged beside the Codex home, not in it, which must hold `auth.json` alone. */
async function writeModelLogin(root: string, authJson: string): Promise<void> {
	assertAccessOnlyModelLogin(authJson);
	const codexHome = join(root, "codex");
	await mkdir(codexHome, { recursive: true, mode: 0o700 });
	const staged = join(root, `.model-login.${randomUUID()}`);
	try {
		await writeFile(staged, authJson, { mode: 0o600, flag: "wx" });
		await rename(staged, join(codexHome, "auth.json"));
	} catch (error) {
		await rm(staged, { force: true });
		throw error;
	}
}

/** Puts a ChatGPT plan's access token from the vault where the run's Codex reads it, in one step: the
 * token command reads the old token or the new one, never half of either. The file holds the access token
 * alone (the vault never hands a run the refresh token), is this user's alone (0600, in a 0700 directory),
 * and lies outside everything the agent's tools reach. */
async function writeChatGptPlanToken(root: string, accessToken: string): Promise<void> {
	if (!/^[\x21-\x7e]{1,16384}$/.test(accessToken)) throw new Error("Native login vault returned an invalid login");
	const directory = join(root, CHATGPT_PLAN_DIRECTORY);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const staged = join(root, `.chatgpt-plan.${randomUUID()}`);
	try {
		await writeFile(staged, accessToken, { mode: 0o600, flag: "wx" });
		await rename(staged, join(directory, CHATGPT_PLAN_TOKEN_FILE));
	} catch (error) {
		await rm(staged, { force: true });
		throw error;
	}
}

interface WarmCredentialRoot {
	key: string;
	root: string;
	durable: ReadonlySet<string>;
	/** The stored capsule bytes this root was opened from or last saved as: reused only while
	 * the store still holds them. Absent for a login kept by the vault. */
	sealed?: Uint8Array;
	/** The credential digest of that stored login. A change to the kept root after it (a spare
	 * harness renewing between runs) is the next run's change to save. */
	digest?: string;
	/** For a login kept by the vault: the version this root holds. */
	vaultVersion?: number;
	timer: ReturnType<typeof setTimeout>;
}

export interface NativeProviderExecutionAuthority {
	leaseId: string;
	runId: string;
	credentialCapsuleId: string;
	encryptedCapsuleReference: string;
	attestationPolicySha256: string;
	computeIdentityId: string;
	runnerId: string;
	assignmentId: string;
	provider: "openai" | "anthropic";
	nativeHarness: NativeHarnessKind;
	model: string;
	expiresAt: string;
}

interface NativeProviderExecutionIdentity {
	authority: NativeProviderExecutionAuthority;
	job: {
		jobId: string;
		jobType: "agent_turn";
		requiredCapability: "agent_turn";
		attemptCount: number;
		payload: JsonValue;
	};
}

export interface NativeCompanyExecutionRequest extends NativeProviderExecutionIdentity {
	runtime: "company-path-v1";
}

interface CapsuleFile {
	path: string;
	mode: number;
	data: string;
}

interface CapsuleArchive {
	schema: typeof CAPSULE_SCHEMA;
	files: CapsuleFile[];
}

interface LoginState {
	request: NativeProviderLoginRequest;
	root: string;
	handle: NativeHarnessLoginHandle;
	status: "awaiting_member" | "completed" | "failed";
	prompt: NativeHarnessLoginPrompt;
	error?: Error;
}

type NativeHarnessChild = ChildProcessByStdio<null, Readable, Readable> | ChildProcessWithoutNullStreams;

function requiredUuid(value: string, label: string): void {
	if (!UUID_PATTERN.test(value)) throw new Error(`${label} is invalid`);
}

function requiredAbsolutePath(value: string, label: string): string {
	if (!isAbsolute(value)) throw new Error(`${label} must be absolute`);
	return resolve(value);
}

function safeRelativePath(path: string): boolean {
	return (
		path.length > 0 &&
		path.length <= 4096 &&
		!path.includes("\\") &&
		!path.startsWith("/") &&
		path.split("/").every((part) => part && part !== "." && part !== ".." && !part.includes("\0"))
	);
}

function sameLogin(left: NativeProviderLoginRequest, right: NativeProviderLoginRequest): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function waitFor(delayMs: number, signal: AbortSignal): Promise<boolean> {
	if (signal.aborted) return Promise.resolve(false);
	return new Promise((resolveWait) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolveWait(true);
		}, delayMs);
		const abort = (): void => {
			clearTimeout(timer);
			resolveWait(false);
		};
		signal.addEventListener("abort", abort, { once: true });
	});
}

function cleanHarnessEnvironment(identityRoot: string): NodeJS.ProcessEnv {
	const home = join(identityRoot, "home");
	const environment: NodeJS.ProcessEnv = {
		HOME: home,
		USERPROFILE: home,
		CODEX_HOME: join(identityRoot, "codex"),
		CLAUDE_CONFIG_DIR: join(identityRoot, "claude"),
		XDG_CONFIG_HOME: join(identityRoot, "xdg", "config"),
		XDG_DATA_HOME: join(identityRoot, "xdg", "data"),
		XDG_CACHE_HOME: join(identityRoot, "xdg", "cache"),
		PATH: process.env.PATH ?? "",
		NO_COLOR: "1",
		BROWSER: "echo",
		DISABLE_AUTOUPDATER: "1",
	};
	for (const key of ["SystemRoot", "ComSpec", "PATHEXT", "WINDIR"]) {
		if (process.env[key]) environment[key] = process.env[key];
	}
	return environment;
}

async function prepareHarnessEnvironment(identityRoot: string): Promise<NodeJS.ProcessEnv> {
	await Promise.all(
		["home", "codex", "claude", join("xdg", "config"), join("xdg", "data"), join("xdg", "cache")].map((path) =>
			mkdir(join(identityRoot, path), { recursive: true, mode: 0o700 }),
		),
	);
	return cleanHarnessEnvironment(identityRoot);
}

async function collectCapsuleFiles(root: string, durablePaths?: ReadonlySet<string>): Promise<CapsuleArchive> {
	const files: CapsuleFile[] = [];
	let totalBytes = 0;
	const durablePathList = durablePaths === undefined ? undefined : [...durablePaths];
	const containsDurableFile = (path: string): boolean =>
		durablePathList === undefined || durablePathList.some((durablePath) => durablePath.startsWith(`${path}/`));
	const visit = async (directory: string, prefix: string): Promise<void> => {
		const metadata = await lstat(directory);
		if (!metadata.isDirectory()) throw new Error("Credential capsule directory is unsafe");
		const handle =
			process.platform === "linux"
				? await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
				: undefined;
		try {
			if (handle) {
				const opened = await handle.stat();
				if (!opened.isDirectory() || opened.dev !== metadata.dev || opened.ino !== metadata.ino)
					throw new Error("Credential capsule directory changed");
			}
			// Linux deployment walks from open directory descriptors. Renaming a
			// parent into a symlink cannot redirect a later child read outside it.
			const anchored = handle ? `/proc/self/fd/${handle.fd}` : directory;
			const entries = await readdir(anchored, { withFileTypes: true });
			entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
			for (const entry of entries) {
				const absolute = join(anchored, entry.name);
				const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
				if (!safeRelativePath(relativePath)) throw new Error("Credential capsule contains an invalid path");
				const entryMetadata = await lstat(absolute);
				// Compatibility aliases are still ignored at login. Losing a path
				// from the original capsule during refresh is an error below, not
				// permission to replace stored credentials with an incomplete archive.
				if (entryMetadata.isSymbolicLink()) continue;
				if (entryMetadata.isDirectory()) {
					if (!containsDurableFile(relativePath)) continue;
					await visit(absolute, relativePath);
					continue;
				}
				if (!entryMetadata.isFile()) throw new Error("Credential capsule contains an unsupported entry");
				if (durablePaths !== undefined && !durablePaths.has(relativePath)) continue;
				totalBytes += entryMetadata.size;
				if (files.length >= MAX_CAPSULE_FILES || totalBytes > MAX_CAPSULE_PLAINTEXT_BYTES)
					throw new Error("Credential capsule exceeds its storage budget");
				files.push({
					path: relativePath,
					mode: entryMetadata.mode & 0o777,
					data: (await readCapsuleFile(absolute, entryMetadata)).toString("base64"),
				});
			}
		} finally {
			await handle?.close();
		}
	};
	await visit(root, "");
	if (durablePaths && (files.length !== durablePaths.size || files.some((file) => !durablePaths.has(file.path))))
		throw new Error("Credential capsule lost an original credential path");
	return { schema: CAPSULE_SCHEMA, files };
}

async function readCapsuleFile(path: string, expected: Stats): Promise<Buffer> {
	// O_NONBLOCK makes a raced FIFO fail its type check instead of hanging
	// credential finalization. O_NOFOLLOW prevents a raced symlink dereference.
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const opened = await handle.stat();
		if (
			!opened.isFile() ||
			opened.nlink !== 1 ||
			opened.dev !== expected.dev ||
			opened.ino !== expected.ino ||
			opened.size !== expected.size ||
			opened.mtimeMs !== expected.mtimeMs ||
			opened.ctimeMs !== expected.ctimeMs ||
			(process.getuid && opened.uid !== process.getuid())
		)
			throw new Error("Credential capsule file is unsafe or changed");
		// Read at most the validated size plus one byte. readFile() after lstat
		// could otherwise allocate past the capsule budget if a file grew.
		const data = Buffer.alloc(opened.size + 1);
		let offset = 0;
		while (offset < data.length) {
			const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		const after = await handle.stat();
		const linked = await lstat(path);
		if (
			offset !== opened.size ||
			after.size !== opened.size ||
			after.nlink !== 1 ||
			after.mtimeMs !== opened.mtimeMs ||
			after.ctimeMs !== opened.ctimeMs ||
			!linked.isFile() ||
			linked.dev !== opened.dev ||
			linked.ino !== opened.ino
		)
			throw new Error("Credential capsule file is unsafe or changed");
		return data.subarray(0, offset);
	} finally {
		await handle.close();
	}
}

async function restoreCapsuleFiles(
	root: string,
	archive: CapsuleArchive,
	credentialPaths?: ReadonlySet<string>,
): Promise<void> {
	if (archive.schema !== CAPSULE_SCHEMA || !Array.isArray(archive.files) || archive.files.length > MAX_CAPSULE_FILES) {
		throw new Error("Credential capsule archive is invalid");
	}
	let totalBytes = 0;
	const paths = new Set<string>();
	const directories = new Set<string>();
	for (const file of archive.files) {
		if (
			!safeRelativePath(file.path) ||
			paths.has(file.path) ||
			directories.has(file.path) ||
			!Number.isSafeInteger(file.mode) ||
			file.mode < 0 ||
			file.mode > 0o777 ||
			typeof file.data !== "string"
		) {
			throw new Error("Credential capsule entry is invalid");
		}
		const components = file.path.split("/");
		for (let index = 1; index < components.length; index++) {
			const parent = components.slice(0, index).join("/");
			if (paths.has(parent)) throw new Error("Credential capsule entry is invalid");
			directories.add(parent);
		}
		paths.add(file.path);
		const bytes = Buffer.from(file.data, "base64");
		totalBytes += bytes.byteLength;
		if (totalBytes > MAX_CAPSULE_PLAINTEXT_BYTES) throw new Error("Credential capsule exceeds its storage budget");
		const target = resolve(root, ...file.path.split("/"));
		const child = relative(root, target);
		if (!child || child === ".." || child.startsWith(`..${sep}`)) {
			throw new Error("Credential capsule entry escapes its identity root");
		}
		// The login archive is not runtime configuration. Validate the complete
		// archive, but materialize only credentials selected by trusted host
		// policy. Extra CLI state must never enter the native auth-only mount.
		if (credentialPaths && !credentialPaths.has(file.path)) continue;
		await mkdir(dirname(target), { recursive: true, mode: 0o700 });
		await writeFile(target, bytes, { flag: "wx", mode: file.mode & 0o700 });
		await chmod(target, file.mode & 0o700);
	}
	if (credentialPaths && [...credentialPaths].some((path) => !paths.has(path)))
		throw new Error("Credential capsule is missing a required credential path");
}

function capsuleKey(value: string): Buffer {
	const key = Buffer.from(value, "base64url");
	if (key.byteLength !== 32) throw new Error("Native credential capsule key must contain 32 bytes");
	return key;
}

function credentialSealingFailure(error: unknown): string {
	if (!(error instanceof Error)) return "unknown";
	for (const [message, reason] of [
		["Credential capsule contains an invalid path", "invalid-path"],
		["Credential capsule cannot contain symbolic links", "symbolic-link"],
		["Credential capsule contains an unsupported entry", "unsupported-entry"],
		["Credential capsule exceeds its storage budget", "storage-budget"],
		["Credential capsule directory is unsafe", "unsafe-directory"],
		["Credential capsule directory changed", "changed-directory"],
		["Credential capsule file is unsafe or changed", "unsafe-file"],
		["Credential capsule lost an original credential path", "missing-credential"],
	] as const) {
		if (error.message === message) return reason;
	}
	return harnessExecutionFailureCategory(error);
}

/** Transport codes that say an answer was lost on its way, never that it was refused. */
const LOST_ANSWER_CODES = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"ETIMEDOUT",
	"EPIPE",
	"EAI_AGAIN",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"UND_ERR_SOCKET",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
]);

/** Whether a credential download got no answer: its request's deadline passed, the connection failed or was cut (28
 * October 2026), or the vault answered 503 `busy` because its database could not serve the call (3 November 2026). An
 * answer that says no (a refusal, a revoked login, or the broker's 403 for any other failure of its own), a malformed
 * answer and a redirect are answers. */
function credentialDownloadLost(error: unknown): boolean {
	let current = error;
	for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
		if (
			current instanceof CloudRequestTimeoutError ||
			current instanceof CloudSecretBrokerBusyError ||
			current.name === "TimeoutError"
		)
			return true;
		if (LOST_ANSWER_CODES.has(String((current as NodeJS.ErrnoException).code))) return true;
		current = current.cause;
	}
	return false;
}

function harnessExecutionFailureCategory(error: unknown): string {
	if (!(error instanceof Error)) return "unknown";
	const code = (error as NodeJS.ErrnoException).code;
	if (
		error.name === "AbortError" ||
		code === "ABORT_ERR" ||
		["Native execution cancelled", "Native execution stopped", "Native provider host stopped"].includes(error.message)
	) {
		return "cancelled";
	}
	if (error.name === "TimeoutError" || code === "ETIMEDOUT") return "timeout";
	if (code === "ENOENT" || code === "ENOTDIR") return "filesystem-not-found";
	if (code === "EACCES" || code === "EPERM") return "filesystem-permission";
	if (code === "EROFS") return "filesystem-read-only";
	if (code === "EISDIR" || code === "ENOTEMPTY") return "filesystem-layout";
	if (code === "ENOSPC") return "resource-capacity";
	if (code === "EMFILE" || code === "ENFILE") return "resource-file-descriptors";
	if (code === "ENOMEM") return "resource-memory";
	if (code === "EPIPE" || code === "ERR_STREAM_WRITE_AFTER_END") return "process-pipe";
	return "unknown";
}

/** The host starts no public mouth for a company run (the company runtime sends through its own), so every
 * failure keeps the fixed `[mouth=uninitialized]` suffix it always carried. */
function safeHarnessExecutionFailure(error: unknown): Error {
	let message: string;
	const metadata = nativeRuntimeFailureMetadata(error);
	if (metadata) {
		message = `Native provider execution failed (stage=${metadata.stage}, category=${metadata.category})`;
	} else if (
		error instanceof Error &&
		(/^Provider harness exited with [A-Za-z0-9_-]{1,32}(?: \((?:authentication|model|provider allowance|provider capacity|provider context|provider network|provider policy|local sandbox|provider request|provider authorization|provider tool schema|harness configuration|harness internal|public message transport) unavailable\))?$/.test(
			error.message,
		) ||
			/^Codex did not complete its turn(?: \((?:authentication|model|provider allowance|provider capacity|provider context|provider network|provider policy|local sandbox|provider request|provider authorization|provider tool schema|harness configuration|harness internal|public message transport) unavailable\))?$/.test(
				error.message,
			) ||
			error.message === "Provider harness output exceeded its byte limit")
	) {
		message = error.message;
	} else {
		message = `Native provider execution harness-execution stage failed (${harnessExecutionFailureCategory(error)})`;
	}
	return new Error(`${message} [mouth=uninitialized]`, { cause: error });
}

export async function sealNativeCredentialCapsule(
	root: string,
	keyValue: string,
	capsuleId: string,
	durablePaths?: ReadonlySet<string>,
): Promise<Uint8Array> {
	requiredUuid(capsuleId, "Credential capsule id");
	const archive = await collectCapsuleFiles(requiredAbsolutePath(root, "Credential capsule root"), durablePaths);
	const plaintext = Buffer.from(JSON.stringify(archive), "utf-8");
	if (plaintext.byteLength > MAX_CAPSULE_PLAINTEXT_BYTES)
		throw new Error("Credential capsule exceeds its storage budget");
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", capsuleKey(keyValue), nonce);
	cipher.setAAD(Buffer.from(`${CAPSULE_SCHEMA}:${capsuleId}`, "utf-8"));
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const tag = cipher.getAuthTag();
	return Buffer.concat([Buffer.from("QNC1", "ascii"), nonce, tag, ciphertext]);
}

/** Digest of a login's credential files (paths and bytes, not modes): tells whether a run
 * changed its login, and whether the stored login is still the one a run started from. */
function credentialArchiveDigest(files: readonly CapsuleFile[], durablePaths: ReadonlySet<string>): string {
	const entries = files
		.filter((file) => durablePaths.has(file.path))
		.map((file) => [file.path, file.data] as const)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	if (entries.length !== durablePaths.size) throw new Error("Credential capsule lost an original credential path");
	return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

async function credentialFilesDigest(root: string, durablePaths: ReadonlySet<string>): Promise<string> {
	const archive = await collectCapsuleFiles(requiredAbsolutePath(root, "Credential capsule root"), durablePaths);
	return credentialArchiveDigest(archive.files, durablePaths);
}

function storedCredentialDigest(
	bytes: Uint8Array,
	keyValue: string,
	capsuleId: string,
	durablePaths: ReadonlySet<string>,
): string {
	return credentialArchiveDigest(decryptCapsuleArchive(bytes, keyValue, capsuleId).files, durablePaths);
}

function decryptCapsuleArchive(bytes: Uint8Array, keyValue: string, capsuleId: string): CapsuleArchive {
	requiredUuid(capsuleId, "Credential capsule id");
	if (bytes.byteLength < 32 || Buffer.from(bytes.subarray(0, 4)).toString("ascii") !== "QNC1") {
		throw new Error("Credential capsule envelope is invalid");
	}
	const nonce = bytes.subarray(4, 16);
	const tag = bytes.subarray(16, 32);
	const ciphertext = bytes.subarray(32);
	const decipher = createDecipheriv("aes-256-gcm", capsuleKey(keyValue), nonce);
	decipher.setAAD(Buffer.from(`${CAPSULE_SCHEMA}:${capsuleId}`, "utf-8"));
	decipher.setAuthTag(Buffer.from(tag));
	try {
		return JSON.parse(
			Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8"),
		) as CapsuleArchive;
	} catch (error) {
		throw new Error("Credential capsule failed authenticated decryption", { cause: error });
	}
}

export async function openNativeCredentialCapsule(
	bytes: Uint8Array,
	root: string,
	keyValue: string,
	capsuleId: string,
	credentialPaths?: ReadonlySet<string>,
): Promise<void> {
	const archive = decryptCapsuleArchive(bytes, keyValue, capsuleId);
	await restoreCapsuleFiles(requiredAbsolutePath(root, "Credential capsule root"), archive, credentialPaths);
}

function collectChildOutput(child: NativeHarnessChild): {
	output: () => string;
	completed: Promise<void>;
} {
	let output = "";
	let exceeded = false;
	const append = (chunk: Buffer): void => {
		if (exceeded) return;
		output += chunk.toString("utf-8");
		if (Buffer.byteLength(output) > MAX_HARNESS_OUTPUT_BYTES) exceeded = true;
	};
	child.stdout.on("data", append);
	child.stderr.on("data", append);
	return {
		output: () => output,
		completed: new Promise<void>((resolveChild, reject) => {
			child.once("error", reject);
			child.once("close", (code, signal) => {
				if (exceeded) reject(new Error("Provider harness output exceeded its byte limit"));
				else if (code !== 0) {
					const category = nativeHarnessFailureCategory(output);
					reject(
						new Error(
							`Provider harness exited with ${code ?? signal ?? "failure"}${category ? ` (${category})` : ""}`,
						),
					);
				} else resolveChild();
			});
		}),
	};
}

export type NativeProviderUsageSignal = "usage_limit" | "rate_limited" | "provider_outage";

/**
 * Typed usage signal from a harness failure (contract section 17). The
 * adapter distinguishes quota exhaustion (switch sponsor), transient rate
 * limiting (retry) and provider outage (wait or fail over) from the safe
 * failure category the host attached, never from provider text. Any other
 * failure is not a usage signal.
 */
export function nativeProviderUsageSignal(error: unknown): NativeProviderUsageSignal | undefined {
	const metadata = nativeRuntimeFailureMetadata(error);
	if (metadata) return metadata.usageSignal ?? undefined;
	let current: unknown = error;
	for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
		const match = /\((provider allowance|provider capacity|provider network) unavailable\)/.exec(current.message);
		if (match) {
			if (match[1] === "provider allowance") return "usage_limit";
			if (match[1] === "provider capacity") return "rate_limited";
			return "provider_outage";
		}
		current = current.cause;
	}
	return undefined;
}

function nativeHarnessFailureCategory(output: string): string | undefined {
	const diagnostics: string[] = [];
	for (const line of output.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as Record<string, unknown>;
			if (event.type === "error" && typeof event.message === "string") diagnostics.push(event.message);
			if (event.error && typeof event.error === "object") {
				const failure = event.error as Record<string, unknown>;
				const message = failure.message;
				if (typeof message === "string") diagnostics.push(message);
				if (typeof failure.code === "string") diagnostics.push(failure.code);
				if (typeof failure.type === "string") diagnostics.push(failure.type);
			}
			if (event.type === "item.completed" && event.item && typeof event.item === "object") {
				const item = event.item as Record<string, unknown>;
				if (item.type === "error" && typeof item.message === "string") diagnostics.push(item.message);
			}
		} catch {
			// Startup failures can be plain stderr. The text is classified below but is never emitted.
			diagnostics.push(line);
		}
	}
	const detail = diagnostics.join("\n").toLowerCase();
	if (!detail) return undefined;
	if (
		/(?:mcp|send_message|public mouth).*(?:fail|error|timed? ?out|timeout|unauthor|invalid|reject)|(?:fail|error|timed? ?out|timeout).*(?:mcp|public mouth)/.test(
			detail,
		)
	) {
		return "public message transport unavailable";
	}
	if (
		/error loading config|failed to (?:load|read|parse) config|invalid configuration|config.*toml.*error|missing environment variable/.test(
			detail,
		)
	) {
		return "harness configuration unavailable";
	}
	if (
		/invalid_function_parameters|invalid_json_schema|invalid.*(?:tool|function).*schema|schema.*(?:tool|function).*invalid|duplicate tool:/.test(
			detail,
		)
	) {
		return "provider tool schema unavailable";
	}
	if (
		/unauthori[sz]ed|authentication|not logged in|login required|sign in again|refresh.?token|access.?token.*(?:refresh|expired|invalid)|status(?: code)? 401|\b401\b/.test(
			detail,
		)
	) {
		return "authentication unavailable";
	}
	if (/forbidden|insufficient_scope|status(?: code)? 403|\b403\b/.test(detail)) {
		return "provider authorization unavailable";
	}
	if (/model .*(?:not found|unsupported|unavailable)|unknown model|invalid model/.test(detail)) {
		return "model unavailable";
	}
	if (/not supported (?:for|on) (?:this )?model|unsupported (?:parameter|option)/.test(detail)) {
		return "model unavailable";
	}
	if (
		/usage[_ ]limit|quota|out of credits|spend cap|upgrade to plus|shared rollout token budget exhausted/.test(detail)
	) {
		return "provider allowance unavailable";
	}
	if (/context[_ ]window|maximum context length|too many tokens/.test(detail)) {
		return "provider context unavailable";
	}
	if (/content[_ ]filter|content policy|cyber[_ ]policy|misalignment[_ ]policy/.test(detail)) {
		return "provider policy unavailable";
	}
	if (/rate.?limit|too many requests|at capacity|high demand|status(?: code)? 429|\b429\b/.test(detail)) {
		return "provider capacity unavailable";
	}
	if (
		/network|timed? out|timeout|connection|stream disconnected|dns|tls|certificate|socket|status(?: code)? 50[234]/.test(
			detail,
		)
	) {
		return "provider network unavailable";
	}
	if (/sandbox|workspace|permission denied|operation not permitted|read-only file system/.test(detail)) {
		return "local sandbox unavailable";
	}
	if (
		/bad request|invalid[_ ]request|unprocessable|unsupported operation|status(?: code)? 4(?:00|04|22)/.test(detail)
	) {
		return "provider request unavailable";
	}
	if (/agent loop died|session configured event was not the first|spawn failed|thread .*panicked/.test(detail)) {
		return "harness internal unavailable";
	}
	return undefined;
}

function interactionFromOutput(output: string): NativeHarnessLoginPrompt {
	const ansiCsiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
	const plainOutput = output.replace(ansiCsiPattern, "");
	const interactionUrl = plainOutput.match(/https:\/\/[^\s<>'"`]+/i)?.[0]?.replace(/[),.;]+$/, "");
	const standaloneCode = plainOutput
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => /^[A-Z0-9]{2,32}(?:-[A-Z0-9]{2,32})+$/.test(line));
	const labeledCode = plainOutput.match(/(?:code|enter)\s*[:=]\s*([A-Z0-9-]{4,64})/i)?.[1];
	const explicitCode = standaloneCode ?? labeledCode;
	return {
		...(interactionUrl ? { interactionUrl } : {}),
		...(explicitCode ? { userCode: explicitCode } : {}),
	};
}

/** Removes a harness root; a directory that gains an entry while it is emptied is retried. */
async function removeHarnessRoot(root: string): Promise<void> {
	await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

async function terminateChild(child: NativeHarnessChild): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	await new Promise<void>((resolveWait) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolveWait();
		}, 5000);
		child.once("close", () => {
			clearTimeout(timer);
			resolveWait();
		});
	});
}

export class OfficialCliNativeHarnessDriver implements NativeHarnessDriver {
	readonly #codexPath: string;
	readonly #claudePath: string;
	readonly #isolation: NativeIsolationConfiguration | undefined;
	readonly #scratchParent: string | undefined;
	readonly #beforeLaunch: (() => Promise<void>) | undefined;

	constructor(
		codexPath = "codex",
		claudePath = "claude",
		isolation?: NativeIsolationConfiguration,
		options: {
			/** Where an isolated sign-in's scratch lives (default: the system temporary directory).
			 * The isolation launcher needs a path at least three levels deep. */
			scratchParent?: string;
			/** Checked before every launch (the vault's helper re-checks its pinned binary). */
			beforeLaunch?: () => Promise<void>;
		} = {},
	) {
		this.#codexPath = codexPath;
		this.#claudePath = claudePath;
		this.#isolation = isolation ? Object.freeze({ ...isolation }) : undefined;
		if (options.scratchParent !== undefined)
			requiredAbsolutePath(options.scratchParent, "Native sign-in scratch parent");
		this.#scratchParent = options.scratchParent;
		this.#beforeLaunch = options.beforeLaunch;
	}

	async #loginProcess(
		command: string,
		args: string[],
		root: string,
		environment: NodeJS.ProcessEnv,
		signal: AbortSignal,
	): Promise<{ child: NativeHarnessChild; close(): Promise<void> }> {
		signal.throwIfAborted();
		await this.#beforeLaunch?.();
		signal.throwIfAborted();
		if (!this.#isolation) {
			const child = spawn(command, args, {
				cwd: root,
				env: environment,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			return { child, close: () => terminateChild(child) };
		}
		const scratchRoot = await mkdtemp(join(this.#scratchParent ?? tmpdir(), "qorpera-native-auth-"));
		try {
			for (const name of ["workspace", "home", "config", "data", "cache"])
				await mkdir(join(scratchRoot, name), { mode: 0o700 });
			const isolated = await launchIsolatedNativeProcess({
				configuration: this.#isolation,
				command,
				args,
				scratchRoot,
				codexHome: join(root, "codex"),
				signal,
			});
			isolated.child.stdin.end();
			return {
				child: isolated.child,
				async close() {
					await isolated.close();
					await rm(scratchRoot, { recursive: true, force: true });
				},
			};
		} catch (error) {
			await rm(scratchRoot, { recursive: true, force: true });
			throw error;
		}
	}

	async beginLogin(
		harness: NativeHarnessKind,
		identityRoot: string,
		signal?: AbortSignal,
	): Promise<NativeHarnessLoginHandle> {
		if (this.#isolation && harness !== "codex-cli")
			throw new Error("The governed native runtime currently accepts Codex only");
		const root = requiredAbsolutePath(identityRoot, "Native identity root");
		const environment = await prepareHarnessEnvironment(root);
		const command = harness === "codex-cli" ? this.#codexPath : this.#claudePath;
		const args = harness === "codex-cli" ? ["login", "--device-auth"] : ["auth", "login", "--claudeai"];
		const cancellation = new AbortController();
		const loginSignal = AbortSignal.any([
			cancellation.signal,
			AbortSignal.timeout(600_000),
			...(signal ? [signal] : []),
		]);
		const launched = await this.#loginProcess(command, args, root, environment, loginSignal);
		const child = launched.child;
		const capture = collectChildOutput(child);
		const abort = (): void => {
			void launched.close();
		};
		loginSignal.addEventListener("abort", abort, { once: true });
		if (loginSignal.aborted) abort();
		const prompt = new Promise<NativeHarnessLoginPrompt>((resolvePrompt, reject) => {
			const started = Date.now();
			const poll = (): void => {
				const parsed = interactionFromOutput(capture.output());
				if (parsed.interactionUrl || parsed.userCode || child.exitCode !== null) {
					resolvePrompt(parsed);
					return;
				}
				if (Date.now() - started >= 10_000) {
					reject(new Error("Provider login did not present an official interaction URL"));
					return;
				}
				setTimeout(poll, 50);
			};
			poll();
		});
		const completed = capture.completed
			.then(async () => {
				loginSignal.throwIfAborted();
				const statusArgs = harness === "codex-cli" ? ["login", "status"] : ["auth", "status"];
				const status = await this.#loginProcess(command, statusArgs, root, environment, loginSignal);
				const stopStatus = (): void => {
					void status.close();
				};
				loginSignal.addEventListener("abort", stopStatus, { once: true });
				try {
					const checked = collectChildOutput(status.child);
					await checked.completed;
					loginSignal.throwIfAborted();
					const reference = checked.output().trim();
					const metadata =
						harness === "codex-cli"
							? Buffer.from(
									(await collectCapsuleFiles(root, CODEX_CREDENTIAL_PATHS)).files[0]!.data,
									"base64",
								).toString("utf-8")
							: reference;
					const providerAccountEmail = nativeProviderAccountEmail(harness, metadata);
					loginSignal.throwIfAborted();
					return {
						...(reference
							? {
									providerAccountReference: `${harness}:${createHash("sha256").update(reference).digest("hex")}`,
								}
							: {}),
						...(providerAccountEmail ? { providerAccountEmail } : {}),
					};
				} finally {
					loginSignal.removeEventListener("abort", stopStatus);
					await status.close();
				}
			})
			.finally(async () => {
				loginSignal.removeEventListener("abort", abort);
				await launched.close();
			});
		void completed.catch(() => undefined);
		return {
			prompt,
			completed,
			cancel: async () => {
				cancellation.abort();
				await launched.close();
			},
		};
	}
}

function exactDescription(request: NativeProviderLoginRequest, description: NativeProviderLoginDescription): void {
	if (
		description.loginId !== request.loginId ||
		description.clientConnectionId !== request.clientConnectionId ||
		description.computeIdentityId !== request.computeIdentityId ||
		description.computeIdentityOwnershipKind !== request.computeIdentityOwnershipKind ||
		description.computeIdentityOwnerUserId !== request.computeIdentityOwnerUserId ||
		description.computeIdentityOwnerScopeKey !== request.computeIdentityOwnerScopeKey ||
		description.provider !== request.provider ||
		description.nativeHarness !== request.nativeHarness ||
		description.expiresAt !== request.expiresAt
	) {
		throw new Error("Native login request does not match its durable control-plane authority");
	}
}

export class NativeProviderHost {
	readonly #controlPlane: NativeProviderControlPlane;
	readonly #capsules: NativeCredentialCapsuleStore;
	readonly #harness: NativeHarnessDriver;
	readonly #cloudRuntime?: NativeCloudExecutionDriver;
	readonly #masterKey: string | undefined;
	readonly #modelLogins: NativeModelLoginClient | undefined;
	readonly #modelLoginRecheckMs: number;
	readonly #backupIdentityKey?: (request: NativeProviderLoginRequest) => Promise<void>;
	readonly #computeIdentityId: string;
	readonly #temporaryRoot: string;
	readonly #warmIdleMs?: number;
	readonly #accountMetadata: boolean;
	#warm?: WarmCredentialRoot;
	readonly #logins = new Map<string, LoginState>();
	readonly #metadataShutdown = new AbortController();
	#metadataRefresh?: Promise<void>;

	constructor(options: {
		controlPlane: NativeProviderControlPlane;
		capsules: NativeCredentialCapsuleStore;
		harness: NativeHarnessDriver;
		cloudRuntime?: NativeCloudExecutionDriver;
		/** The identity's capsule key. Absent when the identity's login is kept by the vault. */
		masterKey?: string;
		/** The vault's model logins, for runs whose capsule names a vault login. */
		modelLogins?: NativeModelLoginClient;
		/** How often a run asks the vault for a newer pass (default one minute). */
		modelLoginRecheckMs?: number;
		computeIdentityId: string;
		temporaryRoot?: string;
		backupIdentityKey?: (request: NativeProviderLoginRequest) => Promise<void>;
		/**
		 * Warm conversations (contract amendment 2026-09-27): after a successful company run
		 * the opened capsule stays in its private root for at most this long, for the next run
		 * this host serves. Absent: every run opens and wipes its own root.
		 */
		warmIdleMs?: number;
		/** Whether the host keeps its identity's account metadata (default true). A sign-in's login guest does not:
		 * its credential allows it only the sign-in (G2-3). */
		accountMetadata?: boolean;
	}) {
		if (options.masterKey !== undefined) capsuleKey(options.masterKey);
		if (options.masterKey === undefined && options.modelLogins === undefined)
			throw new Error("Native provider host needs a capsule key or the login vault");
		if (
			options.warmIdleMs !== undefined &&
			(!Number.isSafeInteger(options.warmIdleMs) || options.warmIdleMs < 1 || options.warmIdleMs > 5 * 60_000)
		)
			throw new Error("Native warm window is invalid");
		this.#warmIdleMs = options.warmIdleMs;
		this.#accountMetadata = options.accountMetadata ?? true;
		requiredUuid(options.computeIdentityId, "Native host Compute Identity id");
		this.#controlPlane = options.controlPlane;
		this.#capsules = options.capsules;
		this.#harness = options.harness;
		this.#cloudRuntime = options.cloudRuntime;
		this.#masterKey = options.masterKey;
		this.#modelLogins = options.modelLogins;
		this.#modelLoginRecheckMs = options.modelLoginRecheckMs ?? MODEL_LOGIN_RECHECK_MS;
		this.#backupIdentityKey = options.backupIdentityKey;
		this.#computeIdentityId = options.computeIdentityId;
		this.#temporaryRoot = resolve(options.temporaryRoot ?? tmpdir());
	}

	/** The identity's capsule key; a host serving only vault logins has none. */
	#capsuleKey(): string {
		if (this.#masterKey === undefined) throw new Error("Native credential key is unavailable");
		return this.#masterKey;
	}

	/** Takes the warm root for this key; a warm root for another key is wiped. */
	async #takeWarm(key: string | undefined): Promise<WarmCredentialRoot | undefined> {
		const warm = this.#warm;
		if (!warm) return undefined;
		this.#warm = undefined;
		clearTimeout(warm.timer);
		if (warm.key === key) return warm;
		await this.#wipeRoot(warm.root);
		return undefined;
	}

	async #wipeRoot(root: string): Promise<void> {
		await this.#cloudRuntime?.disposeSpares?.(root).catch(() => undefined);
		await removeHarnessRoot(root);
	}

	/** Wipes a kept capsule root now (service shutdown). */
	async releaseWarm(): Promise<void> {
		const warm = await this.#takeWarm(undefined);
		if (warm) await this.#wipeRoot(warm.root);
	}

	/** Display metadata refreshes never modify the credential capsule or start a model turn. */
	async refreshRequestedAccountMetadata(
		request: NativeAccountRefreshRequest,
		signal?: AbortSignal,
	): Promise<JsonValue> {
		if (
			request.computeIdentityId !== this.#computeIdentityId ||
			!this.#controlPlane.describeAccountRefresh ||
			!this.#controlPlane.completeAccountRefresh
		)
			throw new Error("Account refresh authority unavailable");
		const checked = AbortSignal.any([
			this.#metadataShutdown.signal,
			AbortSignal.timeout(55_000),
			...(signal ? [signal] : []),
		]);
		const authority = await this.#controlPlane.describeAccountRefresh(request.requestId, request.capability, checked);
		if (
			authority.computeIdentityId !== request.computeIdentityId ||
			authority.requestedByUserId !== request.requestedByUserId ||
			Date.parse(authority.expiresAt) !== Date.parse(request.expiresAt) ||
			Date.parse(authority.expiresAt) <= Date.now()
		)
			throw new Error("Account refresh authority changed");
		if (authority.status !== "completed") {
			await this.refreshAccountMetadata(checked);
			checked.throwIfAborted();
			// Completion records a finished attempt after the database rechecks the
			// live epoch and requester. Failed provider reads remain unknown.
			if (!(await this.#controlPlane.completeAccountRefresh(request.requestId, request.capability, checked)))
				throw new Error("Account usage is unavailable");
		}
		checked.throwIfAborted();
		return { schema: NATIVE_ACCOUNT_REFRESH_RESULT_SCHEMA, request_id: request.requestId, status: "completed" };
	}

	async refreshAccountMetadata(signal?: AbortSignal): Promise<void> {
		if (!this.#accountMetadata) return;
		if (this.#metadataRefresh) return this.#metadataRefresh;
		if (this.#metadataShutdown.signal.aborted) return;
		const refresh = this.#refreshAccountMetadata(signal).catch(() => undefined);
		this.#metadataRefresh = refresh;
		try {
			await refresh;
		} finally {
			if (this.#metadataRefresh === refresh) this.#metadataRefresh = undefined;
		}
	}

	async stopAccountMetadataRefresh(): Promise<void> {
		this.#metadataShutdown.abort();
		await this.#metadataRefresh;
	}

	async #refreshAccountMetadata(signal?: AbortSignal): Promise<void> {
		const control = this.#controlPlane;
		if (!control.listAccountRefreshes || !control.recordAccountMetadata) return;
		const refreshSignal = AbortSignal.any([
			this.#metadataShutdown.signal,
			AbortSignal.timeout(45_000),
			...(signal ? [signal] : []),
		]);
		refreshSignal.throwIfAborted();
		const accounts = await control.listAccountRefreshes(this.#computeIdentityId, refreshSignal);
		for (const account of accounts.slice(0, 64)) {
			if (refreshSignal.aborted) break;
			if (account.nativeHarness !== "codex-cli") continue;
			// A login kept by the vault is read there (Stateless Compute step 1), never on a node.
			if (MODEL_LOGIN_REFERENCE.test(account.encryptedCapsuleReference) || this.#masterKey === undefined) continue;
			let root: string | undefined;
			try {
				const accountSignal = AbortSignal.any([refreshSignal, AbortSignal.timeout(15_000)]);
				const capsule = await this.#capsules.get(account.encryptedCapsuleReference, accountSignal);
				accountSignal.throwIfAborted();
				root = await mkdtemp(join(this.#temporaryRoot, "qorpera-native-account-"));
				await openNativeCredentialCapsule(
					capsule,
					root,
					this.#capsuleKey(),
					account.capsuleId,
					CODEX_CREDENTIAL_PATHS,
				);
				const metadata = (await collectCapsuleFiles(root, CODEX_CREDENTIAL_PATHS)).files[0]!;
				const credential = Buffer.from(metadata.data, "base64").toString("utf8");
				// Revocation or recovery during download must prevent provider credential use.
				const current = await control.listAccountRefreshes(this.#computeIdentityId, accountSignal);
				if (
					!current.some(
						(item) =>
							item.connectionId === account.connectionId &&
							item.connectionVersion === account.connectionVersion &&
							item.capsuleId === account.capsuleId &&
							item.encryptedCapsuleReference === account.encryptedCapsuleReference &&
							item.nativeHarness === account.nativeHarness,
					)
				)
					continue;
				accountSignal.throwIfAborted();
				const providerAccountEmail = nativeProviderAccountEmail("codex-cli", credential);
				const providerAccountIdentity = nativeProviderAccountIdentity(credential);
				const providerAccountUsage = await readNativeProviderAccountUsage(credential, accountSignal).catch(
					() => undefined,
				);
				accountSignal.throwIfAborted();
				if (providerAccountEmail || providerAccountUsage || providerAccountIdentity) {
					await control.recordAccountMetadata(
						this.#computeIdentityId,
						account,
						{
							...(providerAccountEmail ? { providerAccountEmail } : {}),
							...(providerAccountUsage ? { providerAccountUsage } : {}),
							...(providerAccountIdentity ? { providerAccountIdentity } : {}),
						},
						accountSignal,
					);
				}
			} catch {
				// Provider outages and stale authority must not affect login or execution.
			} finally {
				if (root) await rm(root, { recursive: true, force: true });
			}
		}
	}

	async beginLogin(request: NativeProviderLoginRequest, signal?: AbortSignal): Promise<JsonValue> {
		requiredUuid(request.loginId, "Native login id");
		requiredUuid(request.clientConnectionId, "Native client connection id");
		requiredUuid(request.computeIdentityId, "Native compute identity id");
		if (request.computeIdentityId !== this.#computeIdentityId) {
			throw new Error("Native login names another Compute Identity");
		}
		if (
			!TOKEN_PATTERN.test(request.capability) ||
			!Number.isFinite(Date.parse(request.expiresAt)) ||
			Date.parse(request.expiresAt) <= Date.now()
		) {
			throw new Error("Native login capability is invalid");
		}
		const existing = this.#logins.get(request.loginId);
		if (existing) {
			if (!sameLogin(existing.request, request)) throw new Error("Native login id is bound to another request");
			if (existing.status === "failed") throw existing.error ?? new Error("Native provider login failed");
			return {
				schema: LOGIN_RESULT_SCHEMA,
				login_id: request.loginId,
				status: existing.status === "completed" ? "completed" : "awaiting_member",
				interaction_url: existing.prompt.interactionUrl ?? null,
				user_code: existing.prompt.userCode ?? null,
			};
		}
		const description = await this.#controlPlane.describeLogin(request.loginId, request.capability, signal);
		exactDescription(request, description);
		const root = await mkdtemp(join(this.#temporaryRoot, `qorpera-native-login-${request.loginId}-`));
		const handle = await this.#harness.beginLogin(request.nativeHarness, root, signal);
		const state: LoginState = {
			request: structuredClone(request),
			root,
			handle,
			status: "awaiting_member",
			prompt: {},
		};
		this.#logins.set(request.loginId, state);
		try {
			state.prompt = await handle.prompt;
		} catch (error) {
			state.status = "failed";
			state.error = error instanceof Error ? error : new Error(String(error));
			await handle.cancel().catch(() => undefined);
			await removeHarnessRoot(root);
			throw state.error;
		}
		void this.#finishLogin(state).catch((error: unknown) => {
			state.status = "failed";
			state.error = error instanceof Error ? error : new Error(String(error));
			console.error(state.error.message);
		});
		return {
			schema: LOGIN_RESULT_SCHEMA,
			login_id: request.loginId,
			status: "awaiting_member",
			interaction_url: state.prompt.interactionUrl ?? null,
			user_code: state.prompt.userCode ?? null,
		};
	}

	async execute(request: NativeCompanyExecutionRequest, signal?: AbortSignal): Promise<JsonValue> {
		const { authority } = request;
		const cloudRuntime = this.#cloudRuntime;
		if (request.runtime !== "company-path-v1" || !cloudRuntime) {
			throw new Error("Native provider execution runtime is not configured for this request");
		}
		for (const [label, value] of [
			["Native lease id", authority.leaseId],
			["Native run id", authority.runId],
			["Native capsule id", authority.credentialCapsuleId],
			["Native compute identity id", authority.computeIdentityId],
			["Native runner id", authority.runnerId],
			["Native assignment id", authority.assignmentId],
			["Native job id", request.job.jobId],
		] as const)
			requiredUuid(value, label);
		if (authority.computeIdentityId !== this.#computeIdentityId) {
			throw new Error("Native execution names another Compute Identity");
		}
		if (
			request.job.jobType !== "agent_turn" ||
			request.job.requiredCapability !== "agent_turn" ||
			!SHA256_PATTERN.test(authority.attestationPolicySha256) ||
			!Number.isFinite(Date.parse(authority.expiresAt)) ||
			Date.parse(authority.expiresAt) <= Date.now() ||
			!authority.encryptedCapsuleReference.trim() ||
			!authority.model.trim()
		) {
			throw new Error("Native execution authority is invalid");
		}
		const executionAbort = new AbortController();
		const externalAbort = (): void => executionAbort.abort(signal?.reason ?? new Error("Native execution stopped"));
		if (signal?.aborted) externalAbort();
		else signal?.addEventListener("abort", externalAbort, { once: true });
		let stage = "initial-authority-validation";
		// When the last check that answered began. A check whose answer is lost or late is asked again while the next
		// try can begin within a native lease's length of it (WB-001, 28 Oct 2026), so a short control-plane outage does
		// not stop the run; the run's worker, which renews the lease, stops it when the lease ends. A refusal, any other
		// failure, or an outage past that still stops the run at once.
		let validatedAt = performance.now();
		const askAgain = (error: unknown, pauseMs: number, stop: AbortSignal): boolean =>
			cloudControlRetryable(error) &&
			!stop.aborted &&
			performance.now() + pauseMs < validatedAt + NATIVE_AUTHORITY_LEASE_SECONDS * 1000;
		try {
			await this.#controlPlane.validateExecution(request, executionAbort.signal);
		} catch (error) {
			throw new Error(`Native provider execution ${stage} stage failed`, { cause: error });
		}
		// A check at the run's end, before its login is kept: asked again after a short pause.
		const validateAtEnd = async (): Promise<void> => {
			for (let attempt = 0; ; attempt++) {
				const started = performance.now();
				try {
					await this.#controlPlane.validateExecution(request, executionAbort.signal);
					validatedAt = started;
					return;
				} catch (error) {
					const pauseMs = cloudControlBackoffMs(attempt);
					if (!askAgain(error, pauseMs, executionAbort.signal)) throw error;
					await cloudControlPause(pauseMs, executionAbort.signal);
				}
			}
		};
		const validationStop = new AbortController();
		let validationError: unknown;
		const validationSignal = AbortSignal.any([executionAbort.signal, validationStop.signal]);
		const monitor = (async () => {
			while (await waitFor(EXECUTION_AUTHORITY_RECHECK_MS, validationSignal)) {
				const started = performance.now();
				try {
					await this.#controlPlane.validateExecution(request, validationSignal);
					validatedAt = started;
				} catch (error) {
					if (askAgain(error, EXECUTION_AUTHORITY_RECHECK_MS, validationSignal)) continue;
					validationError = error;
					executionAbort.abort(error);
					return;
				}
			}
		})();
		let root: string | undefined;
		let durableCredentialPaths: ReadonlySet<string> | undefined;
		let sealedCapsule: Uint8Array | undefined;
		let sealedCredentialDigest: string | undefined;
		// The stored capsule this run started from and its login's digest: the run saves its login
		// back only when it changed it, and only while the store still holds that login.
		let openedCapsule: Uint8Array | undefined;
		let openedCredentialDigest: string | undefined;
		// A login kept by the vault (Stateless Compute step 1): the run holds a copy without its
		// renewal token, keeps it fresh from the vault, and never saves a login back.
		const vaultLogin = MODEL_LOGIN_REFERENCE.test(authority.encryptedCapsuleReference);
		let vaultVersion: number | undefined;
		const vaultStop = new AbortController();
		let vaultRefresh: Promise<void> | undefined;
		let harnessStarted = false;
		// Warm conversations: the capsule root this host kept from its previous company run, reused
		// only while the stored capsule is byte for byte the one that root was opened from or
		// last saved as.
		const warmKey =
			this.#warmIdleMs !== undefined
				? JSON.stringify([
						authority.credentialCapsuleId,
						authority.encryptedCapsuleReference,
						authority.computeIdentityId,
					])
				: undefined;
		let output: JsonValue | undefined;
		let failure: Error | undefined;
		try {
			stage = "temporary-workspace";
			const warm = await this.#takeWarm(warmKey);
			// A kept root belongs to this run from here: every failure path below wipes it.
			root = warm?.root;
			if (vaultLogin) {
				const modelLogins = this.#modelLogins;
				if (!modelLogins) throw new Error("Native login vault is unavailable");
				stage = "credential-download";
				const binding: ModelLoginRunBinding = {
					leaseId: authority.leaseId,
					runId: authority.runId,
					jobId: request.job.jobId,
					runnerId: authority.runnerId,
					assignmentId: authority.assignmentId,
					credentialCapsuleId: authority.credentialCapsuleId,
					computeIdentityId: authority.computeIdentityId,
				};
				const kept = warm?.vaultVersion;
				const login = await modelLogins.issue({ binding, knownVersion: kept ?? null }, executionAbort.signal);
				// A ChatGPT plan login (Sign in with ChatGPT) runs Codex with the plan's access token in a file
				// of its own instead of a Codex login file; a root holds one kind only.
				const plan = "loginKind" in login;
				if (warm && kept === undefined) {
					root = undefined;
					await this.#wipeRoot(warm.root);
				}
				stage = "temporary-workspace";
				root ??= await mkdtemp(join(this.#temporaryRoot, `qorpera-native-run-${authority.runId}-`));
				stage = "credential-opening";
				if ("loginKind" in login ? login.accessToken !== null : login.authJson !== null) {
					if ("loginKind" in login) await writeChatGptPlanToken(root, login.accessToken as string);
					else await writeModelLogin(root, login.authJson as string);
				} else if (kept !== login.version) throw new Error("Native login vault returned no login");
				vaultVersion = login.version;
				durableCredentialPaths = plan ? CHATGPT_PLAN_CREDENTIAL_PATHS : CODEX_CREDENTIAL_PATHS;
				// The pass ends by itself; ask the vault for a newer one while the run goes on. Codex
				// re-reads its login file before it would renew, and never renews without a token.
				const runRoot = root;
				const refreshSignal = AbortSignal.any([executionAbort.signal, vaultStop.signal]);
				vaultRefresh = (async () => {
					while (await waitFor(this.#modelLoginRecheckMs, refreshSignal)) {
						try {
							const next = await modelLogins.issue(
								{ binding, knownVersion: vaultVersion ?? null },
								refreshSignal,
							);
							// A copy comes back whenever the vault opened the login for this call: a newer
							// version, or the same version after a renewal attempt (a pass it renewed but
							// could not save keeps the old number). Writing it again is harmless. A copy of
							// another kind than the run started with is never written.
							if (plan && "loginKind" in next && next.accessToken !== null) {
								await writeChatGptPlanToken(runRoot, next.accessToken);
								vaultVersion = next.version;
							} else if (!plan && "authJson" in next && next.authJson !== null) {
								await writeModelLogin(runRoot, next.authJson);
								vaultVersion = next.version;
							}
						} catch {
							// The current pass stays in place; the next check tries again.
						}
					}
				})();
			} else {
				stage = "credential-download";
				const capsule = await this.#capsules.get(authority.encryptedCapsuleReference, executionAbort.signal);
				if (warm?.sealed && Buffer.from(capsule).equals(Buffer.from(warm.sealed))) {
					durableCredentialPaths = warm.durable;
					openedCredentialDigest = warm.digest;
				} else {
					if (warm) {
						root = undefined;
						await this.#wipeRoot(warm.root);
					}
					stage = "temporary-workspace";
					root = await mkdtemp(join(this.#temporaryRoot, `qorpera-native-run-${authority.runId}-`));
					stage = "credential-opening";
					await openNativeCredentialCapsule(
						capsule,
						root,
						this.#capsuleKey(),
						authority.credentialCapsuleId,
						CODEX_CREDENTIAL_PATHS,
					);
					durableCredentialPaths = new Set((await collectCapsuleFiles(root)).files.map((file) => file.path));
				}
				if (!root || !durableCredentialPaths) throw new Error("Native credential root is unavailable");
				stage = "credential-opening";
				openedCredentialDigest ??= await credentialFilesDigest(root, durableCredentialPaths);
				openedCapsule = capsule;
			}
			if (!root || !durableCredentialPaths) throw new Error("Native credential root is unavailable");
			// No local prompt/transcript, canonical mount, group walk or MCP
			// endpoint participates in the governed cloud execution path.
			stage = "harness-execution";
			harnessStarted = true;
			const executed = await cloudRuntime.execute(request, root, executionAbort.signal);
			output = {
				schema: HARNESS_RESULT_SCHEMA,
				run_id: authority.runId,
				message_count: executed.delivery.messageCount,
				final_message_id: executed.delivery.finalMessageId,
				provider_session_id: executed.providerSessionId ?? null,
			};
		} catch (error) {
			if (stage === "harness-execution") {
				if (validationError) {
					failure = new Error("Native provider execution completion-authority-validation stage failed", {
						cause: validationError,
					});
				} else {
					failure = safeHarnessExecutionFailure(error);
				}
			} else if (
				stage === "credential-download" &&
				!executionAbort.signal.aborted &&
				credentialDownloadLost(error)
			) {
				// A download that got no answer, before the harness started, is a timeout: the runner tries the run again
				// from the start (cloudRunnerJobFailureBeforeStartIsRetryable). A stopped run is never named one.
				failure = new Error("Native provider execution credential-download stage failed (timeout)", {
					cause: error,
				});
			} else {
				const reason = stage === "credential-sealing" ? ` (${credentialSealingFailure(error)})` : "";
				failure = new Error(`Native provider execution ${stage} stage failed${reason}`, { cause: error });
			}
		} finally {
			// A provider may rotate its login token before a later request fails.
			// Preserve only the original credential paths, never transient sessions,
			// and recheck live authority before replacing the capsule.
			// Several runs may use one login at once and a renewal token works once:
			// a run that did not change its login saves nothing, and a changed login is
			// saved only while the store still holds the login this run started from.
			// That check and the upload are two requests, not one atomic write.
			vaultStop.abort();
			await vaultRefresh;
			if (vaultLogin && root && harnessStarted) {
				// Nothing is saved back; the run's authority is still rechecked at its end, as for a
				// capsule login.
				stage = "completion-authority-validation";
				try {
					executionAbort.signal.throwIfAborted();
					await validateAtEnd();
					executionAbort.signal.throwIfAborted();
				} catch (error) {
					failure ??= new Error(`Native provider execution ${stage} stage failed`, { cause: error });
				}
			}
			if (root && durableCredentialPaths && harnessStarted && openedCapsule && openedCredentialDigest) {
				stage = "completion-authority-validation";
				try {
					executionAbort.signal.throwIfAborted();
					stage = "credential-sealing";
					const endedCredentialDigest = await credentialFilesDigest(root, durableCredentialPaths);
					const refreshedCapsule =
						endedCredentialDigest === openedCredentialDigest
							? undefined
							: await sealNativeCredentialCapsule(
									root,
									this.#capsuleKey(),
									authority.credentialCapsuleId,
									durableCredentialPaths,
								);
					stage = "completion-authority-validation";
					await validateAtEnd();
					executionAbort.signal.throwIfAborted();
					if (!refreshedCapsule) {
						// Unchanged: the store keeps the login this run started from.
						sealedCapsule = openedCapsule;
						sealedCredentialDigest = openedCredentialDigest;
					} else {
						stage = "credential-upload";
						const stored = await this.#capsules
							.get(authority.encryptedCapsuleReference, executionAbort.signal)
							.catch(() => this.#capsules.get(authority.encryptedCapsuleReference, executionAbort.signal));
						const storedDigest = storedCredentialDigest(
							stored,
							this.#capsuleKey(),
							authority.credentialCapsuleId,
							durableCredentialPaths,
						);
						if (storedDigest === openedCredentialDigest) {
							await this.#capsules.put(
								authority.encryptedCapsuleReference,
								refreshedCapsule,
								executionAbort.signal,
							);
							sealedCapsule = refreshedCapsule;
							sealedCredentialDigest = endedCredentialDigest;
						} else {
							// Another run saved a newer login meanwhile. Keep it; this run's copy is not
							// kept warm either.
							console.error(
								`Native provider execution kept a newer stored login for run ${authority.runId}; this run's changed login was not saved`,
							);
						}
					}
				} catch (error) {
					const reason = stage === "credential-sealing" ? ` (${credentialSealingFailure(error)})` : "";
					failure ??= new Error(`Native provider execution ${stage} stage failed${reason}`, { cause: error });
				}
			}
			validationStop.abort();
			try {
				await monitor;
			} catch (error) {
				failure ??= new Error(
					`Native provider execution authority-monitor stage failed (${harnessExecutionFailureCategory(error)})`,
					{ cause: error },
				);
			}
			signal?.removeEventListener("abort", externalAbort);
			const usedRoot = root;
			if (usedRoot) {
				let kept = false;
				if (
					warmKey &&
					this.#warmIdleMs !== undefined &&
					!failure &&
					durableCredentialPaths &&
					((sealedCapsule && sealedCredentialDigest) || vaultVersion !== undefined)
				) {
					try {
						// Only the capsule's own credential files stay; the next harness starts auth-only.
						await pruneToCredentialFiles(usedRoot, durableCredentialPaths);
						const keptRoot = usedRoot;
						cloudRuntime.prepareSpare?.(keptRoot, this.#warmIdleMs);
						const timer = setTimeout(() => {
							if (this.#warm?.root !== keptRoot) return;
							this.#warm = undefined;
							void this.#wipeRoot(keptRoot).catch(() => undefined);
						}, this.#warmIdleMs);
						timer.unref?.();
						this.#warm = {
							key: warmKey,
							root: keptRoot,
							durable: durableCredentialPaths,
							...(vaultVersion !== undefined
								? { vaultVersion }
								: { sealed: sealedCapsule, digest: sealedCredentialDigest }),
							timer,
						};
						kept = true;
					} catch {
						kept = false;
					}
				}
				if (!kept) {
					try {
						await cloudRuntime.disposeSpares?.(usedRoot).catch(() => undefined);
						await removeHarnessRoot(usedRoot);
					} catch (error) {
						failure ??= new Error(
							`Native provider execution cleanup stage failed (${harnessExecutionFailureCategory(error)})`,
							{ cause: error },
						);
					}
				}
			}
		}
		if (failure) throw failure;
		if (!output) throw new Error("Native provider execution internal-completion stage failed");
		return output;
	}

	async #finishLogin(state: LoginState): Promise<void> {
		let stage = "harness-completion";
		try {
			const completed = await state.handle.completed;
			stage = "identity-key-backup";
			await this.#backupIdentityKey?.(state.request);
			// Named for its sign-in: the one capsule the sign-in's login guest may write (G2-4, migration 20260930103000).
			const capsuleId = state.request.loginId;
			const reference = `native-capsule/${capsuleId}`;
			stage = "credential-sealing";
			const capsule = await sealNativeCredentialCapsule(
				state.root,
				this.#capsuleKey(),
				capsuleId,
				state.request.nativeHarness === "codex-cli" ? CODEX_CREDENTIAL_PATHS : undefined,
			);
			stage = "credential-upload";
			await this.#capsules.put(reference, capsule);
			stage = "control-plane-commit";
			await this.#controlPlane.completeLogin({
				loginId: state.request.loginId,
				capability: state.request.capability,
				capsuleId,
				encryptedCapsuleReference: reference,
				attestationPolicySha256: createHash("sha256").update("qorpera.native-provider-host/v1").digest("hex"),
				...(completed.providerAccountReference
					? { providerAccountReference: completed.providerAccountReference }
					: {}),
				...(completed.providerAccountEmail ? { providerAccountEmail: completed.providerAccountEmail } : {}),
			});
			state.status = "completed";
			void this.refreshAccountMetadata();
		} catch (error) {
			const reason = stage === "credential-sealing" ? ` (${credentialSealingFailure(error)})` : "";
			throw new Error(`Native provider login ${stage} stage failed${reason}`, { cause: error });
		} finally {
			await removeHarnessRoot(state.root);
		}
	}
}
