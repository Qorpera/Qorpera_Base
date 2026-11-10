import {
	CLOUD_AGENT_SEND_SCHEMA,
	CloudAgentMouth,
	CloudAgentNoFinalSend,
	type CloudAgentSendInput,
	type CloudAgentSendReceipt,
	parseCloudAgentSendInput,
	parseCloudAgentSendReceipt,
} from "@qorpera/runtime/cloud-agent-mouth";
import { afterEach, describe, expect, it, vi } from "vitest";

const runId = "19000000-0000-4000-8000-000000000001";
const sessionId = "19000000-0000-4000-8000-000000000002";
const messageId = "19000000-0000-4000-8000-000000000003";
const finalMessageId = "19000000-0000-4000-8000-000000000004";
const mouths: CloudAgentMouth[] = [];

function receipt(input: CloudAgentSendInput): CloudAgentSendReceipt {
	return {
		schema: CLOUD_AGENT_SEND_SCHEMA,
		runId,
		sessionId,
		messageId: input.phase === "final" ? finalMessageId : messageId,
		phase: input.phase,
		sequence: input.phase === "final" ? 2 : 1,
	};
}

function create(
	send: (input: CloudAgentSendInput) => Promise<CloudAgentSendReceipt>,
	signal?: AbortSignal,
): CloudAgentMouth {
	const mouth = new CloudAgentMouth(runId, send, signal);
	mouths.push(mouth);
	return mouth;
}

afterEach(async () => {
	await Promise.all(mouths.splice(0).map((mouth) => mouth.close()));
});

