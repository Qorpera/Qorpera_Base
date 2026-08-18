import { describe, expect, it } from "vitest";
import {
	claimNextCustomTriggerBuild,
	finishCustomTriggerBuild,
	queueCustomTriggerBuild,
} from "../src/custom-trigger-builds.ts";

describe("custom trigger build state", () => {
	it("queues idempotently by owning agent and routine key", () => {
		const first = queueCustomTriggerBuild(
			{ version: 1, builds: [] },
			{
				staffAgentId: "6ba7b810-9dad-4d1d-80b4-00c04fd430c8",
				routineKey: "large-payment",
				title: "Review large payments",
				instructions: "Review and report the payment.",
				eventDescription: "A newly settled payment exceeds DKK 50,000.",
				sourceHints: ["Nordea"],
				checkEveryMinutes: 15,
				effort: "high",
			},
			"2026-08-17T00:00:00.000Z",
		);
		const second = queueCustomTriggerBuild(
			first.state,
			{
				staffAgentId: first.build.staffAgentId,
				routineKey: first.build.routineKey,
				title: "Review material payments",
				instructions: first.build.instructions,
				eventDescription: first.build.eventDescription,
				sourceHints: first.build.sourceHints,
				checkEveryMinutes: first.build.checkEveryMinutes,
				effort: first.build.effort,
			},
			"2026-08-17T00:01:00.000Z",
		);
		expect(second.state.builds).toHaveLength(1);
		expect(second.build).toMatchObject({ title: "Review material payments", status: "queued" });
	});

	it("requires a claimed build before recording success", () => {
		const queued = queueCustomTriggerBuild(
			{ version: 1, builds: [] },
			{
				staffAgentId: "6ba7b810-9dad-4d1d-80b4-00c04fd430c8",
				routineKey: "new-lead",
				title: "Review new leads",
				instructions: "Qualify the lead.",
				eventDescription: "A new enterprise lead arrives.",
				sourceHints: ["HubSpot"],
				checkEveryMinutes: 10,
				effort: "high",
			},
		);
		expect(() =>
			finishCustomTriggerBuild(queued.state, queued.build.id, { status: "ready", jobId: "job-1" }),
		).toThrow("not active");
		const claimed = claimNextCustomTriggerBuild(queued.state);
		const finished = finishCustomTriggerBuild(claimed.state, queued.build.id, {
			status: "ready",
			jobId: "job-1",
		});
		expect(finished.build).toMatchObject({ status: "ready", jobId: "job-1" });
	});

	it("reclaims a persisted in-progress build after its worker is gone", () => {
		const queued = queueCustomTriggerBuild(
			{ version: 1, builds: [] },
			{
				staffAgentId: "6ba7b810-9dad-4d1d-80b4-00c04fd430c8",
				routineKey: "new-lead",
				title: "Review new leads",
				instructions: "Qualify the lead.",
				eventDescription: "A new enterprise lead arrives.",
				sourceHints: ["HubSpot"],
				checkEveryMinutes: 10,
				effort: "high",
			},
			"2026-08-17T00:00:00.000Z",
		);
		const firstClaim = claimNextCustomTriggerBuild(queued.state, "2026-08-17T00:01:00.000Z");
		const recovered = claimNextCustomTriggerBuild(firstClaim.state, "2026-08-17T00:02:00.000Z");

		expect(recovered.build).toMatchObject({ id: queued.build.id, status: "building" });
		expect(recovered.build?.updatedAt).toBe("2026-08-17T00:02:00.000Z");
	});
});
