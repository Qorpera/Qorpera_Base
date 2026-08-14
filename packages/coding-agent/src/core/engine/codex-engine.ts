/**
 * Codex app-server engine adapter — Qorpera Base engine mode (spec §6.0).
 *
 * Codex runs its own loop with its own co-trained prompts, tools, caching,
 * and orchestration; we drive it over JSON-RPC (newline-delimited JSON on
 * stdio) and do exactly three things:
 *
 *  1. lifecycle — initialize → thread/start (cwd = the company root, so
 *     codex natively reads the kernel AGENTS.md; optional developer-tier
 *     append as reinforcement, never base-prompt replacement);
 *  2. trail — every completed item is normalized into the pi session tree:
 *     agent messages become assistant messages with model attribution,
 *     reasoning / command executions / file changes become custom entries
 *     (persisted, outside model context). Sessions are the trail (spec §3),
 *     so engine turns land in <company>/trail like everything else;
 *  3. authority — codex approval requests route through the SAME gates as
 *     direct mode: command approvals evaluate as `bash`, patch approvals as
 *     `apply_patch` per file. authority.toml binds engine mode exactly like
 *     everything else. When an authority is present the thread is forced to
 *     approvalPolicy "untrusted" inside Codex's read-only sandbox. Reads may
 *     proceed directly, while every command or patch with an effect must
 *     escape that sandbox through the Qorpera approval bridge.
 *
 * Targets the stable v2 surface (initialize, thread/start, turn/start,
 * item/started|completed, turn/completed, the two approval requests) —
 * everything newer is ignored defensively. Wire facts verified against
 * openai/codex app-server-protocol sources on 2026-08-04.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { VERSION } from "../../config.ts";
import { spawn } from "../../utils/child-process.ts";
import { type Authority, evaluateToolCall, finalizeAuthorityDecision } from "../authority.ts";
import type { SessionManager } from "../session-manager.ts";

interface JsonRpcMessage {
	jsonrpc?: string;
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string };
}

export interface CodexBinary {
	command: string;
	args: string[];
}

export interface CodexEngineOptions {
	cwd: string;
	/** The trail: engine items are recorded into this session. */
	sessionManager: SessionManager;
	authority?: Authority;
	/**
	 * Founder session vs agentic work: attendance supplies intent for outward
	 * effects but never changes product-code roles.
	 */
	attended?: boolean;
	actor?: "controller" | "product-worker";
	productWorktree?: string;
	binary?: CodexBinary;
	model?: string;
	/** Optional developer-tier reinforcement (append; never replaces base). */
	developerInstructions?: string;
	/** thread/start approvalPolicy for sessions without authority. Authority sessions always use "untrusted". */
	approvalPolicy?: string;
	/** Streaming observer for CLI display. */
	onEvent?: (event: CodexEngineEvent) => void;
	requestTimeoutMs?: number;
}

export type CodexEngineEvent =
	| { type: "assistant"; text: string }
	| { type: "reasoning"; summary: string }
	| { type: "command"; command: string; status: string; exitCode?: number | null }
	| { type: "gate"; decision: "accept" | "decline"; command: string; reason?: string }
	| { type: "usage"; inputTokens: number; cachedInputTokens: number; outputTokens: number };

export interface CodexTurnResult {
	finalText: string;
	usage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
}

