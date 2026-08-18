import { describe, expect, it } from "vitest";
import { isPublicSessionGroup, publicSessionRuntimeSnapshot } from "../src/core/session-visibility.ts";

describe("session visibility", () => {
	it("keeps hidden infrastructure runs out of the product session catalog", () => {
		expect(isPublicSessionGroup("infrastructure:trigger-build:build-1")).toBe(false);
		expect(isPublicSessionGroup("job:daily-finance")).toBe(true);
	});

	it("filters infrastructure attachments without changing visible runtime state", () => {
		const visible = {
			trailFile: "visible.jsonl",
			sessionId: "visible",
			actor: "product-worker" as const,
			autonomous: true,
			group: "job:daily-finance",
			status: "running" as const,
			live: true,
			kernelInstanceId: "kernel",
			executorId: "executor",
			updatedAt: "2026-08-17T00:00:00.000Z",
		};
		const hidden = {
			...visible,
			trailFile: "hidden.jsonl",
			sessionId: "hidden",
			group: "infrastructure:trigger-check:check-1",
		};
		const snapshot = publicSessionRuntimeSnapshot({
			revision: 3,
			generatedAt: "2026-08-17T00:00:00.000Z",
			sessions: [visible, hidden],
		});
		expect(snapshot).toEqual({
			revision: 3,
			generatedAt: "2026-08-17T00:00:00.000Z",
			sessions: [visible],
		});
	});
});
