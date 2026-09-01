import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CloudAgentMouth } from "../src/cloud-agent-mouth.ts";
import type { runCloudNativeRunToolSession } from "../src/cloud-native-run-tool-session.ts";
import { type CloudNativeToolIdentity, CloudNativeToolRun } from "../src/cloud-native-tool-authority.ts";
import {
	CloudNativeToolBoundary,
	type CloudToolContext,
	type CloudToolResult,
} from "../src/cloud-native-tool-boundary.ts";
import {
	CLOUD_WAKE_SCHEMA,
	CloudNativeWakeBus,
	type CloudWakeControl,
	type CloudWakeEnvelope,
	type CloudWakePolicy,
	cloudCoworkerMessageTool,
	HttpCloudWakeControl,
	parseCloudWakeEnvelope,
	parseCloudWakePolicy,
	REQUIRED_CLOUD_WAKE_POLICY,
} from "../src/cloud-wake-bus.ts";
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
		audience: { kind: "company", sessionId: authority.identity.sessionId },
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
	const message = { recipientStaffId: randomUUID(), operationKey: "handoff-1", text: "Please examine the note." };
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
	it("rejects unadmitted room authority even though room policy is defined", () => {
		const { authority, envelope } = fixture();
		expect(() =>
			parseCloudWakeEnvelope({ ...envelope, kind: "room", policy: policies[6].policy }, authority.identity),
		).toThrow();
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
		const message = { recipientStaffId: randomUUID(), operationKey: "handoff-1", text: "Please examine the note." };
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