export function resolveCodexBinary(): CodexBinary {
	const override = process.env.QORPERA_CODEX_BIN;
	if (override) {
		const parts = override.split(" ").filter(Boolean);
		return { command: parts[0], args: [...parts.slice(1), "app-server"] };
	}
	return { command: "codex", args: ["app-server"] };
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export class CodexEngineSession {
	private child: ChildProcessWithoutNullStreams;
	private nextId = 1;
	private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private notificationHandlers = new Map<string, (params: unknown) => void>();
	private requestHandlers = new Map<string, (params: unknown) => Promise<unknown>>();
	private stderrTail: string[] = [];
	private threadId = "";
	private model = "codex";
	private modelProvider = "openai";
	/** Items observed via item/started, by id — approval params may omit the command. */
	private itemsById = new Map<string, Record<string, unknown>>();
	private closed = false;

	private readonly options: CodexEngineOptions;

	private constructor(options: CodexEngineOptions, binary: CodexBinary) {
		this.options = options;
		this.child = spawn(binary.command, binary.args, {
			cwd: options.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			// npm shims (codex.cmd, npx.cmd) need a shell on Windows; absolute
			// paths (node.exe in tests) do not.
			shell: process.platform === "win32" && !isAbsolute(binary.command),
		});
		this.child.on("error", (error) => this.failAll(new Error(`codex app-server spawn failed: ${error.message}`)));
		this.child.on("exit", (code) => {
			if (!this.closed) {
				this.failAll(new Error(`codex app-server exited (code ${code}). stderr: ${this.stderrTail.join("\n")}`));
			}
		});
		this.child.stderr.setEncoding("utf-8");
		this.child.stderr.on("data", (chunk: string) => {
			this.stderrTail.push(chunk);
			if (this.stderrTail.length > 40) this.stderrTail.shift();
		});
		const lines = createInterface({ input: this.child.stdout });
		lines.on("line", (line) => this.onLine(line));
		this.installHandlers();
	}

	static async start(options: CodexEngineOptions): Promise<CodexEngineSession> {
		const binary = options.binary ?? resolveCodexBinary();
		const session = new CodexEngineSession(options, binary);
		try {
			const lifecycleTimeoutMs = Math.min(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, 45_000);
			await session.request(
				"initialize",
				{
					clientInfo: { name: "qorpera-base", title: "Qorpera Base", version: VERSION },
					// Newer app-server builds gate the v2 item notification
					// stream behind this capability (the protocol's own client
					// examples set it). Verified live 2026-08-04: without it,
					// turn/completed arrives with no item/completed events.
					capabilities: { experimentalApi: true },
				},
				lifecycleTimeoutMs,
			);
			session.notify("initialized", {});
			const approvalPolicy = options.authority ? "untrusted" : options.approvalPolicy;
			const sandbox = options.authority ? "read-only" : undefined;
			const startResult = (await session.request(
				"thread/start",
				{
					cwd: options.cwd,
					...(options.model ? { model: options.model } : {}),
					...(options.developerInstructions ? { developerInstructions: options.developerInstructions } : {}),
					...(approvalPolicy ? { approvalPolicy } : {}),
					...(sandbox ? { sandbox } : {}),
				},
				lifecycleTimeoutMs,
			)) as { thread?: { id?: string }; model?: string; modelProvider?: string };
			session.threadId = startResult.thread?.id ?? "";
			if (!session.threadId) throw new Error("codex thread/start returned no thread id");
			if (startResult.model) session.model = startResult.model;
			if (startResult.modelProvider) session.modelProvider = startResult.modelProvider;
			options.sessionManager.appendCustomEntry("codex_thread", {
				threadId: session.threadId,
				model: session.model,
				modelProvider: session.modelProvider,
				approvalPolicy: approvalPolicy ?? "(codex default)",
				sandbox: sandbox ?? "(codex default)",
			});
			return session;
		} catch (error) {
			// Never leak the child on a failed start (a stuck codex would keep
			// the host process alive forever).
			await session.dispose();
			throw error;
		}
	}

	/** Run one turn; resolves at turn/completed. */
	runTurn(text: string): Promise<CodexTurnResult> {
		const { sessionManager } = this.options;
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		} as never);

		return new Promise<CodexTurnResult>((resolve, reject) => {
			let lastAssistantText = "";
			let usage: CodexTurnResult["usage"];
			const timeout = setTimeout(
				() => reject(new Error("codex turn timed out")),
				this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
			);

			this.notificationHandlers.set("item/completed", (params) => {
				const { item } = (params ?? {}) as { item?: Record<string, unknown> };
				if (!item || typeof item.type !== "string") return;
				lastAssistantText = this.recordItem(item) ?? lastAssistantText;
			});
			this.notificationHandlers.set("item/started", (params) => {
				const { item } = (params ?? {}) as { item?: Record<string, unknown> };
				if (item && typeof item.id === "string") this.itemsById.set(item.id, item);
			});
			this.notificationHandlers.set("thread/tokenUsage/updated", () => {});
			this.notificationHandlers.set("turn/completed", (params) => {
				clearTimeout(timeout);
				const turn = (
					(params ?? {}) as {
						turn?: { usage?: Record<string, number>; status?: string; error?: { message?: string } };
					}
				).turn;
				if (turn?.status === "failed") {
					const message = turn.error?.message ?? "turn failed";
					this.options.sessionManager.appendCustomEntry("codex_turn_failed", { error: turn.error ?? null });
					reject(new Error(`codex turn failed: ${message}`));
					return;
				}
				if (turn?.usage) {
					usage = {
						inputTokens: turn.usage.inputTokens ?? 0,
						cachedInputTokens: turn.usage.cachedInputTokens ?? 0,
						outputTokens: turn.usage.outputTokens ?? 0,
					};
					this.options.onEvent?.({ type: "usage", ...usage });
				}
				// Attribution rides on a final assistant record with usage.
				this.options.sessionManager.appendMessage({
					role: "assistant",
					content: [{ type: "text", text: lastAssistantText }],
					api: "codex-app-server",
					provider: this.modelProvider,
					model: this.model,
					usage: {
						input: usage?.inputTokens ?? 0,
						output: usage?.outputTokens ?? 0,
						cacheRead: usage?.cachedInputTokens ?? 0,
						cacheWrite: 0,
						totalTokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) + (usage?.cachedInputTokens ?? 0),
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				} as never);
				resolve({ finalText: lastAssistantText, usage });
			});

			this.request("turn/start", {
				threadId: this.threadId,
				input: [{ type: "text", text }],
			}).catch((error) => {
				clearTimeout(timeout);
				reject(error instanceof Error ? error : new Error(String(error)));
			});
		});
	}

	async dispose(): Promise<void> {
		this.closed = true;
		if (this.child.exitCode !== null || this.child.signalCode !== null) return;
		const exited = new Promise<void>((resolve) => {
			this.child.once("exit", () => resolve());
			setTimeout(resolve, 5_000).unref?.();
		});
		this.child.kill();
		if (process.platform === "win32" && this.child.pid) {
			// shell:true wraps the binary in cmd.exe; kill() only reaches the
			// wrapper and would leave codex.exe running. Kill the whole tree.
			spawn("taskkill", ["/pid", String(this.child.pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => {});
		}
		await exited;
	}

	// ---- trail normalization ----------------------------------------------

	/** Record a completed item into the trail; returns assistant text if any. */
	private recordItem(item: Record<string, unknown>): string | undefined {
		const { sessionManager, onEvent } = this.options;
		switch (item.type) {
			case "agentMessage": {
				const text = typeof item.text === "string" ? item.text : "";
				onEvent?.({ type: "assistant", text });
				// Interim (phase-tagged) agent messages are narration; all are
				// trailed as custom entries, the FINAL one becomes the
				// assistant message at turn/completed (Desktop wire lesson:
				// final = LAST agentMessage).
				sessionManager.appendCustomEntry("codex_agent_message", item);
				return text;
			}
			case "reasoning": {
				const summary = Array.isArray(item.summary) ? item.summary.join("\n") : "";
				onEvent?.({ type: "reasoning", summary });
				sessionManager.appendCustomEntry("codex_reasoning", item);
				return undefined;
			}
			case "commandExecution": {
				onEvent?.({
					type: "command",
					command: String(item.command ?? ""),
					status: String(item.status ?? ""),
					exitCode: (item.exitCode as number | null | undefined) ?? null,
				});
				sessionManager.appendCustomEntry("codex_command", item);
				return undefined;
			}
			case "fileChange": {
				sessionManager.appendCustomEntry("codex_file_change", item);
				return undefined;
			}
			case "userMessage":
				return undefined; // we already trailed our own user message
			default: {
				sessionManager.appendCustomEntry("codex_item", item);
				return undefined;
			}
		}
	}

	// ---- authority bridge ---------------------------------------------------

	private installHandlers(): void {
		this.requestHandlers.set("item/commandExecution/requestApproval", async (params) => {
			const record = (params ?? {}) as Record<string, unknown>;
			const itemId = typeof record.itemId === "string" ? record.itemId : "";
			const fromItem = this.itemsById.get(itemId);
			const command =
				typeof record.command === "string"
					? record.command
					: typeof fromItem?.command === "string"
						? (fromItem.command as string)
						: "";
			return { decision: await this.decideCommand(command) };
		});
		this.requestHandlers.set("item/fileChange/requestApproval", async (params) => {
			const record = (params ?? {}) as Record<string, unknown>;
			const itemId = typeof record.itemId === "string" ? record.itemId : "";
			const fromItem = this.itemsById.get(itemId);
			const changes = Array.isArray(fromItem?.changes) ? (fromItem?.changes as Array<Record<string, unknown>>) : [];
			const paths = changes.map((change) => String(change.path ?? "")).filter(Boolean);
			return { decision: await this.decidePatch(paths) };
		});
	}

	private async decideCommand(command: string): Promise<"accept" | "decline"> {
		const { authority, cwd, sessionManager, onEvent } = this.options;
		if (!authority) {
			onEvent?.({ type: "gate", decision: "accept", command });
			return "accept";
		}
		let decision = evaluateToolCall(authority, "bash", { command }, cwd, {
			attended: Boolean(this.options.attended),
			actor: this.options.actor,
			productWorktree: this.options.productWorktree,
		});
		decision = await finalizeAuthorityDecision(authority, decision, "bash", { command });
		if (decision.kind === "allow") {
			onEvent?.({ type: "gate", decision: "accept", command });
			return "accept";
		}
		sessionManager.appendCustomEntry("qorpera_gate", {
			engine: "codex",
			tool: "bash",
			command,
			gateId: decision.gateId,
			reason: decision.reason,
		});
		onEvent?.({ type: "gate", decision: "decline", command, reason: decision.reason });
		return "decline";
	}

	private async decidePatch(paths: string[]): Promise<"accept" | "decline"> {
		const { authority, cwd, sessionManager, onEvent } = this.options;
		if (!authority) return "accept";
		for (const path of paths.length > 0 ? paths : [""]) {
			let decision = evaluateToolCall(authority, "apply_patch", path ? { path } : {}, cwd, {
				attended: Boolean(this.options.attended),
				actor: this.options.actor,
				productWorktree: this.options.productWorktree,
			});
			decision = await finalizeAuthorityDecision(authority, decision, "apply_patch", path ? { path } : {});
			if (decision.kind === "block") {
				sessionManager.appendCustomEntry("qorpera_gate", {
					engine: "codex",
					tool: "apply_patch",
					path,
					gateId: decision.gateId,
					reason: decision.reason,
				});
				onEvent?.({ type: "gate", decision: "decline", command: `apply_patch ${path}`, reason: decision.reason });
				return "decline";
			}
		}
		return "accept";
	}

	// ---- JSON-RPC plumbing --------------------------------------------------

	private onLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;
		if (process.env.QORPERA_ENGINE_DEBUG) {
			process.stderr.write(`[codex-wire] ${trimmed.slice(0, 500)}\n`);
		}
		let message: JsonRpcMessage;
		try {
			message = JSON.parse(trimmed) as JsonRpcMessage;
		} catch {
			return; // non-protocol noise on stdout
		}
		if (message.id !== undefined && message.method) {
			// Server → client request.
			const handler = this.requestHandlers.get(message.method);
			const id = message.id;
			if (!handler) {
				this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `unhandled: ${message.method}` } });
				return;
			}
			handler(message.params)
				.then((result) => this.write({ jsonrpc: "2.0", id, result }))
				.catch((error: unknown) =>
					this.write({ jsonrpc: "2.0", id, error: { code: -32000, message: String(error) } }),
				);
			return;
		}
		if (message.id !== undefined) {
			const pending = this.pending.get(message.id as number);
			if (pending) {
				this.pending.delete(message.id as number);
				if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
				else pending.resolve(message.result);
			}
			return;
		}
		if (message.method) {
			this.notificationHandlers.get(message.method)?.(message.params);
		}
	}

	private request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
		const id = this.nextId++;
		const promise = new Promise<unknown>((resolve, reject) => {
			let timer: NodeJS.Timeout | undefined;
			if (timeoutMs) {
				timer = setTimeout(() => {
					this.pending.delete(id);
					reject(
						new Error(`codex ${method} timed out after ${timeoutMs}ms. stderr: ${this.stderrTail.join("\n")}`),
					);
				}, timeoutMs);
				timer.unref?.();
			}
			this.pending.set(id, {
				resolve: (value) => {
					if (timer) clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					if (timer) clearTimeout(timer);
					reject(error);
				},
			});
		});
		this.write({ jsonrpc: "2.0", id, method, params });
		return promise;
	}

	private notify(method: string, params: unknown): void {
		this.write({ jsonrpc: "2.0", method, params });
	}

	private write(message: JsonRpcMessage): void {
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private failAll(error: Error): void {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}
}