describe("cloud agent public mouth", () => {
	it("accepts only text, phase and an idempotency key, never caller-selected authority or reasoning", () => {
		const input = { idempotencyKey: "result-1", text: "Finished", phase: "final" };
		expect(parseCloudAgentSendInput(input)).toEqual(input);
		for (const invalid of [
			{ ...input, sessionId },
			{ ...input, runId },
			{ ...input, agentId: runId },
			{ ...input, thinking: "private" },
			{ ...input, content: [{ type: "toolCall" }] },
			{ ...input, text: " \n\t" },
			{ ...input, text: "secret\0text" },
			{ ...input, text: "é".repeat(32_769) },
			{ ...input, phase: "analysis" },
			{ ...input, idempotencyKey: "../result" },
			{ ...input, idempotencyKey: "" },
		])
			expect(() => parseCloudAgentSendInput(invalid)).toThrow("Invalid send arguments");
		const delivered = receipt({ ...input, phase: "final" });
		for (const invalid of [
			{ ...delivered, runId: sessionId },
			{ ...delivered, sequence: 0 },
			{ ...delivered, text: "unexpected private payload" },
			{ ...delivered, messageId: "invalid" },
		])
			expect(() => parseCloudAgentSendReceipt(invalid, runId)).toThrow("Invalid send receipt");
	});

	it("confirms durable sends immediately and deduplicates replay after a lost response", async () => {
		const durable = new Map<string, CloudAgentSendReceipt>();
		let loseFirstResponse = true;
		const deliver = vi.fn(async (input: CloudAgentSendInput) => {
			const committed = durable.get(input.idempotencyKey) ?? receipt(input);
			durable.set(input.idempotencyKey, committed);
			if (loseFirstResponse) {
				loseFirstResponse = false;
				throw new Error("private database response and credentials");
			}
			return committed;
		});
		const mouth = create(deliver);
		const progress: CloudAgentSendInput = {
			idempotencyKey: "progress-1",
			text: "Checking the Company File",
			phase: "progress",
		};
		await expect(mouth.send(progress)).rejects.toThrow();
		const replayed = await mouth.send(progress);
		expect(replayed).toMatchObject({ messageId, sequence: 1 });
		expect(await mouth.send(progress)).toEqual(replayed);
		expect(durable.size).toBe(1);
		const final: CloudAgentSendInput = { idempotencyKey: "final-1", text: "Finished", phase: "final" };
		expect(await mouth.send(final)).toMatchObject({ messageId: finalMessageId });
		expect(await mouth.finish()).toEqual({ messageCount: 2, finalMessageId });
		expect(deliver).toHaveBeenCalledTimes(4);
		await expect(mouth.send(progress)).rejects.toThrow("Mouth is closed");
		expect(deliver).toHaveBeenCalledTimes(4);
	});

	it("serializes simultaneous sends and waits for the cloud receipt before acknowledging", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const calls: string[] = [];
		const mouth = create(async (input) => {
			calls.push(input.idempotencyKey);
			if (input.phase === "progress") await gate;
			return receipt(input);
		});
		let acknowledged = false;
		const progress = mouth.send({ idempotencyKey: "first", text: "Working", phase: "progress" }).then(() => {
			acknowledged = true;
		});
		await vi.waitFor(() => expect(calls).toEqual(["first"]));
		const final = mouth.send({ idempotencyKey: "last", text: "Done", phase: "final" });
		expect(acknowledged).toBe(false);
		expect(calls).toEqual(["first"]);
		release();
		await Promise.all([progress, final]);
		expect(calls).toEqual(["first", "last"]);
		expect(await mouth.finish()).toEqual({ messageCount: 2, finalMessageId });
	});

	it("rejects missing final delivery, but permits an explicitly silent job with no audience", async () => {
		const first = create(async (input) => receipt(input));
		await expect(first.finish()).rejects.toThrow("without a final send");
		const second = create(async (input) => receipt(input));
		await second.send({ idempotencyKey: "ack", text: "On it", phase: "progress" });
		await expect(second.finish()).rejects.toThrow("without a final send");
		const silent = create(async (input) => receipt(input));
		await expect(silent.finish(false)).resolves.toEqual({ messageCount: 0, finalMessageId: null });
	});

	it("says what it has delivered without closing, and names a missing final send by its own failure", async () => {
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const mouth = create(async (input) => {
			if (input.phase === "progress") await held;
			return receipt(input);
		});
		expect(await mouth.settled()).toEqual({ messageCount: 0, final: false });
		// A send in flight is waited for: what it delivers counts.
		const progress = mouth.send({ idempotencyKey: "ack", text: "On it", phase: "progress" });
		let settled: { messageCount: number; final: boolean } | undefined;
		const asked = mouth.settled().then((value) => {
			settled = value;
		});
		await Promise.resolve();
		expect(settled).toBeUndefined();
		release();
		await Promise.all([progress, asked]);
		expect(settled).toEqual({ messageCount: 1, final: false });
		// Still open: the run may be given one more turn to make the final send it owes.
		await mouth.send({ idempotencyKey: "last", text: "Done", phase: "final" });
		expect(await mouth.settled()).toEqual({ messageCount: 2, final: true });
		expect(await mouth.finish()).toEqual({ messageCount: 2, finalMessageId });
		const silent = create(async (input) => receipt(input));
		await expect(silent.finish()).rejects.toBeInstanceOf(CloudAgentNoFinalSend);
	});

	it("hands a send its tool call's signal, and starts none for a call that has ended", async () => {
		const deliver = vi.fn(async (input: CloudAgentSendInput, _signal?: AbortSignal) => receipt(input));
		const mouth = create(deliver);
		const call = new AbortController();
		await mouth.send({ idempotencyKey: "ack", text: "On it", phase: "progress" }, call.signal);
		expect(deliver.mock.calls[0][1]).toBe(call.signal);
		call.abort(new Error("tool call ended"));
		await expect(mouth.send({ idempotencyKey: "last", text: "Done", phase: "final" }, call.signal)).rejects.toThrow(
			"tool call ended",
		);
		expect(deliver).toHaveBeenCalledOnce();
		// The mouth itself is still open for a later call.
		await mouth.send({ idempotencyKey: "last", text: "Done", phase: "final" });
		expect(await mouth.finish()).toEqual({ messageCount: 2, finalMessageId });
	});

	it("refuses sends on cancellation and does not treat malformed receipts as delivery", async () => {
		const abort = new AbortController();
		const deliver = vi.fn(async (input: CloudAgentSendInput) => ({ ...receipt(input), runId: sessionId }));
		const mouth = create(deliver, abort.signal);
		const input: CloudAgentSendInput = { idempotencyKey: "final", text: "Done", phase: "final" };
		expect(() => mouth.send({ ...input, sessionId } as CloudAgentSendInput)).toThrow("Invalid send arguments");
		expect(deliver).not.toHaveBeenCalled();
		await expect(mouth.send(input)).rejects.toThrow("Invalid send receipt");
		await expect(mouth.finish()).rejects.toThrow("without a final send");
		const active = create(deliver, abort.signal);
		abort.abort(new Error("run cancelled"));
		await expect(active.send(input)).rejects.toThrow("run cancelled");
		await expect(active.finish()).rejects.toThrow("run cancelled");
		expect(deliver).toHaveBeenCalledTimes(1);
	});

	it("closes after the send in flight and refuses the sends that have not started", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const deliver = vi.fn(async (input: CloudAgentSendInput) => {
			if (input.phase === "progress") await gate;
			return receipt(input);
		});
		const mouth = create(deliver);
		const progress = mouth.send({ idempotencyKey: "first", text: "Working", phase: "progress" });
		await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
		const queued = mouth.send({ idempotencyKey: "last", text: "Done", phase: "final" });
		const refused = expect(queued).rejects.toThrow("Mouth is closed");
		let closed = false;
		const closing = mouth.close().then(() => {
			closed = true;
		});
		await Promise.resolve();
		expect(closed).toBe(false);
		release();
		await closing;
		await expect(progress).resolves.toMatchObject({ messageId });
		await refused;
		const later = mouth.send({ idempotencyKey: "later", text: "Later", phase: "progress" });
		await expect(later).rejects.toThrow("Mouth is closed");
		expect(deliver).toHaveBeenCalledTimes(1);
	});
});
