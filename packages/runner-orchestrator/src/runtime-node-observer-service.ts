import { request } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { withAbortScope } from "./abort-scope.ts";
import { officeDigest, officeRecord } from "./lxd-office-image-provenance.ts";
import { readLxdOfficeCredentialFile, readLxdOfficeProtectedFile } from "./lxd-office-physical-host.ts";
import { RuntimeNodeAgentExitPublisher } from "./runtime-node-agent-exit.ts";
import { RUNTIME_NODE_HEALTH_WAIT_MS, RuntimeNodeHealthPublisher } from "./runtime-node-health.ts";
import { parseRuntimeNodeInventoryPolicy } from "./runtime-node-inventory.ts";
import {
	RuntimeNodeInventoryObserver,
	RuntimeNodeObserverFailure,
	type RuntimeNodeObserverMethod,
	type RuntimeNodeObserverReason,
	type RuntimeNodeObserverRegistry,
	runtimeNodeObserverCode,
	runtimeNodeObserverFailureReason,
} from "./runtime-node-observer.ts";

const METHODS = new Set<RuntimeNodeObserverMethod>([
	"qorpera_runtime_node_inventory_context",
	"qorpera_observe_runtime_node_inventory",
	"qorpera_observe_runtime_node",
	"qorpera_observe_runtime_node_health",
	"qorpera_observe_runtime_node_agent_exit",
]);
const LIMIT = 4194304;
export class RuntimeNodeObserverHttpRegistry implements RuntimeNodeObserverRegistry {
	readonly #origin: string;
	readonly #key: string;
	#pending = false;
	constructor(origin: string, key: string) {
		const url = new URL(origin);
		if (url.protocol !== "https:" || origin !== url.origin || !/^[A-Za-z0-9_.-]{32,4096}$/.test(key))
			throw new Error("INVALID_NODE_OBSERVER_ENDPOINT");
		this.#origin = origin;
		this.#key = key;
	}
	async call(method: RuntimeNodeObserverMethod, args: Record<string, unknown>, caller: AbortSignal): Promise<unknown> {
		const signal = AbortSignal.any([caller, AbortSignal.timeout(5000)]);
		if (!METHODS.has(method) || this.#pending) throw new Error("NODE_OBSERVER_RPC_UNAVAILABLE");
		this.#pending = true;
		// Every failure is NODE_OBSERVER_RPC_UNCONFIRMED, carrying a closed code for the log line: the HTTP status, what
		// was wrong with the answer, the socket's system code, or the timeout. Never the answer's bytes.
		const unconfirmed = (code: string) => new RuntimeNodeObserverFailure("NODE_OBSERVER_RPC_UNCONFIRMED", code);
		try {
			signal.throwIfAborted();
			const body = JSON.stringify(args);
			if (Buffer.byteLength(body) > LIMIT) throw unconfirmed("NODE_OBSERVER_RPC_REQUEST_TOO_LARGE");
			return await new Promise((resolve, reject) => {
				const req = request(
					`${this.#origin}/rest/v1/rpc/${method}`,
					{
						method: "POST",
						signal,
						headers: {
							apikey: this.#key,
							authorization: `Bearer ${this.#key}`,
							"content-type": "application/json",
							accept: "application/json",
							"content-length": Buffer.byteLength(body),
						},
					},
					(res) => {
						res.once("error", reject);
						const fail = (code: string) => {
							res.destroy();
							req.destroy();
							reject(unconfirmed(code));
						};
						const length = res.headers["content-length"];
						const refused =
							res.statusCode !== 200
								? `NODE_OBSERVER_RPC_HTTP_${res.statusCode ?? 0}`
								: !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(res.headers["content-type"] ?? "")
									? "NODE_OBSERVER_RPC_CONTENT_TYPE"
									: length !== undefined && !/^(0|[1-9][0-9]*)$/.test(length)
										? "NODE_OBSERVER_RPC_RESPONSE_INVALID"
										: length !== undefined && Number(length) > LIMIT
											? "NODE_OBSERVER_RPC_RESPONSE_TOO_LARGE"
											: null;
						if (refused) {
							fail(refused);
							return;
						}
						const chunks: Buffer[] = [];
						let size = 0;
						res.on("data", (chunk: Buffer) => {
							size += chunk.length;
							if (size > LIMIT) {
								fail("NODE_OBSERVER_RPC_RESPONSE_TOO_LARGE");
								return;
							}
							chunks.push(chunk);
						});
						res.once("end", () => {
							if (signal.aborted) fail(this.#stopped(caller));
							else if (!res.complete || (length !== undefined && Number(length) !== size))
								fail("NODE_OBSERVER_RPC_RESPONSE_INCOMPLETE");
							else {
								try {
									resolve(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks))));
								} catch {
									fail("NODE_OBSERVER_RPC_RESPONSE_INVALID");
								}
							}
						});
					},
				);
				req.once("error", reject);
				req.end(body);
			});
		} catch (error) {
			if (error instanceof RuntimeNodeObserverFailure) throw error;
			throw unconfirmed(signal.aborted ? this.#stopped(caller) : runtimeNodeObserverCode(error));
		} finally {
			this.#pending = false;
		}
	}
	/** Why a call's signal ended: its own five seconds, or the caller's (a look's own timeout, or the process stopping). */
	#stopped(caller: AbortSignal): string {
		return caller.aborted ? runtimeNodeObserverCode(caller.reason) : "NODE_OBSERVER_RPC_TIMEOUT";
	}
}

