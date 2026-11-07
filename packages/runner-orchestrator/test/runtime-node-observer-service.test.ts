import { describe, expect, it } from "vitest";
import { RuntimeNodeObserverFailure, type RuntimeNodeObserverReason } from "../src/runtime-node-observer.ts";
import { runRuntimeNodeObserverLoops, runtimeNodeObserverLine } from "../src/runtime-node-observer-service.ts";
import { watchAbortSignalAny } from "./helpers/abort-any.ts";

describe("the node observer's loops", () => {
	it("look again and again, each look under a scope of its own, and end with the signal that lasts as long as the process", async () => {
		const lasting = new AbortController();
		const looks = { inventory: 0, health: 0, exit: 0 };
		const seen: AbortSignal[] = [];
		const look =
			<T>(kind: keyof typeof looks, answer: T) =>
			async (signal: AbortSignal) => {
				looks[kind]++;
				seen.push(signal);
				// What a real look does with its signal: a request bounded by its own timeout.
				AbortSignal.any([signal, AbortSignal.timeout(60000)]);
				if (Object.values(looks).every((count) => count >= 4)) lasting.abort();
				return answer;
			};
		const reported: string[] = [];
		const watch = watchAbortSignalAny();
		try {
			await runRuntimeNodeObserverLoops(
				lasting.signal,
				{
					inventory: look("inventory", { state: "ready" as const }),
					health: look("health", undefined),
					exit: look("exit", { healthy: true }),
				},
				{
					report: (state) => reported.push(`inventory:${state}`),
					reportHealth: (state) => reported.push(`health:${state}`),
					reportExit: (state) => reported.push(`exit:${state}`),
				},
				1,
				1,
			);
			expect(Object.values(looks).every((count) => count >= 4)).toBe(true);
			expect(reported).toContain("inventory:ready");
			expect(reported).toContain("health:reported");
			expect(reported).toContain("exit:healthy");
			expect(seen.every((signal) => signal !== lasting.signal)).toBe(true);
			expect(watch.on(lasting.signal)).toBe(0);
			// Each look's own signal ends with the process's.
			expect(seen.every((signal) => signal.aborted)).toBe(false);
			expect(seen.at(-1)?.aborted).toBe(true);
		} finally {
			watch.restore();
		}
	});
	it("report why a look was not ready: its own reason, or the step a failure names, or the loop's", async () => {
		const lasting = new AbortController();
		// Each loop plays its steps, then repeats the last; the process stops once every loop has looked past its end,
		// so every scripted look has been reported.
		const script = <T>(steps: (() => T)[]) => {
			let next = 0;
			return {
				done: () => next > steps.length,
				look: async () => {
					const step = steps[Math.min(next++, steps.length - 1)]!;
					if (inventory.done() && health.done() && exit.done()) lasting.abort();
					return step();
				},
			};
		};
		const unavailable = {
			check: "reconcile",
			code: "NODE_INVENTORY_ENTRY_UNAVAILABLE",
			entries: ["unmanaged:UNREGISTERED_INSTANCE"],
		};
		const inventory = script<{ state: "ready" | "unavailable"; reason?: RuntimeNodeObserverReason | null }>([
			() => ({ state: "unavailable", reason: unavailable }),
			() => {
				throw new RuntimeNodeObserverFailure("NODE_OBSERVER_UNCONFIRMED", "NODE_OBSERVER_RPC_HTTP_503", "publish");
			},
			() => {
				throw new Error("NODE_OBSERVER_BUSY");
			},
			() => {
				throw new Error("refused /etc/private/path");
			},
			() => ({ state: "ready", reason: null }),
		]);
		const health = script<RuntimeNodeObserverReason | null>([
			() => ({ check: "collect", code: "NODE_HEALTH_PROBE_TIMEOUT" }),
			() => {
				throw new Error("NODE_HEALTH_PUBLICATION_UNCONFIRMED");
			},
			() => null,
		]);
		const exit = script<{ healthy: boolean; reason?: RuntimeNodeObserverReason | null }>([
			() => ({ healthy: false, reason: { check: "exit-health", code: "ENOENT" } }),
			() => {
				throw new RuntimeNodeObserverFailure("NODE_OBSERVER_RPC_UNCONFIRMED", "NODE_OBSERVER_RPC_TIMEOUT");
			},
			() => ({ healthy: true }),
		]);
		const reported: Record<string, [string, RuntimeNodeObserverReason | null][]> = {
			inventory: [],
			health: [],
			exit: [],
		};
		await runRuntimeNodeObserverLoops(
			lasting.signal,
			{ inventory: inventory.look, health: health.look, exit: exit.look },
			{
				report: (state, reason) => reported.inventory!.push([state, reason]),
				reportHealth: (state, reason) => reported.health!.push([state, reason]),
				reportExit: (state, reason) => reported.exit!.push([state, reason]),
			},
			1,
			1,
		);
		expect(reported.inventory!.slice(0, 5)).toEqual([
			["unavailable", unavailable],
			["unconfirmed", { check: "publish", code: "NODE_OBSERVER_RPC_HTTP_503" }],
			["unconfirmed", { check: "look", code: "NODE_OBSERVER_BUSY" }],
			["unconfirmed", { check: "look", code: "UNCODED" }],
			["ready", null],
		]);
		expect(reported.health!.slice(0, 3)).toEqual([
			["reported", { check: "collect", code: "NODE_HEALTH_PROBE_TIMEOUT" }],
			["unconfirmed", { check: "publish", code: "NODE_HEALTH_PUBLICATION_UNCONFIRMED" }],
			["reported", null],
		]);
		expect(reported.exit!.slice(0, 3)).toEqual([
			["unhealthy", { check: "exit-health", code: "ENOENT" }],
			["unconfirmed", { check: "publish", code: "NODE_OBSERVER_RPC_TIMEOUT" }],
			["healthy", null],
		]);
		expect(JSON.stringify(reported)).not.toContain("private");
	});
});

describe("the node observer's journal line", () => {
	it("is the look's event and state, with its step, code and entry kinds only when it was not ready", () => {
		expect(runtimeNodeObserverLine("node_agent_exit", "healthy", null)).toBe(
			'{"event":"node_agent_exit","state":"healthy"}\n',
		);
		expect(
			runtimeNodeObserverLine("node_health", "unconfirmed", {
				check: "publish",
				code: "NODE_OBSERVER_RPC_TIMEOUT",
			}),
		).toBe('{"event":"node_health","state":"unconfirmed","check":"publish","code":"NODE_OBSERVER_RPC_TIMEOUT"}\n');
		expect(
			JSON.parse(
				runtimeNodeObserverLine("node_inventory", "unavailable", {
					check: "reconcile",
					code: "NODE_INVENTORY_HEADROOM_EXCEEDED",
					entries: [],
				}),
			),
		).toEqual({
			event: "node_inventory",
			state: "unavailable",
			check: "reconcile",
			code: "NODE_INVENTORY_HEADROOM_EXCEEDED",
			entries: [],
		});
	});
});
