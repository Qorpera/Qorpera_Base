import { type ChildProcessByStdio, type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import type { JsonValue } from "@qorpera/pi-protocol";

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
	};
	for (const key of ["SystemRoot", "ComSpec", "PATHEXT", "WINDIR"]) {
		if (process.env[key]) environment[key] = process.env[key];
	}
	return environment;
}

async function collectCapsuleFiles(root: string): Promise<CapsuleArchive> {
	const files: CapsuleFile[] = [];
	let totalBytes = 0;
	const visit = async (directory: string): Promise<void> => {
		const entries = await readdir(directory, { withFileTypes: true });
		entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
		for (const entry of entries) {
			const absolute = join(directory, entry.name);
			const relativePath = relative(root, absolute).split(sep).join("/");
			if (!safeRelativePath(relativePath)) throw new Error("Credential capsule contains an invalid path");
			const metadata = await lstat(absolute);
			if (metadata.isSymbolicLink()) throw new Error("Credential capsule cannot contain symbolic links");
			if (metadata.isDirectory()) {
				await visit(absolute);
				continue;
			}
			if (!metadata.isFile()) throw new Error("Credential capsule contains an unsupported entry");
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

export async function sealNativeCredentialCapsule(
	root: string,
	keyValue: string,
	capsuleId: string,
): Promise<Uint8Array> {
	requiredUuid(capsuleId, "Credential capsule id");
	const archive = await collectCapsuleFiles(requiredAbsolutePath(root, "Credential capsule root"));
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
				else if (code !== 0) reject(new Error(`Provider harness exited with ${code ?? signal ?? "failure"}`));
				else resolveChild();
			});
		}),
	};
}

function interactionFromOutput(output: string): NativeHarnessLoginPrompt {
	const interactionUrl = output.match(/https:\/\/[^\s<>'"`]+/i)?.[0]?.replace(/[),.;]+$/, "");
	const explicitCode = output.match(/(?:code|enter)\s*[:=]?\s*([A-Z0-9-]{4,64})/i)?.[1];
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
		await mkdir(join(root, "home"), { recursive: true, mode: 0o700 });
		const command = harness === "codex-cli" ? this.#codexPath : this.#claudePath;
		const args = harness === "codex-cli" ? ["login", "--device-auth"] : ["auth", "login", "--claudeai"];
		const child = spawn(command, args, {
			cwd: root,
			env: cleanHarnessEnvironment(root),
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
				env: cleanHarnessEnvironment(root),
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			const checked = collectChildOutput(status);
			await checked.completed;
			const reference = checked.output().trim().slice(0, 512);
			return reference ? { providerAccountReference: reference } : {};
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
		if (!input.model.trim() || input.model.length > 160 || /[\0\r\n]/.test(input.model)) {
			throw new Error("Native model is invalid");
		}
		if (Buffer.byteLength(input.prompt) > MAX_PROMPT_BYTES) throw new Error("Native prompt exceeds its byte limit");
		const lastMessagePath = join(root, "last-message.txt");
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
			env: cleanHarnessEnvironment(root),
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
		} finally {
			input.signal?.removeEventListener("abort", abort);
		}
		if (input.harness === "codex-cli") {
			const text = (await readFile(lastMessagePath, "utf-8")).trim();
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
			if (!text) throw new Error("Codex returned no assistant response");
			return { text, ...(providerSessionId ? { providerSessionId } : {}) };
		}
		const output = JSON.parse(capture.output()) as Record<string, unknown>;
		if (typeof output.result !== "string" || !output.result.trim()) {
			throw new Error("Claude Code returned no assistant response");
		}
		return {
			text: output.result.trim(),
			...(typeof output.session_id === "string" ? { providerSessionId: output.session_id } : {}),
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
	readonly #temporaryRoot: string;
	readonly #logins = new Map<string, LoginState>();

	constructor(options: {
		controlPlane: NativeProviderControlPlane;
		capsules: NativeCredentialCapsuleStore;
		harness: NativeHarnessDriver;
		masterKey: string;
		temporaryRoot?: string;
	}) {
		capsuleKey(options.masterKey);
		this.#controlPlane = options.controlPlane;
		this.#capsules = options.capsules;
		this.#harness = options.harness;
		this.#masterKey = options.masterKey;
		this.#temporaryRoot = resolve(options.temporaryRoot ?? tmpdir());
	}

	async beginLogin(request: NativeProviderLoginRequest, signal?: AbortSignal): Promise<JsonValue> {
		requiredUuid(request.loginId, "Native login id");
		requiredUuid(request.clientConnectionId, "Native client connection id");
		requiredUuid(request.computeIdentityId, "Native compute identity id");
		if (!TOKEN_PATTERN.test(request.capability) || !Number.isFinite(Date.parse(request.expiresAt))) {
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
		await this.#controlPlane.validateExecution(request, executionAbort.signal);
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
		const root = await mkdtemp(join(this.#temporaryRoot, `qorpera-native-run-${authority.runId}-`));
		try {
			await openNativeCredentialCapsule(
				await this.#capsules.get(authority.encryptedCapsuleReference, executionAbort.signal),
				root,
				this.#masterKey,
				authority.credentialCapsuleId,
			);
			const context = await executionPrompt(request);
			const result = await this.#harness.execute({
				harness: authority.nativeHarness,
				model: authority.model,
				identityRoot: root,
				companyRoot: request.input.companyRoot,
				prompt: context.prompt,
				signal: executionAbort.signal,
			});
			if (validationError) throw validationError;
			await this.#controlPlane.validateExecution(request, executionAbort.signal);
			await this.#capsules.put(
				authority.encryptedCapsuleReference,
				await sealNativeCredentialCapsule(root, this.#masterKey, authority.credentialCapsuleId),
				executionAbort.signal,
			);
			return {
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
		} finally {
			validationStop.abort();
			await monitor;
			signal?.removeEventListener("abort", externalAbort);
			await rm(root, { recursive: true, force: true });
		}
	}

	async #finishLogin(state: LoginState): Promise<void> {
		try {
			const completed = await state.handle.completed;
			const capsuleId = randomUUID();
			const reference = `native-capsule/${capsuleId}`;
			await this.#capsules.put(reference, await sealNativeCredentialCapsule(state.root, this.#masterKey, capsuleId));
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
		} finally {
			await rm(state.root, { recursive: true, force: true });
		}
	}
}