/** No enrollment or arbitrary endpoint supplied by a member or environment.
 * The operator installs the reviewed public policy and separate private key.
 * A stopped/failed observer simply loses eligibility through original-time
 * expiry; it never deletes inventory or frees a machine reservation. */
export async function runRuntimeNodeObserver(
	signal: AbortSignal,
	report: ObserverReport<"ready" | "unavailable" | "unconfirmed">,
	reportHealth: ObserverReport<"reported" | "unconfirmed"> = () => {},
	reportExit: ObserverReport<"healthy" | "unhealthy" | "unconfirmed"> = () => {},
): Promise<void> {
	const config = officeRecord(
		JSON.parse(
			new TextDecoder("utf8", { fatal: true }).decode(
				await readLxdOfficeProtectedFile("/etc/qorpera/node-observer.json", 65536),
			),
		),
		["registryUrl", "policy"],
	);
	if (typeof config.registryUrl !== "string") throw new Error("INVALID_NODE_OBSERVER_ENDPOINT");
	const bytes = await readLxdOfficeCredentialFile("/etc/qorpera/node-observer.key", 4096);
	let registry: RuntimeNodeObserverHttpRegistry,
		healthRegistry: RuntimeNodeObserverHttpRegistry,
		exitRegistry: RuntimeNodeObserverHttpRegistry;
	try {
		registry = new RuntimeNodeObserverHttpRegistry(
			config.registryUrl,
			new TextDecoder("utf8", { fatal: true }).decode(bytes).trim(),
		);
		// Independent request ownership: a slow diagnostic export cannot occupy
		// the inventory connection or become an admission prerequisite.
		healthRegistry = new RuntimeNodeObserverHttpRegistry(
			config.registryUrl,
			new TextDecoder("utf8", { fatal: true }).decode(bytes).trim(),
		);
		// The agent exit's health has its own connection too: placement depends on it, the inventory never waits on it.
		exitRegistry = new RuntimeNodeObserverHttpRegistry(
			config.registryUrl,
			new TextDecoder("utf8", { fatal: true }).decode(bytes).trim(),
		);
	} finally {
		bytes.fill(0);
	}
	const policy = parseRuntimeNodeInventoryPolicy(config.policy),
		observer = new RuntimeNodeInventoryObserver(policy, registry);
	const health = new RuntimeNodeHealthPublisher(
		policy.nodeId,
		policy.host.machineIdSha256,
		officeDigest(policy),
		healthRegistry,
	);
	const exit = new RuntimeNodeAgentExitPublisher(
		policy.nodeId,
		policy.host.machineIdSha256,
		officeDigest(policy),
		exitRegistry,
	);
	await runRuntimeNodeObserverLoops(
		signal,
		{
			inventory: (scoped) => observer.observe(scoped),
			health: (scoped) => health.observe(scoped),
			exit: (scoped) => exit.observe(scoped),
		},
		{ report, reportHealth, reportExit },
	);
}

