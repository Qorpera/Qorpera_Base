import { randomUUID } from "node:crypto";
import { isUuid } from "@qorpera/contracts";
import { readLxdOfficeProtectedFile } from "./lxd-office-physical-host.ts";
import type { RuntimeNodeObserverRegistry } from "./runtime-node-observer.ts";

/** The node's agent exit writes its own health check here every 10 seconds (deploy/agent-exit, `health`). */
export const AGENT_EXIT_HEALTH_PATH = "/run/qorpera-agent-exit/health.json";
const SHA = /^[0-9a-f]{64}$/;

export interface RuntimeNodeAgentExit {
	schema: "qorpera.runtime-node-agent-exit/v1";
	nodeId: string;
	machineIdSha256: string;
	policySha256: string;
	observationId: string;
	observedAt: string;
	/** When the exit checked itself; null when its answer could not be read. */
	checkedAt: string | null;
	healthy: boolean;
	problemCount: number;
}

export type AgentExitHealth = Pick<RuntimeNodeAgentExit, "checkedAt" | "healthy" | "problemCount">;
/** The exit's answer: {schema, healthy, checkedAt (seconds, UTC), problems}. Only whether it is healthy, how many
 * problems it saw and when it checked leave the node: the problem texts name machines and addresses. Anything else
 * (a missing, unprotected or malformed file) is an unhealthy exit with no check. */
export function parseAgentExitHealth(bytes: Buffer | null): AgentExitHealth {
	const unknown = { checkedAt: null, healthy: false, problemCount: 0 };
	if (!bytes) return unknown;
	let value: Record<string, unknown>;
	try {
		value = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
	} catch {
		return unknown;
	}
	const checked = typeof value?.checkedAt === "string" ? value.checkedAt : "";
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join() !== "checkedAt,healthy,problems,schema" ||
		value.schema !== "qorpera.agent-exit-health/v1" ||
		typeof value.healthy !== "boolean" ||
		!Array.isArray(value.problems) ||
		!value.problems.every((problem) => typeof problem === "string") ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(checked) ||
		!Number.isFinite(Date.parse(checked)) ||
		new Date(checked).toISOString() !== checked.replace("Z", ".000Z")
	)
		return unknown;
	const problemCount = Math.min(value.problems.length, 1000);
	// Healthy only as the exit said it, with no problem.
	const healthy = value.healthy && problemCount === 0;
	return { checkedAt: new Date(checked).toISOString(), healthy, problemCount };
}

/** Reports the node's agent exit to the database (qorpera_observe_runtime_node_agent_exit) on its own connection, apart
 * from the inventory: an unhealthy exit keeps new agent road machines off this node, never runs or sign-ins. One report
 * at a time. */
export class RuntimeNodeAgentExitPublisher {
	readonly #nodeId: string;
	readonly #machineIdSha256: string;
	readonly #policySha256: string;
	readonly #registry: RuntimeNodeObserverRegistry;
	readonly #read: () => Promise<Buffer | null>;
	#pending = false;
	constructor(
		nodeId: string,
		machineIdSha256: string,
		policySha256: string,
		registry: RuntimeNodeObserverRegistry,
		read: () => Promise<Buffer | null> = () =>
			readLxdOfficeProtectedFile(AGENT_EXIT_HEALTH_PATH, 65536).catch(() => null),
	) {
		if (!isUuid(nodeId) || !SHA.test(machineIdSha256) || !SHA.test(policySha256))
			throw new Error("INVALID_NODE_AGENT_EXIT_PUBLISHER");
		this.#nodeId = nodeId;
		this.#machineIdSha256 = machineIdSha256;
		this.#policySha256 = policySha256;
		this.#registry = registry;
		this.#read = read;
	}
	async observe(signal: AbortSignal): Promise<RuntimeNodeAgentExit> {
		if (this.#pending) throw new Error("NODE_AGENT_EXIT_REPORT_PENDING");
		this.#pending = true;
		try {
			signal.throwIfAborted();
			const health = parseAgentExitHealth(await this.#read());
			const observation: RuntimeNodeAgentExit = {
				schema: "qorpera.runtime-node-agent-exit/v1",
				nodeId: this.#nodeId,
				machineIdSha256: this.#machineIdSha256,
				policySha256: this.#policySha256,
				observationId: randomUUID(),
				observedAt: new Date().toISOString(),
				...health,
			};
			signal.throwIfAborted();
			const answer = (await this.#registry.call(
				"qorpera_observe_runtime_node_agent_exit",
				{ p_observation: observation },
				signal,
			)) as Record<string, unknown> | null;
			if (!answer || answer.nodeId !== this.#nodeId || typeof answer.healthy !== "boolean")
				throw new Error("NODE_AGENT_EXIT_REPORT_UNCONFIRMED");
			return observation;
		} finally {
			this.#pending = false;
		}
	}
}
