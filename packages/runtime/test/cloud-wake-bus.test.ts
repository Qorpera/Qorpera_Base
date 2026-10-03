import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { CloudAgentMouth } from "@qorpera/runtime/cloud-agent-mouth";
import type { runCloudNativeRunToolSession } from "@qorpera/runtime/cloud-native-run-tool-session";
import { type CloudNativeToolIdentity, CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import {
	CloudNativeToolBoundary,
	type CloudToolContext,
	type CloudToolResult,
} from "@qorpera/runtime/cloud-native-tool-boundary";
import {
	CLOUD_WAKE_SCHEMA,
	CloudNativeWakeBus,
	type CloudWakeControl,
	type CloudWakeEnvelope,
	type CloudWakePolicy,
	cloudCoworkerMessageTool,
	cloudWakeIsOwnThread,
	HttpCloudWakeControl,
	parseCloudWakeEnvelope,
	parseCloudWakePolicy,
	REQUIRED_CLOUD_WAKE_POLICY,
} from "@qorpera/runtime/cloud-wake-bus";
import { describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const policies = JSON.parse(readFileSync(new URL("./fixtures/wake-policies.json", import.meta.url), "utf8")) as {
	scenario: string;
	policy: CloudWakePolicy;
}[];
function fixture() {
	const { binding, authority } = nativeToolAuthorityFixture();
	const input = randomUUID();
	const id = randomUUID();
	const envelope: CloudWakeEnvelope = {
		schema: CLOUD_WAKE_SCHEMA,
		id,
		runId: binding.runId,
		kind: "human",
		companyId: authority.identity.companyId,
		environmentId: authority.identity.environmentId,
		staffAgentId: authority.identity.staffAgentId,
		requesterUserId: authority.identity.requesterUserId,
		actorStaffId: null,
		actorUserId: authority.identity.requesterUserId,
		audience: {
			kind: authority.identity.audienceKind,
			userId: authority.identity.audienceUserId,
			sessionId: authority.identity.sessionId,
		},
		source: { kind: "input", id: input, occurrenceKey: `input:${input}` },
		policy: policies[0].policy,
		time: { utc: "2026-08-28T08:00:00.000000Z", local: "2026-08-28T10:00:00.000000", timeZone: "Europe/Copenhagen" },
		pins: {
			companySnapshotId: randomUUID(),
			staffVersion: authority.identity.staffVersion,
			wakeSchema: CLOUD_WAKE_SCHEMA,
			runtimeBundleVersion: null,
		},
		routine: null,
		payload: { inputIds: [input] },
		parentRunId: null,
		causal: { rootId: id, agentIds: [authority.identity.staffAgentId] },
	};
	return { binding, authority, envelope };
}

async function coworkerFixture() {
	const { binding, authority } = nativeToolAuthorityFixture();
	const run = await CloudNativeToolRun.open(
		binding,
		{ describeToolAuthority: async () => authority },
		new AbortController().signal,
	);
	const message = {
		recipientStaffId: randomUUID(),
		operationKey: "handoff-1",
		text: "Please examine the note.",
		priority: true,
	};
	const receipt = {
		schema: "qorpera.coworker-send/v1",
		runId: binding.runId,
		receiptId: randomUUID(),
		occurrenceId: randomUUID(),
		recipientStaffId: message.recipientStaffId,
		status: "queued",
	} as const;
	const call = vi.fn<CloudWakeControl["call"]>(async () => receipt);
	const bus = new CloudNativeWakeBus(run, { call });
	// This callback type is the existing host contract, with no new run handle.
	const makeTools = ((identity: CloudNativeToolIdentity) => ({
		tools: [cloudCoworkerMessageTool(binding, identity, { call })],
		assertContext: (signal: AbortSignal) => run.assertActive(signal),
		// Context views are host-fenced elsewhere; this focused test never releases one.
		recordContextView: async () => {
			throw new Error("recordContextView is not exercised by the wake-bus tool test");
		},
	})) satisfies Parameters<typeof runCloudNativeRunToolSession>[0]["tools"];
	const createBoundary = () => {
		const adapters = makeTools(run.identity);
		return new CloudNativeToolBoundary({
			companyId: run.identity.companyId,
			runId: run.identity.runId,
			identity: run.identity,
			tools: adapters.tools,
			assertActive: (signal) => run.assertActive(signal),
			signal: run.signal,
		});
	};
	return { binding, run, message, receipt, call, bus, createBoundary };
}

function officeWakeFixture() {
	const { authority, envelope } = fixture();
	const identity = { ...authority.identity, audienceKind: "company" as const, audienceUserId: null, sessionId: null };
	const parentRunId = randomUUID();
	const intentId = randomUUID();
	const wake: CloudWakeEnvelope = {
		...envelope,
		kind: "agent",
		actorStaffId: null,
		actorUserId: null,
		parentRunId,
		audience: { kind: "company", userId: null, sessionId: null },
		source: {
			kind: "office-activation",
			id: randomUUID(),
			occurrenceKey: `office-activation:${intentId}:${parentRunId}`,
		},
		policy: {
			schema: "qorpera.wake-policy/v1",
			kind: "agent",
			initial: "forbidden",
			final: "forbidden",
			silenceAllowed: true,
			maxPublicSends: 0,
		},
		payload: {
			schema: "qorpera.office-start-continuation/v1",
			intentId,
			activationId: randomUUID(),
			companyComputerId: randomUUID(),
			computerGeneration: 1,
			receiptId: randomUUID(),
		},
	};
	return { identity, wake };
}

function workerWakeFixture(kind: "worker-dispatch" | "worker-completion") {
	const { authority, envelope } = fixture();
	const sessionId = kind === "worker-completion" ? randomUUID() : null;
	const identity = { ...authority.identity, audienceKind: "company" as const, audienceUserId: null, sessionId };
	const parentRunId = randomUUID();
	const workerId = randomUUID();
	const silent = policies.find((item) => item.scenario === "agent")!.policy;
	const continuation = policies.find((item) => item.scenario === "agent-continuation")!.policy;
	const wake: CloudWakeEnvelope = {
		...envelope,
		kind: "agent",
		actorStaffId: null,
		actorUserId: null,
		parentRunId,
		audience: { kind: "company", userId: null, sessionId },
		source: { kind, id: workerId, occurrenceKey: `${kind}:${workerId}:1` },
		policy: kind === "worker-dispatch" ? silent : continuation,
		payload:
			kind === "worker-dispatch"
				? {
						schema: "qorpera.worker-dispatch/v1",
						workerId,
						workerKey: "prices",
						sequence: 1,
						species: "in-house",
						title: "Collect prices",
						todo: { todoKey: "market-scan", title: "Market scan", path: "work/todos/a/market-scan.json" },
						parentRunId,
						access: "read",
						outputFolder: "work/todos/a/market-scan/prices",
						dispatch: {
							goal: "Collect the list prices.",
							definitionOfDone: "One verified price per competitor.",
							context: "",
							sources: ["research/competitors.md"],
							followUp: null,
							authority: "Read what this agent may read. Write nothing.",
							output: "Report once through report_work.",
							cancellation: "Ends with its todo.",
							completion: "The parent is revived as soon as you report.",
						},
					}
				: {
						schema: "qorpera.worker-completion/v1",
						parentRunId,
						completions: [
							{
								workerKey: "prices",
								todoKey: "market-scan",
								title: "Collect prices",
								sequence: 1,
								outcome: "succeeded",
								summary: "Alfa 49, Beta 59, Gamma 45.",
								summaryTruncated: false,
								needs: null,
								outputs: [],
							},
						],
						stillActive: 0,
					},
	};
	return { identity, wake, silent, continuation };
}

/** Exactly what qorpera_machine_event_payload / qorpera_machine_event_view build. */
function machineWakeFixture() {
	const { identity, wake, continuation } = workerWakeFixture("worker-completion");
	const eventId = randomUUID(),
		machineId = randomUUID(),
		commandId = randomUUID();
	const machineWake: CloudWakeEnvelope = {
		...wake,
		// The key names the wake itself: every drain attempt is its own occurrence.
		source: { kind: "machine-event", id: eventId, occurrenceKey: `machine-event:${randomUUID()}` },
		policy: continuation,
		payload: {
			schema: "qorpera.machine-event/v1",
			parentRunId: wake.parentRunId,
			events: [
				{
					machine: "build-a",
					machineId,
					kind: "running",
					at: "2026-09-28T05:53:26.087508+00:00",
					machineState: "running",
					command: null,
					commandId: null,
					commandState: null,
					exitCode: null,
					outputTail: null,
				},
				{
					machine: "build-a",
					machineId,
					kind: "command",
					at: "2026-09-28T05:55:01.100000+00:00",
					machineState: "running",
					command: "npm test",
					commandId,
					commandState: "failed",
					exitCode: 2,
					outputTail: "1 test failed",
				},
				{
					machine: "build-b",
					machineId: randomUUID(),
					kind: "stopped",
					at: "2026-09-28T05:56:00.000000+00:00",
					machineState: "stopped",
					command: null,
					commandId: null,
					commandState: null,
					exitCode: null,
					outputTail: null,
				},
			],
			stillWaiting: 0,
		},
	};
	return { identity, wake: machineWake };
}

describe("machine event envelopes", () => {
	it("admits a machine event as an internal continuation in its parent's conversation", () => {
		const { identity, wake } = machineWakeFixture();
		const parsed = parseCloudWakeEnvelope(wake, identity);
		expect(parsed.source.kind).toBe("machine-event");
		expect(parsed.policy).toMatchObject({ initial: "optional", final: "optional" });
	});
	it.each([
		(wake: CloudWakeEnvelope) => ({ ...wake, actorUserId: randomUUID() }),
		(wake: CloudWakeEnvelope) => ({ ...wake, parentRunId: null }),
		(wake: CloudWakeEnvelope) => ({ ...wake, payload: { ...wake.payload, schema: "qorpera.worker-completion/v1" } }),
		(wake: CloudWakeEnvelope) => ({ ...wake, payload: { ...wake.payload, events: [] } }),
		(wake: CloudWakeEnvelope) => ({
			...wake,
			payload: { ...wake.payload, events: [{ ...(wake.payload.events as object[])[1], kind: "shell" }] },
		}),
		(wake: CloudWakeEnvelope) => ({
			...wake,
			payload: { ...wake.payload, events: [{ ...(wake.payload.events as object[])[1], extra: true }] },
		}),
	])("rejects a machine event that is not exactly what the kernel admits %#", (mutate) => {
		const { identity, wake } = machineWakeFixture();
		expect(() => parseCloudWakeEnvelope(mutate(wake), identity)).toThrow();
	});
});

describe("worker dispatch and completion envelopes", () => {
	it("admits a blank worker with a complete dispatch and no public mouth", () => {
		const { identity, wake } = workerWakeFixture("worker-dispatch");
		const parsed = parseCloudWakeEnvelope(wake, identity);
		expect(parsed).toEqual(wake);
		expect(parsed.policy.maxPublicSends).toBe(0);
		expect(Object.isFrozen(parsed.payload.dispatch)).toBe(true);
	});
	it("admits a coding session turn: species coding with the executor's scope, up to 64 turns, read access", () => {
		const { identity, wake } = workerWakeFixture("worker-dispatch");
		const workerId = wake.source.id;
		const coding = {
			harness: "codex",
			repository: { host: "github.com", owner: "Qorpera", name: "Qorpera_Base", baseBranch: "master" },
			branch: `qorpera/coding/${workerId}`,
			baseSha: null,
			harnessSessionRef: null,
			sequence: 1,
			vmId: randomUUID(),
		};
		const turn = { ...wake, payload: { ...wake.payload, species: "coding", coding } };
		expect(parseCloudWakeEnvelope(turn, identity).payload.species).toBe("coding");
		expect(() =>
			parseCloudWakeEnvelope(
				{ ...turn, payload: { ...turn.payload, coding: { ...coding, sequence: 2 } } },
				identity,
			),
		).toThrow();
		expect(() =>
			parseCloudWakeEnvelope({ ...turn, payload: { ...turn.payload, access: "write" } }, identity),
		).toThrow();
		expect(() =>
			parseCloudWakeEnvelope(
				{ ...turn, payload: { ...turn.payload, coding: { ...coding, harness: "shell" } } },
				identity,
			),
		).toThrow();
		expect(() => parseCloudWakeEnvelope({ ...wake, payload: { ...wake.payload, coding } }, identity)).toThrow();
	});
	it("admits a completion as an internal continuation that may speak in its parent's conversation", () => {
		const { identity, wake } = workerWakeFixture("worker-completion");
		const parsed = parseCloudWakeEnvelope(wake, identity);
		expect(parsed.policy).toMatchObject({ initial: "optional", final: "optional", maxPublicSends: null });
		expect([parsed.actorUserId, parsed.actorStaffId]).toEqual([null, null]);
	});
	it.each([
		(wake: CloudWakeEnvelope) => ({ ...wake, actorUserId: randomUUID() }),
		(wake: CloudWakeEnvelope) => ({ ...wake, actorStaffId: wake.staffAgentId }),
		(wake: CloudWakeEnvelope) => ({ ...wake, parentRunId: null }),
		(wake: CloudWakeEnvelope) => ({ ...wake, parentRunId: wake.runId }),
		(wake: CloudWakeEnvelope) => ({ ...wake, source: { ...wake.source, id: randomUUID() } }),
		(wake: CloudWakeEnvelope) => ({ ...wake, payload: { ...wake.payload, species: "coding" } }),
		(wake: CloudWakeEnvelope) => ({ ...wake, payload: { ...wake.payload, access: "admin" } }),
		(wake: CloudWakeEnvelope) => ({ ...wake, payload: { ...wake.payload, tools: ["send_message"] } }),
		(wake: CloudWakeEnvelope) => ({
			...wake,
			payload: { ...wake.payload, dispatch: { ...(wake.payload.dispatch as object), definitionOfDone: " " } },
		}),
		(wake: CloudWakeEnvelope) => ({
			...wake,
			payload: { ...wake.payload, dispatch: { ...(wake.payload.dispatch as object), followUp: "More." } },
		}),
	])("rejects a worker dispatch that is not exactly what the kernel admits %#", (mutate) => {
		const { identity, wake } = workerWakeFixture("worker-dispatch");
		expect(() => parseCloudWakeEnvelope(mutate(wake), identity)).toThrow();
	});
	it.each(["worker-dispatch", "worker-completion"] as const)(
		"rejects this run in capitals as the parent of a %s",
		(kind) => {
			const { identity, wake } = workerWakeFixture(kind);
			const self = wake.runId.toUpperCase();
			expect(() =>
				parseCloudWakeEnvelope(
					{ ...wake, parentRunId: self, payload: { ...wake.payload, parentRunId: self } },
					identity,
				),
			).toThrow(kind === "worker-dispatch" ? "Invalid worker dispatch wake" : "Invalid worker completion wake");
		},
	);
	it("never lets a worker, a coworker message or an office continuation borrow the speaking policy", () => {
		const worker = workerWakeFixture("worker-dispatch");
		expect(() => parseCloudWakeEnvelope({ ...worker.wake, policy: worker.continuation }, worker.identity)).toThrow();
		const office = officeWakeFixture();
		expect(() => parseCloudWakeEnvelope({ ...office.wake, policy: worker.continuation }, office.identity)).toThrow();
		const done = workerWakeFixture("worker-completion");
		// A silent parent's revival stays silent even in a conversation; without a conversation it must be.
		expect(parseCloudWakeEnvelope({ ...done.wake, policy: done.silent }, done.identity).policy.maxPublicSends).toBe(
			0,
		);
		const noSession = { ...done.identity, sessionId: null };
		expect(() =>
			parseCloudWakeEnvelope({ ...done.wake, audience: { ...done.wake.audience, sessionId: null } }, noSession),
		).toThrow();
		expect(() =>
			parseCloudWakeEnvelope({ ...done.wake, actorUserId: done.identity.requesterUserId }, done.identity),
		).toThrow();
		expect(() =>
			parseCloudWakeEnvelope({ ...done.wake, payload: { ...done.wake.payload, completions: [] } }, done.identity),
		).toThrow();
	});
});

describe("office activation continuation envelope", () => {
	it("retains the same-agent causal chain without a human or coworker sender", () => {
		const { identity, wake } = officeWakeFixture();
		const parsed = parseCloudWakeEnvelope(wake, identity);
		expect(parsed).toEqual(wake);
		expect(Object.isFrozen(parsed.payload)).toBe(true);
		expect(parsed.policy.maxPublicSends).toBe(0);
	});
	it.each([
		(wake: CloudWakeEnvelope) => ({ ...wake, actorUserId: randomUUID() }),
		(wake: CloudWakeEnvelope) => ({ ...wake, actorStaffId: wake.staffAgentId }),
		(wake: CloudWakeEnvelope) => ({ ...wake, parentRunId: null }),
		(wake: CloudWakeEnvelope) => ({ ...wake, parentRunId: wake.runId }),
		(wake: CloudWakeEnvelope) => ({ ...wake, source: { ...wake.source, occurrenceKey: "activation" } }),
		(wake: CloudWakeEnvelope) => ({ ...wake, source: { ...wake.source, kind: "coworker" } }),
		(wake: CloudWakeEnvelope) => ({ ...wake, kind: "human", policy: policies[0].policy }),
		(wake: CloudWakeEnvelope) => ({ ...wake, payload: { ...wake.payload, schema: "unknown" } }),
		(wake: CloudWakeEnvelope) => ({ ...wake, payload: { ...wake.payload, computerGeneration: 0 } }),
		(wake: CloudWakeEnvelope) => ({
			...wake,
			payload: { ...wake.payload, computerGeneration: Number.MAX_SAFE_INTEGER + 1 },
		}),
		(wake: CloudWakeEnvelope) => ({ ...wake, payload: { ...wake.payload, activationId: "missing" } }),
		(wake: CloudWakeEnvelope) => ({ ...wake, payload: { ...wake.payload, receiptId: null } }),
		(wake: CloudWakeEnvelope) => ({ ...wake, payload: { ...wake.payload, text: "Invented new work" } }),
	])("rejects changed source, parent, actor and activation identity %#", (change) => {
		const { identity, wake } = officeWakeFixture();
		expect(() => parseCloudWakeEnvelope(change(wake), identity)).toThrow();
	});
	it("rejects this run in capitals as its own parent", () => {
		const { identity, wake } = officeWakeFixture();
		const self = wake.runId.toUpperCase();
		const occurrenceKey = `office-activation:${wake.payload.intentId}:${self}`;
		expect(() =>
			parseCloudWakeEnvelope({ ...wake, parentRunId: self, source: { ...wake.source, occurrenceKey } }, identity),
		).toThrow("Invalid office activation wake");
	});
});

describe("immutable cloud wake policies", () => {
	it.each(policies)("accepts the closed $scenario fixture", ({ policy }) => {
		expect(parseCloudWakePolicy(policy)).toEqual(policy);
	});
	it.each([
		undefined,
		null,
		{},
		{ kind: "routine", silenceAllowed: true },
		{ ...policies[0].policy, final: "optional", silenceAllowed: true },
		{ ...policies[2].policy, final: "unexpected" },
		{ ...policies[2].policy, schema: "future" },
		{ ...policies[6].policy, maxPublicSends: 64 },
		{ ...policies[5].policy, fromJob: true },
	])("keeps both human obligations for absent, malformed, or unknown policy %#", (value) => {
		expect(parseCloudWakePolicy(value)).toEqual(REQUIRED_CLOUD_WAKE_POLICY);
	});
	it("reads the agent's own thread only from a room policy with a required final", () => {
		// The SQL/TypeScript parity fixture: the kernel requires a final for a room wake
		// only in a room bound to the woken agent; every other wake is not a room at all.
		const own = policies.filter(({ policy }) => cloudWakeIsOwnThread({ kind: policy.kind!, policy }));
		expect(own.map(({ scenario }) => scenario)).toEqual(["room-required"]);
		const room = policies.find(({ scenario }) => scenario === "room")!.policy;
		expect(cloudWakeIsOwnThread({ kind: "human", policy: { ...room, final: "required" } })).toBe(false);
	});
	it("allows a successful silent routine through the existing mouth component", async () => {
		const send = vi.fn();
		const mouth = new CloudAgentMouth(randomUUID(), send);
		const policy = parseCloudWakePolicy(policies[2].policy);
		expect(await mouth.finish(policy.final === "required")).toEqual({ messageCount: 0, finalMessageId: null });
		expect(send).not.toHaveBeenCalled();
		await mouth.close();
	});
	it("does not count progress as completion when final delivery is optional", async () => {
		const runId = randomUUID();
		const mouth = new CloudAgentMouth(runId, async () => ({
			schema: "qorpera.agent-send/v1",
			runId,
			sessionId: randomUUID(),
			messageId: randomUUID(),
			phase: "progress",
			sequence: 1,
		}));
		await mouth.send({ idempotencyKey: "progress", text: "A material update", phase: "progress" });
		await expect(mouth.finish(false)).rejects.toThrow("without a final send");
		await mouth.close();
	});
});

describe("authorized envelope", () => {
	it("keeps a closed, deeply immutable copy independent of the job payload", () => {
		const { authority, envelope } = fixture();
		const parsed = parseCloudWakeEnvelope(envelope, authority.identity);
		expect(parsed).toEqual(envelope);
		expect(Object.isFrozen(parsed.payload.inputIds)).toBe(true);
		expect(parsed.payload).not.toBe(envelope.payload);
	});
	it.each(["runId", "companyId", "environmentId", "staffAgentId", "requesterUserId"] as const)(
		"rejects another %s",
		(key) => {
			const { authority, envelope } = fixture();
			expect(() => parseCloudWakeEnvelope({ ...envelope, [key]: randomUUID() }, authority.identity)).toThrow();
		},
	);
	it("rejects an input id repeated in capitals", () => {
		const { authority, envelope } = fixture();
		const input = envelope.source.id;
		expect(() =>
			parseCloudWakeEnvelope(
				{ ...envelope, payload: { inputIds: [input, input.toUpperCase()] } },
				authority.identity,
			),
		).toThrow("Invalid input wake");
	});
	it("rejects unadmitted room authority even though room policy is defined", () => {
		const { authority, envelope } = fixture();
		expect(() =>
			parseCloudWakeEnvelope({ ...envelope, kind: "room", policy: policies[6].policy }, authority.identity),
		).toThrow();
	});
	it("accepts a causal chain of any length (runtime v92; it was 16 agents)", () => {
		const { authority, envelope } = fixture();
		const agentIds = [...Array.from({ length: 20 }, () => randomUUID()), envelope.staffAgentId];
		expect(
			parseCloudWakeEnvelope({ ...envelope, causal: { ...envelope.causal, agentIds } }, authority.identity).causal
				.agentIds,
		).toHaveLength(21);
	});
	it("admits a folder-v2 wake that pins no Company File snapshot and still checks a pin that is there", () => {
		const { authority, envelope } = fixture();
		const pinned = (companySnapshotId: unknown) => ({ ...envelope, pins: { ...envelope.pins, companySnapshotId } });
		expect(parseCloudWakeEnvelope(pinned(null), authority.identity).pins.companySnapshotId).toBeNull();
		expect(() => parseCloudWakeEnvelope(pinned("not-a-uuid"), authority.identity)).toThrow();
		const { companySnapshotId: _pin, ...withoutPin } = envelope.pins;
		const unpinned = { ...envelope, pins: withoutPin as typeof envelope.pins };
		expect(() => parseCloudWakeEnvelope(unpinned, authority.identity)).toThrow();
	});
	it("rejects synthetic runtime bundle pins and repeated causal recipients", () => {
		const { authority, envelope } = fixture();
		expect(() =>
			parseCloudWakeEnvelope(
				{ ...envelope, pins: { ...envelope.pins, runtimeBundleVersion: "unadmitted" } },
				authority.identity,
			),
		).toThrow();
		expect(() =>
			parseCloudWakeEnvelope(
				{ ...envelope, causal: { ...envelope.causal, agentIds: [envelope.staffAgentId, envelope.staffAgentId] } },
				authority.identity,
			),
		).toThrow();
		const upper = envelope.staffAgentId.toUpperCase();
		expect(() =>
			parseCloudWakeEnvelope(
				{ ...envelope, causal: { ...envelope.causal, agentIds: [upper, envelope.staffAgentId] } },
				authority.identity,
			),
		).toThrow("Cloud wake does not match its admitted run");
	});
	it("does not accept startup assignment flags or a source missing from the input set", () => {
		const { authority, envelope } = fixture();
		expect(() =>
			parseCloudWakeEnvelope(
				{ ...envelope, payload: { ...envelope.payload, startupAssignment: "trust me" } },
				authority.identity,
			),
		).toThrow();
		expect(() =>
			parseCloudWakeEnvelope({ ...envelope, source: { ...envelope.source, id: randomUUID() } }, authority.identity),
		).toThrow();
	});
	it("checks durable read authority after context I/O", async () => {
		const { binding, authority, envelope } = fixture();
		const run = await CloudNativeToolRun.open(
			binding,
			{ describeToolAuthority: async () => authority },
			new AbortController().signal,
		);
		const call = vi.fn().mockResolvedValueOnce(envelope).mockRejectedValueOnce(new Error("Path permission revoked"));
		try {
			await expect(new CloudNativeWakeBus(run, { call }).read(run.signal)).rejects.toThrow("revoked");
			expect(call.mock.calls[1][0]).toBe("qorpera_assert_company_path_reads");
		} finally {
			run.close();
		}
	});
	it("reuses the caller's durable operation key and checks the addressed receipt", async () => {
		const { binding, authority } = fixture();
		const run = await CloudNativeToolRun.open(
			binding,
			{ describeToolAuthority: async () => authority },
			new AbortController().signal,
		);
		const message = {
			recipientStaffId: randomUUID(),
			operationKey: "handoff-1",
			text: "Please examine the note.",
			priority: true,
		};
		const receipt = {
			schema: "qorpera.coworker-send/v1",
			runId: binding.runId,
			receiptId: randomUUID(),
			occurrenceId: randomUUID(),
			recipientStaffId: message.recipientStaffId,
			status: "queued",
		};
		const call = vi.fn().mockResolvedValue(receipt);
		try {
			const bus = new CloudNativeWakeBus(run, { call });
			expect(await bus.sendCoworker(message, run.signal)).toEqual(receipt);
			expect(await bus.sendCoworker(message, run.signal)).toEqual(receipt);
			expect(call.mock.calls[0][1]).toEqual(call.mock.calls[1][1]);
			call.mockResolvedValueOnce({ ...receipt, recipientStaffId: randomUUID() });
			await expect(bus.sendCoworker(message, run.signal)).rejects.toThrow("receipt");
		} finally {
			run.close();
		}
	});
});

describe("native coworker tool adapter", () => {
	it("uses the host binding, canonicalizes the recipient and fences the receipt", async () => {
		const { binding, run, message, receipt, call, createBoundary } = await coworkerFixture();
		const boundary = createBoundary();
		try {
			const response = await boundary.invoke("send_1", "qorpera", "send_coworker_message", {
				...message,
				recipientStaffId: message.recipientStaffId.toUpperCase(),
			});
			expect(response.success).toBe(true);
			const result = JSON.parse(response.contentItems[0].text) as CloudToolResult;
			expect(result).toMatchObject({
				trust: "untrusted_data",
				status: "ok",
				provenance: {
					runId: binding.runId,
					identity: run.identity,
					tool: "send_coworker_message",
					source: "runtime",
				},
				content: { kind: "json", truncated: false },
			});
			expect(JSON.parse(result.content.text)).toEqual(receipt);
			expect(call.mock.calls[0].slice(0, 2)).toEqual([
				"qorpera_send_coworker_message",
				{
					p_binding: binding,
					p_recipient_staff_id: message.recipientStaffId,
					p_operation_key: message.operationKey,
					p_text: message.text,
				},
			]);
			expect(response.contentItems[0].text).not.toContain(binding.credentialCapsuleId);
		} finally {
			boundary.close();
			run.close();
		}
	});

	it("retains the same durable key across native tool sessions", async () => {
		const { run, message, call, createBoundary } = await coworkerFixture();
		const first = createBoundary();
		const reopened = createBoundary();
		try {
			const accepted = await first.invoke("send_1", "qorpera", "send_coworker_message", message);
			expect(accepted.success).toBe(true);
			expect(await first.invoke("send_1", "qorpera", "send_coworker_message", message)).toEqual(accepted);
			expect(call).toHaveBeenCalledTimes(1);
			first.close();
			expect((await reopened.invoke("send_2", "qorpera", "send_coworker_message", message)).success).toBe(true);
			expect(call).toHaveBeenCalledTimes(2);
			expect(call.mock.calls[1][1]).toEqual(call.mock.calls[0][1]);
		} finally {
			first.close();
			reopened.close();
			run.close();
		}
	});

	it.each([
		["injected binding", { binding: { runId: randomUUID() } }],
		["injected requester", { requesterUserId: randomUUID() }],
		["room destination", { roomId: randomUUID() }],
		["silence flag", { silenceAllowed: true }],
		["invalid recipient", { recipientStaffId: "not-a-staff-id" }],
		["invalid operation key", { operationKey: " leading-space" }],
		["oversized operation key", { operationKey: "x".repeat(97) }],
		["blank text", { text: " \n " }],
		["null text", { text: null }],
		["NUL text", { text: "before\0after" }],
		["UTF-8 byte overflow", { text: "ø".repeat(2049) }],
	] as const)("denies %s before dispatch", async (_label, override) => {
		const { run, message, call, createBoundary } = await coworkerFixture();
		const boundary = createBoundary();
		try {
			const response = await boundary.invoke("invalid", "qorpera", "send_coworker_message", {
				...message,
				...override,
			});
			expect(response.success).toBe(false);
			expect(JSON.parse(response.contentItems[0].text)).toMatchObject({
				status: "denied",
				content: { text: "INVALID_ARGUMENTS" },
			});
			expect(call).not.toHaveBeenCalled();
		} finally {
			boundary.close();
			run.close();
		}
	});

	it("rejects a missing or mismatched host identity before any effect", async () => {
		const { binding, run, message, call } = await coworkerFixture();
		const tool = cloudCoworkerMessageTool(binding, run.identity, { call });
		const context: CloudToolContext = {
			companyId: run.identity.companyId,
			runId: run.identity.runId,
			callId: "send_1",
			argumentSha256: "0".repeat(64),
			signal: run.signal,
			identity: run.identity,
		};
		try {
			await expect(tool.execute(message, { ...context, identity: undefined })).rejects.toThrow("native run");
			for (const key of ["companyId", "runId"] as const) {
				await expect(tool.execute(message, { ...context, [key]: randomUUID() })).rejects.toThrow("native run");
			}
			for (const key of Object.keys(run.identity) as (keyof CloudNativeToolIdentity)[]) {
				const previous = run.identity[key];
				const identity = { ...run.identity, [key]: typeof previous === "number" ? previous + 1 : randomUUID() };
				await expect(tool.execute(message, { ...context, identity })).rejects.toThrow("native run");
			}
			expect(call).not.toHaveBeenCalled();
		} finally {
			run.close();
		}
	});

	it("rejects a host binding attached to another admitted identity", async () => {
		const { binding, run, call } = await coworkerFixture();
		try {
			for (const key of [
				"leaseId",
				"runId",
				"jobId",
				"runnerId",
				"assignmentId",
				"computeIdentityId",
				"provider",
				"nativeHarness",
				"model",
			] as const) {
				expect(() => cloudCoworkerMessageTool(binding, { ...run.identity, [key]: randomUUID() }, { call })).toThrow(
					"binding does not match",
				);
			}
			expect(call).not.toHaveBeenCalled();
		} finally {
			run.close();
		}
	});

	it("retains immutable host binding and identity copies", async () => {
		const { binding, run, message, receipt, call } = await coworkerFixture();
		const mutableBinding = { ...binding };
		const mutableIdentity = { ...run.identity };
		const tool = cloudCoworkerMessageTool(mutableBinding, mutableIdentity, { call });
		mutableBinding.runId = randomUUID();
		mutableIdentity.requesterUserId = randomUUID();
		try {
			expect(
				await tool.execute(message, {
					companyId: run.identity.companyId,
					runId: run.identity.runId,
					callId: "immutable",
					argumentSha256: "0".repeat(64),
					identity: run.identity,
					signal: run.signal,
				}),
			).toEqual({ kind: "json", value: receipt });
			expect(call.mock.calls[0][1].p_binding).toEqual(binding);
		} finally {
			run.close();
		}
	});

	it("does not dispatch after the native run closes", async () => {
		const { run, message, call, bus, createBoundary } = await coworkerFixture();
		const boundary = createBoundary();
		try {
			run.close();
			const response = await boundary.invoke("closed", "qorpera", "send_coworker_message", message);
			expect(response.success).toBe(false);
			await expect(bus.sendCoworker(message, new AbortController().signal)).rejects.toThrow();
			expect(call).not.toHaveBeenCalled();
		} finally {
			boundary.close();
			run.close();
		}
	});

	it("keeps an uncertain effect unconfirmed without leaking its error or replaying it", async () => {
		const { run, message, call, createBoundary } = await coworkerFixture();
		call.mockRejectedValue(new Error("PRIVATE_DELIVERY_DETAIL"));
		const boundary = createBoundary();
		try {
			const response = await boundary.invoke("uncertain", "qorpera", "send_coworker_message", message);
			expect(response.success).toBe(false);
			expect(JSON.parse(response.contentItems[0].text)).toMatchObject({
				status: "unconfirmed",
				content: { text: "TOOL_OUTCOME_UNCONFIRMED" },
			});
			expect(response.contentItems[0].text).not.toContain("PRIVATE_DELIVERY_DETAIL");
			expect(await boundary.invoke("uncertain", "qorpera", "send_coworker_message", message)).toEqual(response);
			expect(call).toHaveBeenCalledTimes(1);
		} finally {
			boundary.close();
			run.close();
		}
	});

	it("does not release a receipt when native authority closes during dispatch", async () => {
		const { run, message, receipt, call, createBoundary } = await coworkerFixture();
		call.mockImplementationOnce(async () => {
			run.close();
			return receipt;
		});
		const boundary = createBoundary();
		try {
			const response = await boundary.invoke("cancelled", "qorpera", "send_coworker_message", message);
			expect(response.success).toBe(false);
			expect(JSON.parse(response.contentItems[0].text)).toMatchObject({
				status: "denied",
				content: { text: "AUTHORITY_UNAVAILABLE" },
			});
			expect(response.contentItems[0].text).not.toContain(receipt.receiptId);
			expect(call).toHaveBeenCalledTimes(1);
		} finally {
			boundary.close();
			run.close();
		}
	});
});

describe("cloud-only wake transport", () => {
	it("does not retry an uncertain send or fall back to local execution", async () => {
		const request = vi.fn().mockRejectedValue(new Error("lost response"));
		const control = new HttpCloudWakeControl({
			supabaseUrl: "https://fixture.test",
			serviceRoleKey: "fixture-service",
			fetch: request,
		});
		await expect(control.call("qorpera_send_coworker_message", {}, new AbortController().signal)).rejects.toThrow(
			"lost response",
		);
		expect(request).toHaveBeenCalledTimes(1);
		expect(request.mock.calls[0][1].redirect).toBe("error");
	});
	it("bounds the response and does not expose a denied response body", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(new Response("private-denial", { status: 403 }))
			.mockResolvedValueOnce(new Response("x".repeat(100_000)));
		const control = new HttpCloudWakeControl({
			supabaseUrl: "https://fixture.test",
			serviceRoleKey: "fixture-service",
			fetch: request,
		});
		await expect(control.call("qorpera_read_native_wake", {}, new AbortController().signal)).rejects.toThrow(
			"Wake authority unavailable",
		);
		await expect(control.call("qorpera_read_native_wake", {}, new AbortController().signal)).rejects.toThrow(
			"byte limit",
		);
	});
});

function pairWakeFixture() {
	const { authority, envelope } = fixture();
	const sessionId = authority.identity.sessionId ?? randomUUID();
	const identity = { ...authority.identity, audienceKind: "company" as const, audienceUserId: null, sessionId };
	const coworkerId = randomUUID();
	const pair = policies.find((item) => item.scenario === "agent-pair")!.policy;
	const pairSessionId = randomUUID();
	const pairEventId = randomUUID();
	const wake: CloudWakeEnvelope = {
		...envelope,
		kind: "agent",
		actorStaffId: coworkerId,
		actorUserId: identity.requesterUserId,
		parentRunId: randomUUID(),
		audience: { kind: "company", userId: null, sessionId },
		source: { kind: "coworker", id: envelope.id, occurrenceKey: `coworker:${randomUUID()}:ask-1` },
		policy: pair,
		payload: {
			text: "Could you check the note?",
			senderStaffId: coworkerId,
			receiptId: randomUUID(),
			pairSessionId,
			pairEventId,
			transcript: [
				{
					eventId: pairEventId,
					staffAgentId: coworkerId,
					text: "Could you check the note?",
					at: "2026-09-22T19:24:00.000000Z",
				},
			],
		},
		causal: { rootId: envelope.id, agentIds: [coworkerId, identity.staffAgentId] },
	};
	return { identity, wake, coworkerId, pair };
}

describe("coworker message in the agent's own thread (contract 14.6, 2026-09-22)", () => {
	it("parses the pair policy exactly: no opening word, an optional final word, no send limit", () => {
		const { pair } = pairWakeFixture();
		expect(parseCloudWakePolicy(pair)).toEqual(pair);
		// A numeric send limit is no longer a policy the kernel issues (runtime v92).
		expect(parseCloudWakePolicy({ ...pair, maxPublicSends: 2 })).toEqual(REQUIRED_CLOUD_WAKE_POLICY);
		expect(parseCloudWakePolicy({ ...pair, silenceAllowed: false })).toEqual(REQUIRED_CLOUD_WAKE_POLICY);
		// With an opening word it is the worker continuation's policy, which a coworker's
		// message in the thread may not carry (refused below).
		expect(parseCloudWakePolicy({ ...pair, initial: "optional" })).toEqual(
			policies.find((item) => item.scenario === "agent-continuation")!.policy,
		);
	});
	it("accepts the wake with the agent's thread, the transcript identity and the exchange so far", () => {
		const { identity, wake } = pairWakeFixture();
		const parsed = parseCloudWakeEnvelope(wake, identity);
		expect(parsed).toEqual(wake);
		expect(parsed.policy.maxPublicSends).toBeNull();
		expect(parsed.audience.sessionId).toBe(identity.sessionId);
		expect(Object.isFrozen(parsed.payload.transcript)).toBe(true);
		// Without the exchange (a first message) the payload still parses.
		const { transcript: _omitted, ...first } = wake.payload;
		expect(parseCloudWakeEnvelope({ ...wake, payload: first }, identity).payload).toEqual(first);
	});
	it("still reads an occurrence admitted before v70: no thread, no mouth, no transcript", () => {
		const { identity, wake } = pairWakeFixture();
		const silent = policies.find((item) => item.scenario === "agent")!.policy;
		const legacyIdentity = { ...identity, sessionId: null };
		const { pairSessionId: _s, pairEventId: _e, transcript: _t, ...payload } = wake.payload;
		const legacy = { ...wake, audience: { ...wake.audience, sessionId: null }, policy: silent, payload };
		expect(parseCloudWakeEnvelope(legacy, legacyIdentity).policy.maxPublicSends).toBe(0);
	});
	it.each([
		[
			"a thread without the pair policy",
			(wake: CloudWakeEnvelope) => ({ ...wake, policy: policies.find((item) => item.scenario === "agent")!.policy }),
		],
		[
			"a thread with the worker continuation's policy",
			(wake: CloudWakeEnvelope) => ({
				...wake,
				policy: policies.find((item) => item.scenario === "agent-continuation")!.policy,
			}),
		],
		[
			"the pair policy without a thread",
			(wake: CloudWakeEnvelope, identity: CloudNativeToolIdentity) =>
				[
					{ ...wake, audience: { ...wake.audience, sessionId: null } },
					{ ...identity, sessionId: null },
				] as const,
		],
		[
			"a transcript identity without its event",
			(wake: CloudWakeEnvelope) => ({ ...wake, payload: { ...wake.payload, pairEventId: undefined } }),
		],
		[
			"a transcript longer than the kernel sends",
			(wake: CloudWakeEnvelope) => ({
				...wake,
				payload: {
					...wake.payload,
					transcript: Array.from({ length: 25 }, () => (wake.payload.transcript as unknown[])[0]),
				},
			}),
		],
		[
			"a transcript line with an extra key",
			(wake: CloudWakeEnvelope) => ({
				...wake,
				payload: {
					...wake.payload,
					transcript: [{ ...(wake.payload.transcript as Record<string, unknown>[])[0], role: "system" }],
				},
			}),
		],
		[
			"a payload key the kernel never writes",
			(wake: CloudWakeEnvelope) => ({ ...wake, payload: { ...wake.payload, priority: true } }),
		],
		[
			"a sender who is not the actor",
			(wake: CloudWakeEnvelope) => ({ ...wake, payload: { ...wake.payload, senderStaffId: randomUUID() } }),
		],
	])("rejects %s", (_name, mutate) => {
		const { identity, wake } = pairWakeFixture();
		const result = mutate(wake, identity);
		const [mutated, who] = Array.isArray(result) ? result : [result, identity];
		expect(() => parseCloudWakeEnvelope(JSON.parse(JSON.stringify(mutated)), who)).toThrow();
	});
});

describe("held coworker messages (contract 14.6, second cut)", () => {
	function heldLine(staffAgentId: string = randomUUID()) {
		return {
			eventId: randomUUID(),
			staffAgentId,
			text: "FYI: the note is updated.",
			at: "2026-09-22T22:30:00.000000Z",
			pairSessionId: randomUUID(),
		};
	}
	it("carries messages left for the agent on a human wake and on a coworker wake", () => {
		const human = fixture();
		const parsed = parseCloudWakeEnvelope(
			{ ...human.envelope, payload: { ...human.envelope.payload, heldMessages: [heldLine()] } },
			human.authority.identity,
		);
		expect(parsed.payload.heldMessages).toHaveLength(1);
		expect(Object.isFrozen(parsed.payload.heldMessages)).toBe(true);
		const { identity, wake } = pairWakeFixture();
		const withHeld = { ...wake, payload: { ...wake.payload, heldMessages: [heldLine(), heldLine()] } };
		expect(parseCloudWakeEnvelope(withHeld, identity).payload.heldMessages).toHaveLength(2);
	});
	it.each([
		["an empty list", () => []],
		["more than twelve", () => Array.from({ length: 13 }, () => heldLine())],
		["a line with an extra key", () => [{ ...heldLine(), priority: false }]],
		["a line without its transcript", () => [{ ...heldLine(), pairSessionId: undefined }]],
		["a blank text", () => [{ ...heldLine(), text: " " }]],
	])("rejects %s", (_name, make) => {
		const human = fixture();
		expect(() =>
			parseCloudWakeEnvelope(
				JSON.parse(
					JSON.stringify({ ...human.envelope, payload: { ...human.envelope.payload, heldMessages: make() } }),
				),
				human.authority.identity,
			),
		).toThrow();
	});
	it("reads twelve held lines and a full transcript in one payload", () => {
		const { identity, wake } = pairWakeFixture();
		const line = { ...heldLine(), text: "ø".repeat(400) };
		const transcript = Array.from({ length: 12 }, () => ({
			eventId: randomUUID(),
			staffAgentId: wake.actorStaffId as string,
			text: "ø".repeat(400),
			at: "2026-09-22T22:30:00.000000Z",
		}));
		const heavy = {
			...wake,
			payload: { ...wake.payload, transcript, heldMessages: Array.from({ length: 12 }, () => line) },
		};
		expect(Buffer.byteLength(JSON.stringify(heavy.payload))).toBeGreaterThan(16384);
		expect(parseCloudWakeEnvelope(heavy, identity).payload.heldMessages).toHaveLength(12);
	});
	it("rejects a held message the agent supposedly left for itself", () => {
		const human = fixture();
		const self = human.authority.identity.staffAgentId;
		for (const staffAgentId of [self, self.toUpperCase()])
			expect(() =>
				parseCloudWakeEnvelope(
					{ ...human.envelope, payload: { ...human.envelope.payload, heldMessages: [heldLine(staffAgentId)] } },
					human.authority.identity,
				),
			).toThrow("Invalid held coworker messages");
		// The same the other way round: an identity in capitals and a lowercase line.
		const upper = self.toUpperCase();
		const identity = { ...human.authority.identity, staffAgentId: upper };
		expect(() =>
			parseCloudWakeEnvelope(
				{
					...human.envelope,
					staffAgentId: upper,
					causal: { ...human.envelope.causal, agentIds: [upper] },
					payload: { ...human.envelope.payload, heldMessages: [heldLine(self)] },
				},
				identity,
			),
		).toThrow("Invalid held coworker messages");
	});
	it("sends priority false to the kernel and accepts a held receipt", async () => {
		const { binding, run, message, call, createBoundary } = await coworkerFixture();
		const held = {
			schema: "qorpera.coworker-send/v1",
			runId: binding.runId,
			receiptId: randomUUID(),
			occurrenceId: null,
			recipientStaffId: message.recipientStaffId,
			status: "held",
		} as const;
		call.mockResolvedValueOnce(held);
		const boundary = createBoundary();
		try {
			const response = await boundary.invoke("held_1", "qorpera", "send_coworker_message", {
				...message,
				priority: false,
			});
			expect(response.success).toBe(true);
			const result = JSON.parse(response.contentItems[0].text) as CloudToolResult;
			expect(JSON.parse(result.content.text)).toEqual(held);
			expect(call).toHaveBeenLastCalledWith(
				"qorpera_send_coworker_message",
				expect.objectContaining({ p_priority: false, p_text: message.text }),
				expect.anything(),
			);
			// A priority message sends no flag at all, so a kernel before this cut still understands it.
			const queued = await boundary.invoke("queued_1", "qorpera", "send_coworker_message", message);
			expect(queued.success).toBe(true);
			expect(call.mock.lastCall?.[1]).not.toHaveProperty("p_priority");
			const wrong = await boundary.invoke("wrong_1", "qorpera", "send_coworker_message", {
				...message,
				priority: "later",
			});
			expect(wrong.success).toBe(false);
		} finally {
			boundary.close();
			run.close();
		}
	});
});

describe("dynamic routine wakes", () => {
	function routineWake(routine: Record<string, unknown>) {
		const { authority, envelope } = fixture();
		const routineId = randomUUID();
		return {
			identity: authority.identity,
			wake: {
				...envelope,
				kind: "routine",
				actorUserId: null,
				source: { kind: "schedule", id: routineId, occurrenceKey: `once:1:1:${routineId}` },
				policy: policies[2].policy,
				routine: { id: routineId, version: 1, intent: "Check whether invoice 42 was paid.", ...routine },
				payload: { schema: "qorpera.routine-once-occurrence/v1", attempt: 1 },
			} as unknown as CloudWakeEnvelope,
		};
	}
	it("carries the dynamic mark and routine key only for a dynamic routine", () => {
		const dynamic = routineWake({ dynamic: true, routineKey: "invoice-watch" });
		expect(parseCloudWakeEnvelope(dynamic.wake, dynamic.identity).routine).toEqual({
			...dynamic.wake.routine,
			dynamic: true,
			routineKey: "invoice-watch",
		});
		const fixed = routineWake({});
		expect(parseCloudWakeEnvelope(fixed.wake, fixed.identity).routine).not.toHaveProperty("dynamic");
	});
	it.each([
		{ dynamic: false },
		{ dynamic: "yes" },
		{ schedule: "hourly" },
		{ dynamic: true },
		{ routineKey: "invoice-watch" },
		{ dynamic: true, routineKey: "Not A Key" },
	])("rejects a routine marked %j", (extra) => {
		const { identity, wake } = routineWake(extra);
		expect(() => parseCloudWakeEnvelope(wake, identity)).toThrow();
	});
});

describe("event wakes", () => {
	function eventWake(payload: Record<string, unknown> = {}, source: Record<string, unknown> = {}) {
		const { authority, envelope } = fixture();
		const routineId = randomUUID();
		const hookId = randomUUID();
		const deliveryId = randomUUID();
		return {
			identity: authority.identity,
			hookId,
			wake: {
				...envelope,
				kind: "routine",
				actorUserId: null,
				source: { kind: "event", id: hookId, occurrenceKey: `event:1:agent:${deliveryId}:1`, ...source },
				policy: policies[2].policy,
				routine: { id: routineId, version: 1, intent: "Answer each form submission." },
				payload: {
					hookId,
					firstDeliveryId: deliveryId,
					hook: { id: hookId, name: "forms", purpose: "Website form" },
					events: [
						{
							deliveryId,
							type: "contact.submitted",
							receivedAt: "2026-09-29T02:00:00.000000Z",
							contentType: "application/json",
							bytes: 14,
							encoding: "utf8",
							text: '{"name":"Ada"}',
							truncated: false,
						},
						{
							deliveryId: randomUUID(),
							type: null,
							receivedAt: "2026-09-29T02:00:01.000000Z",
							contentType: null,
							bytes: 3,
							encoding: "base64",
							data: "/wAQ",
							truncated: false,
						},
						{
							deliveryId: randomUUID(),
							type: null,
							receivedAt: "2026-09-22T02:00:00.000000Z",
							contentType: null,
							bytes: 9,
							bodyCleared: true,
						},
					],
					more: 0,
					...payload,
				},
			} as unknown as CloudWakeEnvelope,
		};
	}
	it("admits a routine wake with a batch of events from its hook", () => {
		const { wake, identity } = eventWake();
		const parsed = parseCloudWakeEnvelope(wake, identity);
		expect(parsed.source.kind).toBe("event");
		expect(parsed.payload.events).toHaveLength(3);
	});
	it("admits 20 events and a payload at its bound, and nothing past it", () => {
		const event = () => ({
			deliveryId: randomUUID(),
			type: null,
			receivedAt: "2026-09-29T02:00:00.000000Z",
			contentType: null,
			bytes: 0,
		});
		const twenty = eventWake({ events: Array.from({ length: 20 }, event) });
		expect(parseCloudWakeEnvelope(twenty.wake, twenty.identity).payload.events).toHaveLength(20);
		const sized = (extra: number) => {
			const { wake, identity } = eventWake({
				events: [{ ...event(), encoding: "utf8", text: "", truncated: true }],
			});
			const base = Buffer.byteLength(JSON.stringify(wake.payload));
			const events = (wake.payload as { events: Record<string, unknown>[] }).events;
			events[0].text = "a".repeat(49152 - base + extra);
			return () => parseCloudWakeEnvelope(wake, identity);
		};
		expect(sized(0)).not.toThrow();
		expect(sized(1)).toThrow();
	});
	it.each<[string, Record<string, unknown>, Record<string, unknown>?]>([
		["another hook's events", { hookId: randomUUID() }],
		["a hook named otherwise", { hook: { id: randomUUID(), name: "forms", purpose: "Website form" } }],
		[
			"more than 20 events",
			{
				events: Array.from({ length: 21 }, () => ({
					deliveryId: randomUUID(),
					type: null,
					receivedAt: "2026-09-29T02:00:00.000000Z",
					contentType: null,
					bytes: 0,
				})),
			},
		],
		["a negative remainder", { more: -1 }],
		[
			"a content type over 256 characters",
			{
				events: [
					{
						deliveryId: randomUUID(),
						type: null,
						receivedAt: "2026-09-29T02:00:00.000000Z",
						contentType: "c".repeat(257),
						bytes: 0,
					},
				],
			},
		],
		[
			"a cleared body that also has text",
			{
				events: [
					{
						deliveryId: randomUUID(),
						type: null,
						receivedAt: "2026-09-29T02:00:00.000000Z",
						contentType: null,
						bytes: 1,
						encoding: "utf8",
						text: "x",
						truncated: false,
						bodyCleared: true,
					},
				],
			},
		],
		[
			"a body marked not cleared",
			{
				events: [
					{
						deliveryId: randomUUID(),
						type: null,
						receivedAt: "2026-09-29T02:00:00.000000Z",
						contentType: null,
						bytes: 1,
						bodyCleared: false,
					},
				],
			},
		],
		["an unknown key", { note: "hi" }],
		[
			"a body without its truncation flag",
			{
				events: [
					{
						deliveryId: randomUUID(),
						type: null,
						receivedAt: "2026-09-29T02:00:00.000000Z",
						contentType: null,
						bytes: 1,
						encoding: "utf8",
						text: "x",
					},
				],
			},
		],
		[
			"a type with a space",
			{
				events: [
					{
						deliveryId: randomUUID(),
						type: "invoice paid",
						receivedAt: "2026-09-29T02:00:00.000000Z",
						contentType: null,
						bytes: 0,
					},
				],
			},
		],
		["a parent run", {}, {}],
	])("rejects %s", (label, payload, source) => {
		const { wake, identity } = eventWake(payload, source);
		const changed = label === "a parent run" ? ({ ...wake, parentRunId: randomUUID() } as CloudWakeEnvelope) : wake;
		expect(() => parseCloudWakeEnvelope(changed, identity)).toThrow();
	});
	it("rejects a hook purpose over 2048 bytes", () => {
		const { wake, identity } = eventWake();
		const payload = wake.payload as { hook: Record<string, unknown> };
		payload.hook.purpose = "p".repeat(2048);
		expect(() => parseCloudWakeEnvelope(wake, identity)).not.toThrow();
		payload.hook.purpose = "p".repeat(2049);
		expect(() => parseCloudWakeEnvelope(wake, identity)).toThrow();
	});
	it("rejects the same event twice in one batch", () => {
		const { wake, identity } = eventWake();
		const events = (wake.payload as { events: Record<string, unknown>[] }).events;
		const doubled = {
			...wake,
			payload: { ...wake.payload, events: [events[0], { ...events[0] }] },
		} as CloudWakeEnvelope;
		expect(() => parseCloudWakeEnvelope(doubled, identity)).toThrow();
	});
});
