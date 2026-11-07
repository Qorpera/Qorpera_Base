import { describe, expect, it, vi } from "vitest";
import { parseAgentExitHealth, RuntimeNodeAgentExitPublisher } from "../src/runtime-node-agent-exit.ts";
import type { RuntimeNodeObserverMethod } from "../src/runtime-node-observer.ts";

const nodeId = "00000000-0000-4000-8000-000000000010";
const health = (value: unknown) => Buffer.from(JSON.stringify(value));
const checkedAt = "2026-10-04T02:00:05Z";

describe("the agent exit's health file", () => {
	it("is read as the exit wrote it: healthy, how many problems, when it checked (with milliseconds)", () => {
		expect(
			parseAgentExitHealth(
				health({ schema: "qorpera.agent-exit-health/v1", healthy: true, checkedAt, problems: [] }),
			),
		).toEqual({ healthy: true, problemCount: 0, checkedAt: "2026-10-04T02:00:05.000Z" });
		expect(
			parseAgentExitHealth(
				health({
					schema: "qorpera.agent-exit-health/v1",
					healthy: false,
					checkedAt,
					problems: ["no DNS", "logger silent"],
				}),
			),
		).toEqual({ healthy: false, problemCount: 2, checkedAt: "2026-10-04T02:00:05.000Z" });
	});
	it("is unhealthy, with no check, when it is missing or not the exit's", () => {
		const unknown = { healthy: false, problemCount: 0, checkedAt: null };
		for (const bytes of [
			null,
			Buffer.from("not json"),
			Buffer.from([0xff, 0xfe]),
			health([]),
			health({ schema: "qorpera.agent-exit-health/v2", healthy: true, checkedAt, problems: [] }),
			health({ schema: "qorpera.agent-exit-health/v1", healthy: "true", checkedAt, problems: [] }),
			health({
				schema: "qorpera.agent-exit-health/v1",
				healthy: true,
				checkedAt: "2026-10-04 02:00:05",
				problems: [],
			}),
			health({
				schema: "qorpera.agent-exit-health/v1",
				healthy: true,
				checkedAt: "2026-13-04T02:00:05Z",
				problems: [],
			}),
			health({ schema: "qorpera.agent-exit-health/v1", healthy: true, checkedAt, problems: [1] }),
			health({ schema: "qorpera.agent-exit-health/v1", healthy: true, checkedAt, problems: [], extra: 1 }),
		])
			expect(parseAgentExitHealth(bytes)).toEqual(unknown);
	});
	it("is never healthy with a problem, whatever it says", () => {
		expect(
			parseAgentExitHealth(
				health({ schema: "qorpera.agent-exit-health/v1", healthy: true, checkedAt, problems: ["x"] }),
			),
		).toMatchObject({ healthy: false, problemCount: 1 });
	});
});

