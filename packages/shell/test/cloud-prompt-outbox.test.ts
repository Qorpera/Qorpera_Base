import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	acknowledgeCloudPromptOutbox,
	pendingCloudPromptOutbox,
	stageCloudPromptOutbox,
} from "../src/cloud-prompt-outbox.ts";

const profileId = "10000000-0000-4000-8000-000000000001";
const staffAgentId = "20000000-0000-4000-8000-000000000002";
const sessionId = "30000000-0000-4000-8000-000000000003";
const adoptedSessionId = "30000000-0000-4000-8000-000000000006";
const firstId = "40000000-0000-4000-8000-000000000004";
const secondId = "50000000-0000-4000-8000-000000000005";
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("cloud prompt outbox", () => {
	it("persists the complete send before acknowledgement and reuses its id", async () => {
		const userData = await mkdtemp(join(tmpdir(), "qorpera-cloud-prompt-outbox-"));
		roots.push(userData);
		const envelope = {
			message: "hidden context\n\nPlease review this",
			displayText: "Please review this",
			images: [{ type: "image" as const, data: Buffer.from("image").toString("base64"), mimeType: "image/png" }],
			executionSponsor: {
				sponsorBindingId: "60000000-0000-4000-8000-000000000006",
				sponsorVersion: 2,
				computeIdentityId: "70000000-0000-4000-8000-000000000007",
				workerClass: "managed_sandbox" as const,
			},
		};
		const staged = await stageCloudPromptOutbox({
			userData,
			profileId,
			staffAgentId,
			sessionId,
			id: firstId,
			envelope,
		});
		expect(staged.id).toBe(firstId);
		expect(await pendingCloudPromptOutbox({ userData, profileId, staffAgentId })).toMatchObject({
			id: firstId,
			envelope,
		});
		const replay = await stageCloudPromptOutbox({
			userData,
			profileId,
			staffAgentId,
			sessionId,
			id: firstId,
			envelope,
		});
		expect(replay.id).toBe(firstId);
		await expect(
			stageCloudPromptOutbox({
				userData,
				profileId,
				staffAgentId,
				sessionId,
				id: secondId,
				envelope,
			}),
		).rejects.toThrow("previous message");
		expect(await acknowledgeCloudPromptOutbox({ userData, profileId, staffAgentId, sessionId, id: firstId })).toBe(
			true,
		);
		expect(await pendingCloudPromptOutbox({ userData, profileId, staffAgentId })).toBeUndefined();
		expect(await acknowledgeCloudPromptOutbox({ userData, profileId, staffAgentId, sessionId, id: firstId })).toBe(
			true,
		);
		const deliberateRepeat = await stageCloudPromptOutbox({
			userData,
			profileId,
			staffAgentId,
			sessionId,
			id: secondId,
			envelope,
		});
		expect(deliberateRepeat.id).toBe(secondId);
	});

	it("requires an explicit resend before moving a durable send to a re-adopted conversation", async () => {
		const userData = await mkdtemp(join(tmpdir(), "qorpera-cloud-prompt-outbox-"));
		roots.push(userData);
		const envelope = { message: "survive re-adoption" };
		await stageCloudPromptOutbox({
			userData,
			profileId,
			staffAgentId,
			sessionId,
			id: firstId,
			envelope,
		});
		const replay = await stageCloudPromptOutbox({
			userData,
			profileId,
			staffAgentId,
			sessionId: adoptedSessionId,
			id: firstId,
			envelope,
		});

		expect(replay.id).toBe(firstId);
		expect(await pendingCloudPromptOutbox({ userData, profileId, staffAgentId })).toMatchObject({
			id: firstId,
			sessionId: adoptedSessionId,
			envelope,
		});
		expect(
			await acknowledgeCloudPromptOutbox({
				userData,
				profileId,
				staffAgentId,
				sessionId,
				id: firstId,
			}),
		).toBe(false);
		expect(
			await acknowledgeCloudPromptOutbox({
				userData,
				profileId,
				staffAgentId,
				sessionId: adoptedSessionId,
				id: firstId,
			}),
		).toBe(true);
	});

	it("refuses to replace an unacknowledged message with different content", async () => {
		const userData = await mkdtemp(join(tmpdir(), "qorpera-cloud-prompt-outbox-"));
		roots.push(userData);
		await stageCloudPromptOutbox({
			userData,
			profileId,
			staffAgentId,
			sessionId,
			id: firstId,
			envelope: { message: "first" },
		});
		await expect(
			stageCloudPromptOutbox({
				userData,
				profileId,
				staffAgentId,
				sessionId,
				id: secondId,
				envelope: { message: "second" },
			}),
		).rejects.toThrow("previous message");
	});
});
