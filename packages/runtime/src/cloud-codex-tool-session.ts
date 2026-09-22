import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { JsonValue } from "@qorpera/contracts";
import { CLOUD_NATIVE_CAPTURE_IMAGES_CAPABILITY } from "./cloud-native-capture-images.ts";
import {
	type NativeRuntimeFailureStage,
	type NativeRuntimeUsageSignal,
	nativeRuntimeUsageSignal,
	tagNativeRuntimeFailure,
} from "./cloud-native-failure.ts";
import { launchIsolatedNativeProcess, type NativeIsolationConfiguration } from "./cloud-native-isolation.ts";
import {
	CLOUD_NATIVE_RESULT_FENCE_SCHEMA,
	type CloudNativeFenceRequest,
	startCloudNativeResultFence,
} from "./cloud-native-result-fence.ts";
import {
	CLOUD_TOOL_RESULT_INSTRUCTIONS,
	type CloudNativeFencedResult,
	type CloudNativeToolBoundary,
} from "./cloud-native-tool-boundary.ts";
import {
	CloudRuntimeDiagnosticError,
	type CloudRuntimeErrorCategory,
	type CloudRuntimeObservability,
	type CloudRuntimeObservationSpan,
	type CloudRuntimeOutcome,
	cloudRuntimeErrorCategory,
} from "./cloud-runtime-observability.ts";
import {
	CLOUD_RUNTIME_MODEL_POLICY,
	type CloudRuntimeReasoningEffort,
	isCloudRuntimeReasoningEffort,
} from "./cloud-runtime-policy.ts";

export const CLOUD_CODEX_BOUNDARY_VERSION = "0.155.1";
const CLIENT_NAME = "qorpera_cloud_boundary";
const DIRECT_TOOLS_CAPABILITY = "qorpera.native-direct-tools/v1";
const MESSAGE_COMPOSITION_CAPABILITY = "qorpera.native-message-composition/v1";
const MAX_WIRE_BYTES = 16 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_CAPTURE_MESSAGE_BYTES = 12 * 1024 * 1024;
const MAX_CAPTURE_WIRE_BYTES = 256 * 1024 * 1024;
// Protocol flood bound, not a turn cap: every tool call is one server request.
const MAX_REQUESTS = 16_384;
// A stalled provider or process is a fence, not a cap: with no wall clock on a
// turn, silence this long ends the attempt so a run cannot sit for its whole deadline.
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;
const MAX_PROMPT_BYTES = 1024 * 1024;
const TOKEN_COUNTERS = [
	"inputTokens",
	"outputTokens",
	"cachedInputTokens",
	"cacheWriteInputTokens",
	"reasoningOutputTokens",
	"totalTokens",
] as const;

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
	"current_time_reminder",
	"sleep_tool",
] as const;

export function cloudCodexBoundaryConfig(effort: CloudRuntimeReasoningEffort): readonly string[] {
	return Object.freeze([`model_reasoning_effort="${effort}"`, ...CLOUD_CODEX_BOUNDARY_FIXED_CONFIG]);
}

export const CLOUD_CODEX_BOUNDARY_FIXED_CONFIG: readonly string[] = Object.freeze([
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

/** The boundary configuration for the default (attended-thread) effort. */
export const CLOUD_CODEX_BOUNDARY_CONFIG: readonly string[] = cloudCodexBoundaryConfig(
	CLOUD_RUNTIME_MODEL_POLICY.effort,
);

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native boundary protocol");
	return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9_:.-]{1,160}$/.test(value))
		throw new Error("Invalid native boundary identity");
	return value;
}

