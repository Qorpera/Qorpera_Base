import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { JsonValue } from "@qorpera/contracts";
import { launchIsolatedNativeProcess, type NativeIsolationConfiguration } from "./cloud-native-isolation.ts";
import {
	CLOUD_NATIVE_RESULT_FENCE_SCHEMA,
	type CloudNativeFenceRequest,
	startCloudNativeResultFence,
} from "./cloud-native-result-fence.ts";
import { CLOUD_TOOL_RESULT_INSTRUCTIONS, type CloudNativeToolBoundary } from "./cloud-native-tool-boundary.ts";

export const CLOUD_CODEX_BOUNDARY_VERSION = "0.147.0";
const CLIENT_NAME = "qorpera_cloud_boundary";
const DIRECT_TOOLS_CAPABILITY = "qorpera.native-direct-tools/v1";
const MAX_WIRE_BYTES = 16 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_REQUESTS = 256;
const MAX_PROMPT_BYTES = 1024 * 1024;

const DISABLED_FEATURES = [
	"shell_tool",
	"unified_exec",
	"shell_snapshot",
	"multi_agent",
	"multi_agent_v2",
	"apps",
	"plugins",
	"hooks",
	"browser_use",
	"browser_use_external",
	"browser_use_full_cdp_access",
	"computer_use",
	"in_app_browser",
	"image_generation",
	"view_image",
	"goals",
	"workspace_dependencies",
	"code_mode_only",
	"code_mode_host",
	"skill_mcp_dependency_install",
	"skill_search",
	"memories",
	"remote_plugin",
	"recommended_plugins",
	"tool_suggest",
	"request_permissions_tool",
	"guardian_approval",
] as const;

export const CLOUD_CODEX_BOUNDARY_CONFIG: readonly string[] = Object.freeze([
	'model_reasoning_effort="low"',
	'web_search="disabled"',
	'approval_policy="never"',
	'approvals_reviewer="user"',
	'sandbox_mode="read-only"',
	"project_doc_max_bytes=0",
	"check_for_update_on_startup=false",
	"skills.bundled.enabled=false",
	"skills.include_instructions=false",
	"orchestrator.skills.enabled=false",
	"orchestrator.mcp.enabled=false",
	"tools.update_plan.enabled=false",
	"tools.experimental_request_user_input.enabled=false",
	"agents.enabled=false",
	"mcp_servers={}",
	"analytics.enabled=false",
	"feedback.enabled=false",
	"tool_output_token_limit=65536",
	// Defense in depth: the pinned native capability also prevents model metadata from enabling Code Mode.
	'features.code_mode={enabled=false,direct_only_tool_namespaces=["qorpera"],excluded_tool_namespaces=["skills"]}',
	...DISABLED_FEATURES.map((feature) => `features.${feature}=false`),
]);

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native boundary protocol");
	return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9_:.-]{1,160}$/.test(value))
		throw new Error("Invalid native boundary identity");
	return value;
}

function verifyConfiguration(value: unknown): void {
	const config = object(object(value).config);
	const features = object(config.features);
	const skills = object(config.skills);
	const orchestrator = object(config.orchestrator);
	const codeMode = object(features.code_mode);
	if (
		DISABLED_FEATURES.some((feature) => features[feature] !== false) ||
		Object.keys(object(config.mcp_servers)).length !== 0 ||
		config.approval_policy !== "never" ||
		config.approvals_reviewer !== "user" ||
		config.sandbox_mode !== "read-only" ||
		config.web_search !== "disabled" ||
		config.model_reasoning_effort !== "low" ||
		config.project_doc_max_bytes !== 0 ||
		config.tool_output_token_limit !== 65536 ||
		object(skills.bundled).enabled !== false ||
		skills.include_instructions !== false ||
		object(orchestrator.skills).enabled !== false ||
		object(orchestrator.mcp).enabled !== false ||
		codeMode.enabled !== false ||
		JSON.stringify(codeMode.direct_only_tool_namespaces) !== '["qorpera"]' ||
		JSON.stringify(codeMode.excluded_tool_namespaces) !== '["skills"]' ||
		object(config.agents).enabled !== false
	)
		throw new Error("Native boundary configuration was not applied");
}