describe("the agent exit publisher", () => {
	function registry(answer: unknown = { nodeId, healthy: true }) {
		const calls: { method: RuntimeNodeObserverMethod; args: Record<string, unknown> }[] = [];
		return {
			calls,
			call: vi.fn(async (method: RuntimeNodeObserverMethod, args: Record<string, unknown>) => {
				calls.push({ method, args });
				return answer;
			}),
		};
	}
	it("posts the node's identity and the exit's answer, never its problem texts", async () => {
		const r = registry();
		const publisher = new RuntimeNodeAgentExitPublisher(nodeId, "a".repeat(64), "b".repeat(64), r, async () =>
			health({
				schema: "qorpera.agent-exit-health/v1",
				healthy: false,
				checkedAt,
				problems: ["qp/m1 (10.210.1.1) …"],
			}),
		);
		const report = await publisher.observe(new AbortController().signal);
		expect(r.calls).toHaveLength(1);
		expect(r.calls[0].method).toBe("qorpera_observe_runtime_node_agent_exit");
		const posted = r.calls[0].args.p_observation as Record<string, unknown>;
		expect(posted).toEqual(report.observation);
		expect(report).toMatchObject({
			healthy: false,
			reason: { check: "exit-health", code: "NODE_AGENT_EXIT_PROBLEMS" },
		});
		expect(JSON.stringify(report.reason)).not.toContain("10.210.1.1");
		expect(Object.keys(posted).sort()).toEqual([
			"checkedAt",
			"healthy",
			"machineIdSha256",
			"nodeId",
			"observationId",
			"observedAt",
			"policySha256",
			"problemCount",
			"schema",
		]);
		expect(posted).toMatchObject({
			schema: "qorpera.runtime-node-agent-exit/v1",
			nodeId,
			machineIdSha256: "a".repeat(64),
			policySha256: "b".repeat(64),
			healthy: false,
			problemCount: 1,
			checkedAt: "2026-10-04T02:00:05.000Z",
		});
		expect(JSON.stringify(posted)).not.toContain("10.210.1.1");
		expect(posted.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	});
	it("posts an unreadable answer as unhealthy, and refuses an answer from the database that is not its node's", async () => {
		const r = registry();
		await new RuntimeNodeAgentExitPublisher(nodeId, "a".repeat(64), "b".repeat(64), r, async () => null).observe(
			new AbortController().signal,
		);
		expect(r.calls[0].args.p_observation).toMatchObject({ healthy: false, checkedAt: null, problemCount: 0 });
		const wrong = registry({ nodeId: "00000000-0000-4000-8000-000000000011", healthy: true });
		await expect(
			new RuntimeNodeAgentExitPublisher(nodeId, "a".repeat(64), "b".repeat(64), wrong, async () => null).observe(
				new AbortController().signal,
			),
		).rejects.toThrow("NODE_AGENT_EXIT_REPORT_UNCONFIRMED");
	});
	it("says why the exit is unhealthy for the log line, a closed code only, and nothing when it is healthy", async () => {
		const reason = async (read: () => Promise<Buffer | null>) => {
			const r = registry();
			const look = await new RuntimeNodeAgentExitPublisher(nodeId, "a".repeat(64), "b".repeat(64), r, read).observe(
				new AbortController().signal,
			);
			// The report the database gets has no reason in it.
			expect(Object.keys(r.calls[0].args.p_observation as object)).not.toContain("reason");
			return look.reason;
		};
		const answer = (fields: Record<string, unknown>) => async () =>
			health({ schema: "qorpera.agent-exit-health/v1", healthy: true, checkedAt, problems: [], ...fields });
		expect(await reason(answer({}))).toBeNull();
		expect(await reason(answer({ healthy: false }))).toEqual({
			check: "exit-health",
			code: "NODE_AGENT_EXIT_UNHEALTHY",
		});
		expect(await reason(answer({ problems: ["qp/m1 (10.210.1.1)"] }))).toEqual({
			check: "exit-health",
			code: "NODE_AGENT_EXIT_PROBLEMS",
		});
		expect(await reason(async () => null)).toEqual({
			check: "exit-health",
			code: "NODE_AGENT_EXIT_HEALTH_UNREADABLE",
		});
		expect(await reason(async () => Buffer.from("not json"))).toEqual({
			check: "exit-health",
			code: "NODE_AGENT_EXIT_HEALTH_MALFORMED",
		});
		expect(await reason(answer({ extra: 1 }))).toEqual({
			check: "exit-health",
			code: "NODE_AGENT_EXIT_HEALTH_MALFORMED",
		});
		// A read that fails names its system code, never its message or the path.
		const missing = Object.assign(new Error("ENOENT: no such file or directory, open '/run/private/health.json'"), {
			code: "ENOENT",
		});
		expect(
			await reason(async () => {
				throw missing;
			}),
		).toEqual({ check: "exit-health", code: "ENOENT" });
		expect(
			await reason(async () => {
				throw new Error("refused /run/private/health.json");
			}),
		).toEqual({ check: "exit-health", code: "UNCODED" });
	});
	it("refuses an identity that is not one, and a second report while one is pending", async () => {
		expect(() => new RuntimeNodeAgentExitPublisher("node", "a".repeat(64), "b".repeat(64), registry())).toThrow(
			"INVALID_NODE_AGENT_EXIT_PUBLISHER",
		);
		let release = (): void => {};
		const slow = {
			call: vi.fn(
				() =>
					new Promise((resolve) => {
						release = () => resolve({ nodeId, healthy: true });
					}),
			),
		};
		const publisher = new RuntimeNodeAgentExitPublisher(
			nodeId,
			"a".repeat(64),
			"b".repeat(64),
			slow,
			async () => null,
		);
		const first = publisher.observe(new AbortController().signal);
		await expect(publisher.observe(new AbortController().signal)).rejects.toThrow("NODE_AGENT_EXIT_REPORT_PENDING");
		await new Promise((resolve) => setImmediate(resolve));
		release();
		await first;
	});
});
