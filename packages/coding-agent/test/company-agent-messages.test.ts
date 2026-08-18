import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	markStaffAgentMessagesDelivered,
	pendingStaffAgentMessages,
	queueStaffAgentMessage,
	readStaffAgentMessages,
	recentDeliveredStaffAgentMessages,
	staffAgentMessagesPath,
} from "../src/core/company-agent-messages.ts";

const SENDER = "11111111-1111-4111-8111-111111111111";
const RECIPIENT = "22222222-2222-4222-8222-222222222222";

describe("company agent message ledger", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "qorpera-agent-messages-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("treats a missing ledger as empty and queues a durable addressed message", () => {
		expect(readStaffAgentMessages(root)).toEqual([]);
		const message = queueStaffAgentMessage(root, {
			fromAgentId: SENDER,
			toAgentId: RECIPIENT,
			subject: "Handoff",
			body: "The supplier report is ready under files/reports/.",
		});

		expect(message).toMatchObject({
			fromAgentId: SENDER,
			toAgentId: RECIPIENT,
			subject: "Handoff",
			status: "queued",
		});
		expect(staffAgentMessagesPath(root)).toBe(join(root, ".qorpera", "agent-messages.json"));
		expect(readdirSync(join(root, ".qorpera"))).toEqual(["agent-messages.json"]);
		expect(readStaffAgentMessages(root)).toEqual([message]);
		expect(pendingStaffAgentMessages(root, RECIPIENT)).toEqual([message]);
		expect(pendingStaffAgentMessages(root, SENDER)).toEqual([]);
	});

	it("marks messages delivered exactly once and keeps them readable for continuity", () => {
		const first = queueStaffAgentMessage(root, { fromAgentId: SENDER, toAgentId: RECIPIENT, body: "First" });
		const second = queueStaffAgentMessage(root, { fromAgentId: SENDER, toAgentId: RECIPIENT, body: "Second" });

		markStaffAgentMessagesDelivered(root, [first.id]);
		expect(pendingStaffAgentMessages(root, RECIPIENT)).toMatchObject([{ id: second.id }]);
		const delivered = recentDeliveredStaffAgentMessages(root, RECIPIENT, 5);
		expect(delivered).toMatchObject([{ id: first.id, status: "delivered" }]);
		expect(delivered[0]?.deliveredAt).toBeTruthy();

		// Re-marking a delivered message keeps its original delivery timestamp.
		const stamp = delivered[0]?.deliveredAt;
		markStaffAgentMessagesDelivered(root, [first.id, second.id]);
		expect(recentDeliveredStaffAgentMessages(root, RECIPIENT, 5).find((m) => m.id === first.id)?.deliveredAt).toBe(
			stamp,
		);
		expect(pendingStaffAgentMessages(root, RECIPIENT)).toEqual([]);
	});

	it("validates addressing and bounded content", () => {
		expect(() => queueStaffAgentMessage(root, { fromAgentId: SENDER, toAgentId: SENDER, body: "Loop" })).toThrow(
			"cannot target its own sender",
		);
		expect(() => queueStaffAgentMessage(root, { fromAgentId: SENDER, toAgentId: "not-a-uuid", body: "Bad" })).toThrow(
			"toAgentId is invalid",
		);
		expect(() => queueStaffAgentMessage(root, { fromAgentId: SENDER, toAgentId: RECIPIENT, body: "  " })).toThrow(
			"body is invalid",
		);
		expect(() =>
			queueStaffAgentMessage(root, {
				fromAgentId: SENDER,
				toAgentId: RECIPIENT,
				subject: "a\nb",
				body: "Multi-line subject",
			}),
		).toThrow("subject is invalid");
		expect(() =>
			queueStaffAgentMessage(root, {
				fromAgentId: SENDER,
				toAgentId: RECIPIENT,
				body: "x".repeat(16 * 1024 + 1),
			}),
		).toThrow("body is invalid");
	});

	it("caps undelivered mail per recipient instead of growing without bound", () => {
		for (let index = 0; index < 64; index++) {
			queueStaffAgentMessage(root, { fromAgentId: SENDER, toAgentId: RECIPIENT, body: `Message ${index}` });
		}
		expect(() =>
			queueStaffAgentMessage(root, { fromAgentId: SENDER, toAgentId: RECIPIENT, body: "One too many" }),
		).toThrow("too many undelivered messages");
	});

	it("rejects tampered ledgers instead of silently accepting forged mail", () => {
		const message = queueStaffAgentMessage(root, { fromAgentId: SENDER, toAgentId: RECIPIENT, body: "Real" });
		writeFileSync(
			staffAgentMessagesPath(root),
			`${JSON.stringify({
				version: 1,
				messages: [{ ...message, status: "delivered" }],
			})}\n`,
			"utf-8",
		);
		expect(() => readStaffAgentMessages(root)).toThrow("delivery timestamp is missing");

		writeFileSync(
			staffAgentMessagesPath(root),
			`${JSON.stringify({ version: 1, messages: [{ forged: true }] })}\n`,
			"utf-8",
		);
		expect(() => readStaffAgentMessages(root)).toThrow("Agent message record is invalid");
	});
});