/** Only pinned native error discriminants are inspected, never diagnostic text. */
function nativeErrorCategory(value: unknown): CloudRuntimeErrorCategory | undefined {
	if (value === null) return "provider_failed";
	if (typeof value === "string") {
		if (["contextWindowExceeded", "sessionBudgetExceeded", "usageLimitExceeded"].includes(value))
			return "budget_exhausted";
		if (
			[
				"serverOverloaded",
				"cyberPolicy",
				"internalServerError",
				"unauthorized",
				"badRequest",
				"threadRollbackFailed",
				"sandboxError",
				"other",
			].includes(value)
		)
			return "provider_failed";
		return undefined;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const info = value as Record<string, unknown>;
	const keys = Object.keys(info);
	if (
		keys.length !== 1 ||
		![
			"httpConnectionFailed",
			"responseStreamConnectionFailed",
			"responseStreamDisconnected",
			"responseTooManyFailedAttempts",
		].includes(keys[0])
	)
		return undefined;
	const details = info[keys[0]];
	if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
	const status = (details as Record<string, unknown>).httpStatusCode;
	if (
		Object.keys(details).join() !== "httpStatusCode" ||
		(status !== null && (!Number.isSafeInteger(status) || (status as number) < 100 || (status as number) > 599))
	)
		return undefined;
	return keys[0] === "responseTooManyFailedAttempts" ? "provider_failed" : "transport_unavailable";
}

function verifyConfiguration(value: unknown, effort: CloudRuntimeReasoningEffort): void {
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
		config.model_reasoning_effort !== effort ||
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
	readonly #observability?: CloudRuntimeObservability;
	readonly #fenceObservations = new Map<
		string,
		{ span?: CloudRuntimeObservationSpan; contextRecorded: boolean; finished: boolean }
	>();
	#turnObservation?: CloudRuntimeObservationSpan;
	readonly #compositions = new Map<
		string,
		{ span?: CloudRuntimeObservationSpan; timer?: ReturnType<typeof setTimeout>; finished: boolean }
	>();
	#failureCategory: CloudRuntimeErrorCategory = "unknown";
	#providerErrorCategory?: CloudRuntimeErrorCategory;
	#providerUsageSignal: NativeRuntimeUsageSignal | null = null;
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
	#lastActivityAt = Date.now();

	get lastActivityAt(): number {
		return this.#lastActivityAt;
	}
	#toolCalls = 0;
	#activeCalls = 0;
	#threadId?: string;
	#prewarmThreadId?: string;
	#turnId?: string;
	#startingThread = false;
	#startingTurn = false;
	readonly #modelRequests = new Set<string>();
	/** Call ids whose fenced result closes the turn (a confirmed final public send). */
	readonly #turnEndCallIds = new Set<string>();
	#turnEndRequested = false;
	#finished = false;
	#closed = false;

	constructor(
		child: ChildProcessWithoutNullStreams,
		boundary: CloudNativeToolBoundary,
		observability?: CloudRuntimeObservability,
	) {
		this.#child = child;
		this.#boundary = boundary;
		this.#observability = observability;
		this.completed = new Promise<void>((resolve, reject) => {
			this.#resolveCompleted = resolve;
			this.#rejectCompleted = reject;
		});
		void this.completed.catch(() => undefined);
		child.on("error", () => this.fail("Native boundary process unavailable", "transport_unavailable"));
		child.stdin.on("error", () => this.fail("Native boundary transport unavailable", "transport_unavailable"));
		child.on("close", () => {
			if (!this.#closed) this.fail("Native boundary process ended unexpectedly", "transport_unavailable");
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
					if (
						Buffer.byteLength(line) >
						(boundary.captureImagesEnabled ? MAX_CAPTURE_MESSAGE_BYTES : MAX_MESSAGE_BYTES)
					)
						throw new Error("Native boundary message too large");
					if (line.trim()) this.#message(object(JSON.parse(line)));
					end = this.#buffer.indexOf("\n");
				}
				if (
					Buffer.byteLength(this.#buffer) >
					(boundary.captureImagesEnabled ? MAX_CAPTURE_MESSAGE_BYTES : MAX_MESSAGE_BYTES)
				)
					throw new Error("Native boundary message too large");
			} catch {
				this.fail("Invalid native boundary protocol", "invalid_response");
			}
		});
	}

	get toolCalls(): number {
		return this.#toolCalls;
	}
	get fencedRequests(): number {
		return this.#modelRequests.size;
	}
	get failureCategory(): CloudRuntimeErrorCategory {
		return this.#failureCategory;
	}
	get usageSignal(): NativeRuntimeUsageSignal | null {
		return this.#providerUsageSignal;
	}
	assertCompleted(): void {
		if (this.#failure) throw this.#failure;
		if (!this.#finished || this.#activeCalls > 0 || this.#modelRequests.size === 0) {
			this.#failureCategory = "invalid_response";
			throw new Error("Native boundary turn is incomplete");
		}
	}

	/** One host invocation, including tools/retries/compaction; not a provider HTTP attempt. */
	observeTurnStart(inputBytes: number): void {
		try {
			this.#turnObservation = this.#observability?.start("model_turn", {
				logicalOperationSha256: createHash("sha256")
					.update(JSON.stringify([this.#threadId, "model_turn"]))
					.digest("hex"),
				// Exact admitted prompt bytes, not the full provider request or network traffic.
				inputBytes,
			});
		} catch {
			// Optional diagnostics cannot change native execution or authority.
		}
	}

	contextRecorded(requestId: string): void {
		const observation = this.#fenceObservations.get(requestId);
		if (observation) observation.contextRecorded = true;
	}

	finishObservations(succeeded: boolean, signal: AbortSignal): void {
		const category = signal.aborted ? cloudRuntimeErrorCategory(undefined, signal) : this.#failureCategory;
		const failureStatus = category === "cancelled" ? "cancelled" : "failed";
		for (const callId of this.#compositions.keys())
			this.#finishComposition(callId, succeeded ? "unconfirmed" : failureStatus);
		for (const observation of this.#fenceObservations.values()) {
			if (observation.finished) continue;
			observation.finished = true;
			try {
				observation.span?.finish(succeeded ? "unconfirmed" : failureStatus, {
					errorCategory: succeeded ? null : category,
				});
			} catch {
				// Diagnostic export is independent of the result-fence protocol.
			}
		}
		try {
			this.#turnObservation?.finish(succeeded ? "succeeded" : failureStatus, {
				errorCategory: succeeded ? null : category,
			});
		} catch {
			// In particular, an exporter failure cannot turn a verified result into a failure.
		}
	}

	#observeFence(request: CloudNativeFenceRequest): void {
		if (!this.#observability) return;
		let observation = this.#fenceObservations.get(request.requestId);
		if (!observation) {
			observation = { contextRecorded: false, finished: false };
			this.#fenceObservations.set(request.requestId, observation);
			try {
				observation.span = this.#observability.start("native_result_fence", {
					logicalOperationSha256: createHash("sha256")
						.update(JSON.stringify([request.threadId, request.turnId, request.purpose, request.requestId]))
						.digest("hex"),
					parentAttemptId: request.purpose === "prewarm" ? undefined : this.#turnObservation?.attemptId,
				});
			} catch {
				// No retries or authority changes for unavailable diagnostics.
			}
		} else if (observation.contextRecorded && !observation.finished) {
			observation.finished = true;
			try {
				// The mandatory context callback and subsequent binding check passed.
				// Neither socket-reply delivery nor provider-request completion is observed here.
				observation.span?.finish("unconfirmed");
			} catch {
				// Preserve the mandatory callback/binding/socket sequence on exporter failure.
			}
		}
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
			this.#observeFence(request);
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
		this.#observeFence(request);
		// Contract 7.1: the final send closes the turn. Once its result has been
		// fenced, stop the provider instead of paying for a closing model round
		// whose text is never delivered. The interrupted completion is a success.
		if (
			!this.#turnEndRequested &&
			this.#activeCalls === 0 &&
			request.outputs.some((output) => this.#turnEndCallIds.has(output.callId))
		) {
			this.#turnEndRequested = true;
			void this.request("turn/interrupt", { threadId: request.threadId, turnId: request.turnId }).catch(
				() => undefined,
			);
		}
	}

	fail(message: string, category: CloudRuntimeErrorCategory = "unknown"): void {
		if (this.#failure || this.#closed) return;
		this.#failure = new CloudRuntimeDiagnosticError(category, message);
		this.#failureCategory = category;
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
		for (const callId of this.#compositions.keys()) this.#finishComposition(callId, "unconfirmed");
		this.#closed = true;
		this.#boundary.close();
		for (const pending of this.#pending.values()) pending.reject(new Error("Native boundary transport closed"));
		this.#pending.clear();
		this.#child.stdin.end();
	}

	#accountBytes(count: number): void {
		this.#bytes += count;
		if (this.#bytes > (this.#boundary.captureImagesEnabled ? MAX_CAPTURE_WIRE_BYTES : MAX_WIRE_BYTES))
			this.fail("Native boundary output limit exceeded", "budget_exhausted");
	}

	#write(message: unknown): void {
		if (this.#closed || this.#failure) return;
		const text = JSON.stringify(message);
		if (
			Buffer.byteLength(text) > (this.#boundary.captureImagesEnabled ? MAX_CAPTURE_MESSAGE_BYTES : MAX_MESSAGE_BYTES)
		) {
			this.fail("Native boundary input limit exceeded", "budget_exhausted");
			return;
		}
		// Replaying the same cached image must not bypass the aggregate wire cap.
		if (this.#boundary.captureImagesEnabled) this.#accountBytes(Buffer.byteLength(text) + 1);
		if (this.#failure) return;
		this.#child.stdin.write(`${text}\n`);
	}

	#finishComposition(callId: string, outcome: CloudRuntimeOutcome): void {
		const composition = this.#compositions.get(callId);
		if (!composition || composition.finished) return;
		composition.finished = true;
		clearTimeout(composition.timer);
		try {
			composition.span?.finish(outcome);
		} catch {
			// Optional presentation metadata cannot affect the native turn.
		}
	}

	#observeComposition(value: unknown): void {
		if (this.#finished || !this.#threadId || !this.#turnId || !this.#observability) return;
		try {
			const params = object(value);
			if (
				Object.keys(params).sort().join() !== "callId,phase,threadId,turnId" ||
				params.threadId !== this.#threadId ||
				params.turnId !== this.#turnId ||
				(params.phase !== "start" && params.phase !== "finish")
			)
				return;
			const callId = identifier(params.callId);
			if (params.phase === "finish") {
				// Remember early finishes too: replayed starts must not revive a completed item.
				if (!this.#compositions.has(callId) && this.#compositions.size < MAX_REQUESTS)
					this.#compositions.set(callId, { finished: true });
				this.#finishComposition(callId, "succeeded");
				return;
			}
			if (this.#compositions.has(callId) || this.#compositions.size >= MAX_REQUESTS) return;
			const composition: {
				span?: CloudRuntimeObservationSpan;
				timer?: ReturnType<typeof setTimeout>;
				finished: boolean;
			} = { finished: false };
			this.#compositions.set(callId, composition);
			const renew = () => {
				if (composition.finished || this.#failure || this.#closed || this.#finished) return;
				try {
					const previous = composition.span;
					composition.span = this.#observability!.start("message_composition", {
						logicalOperationSha256: createHash("sha256")
							.update(JSON.stringify([this.#threadId, this.#turnId, callId]))
							.digest("hex"),
						parentAttemptId: this.#turnObservation?.attemptId,
					});
					// Start the next expiring pulse first so a long reply has no presentation gap.
					previous?.finish("succeeded");
				} catch {
					// Missing telemetry falls back to Working in the member projection.
				}
				composition.timer = setTimeout(renew, 5_000);
				composition.timer.unref?.();
			};
			renew();
		} catch {
			// Ignore malformed optional notifications without accepting their contents.
		}
	}

	#observeDiagnostic(method: string, value: unknown): void {
		if (this.#finished || !this.#threadId || !this.#turnId) return;
		try {
			const params = object(value);
			if (params.threadId !== this.#threadId || params.turnId !== this.#turnId) return;
			if (method === "error") {
				if (typeof params.willRetry !== "boolean") return;
				const category = nativeErrorCategory(object(params.error).codexErrorInfo);
				// A retry hint is not an HTTP attempt or a terminal turn outcome.
				if (category && !params.willRetry) {
					this.#providerErrorCategory = category;
					this.#providerUsageSignal = nativeRuntimeUsageSignal(object(params.error).codexErrorInfo);
				}
				return;
			}
			if (!this.#turnObservation) return;
			const usage = object(params.tokenUsage);
			if (
				Object.keys(usage).sort().join() !== "last,modelContextWindow,total" ||
				(usage.modelContextWindow !== null &&
					(!Number.isSafeInteger(usage.modelContextWindow) || (usage.modelContextWindow as number) < 0))
			)
				return;
			const total = object(usage.total);
			const last = object(usage.last);
			for (const snapshot of [total, last]) {
				if (
					Object.keys(snapshot).sort().join() !== [...TOKEN_COUNTERS].sort().join() ||
					TOKEN_COUNTERS.some((key) => !Number.isSafeInteger(snapshot[key]) || (snapshot[key] as number) < 0)
				)
					return;
			}
			// Native cumulative snapshots can be replayed/recomputed. Never sum updates,
			// infer a request count, or label these counters billing-exact provider usage.
			this.#turnObservation.update({
				inputTokens: total.inputTokens as number,
				outputTokens: total.outputTokens as number,
				cachedInputTokens: total.cachedInputTokens as number,
				cacheWriteInputTokens: total.cacheWriteInputTokens as number,
				reasoningOutputTokens: total.reasoningOutputTokens as number,
				totalTokens: total.totalTokens as number,
			});
		} catch {
			// Malformed optional diagnostics remain unavailable; protocol enforcement is unchanged.
		}
	}

	#message(message: Record<string, unknown>): void {
		if (this.#failure || this.#closed) return;
		this.#lastActivityAt = Date.now();
		if (message.method === undefined) {
			if (typeof message.id !== "number") throw new Error("Invalid native response id");
			const pending = this.#pending.get(message.id);
			if (!pending) throw new Error("Unexpected native response id");
			if (message.error === undefined && !Object.hasOwn(message, "result"))
				throw new Error("Missing native response");
			this.#pending.delete(message.id);
			if (message.error !== undefined) {
				this.#failureCategory = "provider_failed";
				pending.reject(new CloudRuntimeDiagnosticError("provider_failed", "Native boundary request rejected"));
			} else if (Object.hasOwn(message, "result")) pending.resolve(message.result);
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
				({ completesTurn, ...result }) => {
					this.#activeCalls--;
					if (this.#finished) {
						this.fail("Native turn ended with a pending tool call", "invalid_response");
						return;
					}
					// The host-only marker never reaches the provider; the fence that
					// follows this result is where the turn ends (see assertModelRequest).
					if (completesTurn) this.#turnEndCallIds.add(callId);
					this.#write({ id: message.id, result });
				},
				() => {
					this.#activeCalls--;
					this.fail("Native tool boundary dispatch failed", "unknown");
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
			if (turn.status === "interrupted" && turn.error == null && this.#turnEndRequested) {
				this.#resolveCompleted();
			} else if (turn.status !== "completed" || turn.error != null) {
				const error =
					turn.error && typeof turn.error === "object" && !Array.isArray(turn.error)
						? (turn.error as Record<string, unknown>)
						: undefined;
				this.#providerUsageSignal =
					turn.status === "interrupted"
						? null
						: error?.codexErrorInfo === undefined
							? this.#providerUsageSignal
							: nativeRuntimeUsageSignal(error.codexErrorInfo);
				this.fail(
					"Native boundary turn did not complete",
					turn.status === "interrupted"
						? "cancelled"
						: (nativeErrorCategory(error?.codexErrorInfo) ?? this.#providerErrorCategory ?? "provider_failed"),
				);
			} else this.#resolveCompleted();
		} else if (message.method === "thread/tokenUsage/updated" || message.method === "error") {
			this.#observeDiagnostic(message.method, message.params);
		} else if (message.method === "qorpera/messageComposition") {
			this.#observeComposition(message.params);
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
	/** Always supplied from admitted cloud identity; standalone component probes use current policy. */
	reasoningEffort?: CloudRuntimeReasoningEffort;
	prompt: string;
	/** Versioned host-owned laws only; never job text, file content or model input. */
	runtimeInstructions?: string;
	/** Only a fresh, host-restored Codex auth home is accepted; no user config, skills or hooks. */
	identityRoot?: string;
	/** Required by the production company-path entrypoint; omitted only by synthetic/native component probes. */
	isolation?: NativeIsolationConfiguration;
	/** Called after artifact/configuration checks and before thread prewarm or any model request. */
	beforeModelStart?: (signal: AbortSignal) => Promise<void>;
	/** Optional metadata-only logical-turn/gate observations; not provider HTTP timing. */
	observability?: CloudRuntimeObservability;
	recordContextView?: (
		frame: CloudNativeFenceRequest,
		outputs: readonly CloudNativeFencedResult[],
		signal: AbortSignal,
	) => Promise<void>;
	signal: AbortSignal;
	timeoutMs?: number;
	idleTimeoutMs?: number;
}): Promise<{ providerSessionId: string; toolCalls: number; codexVersion: string; fencedRequests: number }> {
	// A turn has no wall-clock cap (founder, 2026-09-22); a timeout is a test
	// or operator choice, never a default. The run lease and deadline still bound it.
	const timeoutMs = options.timeoutMs;
	const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
	const effort = options.reasoningEffort ?? CLOUD_RUNTIME_MODEL_POLICY.effort;
	if (
		process.platform === "win32" ||
		(timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) ||
		!Number.isSafeInteger(idleTimeoutMs) ||
		idleTimeoutMs < 1
	)
		throw new Error("Unsupported native boundary execution");
	if (
		!options.model.trim() ||
		options.model.length > 160 ||
		/[\0\r\n]/.test(options.model) ||
		!/^[0-9a-f]{64}$/.test(options.binarySha256) ||
		!isAbsolute(options.command[0]) ||
		Buffer.byteLength(options.prompt) > MAX_PROMPT_BYTES ||
		Buffer.byteLength(options.runtimeInstructions ?? "") > 32 * 1024 ||
		!isCloudRuntimeReasoningEffort(effort)
	)
		throw new Error("Invalid native boundary input");
	options.signal.throwIfAborted();
	const allocation = await mkdtemp(join(tmpdir(), "qorpera-codex-boundary-"));
	// Linux commonly uses /tmp. Keep the runtime below the unique private
	// allocation so the containment validator never receives a shallow root.
	const root = join(allocation, "runtime");
	const signal =
		timeoutMs === undefined ? options.signal : AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]);
	let child: ChildProcessWithoutNullStreams | undefined;
	let isolated: Awaited<ReturnType<typeof launchIsolatedNativeProcess>> | undefined;
	let rpc: CodexBoundaryRpc | undefined;
	let idleWatch: ReturnType<typeof setInterval> | undefined;
	let fence: Awaited<ReturnType<typeof startCloudNativeResultFence>> | undefined;
	let fenceFailed = false;
	let stage: NativeRuntimeFailureStage = "codex-artifact";
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
		stage = "codex-identity";
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
		// Generate one host-owned bootstrap and explicitly load these exact bytes.
		// Ambient project/home instruction discovery remains disabled: a Company
		// File or restored auth home must never add a second platform prompt.
		const nativeInstructions = [CLOUD_TOOL_RESULT_INSTRUCTIONS, options.runtimeInstructions]
			.filter(Boolean)
			.join("\n");
		await writeFile(join(workspace, "AGENTS.md"), nativeInstructions, { mode: 0o400, flag: "wx" });
		signal.throwIfAborted();
		stage = "codex-result-fence";
		fence = await startCloudNativeResultFence({
			root,
			boundary: options.boundary,
			assertSession: (request) => {
				if (!rpc) throw new Error("Native result boundary not initialized");
				rpc.assertModelRequest(request);
			},
			recordContextView: async (request, outputs, contextSignal) => {
				await options.recordContextView?.(request, outputs, contextSignal);
				rpc?.contextRecorded(request.requestId);
			},
			onFailure: () => {
				fenceFailed = true;
				rpc?.fail("Native result boundary unavailable", "authority_unavailable");
			},
			signal,
		});
		const commandArgs = [
			...prefix,
			"app-server",
			"--strict-config",
			"--listen",
			"stdio://",
			...cloudCodexBoundaryConfig(effort).flatMap((config) => ["-c", config]),
		];
		stage = "codex-process-start";
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
		rpc = new CodexBoundaryRpc(child, options.boundary, options.observability);
		const watched = rpc;
		idleWatch = setInterval(
			() => {
				if (Date.now() - watched.lastActivityAt > idleTimeoutMs) watched.fail("Native boundary execution stalled");
			},
			Math.min(idleTimeoutMs, 15_000),
		);
		idleWatch.unref();
		if (fenceFailed) rpc.fail("Native result boundary unavailable", "authority_unavailable");
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		stage = "codex-initialize";
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
		if (!initialized.userAgent.split(" ").includes(MESSAGE_COMPOSITION_CAPABILITY))
			throw new Error("Native boundary requires message composition support");
		if (
			options.boundary.captureImagesEnabled &&
			!initialized.userAgent.split(" ").includes(CLOUD_NATIVE_CAPTURE_IMAGES_CAPABILITY)
		)
			throw new Error("Native boundary requires capture image support");
		rpc.initialized();
		stage = "codex-configuration";
		verifyConfiguration(await rpc.request("config/read", { includeLayers: false, cwd: workspace }), effort);
		stage = "codex-skills";
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
		stage = "execution-admission";
		await options.beforeModelStart?.(signal);
		signal.throwIfAborted();
		stage = "codex-thread-start";
		rpc.startThread();
		const started = object(
			await rpc.request("thread/start", {
				// provider-default omits the model: the pinned Codex chooses its own default. An explicit
				// name is only sent for a session override; the provider rejects names newer than the binary.
				...(options.model === "provider-default" ? {} : { model: options.model }),
				cwd: workspace,
				runtimeWorkspaceRoots: [],
				environments: [],
				ephemeral: true,
				approvalPolicy: "never",
				approvalsReviewer: "user",
				sandbox: "read-only",
				developerInstructions: nativeInstructions,
				dynamicTools: [options.boundary.specification],
			}),
		);
		const threadId = identifier(object(started.thread).id);
		rpc.bindThread(threadId);
		stage = "codex-turn-start";
		rpc.startTurn();
		rpc.observeTurnStart(Buffer.byteLength(options.prompt));
		const turnRequest = rpc.request("turn/start", {
			threadId,
			input: [{ type: "text", text: options.prompt, text_elements: [] }],
			effort,
			environments: [],
			runtimeWorkspaceRoots: [],
			sandboxPolicy: { type: "readOnly", networkAccess: false },
		});
		const turnStarted = object(await turnRequest);
		rpc.confirmTurn(object(turnStarted.turn).id);
		stage = "codex-turn-completion";
		await rpc.completed;
		rpc.assertCompleted();
		signal.throwIfAborted();
		rpc.finishObservations(true, signal);
		return {
			providerSessionId: threadId,
			toolCalls: rpc.toolCalls,
			codexVersion: CLOUD_CODEX_BOUNDARY_VERSION,
			fencedRequests: rpc.fencedRequests,
		};
	} catch (error) {
		rpc?.finishObservations(false, signal);
		if (signal.aborted)
			throw tagNativeRuntimeFailure(
				new Error("Native boundary execution stopped"),
				stage,
				cloudRuntimeErrorCategory(error, signal),
			);
		throw tagNativeRuntimeFailure(
			error,
			stage,
			rpc && rpc.failureCategory !== "unknown" ? rpc.failureCategory : cloudRuntimeErrorCategory(error),
			rpc?.usageSignal ?? null,
		);
	} finally {
		if (idleWatch !== undefined) clearInterval(idleWatch);
		signal.removeEventListener("abort", abort);
		rpc?.close();
		options.boundary.close();
		await fence?.close();
		if (isolated) await isolated.close();
		else if (child) await stopProcessGroup(child);
		await rm(allocation, { recursive: true, force: true });
	}
}