/** A loop's report: the look's state, and why it was not ready (null when it was). */
export type ObserverReport<State extends string> = (state: State, reason: RuntimeNodeObserverReason | null) => void;

/** The observer's journal line for one look: `{event, state}`, and for a look that was not whole its step, closed code
 * and entry kinds (`check`, `code`, `entries`). Nothing else: a healthy line is the same as before. */
export function runtimeNodeObserverLine(
	event: string,
	state: string,
	reason: RuntimeNodeObserverReason | null,
): string {
	const why = reason
		? { check: reason.check, code: reason.code, ...(reason.entries ? { entries: reason.entries } : {}) }
		: {};
	return `${JSON.stringify({ event, state, ...why })}\n`;
}

/** The observer's three loops: inventory and agent exit one look every `pauseMs` each (placement reads them), health
 * every `healthPauseMs` (RUNTIME_NODE_HEALTH_WAIT_MS: nothing gates on it). `signal` lasts as long as the process, so
 * each look runs under a scope of its own (abort-scope.ts). A look that throws reports the step it names, else the
 * loop's own: `look` for the inventory (busy before its first step), `publish` for health and the exit (only their
 * publication and its receipt can throw). */
export async function runRuntimeNodeObserverLoops(
	signal: AbortSignal,
	looks: {
		inventory: (
			signal: AbortSignal,
		) => Promise<{ state: "ready" | "unavailable"; reason?: RuntimeNodeObserverReason | null }>;
		health: (signal: AbortSignal) => Promise<RuntimeNodeObserverReason | null | undefined>;
		exit: (signal: AbortSignal) => Promise<{ healthy: boolean; reason?: RuntimeNodeObserverReason | null }>;
	},
	reports: {
		report: ObserverReport<"ready" | "unavailable" | "unconfirmed">;
		reportHealth: ObserverReport<"reported" | "unconfirmed">;
		reportExit: ObserverReport<"healthy" | "unhealthy" | "unconfirmed">;
	},
	pauseMs = 5000,
	healthPauseMs = RUNTIME_NODE_HEALTH_WAIT_MS,
): Promise<void> {
	const { report, reportHealth, reportExit } = reports;
	const inventoryLoop = async () => {
		while (!signal.aborted) {
			try {
				const look = await withAbortScope(signal, (scoped) => looks.inventory(scoped));
				report(look.state, look.reason ?? null);
			} catch (error) {
				if (!signal.aborted) report("unconfirmed", runtimeNodeObserverFailureReason(error, "look"));
			}
			if (!signal.aborted) await delay(pauseMs, undefined, { signal }).catch(() => {});
		}
	};
	const healthLoop = async () => {
		while (!signal.aborted) {
			try {
				reportHealth("reported", (await withAbortScope(signal, (scoped) => looks.health(scoped))) ?? null);
			} catch (error) {
				if (!signal.aborted) reportHealth("unconfirmed", runtimeNodeObserverFailureReason(error, "publish"));
			}
			if (!signal.aborted) await delay(healthPauseMs, undefined, { signal }).catch(() => {});
		}
	};
	const exitLoop = async () => {
		while (!signal.aborted) {
			try {
				const look = await withAbortScope(signal, (scoped) => looks.exit(scoped));
				reportExit(look.healthy ? "healthy" : "unhealthy", look.reason ?? null);
			} catch (error) {
				if (!signal.aborted) reportExit("unconfirmed", runtimeNodeObserverFailureReason(error, "publish"));
			}
			if (!signal.aborted) await delay(pauseMs, undefined, { signal }).catch(() => {});
		}
	};
	await Promise.all([inventoryLoop(), healthLoop(), exitLoop()]);
}
