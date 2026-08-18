import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendCompanyRoomMessage,
	archiveCompanyRoom,
	companyRoomDeliveryRegistryPath,
	companyRoomRegistryPath,
	createCompanyRoom,
	queueCompanyRoomDelivery,
	readCompanyRoomMessages,
	readCompanyRooms,
	readQueuedCompanyRoomDeliveries,
	removeQueuedCompanyRoomDeliveries,
	rescheduleCompanyRoomDelivery,
	restoreCompanyRoom,
	updateCompanyRoom,
} from "../src/core/company-rooms.ts";

const STAFF_A = "11111111-1111-4111-8111-111111111111";
const STAFF_B = "22222222-2222-4222-8222-222222222222";
const STAFF_C = "33333333-3333-4333-8333-333333333333";

describe("company room registry and transcript", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "qorpera-company-rooms-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("creates a durable room and hash-chained speaker-attributed transcript", () => {
		const room = createCompanyRoom(root, { participantIds: [STAFF_A, STAFF_B], title: "Launch team" });
		const founder = appendCompanyRoomMessage(root, room.id, {
			speaker: { kind: "founder" },
			text: "Prepare the launch plan.",
			targetStaffAgentIds: [STAFF_A, STAFF_B],
		});
		const staff = appendCompanyRoomMessage(root, room.id, {
			speaker: { kind: "staff", staffAgentId: STAFF_A },
			text: "I will own the schedule.",
			sourceTrailFile: "room-agent.jsonl",
		});

		expect(companyRoomRegistryPath(root)).toBe(join(root, ".qorpera", "rooms.json"));
		expect(readCompanyRooms(root)).toMatchObject([{ id: room.id, participantIds: [STAFF_A, STAFF_B] }]);
		expect(readCompanyRoomMessages(root, room.id)).toEqual([founder, staff]);
		expect(founder.previousHash).toBeNull();
		expect(staff.previousHash).toBe(founder.hash);
		expect(staff.sequence).toBe(2);
	});

	it("archives without deleting room history", () => {
		const room = createCompanyRoom(root, { participantIds: [STAFF_A, STAFF_B] });
		appendCompanyRoomMessage(root, room.id, { speaker: { kind: "founder" }, text: "Keep this." });

		expect(archiveCompanyRoom(root, room.id).status).toBe("archived");
		expect(readCompanyRoomMessages(root, room.id)).toHaveLength(1);
		expect(() =>
			appendCompanyRoomMessage(root, room.id, { speaker: { kind: "founder" }, text: "Do not append." }),
		).toThrow("unavailable");
		expect(restoreCompanyRoom(root, room.id).status).toBe("active");
		expect(
			appendCompanyRoomMessage(root, room.id, { speaker: { kind: "founder" }, text: "Continue here." }).sequence,
		).toBe(2);
	});

	it("renames a room and updates its participants without changing history", () => {
		const room = createCompanyRoom(root, { participantIds: [STAFF_A, STAFF_B], title: "Initial" });
		appendCompanyRoomMessage(root, room.id, { speaker: { kind: "founder" }, text: "Persistent history." });
		appendCompanyRoomMessage(root, room.id, {
			speaker: { kind: "staff", staffAgentId: STAFF_A },
			text: "A historical participant response.",
		});

		expect(updateCompanyRoom(root, room.id, { title: "Delivery team" })).toMatchObject({
			title: "Delivery team",
			participantIds: [STAFF_A, STAFF_B],
		});
		expect(updateCompanyRoom(root, room.id, { participantIds: [STAFF_B, STAFF_C], title: null })).toMatchObject({
			participantIds: [STAFF_B, STAFF_C],
			historicalParticipantIds: [STAFF_A, STAFF_B, STAFF_C],
		});
		expect(readCompanyRooms(root)[0]).not.toHaveProperty("title");
		expect(readCompanyRoomMessages(root, room.id)).toHaveLength(2);
	});

	it("rejects invalid participants and transcript tampering", () => {
		expect(() => createCompanyRoom(root, { participantIds: [STAFF_A, STAFF_A] })).toThrow("participants");
		const room = createCompanyRoom(root, { participantIds: [STAFF_A, STAFF_B] });
		appendCompanyRoomMessage(root, room.id, { speaker: { kind: "founder" }, text: "Original" });
		const path = join(root, ".qorpera", "rooms", `${room.id}.jsonl`);
		const content = JSON.parse(readFileSync(path, "utf-8")) as { text: string };
		writeFileSync(path, `${JSON.stringify({ ...content, text: "Changed" })}\n`, "utf-8");

		expect(() => readCompanyRoomMessages(root, room.id)).toThrow("hash");
		expect(existsSync(path)).toBe(true);
	});

	it("persists, reschedules, and completes queued founder-message delivery", () => {
		const room = createCompanyRoom(root, { participantIds: [STAFF_A, STAFF_B] });
		const message = appendCompanyRoomMessage(root, room.id, {
			speaker: { kind: "founder" },
			text: "Run this when both agents are free.",
		});
		const delivery = queueCompanyRoomDelivery(root, room.id, {
			messageId: message.id,
			targetStaffAgentIds: [STAFF_A, STAFF_B],
		});

		expect(companyRoomDeliveryRegistryPath(root)).toBe(join(root, ".qorpera", "room-deliveries.json"));
		expect(readQueuedCompanyRoomDeliveries(root, room.id)).toEqual([delivery]);
		const retry = rescheduleCompanyRoomDelivery(root, delivery.id, [STAFF_B], "runtime unavailable");
		expect(retry).toMatchObject({ targetStaffAgentIds: [STAFF_B], attempts: 1, lastError: "runtime unavailable" });
		expect(rescheduleCompanyRoomDelivery(root, delivery.id, [])).toBeUndefined();
		expect(readQueuedCompanyRoomDeliveries(root)).toEqual([]);
	});

	it("queues staff-delegation deliveries but never back to their own speaker", () => {
		const room = createCompanyRoom(root, { participantIds: [STAFF_A, STAFF_B] });
		const delegation = appendCompanyRoomMessage(root, room.id, {
			speaker: { kind: "staff", staffAgentId: STAFF_A },
			text: "Please draft the launch checklist.",
			targetStaffAgentIds: [STAFF_B],
		});
		const delivery = queueCompanyRoomDelivery(root, room.id, {
			messageId: delegation.id,
			targetStaffAgentIds: [STAFF_B],
		});
		expect(delivery.targetStaffAgentIds).toEqual([STAFF_B]);
		expect(removeQueuedCompanyRoomDeliveries(root, room.id)).toEqual([delivery]);

		const broadcast = appendCompanyRoomMessage(root, room.id, {
			speaker: { kind: "staff", staffAgentId: STAFF_A },
			text: "Status update for the room.",
		});
		expect(() =>
			queueCompanyRoomDelivery(root, room.id, {
				messageId: broadcast.id,
				targetStaffAgentIds: [STAFF_A],
			}),
		).toThrow("own speaker");
	});

	it("rejects queue targets outside the founder message and removes room deliveries", () => {
		const room = createCompanyRoom(root, { participantIds: [STAFF_A, STAFF_B] });
		const message = appendCompanyRoomMessage(root, room.id, {
			speaker: { kind: "founder" },
			text: "Only A should run this.",
			targetStaffAgentIds: [STAFF_A],
		});
		expect(() =>
			queueCompanyRoomDelivery(root, room.id, {
				messageId: message.id,
				targetStaffAgentIds: [STAFF_B],
			}),
		).toThrow("not addressed");
		const delivery = queueCompanyRoomDelivery(root, room.id, {
			messageId: message.id,
			targetStaffAgentIds: [STAFF_A],
		});
		expect(removeQueuedCompanyRoomDeliveries(root, room.id)).toEqual([delivery]);
		expect(readQueuedCompanyRoomDeliveries(root)).toEqual([]);
	});
});
