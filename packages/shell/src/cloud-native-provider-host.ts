import { type ChildProcessByStdio, type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import type { JsonValue } from "@qorpera/contracts";

const CAPSULE_SCHEMA = "qorpera.native-credential-capsule/v1";
const LOGIN_RESULT_SCHEMA = "qorpera.native-provider-login-result/v1";
const HARNESS_RESULT_SCHEMA = "qorpera.native-harness-result/v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_CAPSULE_PLAINTEXT_BYTES = 64 * 1024 * 1024;
const MAX_CAPSULE_FILES = 4096;
const MAX_HARNESS_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_PROMPT_BYTES = 16 * 1024 * 1024;
const EXECUTION_AUTHORITY_RECHECK_MS = 15_000;
const PROVIDER_DEFAULT_MODEL = "provider-default";

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
}

export interface NativeProviderControlPlane {
	describeLogin(loginId: string, capability: string, signal?: AbortSignal): Promise<NativeProviderLoginDescription>;
	completeLogin(input: CompleteNativeProviderLoginInput, signal?: AbortSignal): Promise<void>;
	validateExecution(request: NativeProviderExecutionRequest, signal?: AbortSignal): Promise<void>;
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
	completed: Promise<{ providerAccountReference?: string }>;
	cancel(): Promise<void>;
}

export interface NativeHarnessExecutionInput {
	harness: NativeHarnessKind;
	model: string;
	identityRoot: string;
	companyRoot: string;
	prompt: string;
	environment?: Readonly<Record<string, string>>;
	signal?: AbortSignal;
}

export interface NativeHarnessDriver {
	beginLogin(
		harness: NativeHarnessKind,
		identityRoot: string,
		signal?: AbortSignal,
	): Promise<NativeHarnessLoginHandle>;
	execute(input: NativeHarnessExecutionInput): Promise<{ text: string; providerSessionId?: string }>;
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

export interface NativeProviderExecutionRequest {
	authority: NativeProviderExecutionAuthority;
	job: {
		jobId: string;
		jobType: "agent_turn";
		requiredCapability: "agent_turn";
		attemptCount: number;
		payload: JsonValue;
	};
	input: {
		companyRoot: string;
		executionContextPath: string;
		queuedInputsPath: string;
		transcriptPath: string;
	};
	outputRoot: string;
	/** Extra harness environment from the runner (DISPLAY on the Company
	 * Computer's screens); never allowed to touch the identity boundary. */
	environment?: Readonly<Record<string, string>>;
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

async function grantWorkspaceGroupAccess(root: string): Promise<void> {
	/* The workspace mixes runner-owned materialized entries with entries the
	 * harness created as this process's user. Only the latter need (or
	 * permit) a mode change; chmod on a foreign-owned entry raises EPERM,
	 * so restrict the walk to entries this process owns. */
	/* The host service umask already lands harness output group-shared;
	 * this walk only repairs stragglers, so no single entry — vanished,
	 * foreign-owned, or unreadable — may fail the attempt. */
	const ownUid = process.getuid?.();
	const pending = [root];
	while (pending.length > 0) {
		const current = pending.pop() as string;
		let metadata: Awaited<ReturnType<typeof lstat>>;
		try {
			metadata = await lstat(current);
		} catch {
			continue;
		}
		if (metadata.isSymbolicLink()) continue;
		const owned = ownUid === undefined || metadata.uid === ownUid;
		if (metadata.isDirectory()) {
			if (owned) await chmod(current, metadata.mode | 0o050).catch(() => undefined);
			let entries: string[];
			try {
				entries = await readdir(current);
			} catch {
				continue;
			}
			for (const entry of entries) pending.push(join(current, entry));
			continue;
		}
		if (metadata.isFile() && owned) await chmod(current, metadata.mode | 0o040).catch(() => undefined);
	}
}

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
	const visit = async (directory: string): Promise<void> => {
		const entries = await readdir(directory, { withFileTypes: true });
		entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
		for (const entry of entries) {
			const absolute = join(directory, entry.name);
			const relativePath = relative(root, absolute).split(sep).join("/");
			if (!safeRelativePath(relativePath)) throw new Error("Credential capsule contains an invalid path");
			const metadata = await lstat(absolute);
			// Official CLIs may create compatibility aliases such as ~/.codex ->
			// $CODEX_HOME. Never follow or reproduce those links: the canonical
			// credential directory is already captured as ordinary files.
			if (metadata.isSymbolicLink()) continue;
			if (metadata.isDirectory()) {
				if (!containsDurableFile(relativePath)) continue;
				await visit(absolute);
				continue;
			}
			if (!metadata.isFile()) throw new Error("Credential capsule contains an unsupported entry");
			if (durablePaths !== undefined && !durablePaths.has(relativePath)) continue;
			totalBytes += metadata.size;
			if (files.length >= MAX_CAPSULE_FILES || totalBytes > MAX_CAPSULE_PLAINTEXT_BYTES) {
				throw new Error("Credential capsule exceeds its storage budget");
			}
			files.push({
				path: relativePath,
				mode: metadata.mode & 0o777,
				data: (await readFile(absolute)).toString("base64"),
			});
		}
	};
	await visit(root);
	return { schema: CAPSULE_SCHEMA, files };
}

async function restoreCapsuleFiles(root: string, archive: CapsuleArchive): Promise<void> {
	if (archive.schema !== CAPSULE_SCHEMA || !Array.isArray(archive.files) || archive.files.length > MAX_CAPSULE_FILES) {
		throw new Error("Credential capsule archive is invalid");
	}
	let totalBytes = 0;
	for (const file of archive.files) {
		if (
			!safeRelativePath(file.path) ||
			!Number.isSafeInteger(file.mode) ||
			file.mode < 0 ||
			file.mode > 0o777 ||
			typeof file.data !== "string"
		) {
			throw new Error("Credential capsule entry is invalid");
		}
		const bytes = Buffer.from(file.data, "base64");
		totalBytes += bytes.byteLength;
		if (totalBytes > MAX_CAPSULE_PLAINTEXT_BYTES) throw new Error("Credential capsule exceeds its storage budget");
		const target = resolve(root, ...file.path.split("/"));
		const child = relative(root, target);
		if (!child || child === ".." || child.startsWith(`..${sep}`)) {
			throw new Error("Credential capsule entry escapes its identity root");
		}
		await mkdir(dirname(target), { recursive: true, mode: 0o700 });
		await writeFile(target, bytes, { flag: "wx", mode: file.mode & 0o700 });
		await chmod(target, file.mode & 0o700);
	}
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
	] as const) {
		if (error.message === message) return reason;
	}
	return harnessExecutionFailureCategory(error);
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

