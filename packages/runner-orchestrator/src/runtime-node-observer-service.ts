import { request } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { withAbortScope } from "./abort-scope.ts";
import { officeDigest, officeRecord } from "./lxd-office-image-provenance.ts";
import { readLxdOfficeCredentialFile, readLxdOfficeProtectedFile } from "./lxd-office-physical-host.ts";
import { RuntimeNodeAgentExitPublisher } from "./runtime-node-agent-exit.ts";
import { RuntimeNodeHealthPublisher } from "./runtime-node-health.ts";
import { parseRuntimeNodeInventoryPolicy } from "./runtime-node-inventory.ts";
import {
	RuntimeNodeInventoryObserver,
	type RuntimeNodeObserverMethod,
	type RuntimeNodeObserverRegistry,
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
		try {
			signal.throwIfAborted();
			const body = JSON.stringify(args);
			if (Buffer.byteLength(body) > LIMIT) throw new Error();
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
						const fail = () => {
							res.destroy();
							req.destroy();
							reject(new Error());
						};
						const length = res.headers["content-length"];
						if (
							res.statusCode !== 200 ||
							!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(res.headers["content-type"] ?? "") ||
							(length !== undefined && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > LIMIT))
						) {
							fail();
							return;
						}
						const chunks: Buffer[] = [];
						let size = 0;
						res.on("data", (chunk: Buffer) => {
							size += chunk.length;
							if (size > LIMIT) {
								fail();
								return;
							}
							chunks.push(chunk);
						});
						res.once("end", () => {
							try {
								signal.throwIfAborted();
								if (!res.complete || (length !== undefined && Number(length) !== size)) throw new Error();
								resolve(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks))));
							} catch {
								fail();
							}
						});
					},
				);
				req.once("error", reject);
				req.end(body);
			});
		} catch {
			throw new Error("NODE_OBSERVER_RPC_UNCONFIRMED");
		} finally {
			this.#pending = false;
		}
	}
}

/** No enrollment or arbitrary endpoint supplied by a member or environment.
 * The operator installs the reviewed public policy and separate private key.
 * A stopped/failed observer simply loses eligibility through original-time
 * expiry; it never deletes inventory or frees a machine reservation. */
export async function runRuntimeNodeObserver(
	signal: AbortSignal,
	report: (state: "ready" | "unavailable" | "unconfirmed") => void,
	reportHealth: (state: "reported" | "unconfirmed") => void = () => {},
	reportExit: (state: "healthy" | "unhealthy" | "unconfirmed") => void = () => {},
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

/** The observer's three loops, one look every `pauseMs` each. `signal` lasts as long as the process, so each look runs
 * under a scope of its own (abort-scope.ts). */
export async function runRuntimeNodeObserverLoops(
	signal: AbortSignal,
	looks: {
		inventory: (signal: AbortSignal) => Promise<{ state: "ready" | "unavailable" }>;
		health: (signal: AbortSignal) => Promise<unknown>;
		exit: (signal: AbortSignal) => Promise<{ healthy: boolean }>;
	},
	reports: {
		report: (state: "ready" | "unavailable" | "unconfirmed") => void;
		reportHealth: (state: "reported" | "unconfirmed") => void;
		reportExit: (state: "healthy" | "unhealthy" | "unconfirmed") => void;
	},
	pauseMs = 5000,
): Promise<void> {
	const { report, reportHealth, reportExit } = reports;
	const inventoryLoop = async () => {
		while (!signal.aborted) {
			try {
				report((await withAbortScope(signal, (scoped) => looks.inventory(scoped))).state);
			} catch {
				if (!signal.aborted) report("unconfirmed");
			}
			if (!signal.aborted) await delay(pauseMs, undefined, { signal }).catch(() => {});
		}
	};
	const healthLoop = async () => {
		while (!signal.aborted) {
			try {
				await withAbortScope(signal, (scoped) => looks.health(scoped));
				reportHealth("reported");
			} catch {
				if (!signal.aborted) reportHealth("unconfirmed");
			}
			if (!signal.aborted) await delay(pauseMs, undefined, { signal }).catch(() => {});
		}
	};
	const exitLoop = async () => {
		while (!signal.aborted) {
			try {
				reportExit(
					(await withAbortScope(signal, (scoped) => looks.exit(scoped))).healthy ? "healthy" : "unhealthy",
				);
			} catch {
				if (!signal.aborted) reportExit("unconfirmed");
			}
			if (!signal.aborted) await delay(pauseMs, undefined, { signal }).catch(() => {});
		}
	};
	await Promise.all([inventoryLoop(), healthLoop(), exitLoop()]);
}