class CodexBoundaryRpc {
	readonly #child: ChildProcessWithoutNullStreams;
	readonly #boundary: CloudNativeToolBoundary;
	readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	readonly #requestIds = new Set<string>();
	readonly #decoder = new StringDecoder("utf8");
	readonly completed: Promise<void>;
	#resolveCompleted: () => void = () => undefined;
	#rejectCompleted: (error: Error) => void = () => undefined;
	#failure?: Error;
	#sequence = 0;
	#buffer = "";
	#bytes = 0;
	#serverRequests = 0;
	#toolCalls = 0;
	#activeCalls = 0;
	#threadId?: string;
	#prewarmThreadId?: string;
	#turnId?: string;
	#startingThread = false;
	#startingTurn = false;
	readonly #modelRequests = new Set<string>();
	#finished = false;
	#closed = false;

	constructor(child: ChildProcessWithoutNullStreams, boundary: CloudNativeToolBoundary) {
		this.#child = child;
		this.#boundary = boundary;
		this.completed = new Promise<void>((resolve, reject) => {
			this.#resolveCompleted = resolve;
			this.#rejectCompleted = reject;
		});
		void this.completed.catch(() => undefined);
		child.on("error", () => this.fail("Native boundary process unavailable"));
		child.stdin.on("error", () => this.fail("Native boundary transport unavailable"));
		child.on("close", () => {
			if (!this.#closed) this.fail("Native boundary process ended unexpectedly");
		});
		child.stderr.on("data", (chunk: Buffer) => this.#accountBytes(chunk.length));
		child.stdout.on("data", (chunk: Buffer) => {
			try {
				this.#accountBytes(chunk.length);
				if (this.#failure || this.#closed) return;
				this.#buffer += this.#decoder.write(chunk);
				let end = this.#buffer.indexOf("\n");
				while (end >= 0) {
					const line = this.#buffer.slice(0, end);
					this.#buffer = this.#buffer.slice(end + 1);
					if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) throw new Error("Native boundary message too large");
					if (line.trim()) this.#message(object(JSON.parse(line)));
					end = this.#buffer.indexOf("\n");
				}
				if (Buffer.byteLength(this.#buffer) > MAX_MESSAGE_BYTES)
					throw new Error("Native boundary message too large");
			} catch {
				this.fail("Invalid native boundary protocol");
			}
		});
	}

	get toolCalls(): number {
		return this.#toolCalls;
	}
	get fencedRequests(): number {
		return this.#modelRequests.size;
	}
	assertCompleted(): void {
		if (this.#failure) throw this.#failure;
		if (!this.#finished || this.#activeCalls > 0 || this.#modelRequests.size === 0)
			throw new Error("Native boundary turn is incomplete");
	}

	assertModelRequest(request: CloudNativeFenceRequest): void {
		if (this.#failure || this.#closed || this.#finished) throw new Error("Native result boundary stopped");
		if (request.purpose === "prewarm") {
			if (
				(!this.#startingThread && !this.#threadId) ||
				(this.#threadId && this.#threadId !== request.threadId) ||
				(this.#prewarmThreadId && this.#prewarmThreadId !== request.threadId) ||
				request.outputs.length !== 0
			)
				throw new Error("Native prewarm binding failed");
			this.#prewarmThreadId = request.threadId;
			return;
		}
		if (
			!this.#threadId ||
			this.#threadId !== request.threadId ||
			request.turnId === null ||
			(!this.#startingTurn && !this.#turnId)
		)
			throw new Error("Native result binding failed");
		this.confirmTurn(request.turnId);
		this.#modelRequests.add(request.requestId);
	}

	fail(message: string): void {
		if (this.#failure || this.#closed) return;
		this.#failure = new Error(message);
		this.#boundary.close();
		for (const pending of this.#pending.values()) pending.reject(this.#failure);
		this.#pending.clear();
		this.#rejectCompleted(this.#failure);
	}

	async request(method: string, params: JsonValue): Promise<unknown> {
		if (this.#failure) throw this.#failure;
		if (this.#closed) throw new Error("Native boundary transport closed");
		const id = ++this.#sequence;
		return new Promise((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			this.#write({ id, method, params });
		});
	}

	initialized(): void {
		this.#write({ method: "initialized", params: {} });
	}
	startThread(): void {
		this.#startingThread = true;
	}
	bindThread(threadId: string): void {
		if (!this.#startingThread || (this.#prewarmThreadId && this.#prewarmThreadId !== threadId))
			throw new Error("Native thread binding failed");
		this.#threadId = identifier(threadId);
		this.#startingThread = false;
	}
	startTurn(): void {
		this.#startingTurn = true;
	}
	confirmTurn(turnId: unknown): void {
		const id = identifier(turnId);
		if (this.#turnId !== undefined && this.#turnId !== id) throw new Error("Native boundary turn binding failed");
		this.#turnId = id;
	}

	close(): void {
		this.#closed = true;
		this.#boundary.close();
		for (const pending of this.#pending.values()) pending.reject(new Error("Native boundary transport closed"));
		this.#pending.clear();
		this.#child.stdin.end();
	}

	#accountBytes(count: number): void {
		this.#bytes += count;
		if (this.#bytes > MAX_WIRE_BYTES) this.fail("Native boundary output limit exceeded");
	}

	#write(message: unknown): void {
		if (this.#closed || this.#failure) return;
		const text = JSON.stringify(message);
		if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) {
			this.fail("Native boundary input limit exceeded");
			return;
		}
		this.#child.stdin.write(`${text}\n`);
	}

	#message(message: Record<string, unknown>): void {
		if (this.#failure || this.#closed) return;
		if (message.method === undefined) {
			if (typeof message.id !== "number") throw new Error("Invalid native response id");
			const pending = this.#pending.get(message.id);
			if (!pending) throw new Error("Unexpected native response id");
			if (message.error === undefined && !Object.hasOwn(message, "result"))
				throw new Error("Missing native response");
			this.#pending.delete(message.id);
			if (message.error !== undefined) pending.reject(new Error("Native boundary request rejected"));
			else if (Object.hasOwn(message, "result")) pending.resolve(message.result);
			else throw new Error("Missing native response");
			return;
		}
		if (typeof message.method !== "string") throw new Error("Invalid native method");
		if (message.id !== undefined) {
			if (
				(typeof message.id !== "string" && !Number.isSafeInteger(message.id)) ||
				++this.#serverRequests > MAX_REQUESTS
			)
				throw new Error("Invalid native request");
			const requestId = `${typeof message.id}:${message.id}`;
			if (this.#requestIds.has(requestId)) throw new Error("Duplicate native request");
			this.#requestIds.add(requestId);
			if (message.method !== "item/tool/call") {
				// No approval, process, credential-refresh or UI callback may become a second effect channel.
				this.#write({
					id: message.id,
					error: { code: -32601, message: "Operation not available in this cloud tool boundary" },
				});
				return;
			}
			const params = object(message.params);
			if (
				!this.#threadId ||
				!this.#turnId ||
				this.#finished ||
				params.threadId !== this.#threadId ||
				params.turnId !== this.#turnId ||
				params.namespace !== "qorpera" ||
				typeof params.tool !== "string"
			)
				throw new Error("Native tool binding failed");
			const callId = identifier(params.callId);
			this.#toolCalls++;
			this.#activeCalls++;
			void this.#boundary.invoke(callId, params.namespace, params.tool, params.arguments).then(
				(result) => {
					this.#activeCalls--;
					if (this.#finished) {
						this.fail("Native turn ended with a pending tool call");
						return;
					}
					this.#write({ id: message.id, result });
				},
				() => {
					this.#activeCalls--;
					this.fail("Native tool boundary dispatch failed");
				},
			);
			return;
		}
		if (message.method === "turn/started") {
			const params = object(message.params);
			const turnId = identifier(object(params.turn).id);
			if (
				!this.#startingTurn ||
				(this.#turnId !== undefined && this.#turnId !== turnId) ||
				params.threadId !== this.#threadId
			)
				throw new Error("Native turn binding failed");
			this.#turnId = turnId;
			this.#startingTurn = false;
		} else if (message.method === "turn/completed") {
			const params = object(message.params);
			const turn = object(params.turn);
			if (
				!this.#turnId ||
				this.#startingTurn ||
				this.#finished ||
				this.#activeCalls > 0 ||
				params.threadId !== this.#threadId ||
				turn.id !== this.#turnId
			)
				throw new Error("Native completion binding failed");
			this.#finished = true;
			if (turn.status !== "completed" || turn.error != null) this.fail("Native boundary turn did not complete");
			else this.#resolveCompleted();
		}
		// Assistant text, reasoning, diffs, tool events and diagnostics are never delivered or returned.
	}
}

async function stopProcessGroup(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (!child.pid) return;
	const processGroup = -child.pid;
	try {
		process.kill(processGroup, "SIGTERM");
	} catch {
		return;
	}
	await new Promise<void>((resolve) => setTimeout(resolve, 100));
	// The leader may already have exited while a descendant still holds the group.
	try {
		process.kill(processGroup, "SIGKILL");
	} catch {
		/* Already stopped. */
	}
}

/**
 * Cloud-host adapter selected only by the explicit company-path-v1 runtime lane.
 * No Company File directory is passed to Codex. The caller supplies the cloud tools.
 * Requires the pinned native result-fence and direct-tools capabilities; older binaries fail before thread creation.
 */
export async function runCloudCodexToolSession(options: {
	command: readonly [string, ...string[]];
	/** Independently provisioned artifact digest, never supplied by the model or inferred from its version string. */
	binarySha256: string;
	boundary: CloudNativeToolBoundary;
	model: string;
	prompt: string;
	/** Versioned host-owned laws only; never job text, file content or model input. */
	runtimeInstructions?: string;
	/** Only a fresh, host-restored Codex auth home is accepted; no user config, skills or hooks. */
	identityRoot?: string;
	/** Required by the production company-path entrypoint; omitted only by synthetic/native component probes. */
	isolation?: NativeIsolationConfiguration;
	/** Called after artifact/configuration checks and before thread prewarm or any model request. */
	beforeModelStart?: (signal: AbortSignal) => Promise<void>;
	signal: AbortSignal;
	timeoutMs?: number;
}): Promise<{ providerSessionId: string; toolCalls: number; codexVersion: string; fencedRequests: number }> {
	const timeoutMs = options.timeoutMs ?? 30_000;
	if (process.platform === "win32" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
		throw new Error("Unsupported native boundary execution");
	if (
		!options.model.trim() ||
		options.model.length > 160 ||
		/[\0\r\n]/.test(options.model) ||
		!/^[0-9a-f]{64}$/.test(options.binarySha256) ||
		!isAbsolute(options.command[0]) ||
		Buffer.byteLength(options.prompt) > MAX_PROMPT_BYTES ||
		Buffer.byteLength(options.runtimeInstructions ?? "") > 32 * 1024
	)
		throw new Error("Invalid native boundary input");
	options.signal.throwIfAborted();
	const allocation = await mkdtemp(join(tmpdir(), "qorpera-codex-boundary-"));
	// Linux commonly uses /tmp. Keep the runtime below the unique private
	// allocation so the containment validator never receives a shallow root.
	const root = join(allocation, "runtime");
	const signal = AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]);
	let child: ChildProcessWithoutNullStreams | undefined;
	let isolated: Awaited<ReturnType<typeof launchIsolatedNativeProcess>> | undefined;
	let rpc: CodexBoundaryRpc | undefined;
	let fence: Awaited<ReturnType<typeof startCloudNativeResultFence>> | undefined;
	let fenceFailed = false;
	const abort = (): void => {
		rpc?.fail("Native boundary execution stopped");
	};
	try {
		await mkdir(root, { mode: 0o700 });
		const [executable, ...prefix] = options.command;
		const command = await realpath(executable);
		const artifact = await lstat(command);
		if (!artifact.isFile() || artifact.size > 512 * 1024 * 1024 || (artifact.mode & 0o022) !== 0)
			throw new Error("Invalid native boundary artifact");
		const hash = createHash("sha256");
		for await (const chunk of createReadStream(command, { signal })) hash.update(chunk);
		if (hash.digest("hex") !== options.binarySha256) throw new Error("Native boundary artifact mismatch");
		if (options.identityRoot && !isAbsolute(options.identityRoot))
			throw new Error("Invalid native identity directory");
		const codexHome = join(options.identityRoot ?? root, "codex");
		await mkdir(codexHome, { recursive: true, mode: 0o700 });
		if (!(await lstat(codexHome)).isDirectory()) throw new Error("Invalid native identity directory");
		for (const entry of await readdir(codexHome, { withFileTypes: true })) {
			if (entry.name !== "auth.json" || !entry.isFile())
				throw new Error("Native boundary requires an auth-only identity");
		}
		const workspace = join(root, "workspace");
		const home = join(root, "home");
		await Promise.all(
			[workspace, home, join(root, "config"), join(root, "data"), join(root, "cache")].map((path) =>
				mkdir(path, { mode: 0o700 }),
			),
		);
		signal.throwIfAborted();
		fence = await startCloudNativeResultFence({
			root,
			boundary: options.boundary,
			assertSession: (request) => {
				if (!rpc) throw new Error("Native result boundary not initialized");
				rpc.assertModelRequest(request);
			},
			onFailure: () => {
				fenceFailed = true;
				rpc?.fail("Native result boundary unavailable");
			},
			signal,
		});
		const commandArgs = [
			...prefix,
			"app-server",
			"--strict-config",
			"--listen",
			"stdio://",
			...CLOUD_CODEX_BOUNDARY_CONFIG.flatMap((config) => ["-c", config]),
		];
		if (options.isolation) {
			isolated = await launchIsolatedNativeProcess({
				configuration: options.isolation,
				command,
				args: commandArgs,
				scratchRoot: root,
				codexHome,
				fenceSocket: fence.path,
				signal,
			});
			child = isolated.child;
		} else
			child = spawn(command, commandArgs, {
				cwd: workspace,
				env: {
					HOME: home,
					CODEX_HOME: codexHome,
					XDG_CONFIG_HOME: join(root, "config"),
					XDG_DATA_HOME: join(root, "data"),
					XDG_CACHE_HOME: join(root, "cache"),
					PATH: process.env.PATH ?? "/usr/bin:/bin",
					NO_COLOR: "1",
					QORPERA_NATIVE_RESULT_FENCE_SOCKET: fence.path,
				},
				stdio: ["pipe", "pipe", "pipe"],
				detached: true,
			});
		rpc = new CodexBoundaryRpc(child, options.boundary);
		if (fenceFailed) rpc.fail("Native result boundary unavailable");
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		const initialized = object(
			await rpc.request("initialize", {
				clientInfo: { name: CLIENT_NAME, version: "1" },
				capabilities: { experimentalApi: true },
			}),
		);
		if (
			typeof initialized.userAgent !== "string" ||
			!initialized.userAgent.startsWith(`${CLIENT_NAME}/${CLOUD_CODEX_BOUNDARY_VERSION} `) ||
			!initialized.userAgent.split(" ").includes(CLOUD_NATIVE_RESULT_FENCE_SCHEMA)
		)
			throw new Error("Unsupported Codex boundary version or missing native result fence");
		if (!initialized.userAgent.endsWith(` ${CLOUD_NATIVE_RESULT_FENCE_SCHEMA} ${DIRECT_TOOLS_CAPABILITY}`))
			throw new Error("Native boundary requires governed direct tools");
		rpc.initialized();
		verifyConfiguration(await rpc.request("config/read", { includeLayers: false, cwd: workspace }));
		const skills = object(await rpc.request("skills/list", { cwds: [workspace], forceReload: true }));
		if (!Array.isArray(skills.data) || skills.data.length !== 1)
			throw new Error("Native skill catalog could not be verified");
		const catalog = object(skills.data[0]);
		if (
			!Array.isArray(catalog.skills) ||
			catalog.skills.length !== 0 ||
			!Array.isArray(catalog.errors) ||
			catalog.errors.length !== 0
		)
			throw new Error("Native boundary requires an empty provider skill catalog");
		await options.beforeModelStart?.(signal);
		signal.throwIfAborted();
		rpc.startThread();
		const started = object(
			await rpc.request("thread/start", {
				...(options.model === "provider-default" ? {} : { model: options.model }),
				cwd: workspace,
				runtimeWorkspaceRoots: [],
				environments: [],
				ephemeral: true,
				approvalPolicy: "never",
				approvalsReviewer: "user",
				sandbox: "read-only",
				developerInstructions: [CLOUD_TOOL_RESULT_INSTRUCTIONS, options.runtimeInstructions]
					.filter(Boolean)
					.join("\n"),
				dynamicTools: [options.boundary.specification],
			}),
		);
		const threadId = identifier(object(started.thread).id);
		rpc.bindThread(threadId);
		rpc.startTurn();
		const turnStarted = object(
			await rpc.request("turn/start", {
				threadId,
				input: [{ type: "text", text: options.prompt, text_elements: [] }],
				effort: "low",
				environments: [],
				runtimeWorkspaceRoots: [],
				sandboxPolicy: { type: "readOnly", networkAccess: false },
			}),
		);
		rpc.confirmTurn(object(turnStarted.turn).id);
		await rpc.completed;
		rpc.assertCompleted();
		signal.throwIfAborted();
		return {
			providerSessionId: threadId,
			toolCalls: rpc.toolCalls,
			codexVersion: CLOUD_CODEX_BOUNDARY_VERSION,
			fencedRequests: rpc.fencedRequests,
		};
	} catch (error) {
		if (signal.aborted) throw new Error("Native boundary execution stopped");
		throw error;
	} finally {
		signal.removeEventListener("abort", abort);
		rpc?.close();
		options.boundary.close();
		await fence?.close();
		if (isolated) await isolated.close();
		else if (child) await stopProcessGroup(child);
		await rm(allocation, { recursive: true, force: true });
	}
}