function safeHarnessExecutionFailure(error: unknown): Error {
	if (
		error instanceof Error &&
		(/^Provider harness exited with [A-Za-z0-9_-]{1,32}(?: \((?:authentication|model|provider capacity|provider network|local sandbox|provider request) unavailable\))?$/.test(
			error.message,
		) ||
			/^Codex returned no assistant response(?: \((?:authentication|model|provider capacity|provider network|local sandbox|provider request) unavailable\))?$/.test(
				error.message,
			) ||
			error.message === "Provider harness output exceeded its byte limit")
	) {
		return error;
	}
	return new Error(
		`Native provider execution harness-execution stage failed (${harnessExecutionFailureCategory(error)})`,
		{ cause: error },
	);
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

export async function openNativeCredentialCapsule(
	bytes: Uint8Array,
	root: string,
	keyValue: string,
	capsuleId: string,
): Promise<void> {
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
	let archive: CapsuleArchive;
	try {
		archive = JSON.parse(
			Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8"),
		) as CapsuleArchive;
	} catch (error) {
		throw new Error("Credential capsule failed authenticated decryption", { cause: error });
	}
	await restoreCapsuleFiles(requiredAbsolutePath(root, "Credential capsule root"), archive);
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

function nativeHarnessFailureCategory(output: string): string | undefined {
	const diagnostics: string[] = [];
	for (const line of output.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as Record<string, unknown>;
			if (event.type === "error" && typeof event.message === "string") diagnostics.push(event.message);
			if (event.type === "turn.failed" && event.error && typeof event.error === "object") {
				const message = (event.error as Record<string, unknown>).message;
				if (typeof message === "string") diagnostics.push(message);
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
	if (/unauthori[sz]ed|authentication|not logged in|login required|status(?: code)? 401|\b401\b/.test(detail)) {
		return "authentication unavailable";
	}
	if (/model .*(?:not found|unsupported|unavailable)|unknown model|invalid model/.test(detail)) {
		return "model unavailable";
	}
	if (/not supported (?:for|on) (?:this )?model|unsupported (?:parameter|option)/.test(detail)) {
		return "model unavailable";
	}
	if (/rate.?limit|quota|insufficient_quota|too many requests|status(?: code)? 429|\b429\b/.test(detail)) {
		return "provider capacity unavailable";
	}
	if (/network|timed? out|timeout|connection|dns|tls|certificate|socket|status(?: code)? 50[234]/.test(detail)) {
		return "provider network unavailable";
	}
	if (/sandbox|workspace|permission denied|operation not permitted|read-only file system/.test(detail)) {
		return "local sandbox unavailable";
	}
	if (/bad request|invalid request|unprocessable|status(?: code)? 4(?:00|04|22)/.test(detail)) {
		return "provider request unavailable";
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

	constructor(codexPath = "codex", claudePath = "claude") {
		this.#codexPath = codexPath;
		this.#claudePath = claudePath;
	}

	async beginLogin(
		harness: NativeHarnessKind,
		identityRoot: string,
		signal?: AbortSignal,
	): Promise<NativeHarnessLoginHandle> {
		const root = requiredAbsolutePath(identityRoot, "Native identity root");
		const environment = await prepareHarnessEnvironment(root);
		const command = harness === "codex-cli" ? this.#codexPath : this.#claudePath;
		const args = harness === "codex-cli" ? ["login", "--device-auth"] : ["auth", "login", "--claudeai"];
		const child = spawn(command, args, {
			cwd: root,
			env: environment,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const capture = collectChildOutput(child);
		const abort = (): void => {
			void terminateChild(child);
		};
		signal?.addEventListener("abort", abort, { once: true });
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
		const completed = capture.completed.then(async () => {
			signal?.removeEventListener("abort", abort);
			const statusArgs = harness === "codex-cli" ? ["login", "status"] : ["auth", "status"];
			const status = spawn(command, statusArgs, {
				cwd: root,
				env: environment,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			const checked = collectChildOutput(status);
			await checked.completed;
			const reference = checked.output().trim();
			return reference
				? { providerAccountReference: `${harness}:${createHash("sha256").update(reference).digest("hex")}` }
				: {};
		});
		return {
			prompt,
			completed,
			cancel: () => terminateChild(child),
		};
	}

	async execute(input: NativeHarnessExecutionInput): Promise<{ text: string; providerSessionId?: string }> {
		const root = requiredAbsolutePath(input.identityRoot, "Native identity root");
		const companyRoot = requiredAbsolutePath(input.companyRoot, "Native Company File root");
		const environment = await prepareHarnessEnvironment(root);
		if (input.environment) {
			/* Runner-supplied variables ride alongside the clean harness
			 * environment; the identity boundary's own variables are never
			 * overridable, so a work-surface hint can't repoint HOME or the
			 * capsule directories. */
			for (const [key, value] of Object.entries(input.environment)) {
				if (key in environment) {
					throw new Error("Native harness environment cannot override the identity boundary");
				}
				environment[key] = value;
			}
		}
		if (!input.model.trim() || input.model.length > 160 || /[\0\r\n]/.test(input.model)) {
			throw new Error("Native model is invalid");
		}
		if (Buffer.byteLength(input.prompt) > MAX_PROMPT_BYTES) throw new Error("Native prompt exceeds its byte limit");
		const lastMessagePath = join(root, `.qorpera-last-message-${randomUUID()}.txt`);
		const command = input.harness === "codex-cli" ? this.#codexPath : this.#claudePath;
		const modelArgs = input.model === PROVIDER_DEFAULT_MODEL ? [] : ["--model", input.model];
		const args =
			input.harness === "codex-cli"
				? [
						"exec",
						"--json",
						"--skip-git-repo-check",
						"--sandbox",
						"workspace-write",
						...modelArgs,
						"--cd",
						companyRoot,
						"--output-last-message",
						lastMessagePath,
						"-",
					]
				: ["--print", "--output-format", "json", "--permission-mode", "auto", "--safe-mode", ...modelArgs];
		const child = spawn(command, args, {
			cwd: companyRoot,
			env: environment,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		const capture = collectChildOutput(child);
		const abort = (): void => {
			void terminateChild(child);
		};
		input.signal?.addEventListener("abort", abort, { once: true });
		child.stdin.end(input.prompt, "utf-8");
		try {
			await capture.completed;
			if (input.harness !== "codex-cli") {
				const output = JSON.parse(capture.output()) as Record<string, unknown>;
				if (typeof output.result !== "string" || !output.result.trim()) {
					throw new Error("Claude Code returned no assistant response");
				}
				return {
					text: output.result.trim(),
					...(typeof output.session_id === "string" ? { providerSessionId: output.session_id } : {}),
				};
			}
			let text = "";
			try {
				text = (await readFile(lastMessagePath, "utf-8")).trim();
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			let providerSessionId: string | undefined;
			for (const line of capture.output().split(/\r?\n/)) {
				if (!line.trim()) continue;
				try {
					const event = JSON.parse(line) as Record<string, unknown>;
					if (event.type === "thread.started" && typeof event.thread_id === "string") {
						providerSessionId = event.thread_id;
					}
				} catch {
					// The official CLI may emit non-JSON diagnostics alongside JSONL events.
				}
			}
			if (!text) {
				const category = nativeHarnessFailureCategory(capture.output());
				throw new Error(`Codex returned no assistant response${category ? ` (${category})` : ""}`);
			}
			return { text, ...(providerSessionId ? { providerSessionId } : {}) };
		} finally {
			input.signal?.removeEventListener("abort", abort);
			await rm(lastMessagePath, { force: true });
		}
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

async function boundedText(path: string, label: string): Promise<string> {
	const metadata = await lstat(path);
	if (!metadata.isFile() || metadata.size > MAX_PROMPT_BYTES) throw new Error(`${label} exceeds its byte limit`);
	return readFile(path, "utf-8");
}

async function executionPrompt(
	request: NativeProviderExecutionRequest,
): Promise<{ prompt: string; parentId?: string }> {
	const [context, inputs, transcript] = await Promise.all([
		boundedText(request.input.executionContextPath, "Execution context"),
		boundedText(request.input.queuedInputsPath, "Queued inputs"),
		boundedText(request.input.transcriptPath, "Canonical transcript"),
	]);
	const prompt = [
		"You are executing one Qorpera agent turn inside an isolated cloud computer.",
		"The Qorpera transcript is canonical. Use it to reconstruct context; do not assume local provider-session continuity.",
		"Work in the supplied Company File checkout. Return the assistant response for this turn.",
		"\n<execution-context>\n",
		context,
		"\n</execution-context>\n<canonical-transcript>\n",
		transcript,
		"\n</canonical-transcript>\n<queued-inputs>\n",
		inputs,
		"\n</queued-inputs>\n",
	].join("");
	if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw new Error("Native turn context exceeds its byte limit");
	let parentId: string | undefined;
	for (const line of transcript.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as Record<string, unknown>;
			const entry =
				parsed.entry && typeof parsed.entry === "object" ? (parsed.entry as Record<string, unknown>) : parsed;
			if (typeof entry.id === "string" && UUID_PATTERN.test(entry.id)) parentId = entry.id;
		} catch {
			// The runner already verified the canonical transcript; ignore only an
			// unrecognized local projection line when choosing a parent id.
		}
	}
	return { prompt, ...(parentId ? { parentId } : {}) };
}

export class NativeProviderHost {
	readonly #controlPlane: NativeProviderControlPlane;
	readonly #capsules: NativeCredentialCapsuleStore;
	readonly #harness: NativeHarnessDriver;
	readonly #masterKey: string;
	readonly #computeIdentityId: string;
	readonly #temporaryRoot: string;
	readonly #logins = new Map<string, LoginState>();

	constructor(options: {
		controlPlane: NativeProviderControlPlane;
		capsules: NativeCredentialCapsuleStore;
		harness: NativeHarnessDriver;
		masterKey: string;
		computeIdentityId: string;
		temporaryRoot?: string;
	}) {
		capsuleKey(options.masterKey);
		requiredUuid(options.computeIdentityId, "Native host Compute Identity id");
		this.#controlPlane = options.controlPlane;
		this.#capsules = options.capsules;
		this.#harness = options.harness;
		this.#masterKey = options.masterKey;
		this.#computeIdentityId = options.computeIdentityId;
		this.#temporaryRoot = resolve(options.temporaryRoot ?? tmpdir());
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
			await rm(root, { recursive: true, force: true });
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

	async execute(request: NativeProviderExecutionRequest, signal?: AbortSignal): Promise<JsonValue> {
		const { authority } = request;
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
		try {
			await this.#controlPlane.validateExecution(request, executionAbort.signal);
		} catch (error) {
			throw new Error(`Native provider execution ${stage} stage failed`, { cause: error });
		}
		const validationStop = new AbortController();
		let validationError: unknown;
		const validationSignal = AbortSignal.any([executionAbort.signal, validationStop.signal]);
		const monitor = (async () => {
			while (await waitFor(EXECUTION_AUTHORITY_RECHECK_MS, validationSignal)) {
				try {
					await this.#controlPlane.validateExecution(request, validationSignal);
				} catch (error) {
					validationError = error;
					executionAbort.abort(error);
					return;
				}
			}
		})();
		let root: string | undefined;
		let output: JsonValue | undefined;
		let failure: Error | undefined;
		try {
			stage = "temporary-workspace";
			root = await mkdtemp(join(this.#temporaryRoot, `qorpera-native-run-${authority.runId}-`));
			stage = "credential-download";
			const capsule = await this.#capsules.get(authority.encryptedCapsuleReference, executionAbort.signal);
			stage = "credential-opening";
			await openNativeCredentialCapsule(capsule, root, this.#masterKey, authority.credentialCapsuleId);
			const durableCredentialPaths = new Set((await collectCapsuleFiles(root)).files.map((file) => file.path));
			stage = "prompt-materialization";
			const context = await executionPrompt(request);
			stage = "harness-execution";
			const result = await this.#harness.execute({
				harness: authority.nativeHarness,
				model: authority.model,
				identityRoot: root,
				companyRoot: request.input.companyRoot,
				prompt: context.prompt,
				...(request.environment ? { environment: request.environment } : {}),
				signal: executionAbort.signal,
			});
			/* The harness runs as this host's user; entries it creates carry
			 * no group bits, and the runner reads the shared workspace only
			 * through the shared execution group. Grant group traversal on
			 * everything under the company root so output capture and review
			 * can read every created entry. */
			stage = "workspace-normalization";
			await grantWorkspaceGroupAccess(request.input.companyRoot);
			stage = "completion-authority-validation";
			if (validationError) throw validationError;
			await this.#controlPlane.validateExecution(request, executionAbort.signal);
			stage = "credential-sealing";
			const refreshedCapsule = await sealNativeCredentialCapsule(
				root,
				this.#masterKey,
				authority.credentialCapsuleId,
				durableCredentialPaths,
			);
			stage = "credential-upload";
			await this.#capsules.put(authority.encryptedCapsuleReference, refreshedCapsule, executionAbort.signal);
			output = {
				schema: HARNESS_RESULT_SCHEMA,
				assistant_entry: {
					type: "message",
					id: randomUUID(),
					parentId: context.parentId ?? null,
					timestamp: new Date().toISOString(),
					message: {
						role: "assistant",
						content: [{ type: "text", text: result.text }],
					},
				},
				provider_session_id: result.providerSessionId ?? null,
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
			} else {
				const reason = stage === "credential-sealing" ? ` (${credentialSealingFailure(error)})` : "";
				failure = new Error(`Native provider execution ${stage} stage failed${reason}`, { cause: error });
			}
		} finally {
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
			/* A failed or fenced attempt still leaves partial output that the
			 * durable review path must be able to read; normalize best-effort
			 * without masking the original failure. */
			if (failure) await grantWorkspaceGroupAccess(request.input.companyRoot).catch(() => undefined);
			if (root) {
				try {
					await rm(root, { recursive: true, force: true });
				} catch (error) {
					failure ??= new Error(
						`Native provider execution cleanup stage failed (${harnessExecutionFailureCategory(error)})`,
						{ cause: error },
					);
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
			const capsuleId = randomUUID();
			const reference = `native-capsule/${capsuleId}`;
			stage = "credential-sealing";
			const capsule = await sealNativeCredentialCapsule(state.root, this.#masterKey, capsuleId);
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
			});
			state.status = "completed";
		} catch (error) {
			const reason = stage === "credential-sealing" ? ` (${credentialSealingFailure(error)})` : "";
			throw new Error(`Native provider login ${stage} stage failed${reason}`, { cause: error });
		} finally {
			await rm(state.root, { recursive: true, force: true });
		}
	}
}
