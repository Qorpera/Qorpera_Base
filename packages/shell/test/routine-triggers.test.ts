import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScheduledJob } from "@qorpera/pi-coding-agent/company-connections";
import { afterEach, describe, expect, it } from "vitest";
import {
	completePendingRoutineTrigger,
	dueCustomRoutineCheck,
	parseGitHubRepositoryEvents,
	pollGitHubRoutineTriggers,
	queueCustomRoutineTrigger,
	readRoutineTriggerState,
	recordCustomRoutineCheck,
	routineTriggerStatePath,
	writeRoutineTriggerState,
} from "../src/routine-triggers.ts";

const root = join(tmpdir(), `qorpera-routine-trigger-${Date.now()}-${Math.random().toString(36).slice(2)}`);

const job: ScheduledJob = {
	id: "job-1",
	title: "Review new pull requests",
	prompt: "Review the change",
	triggers: [
		{
			id: "trigger-1",
			kind: "github",
			repository: "Qorpera/Qorpera_Base",
			events: ["pull_request.opened", "check_run.failed"],
			actors: [],
		},
	],
	enabled: true,
	effort: "high",
	placement: "local",
	publication: { mode: "automatic" },
	createdAt: "2026-08-15T00:00:00.000Z",
	updatedAt: "2026-08-15T00:00:00.000Z",
};

const feed = (events: unknown[]) => async () => ({
	code: 0,
	stdout: JSON.stringify(events),
	stderr: "",
	unavailable: false,
	cancelled: false,
});

describe("GitHub routine triggers", () => {
	afterEach(() => {
		if (existsSync(root)) rmSync(root, { recursive: true, force: true });
	});

	it("parses repository events defensively", () => {
		expect(parseGitHubRepositoryEvents("not json")).toEqual([]);
		expect(parseGitHubRepositoryEvents('[{"id":"1"}]')).toEqual([]);
	});

	it("baselines a repository then queues matching new events once", async () => {
		const opened = {
			id: "2",
			type: "PullRequestEvent",
			created_at: "2026-08-15T01:00:00.000Z",
			actor: { login: "jonas" },
			repo: { name: "Qorpera/Qorpera_Base" },
			payload: { action: "opened", number: 42 },
		};
		const prior = { ...opened, id: "1", created_at: "2026-08-15T00:00:00.000Z" };
		const baseline = await pollGitHubRoutineTriggers({
			jobs: [job],
			state: { version: 1, githubCursors: {}, pending: [] },
			run: feed([prior]),
		});
		expect(baseline).toEqual({
			version: 1,
			githubCursors: { "Qorpera/Qorpera_Base": "1" },
			pending: [],
			completedEventIds: [],
			customChecks: {},
		});
		const triggered = await pollGitHubRoutineTriggers({ jobs: [job], state: baseline, run: feed([opened, prior]) });
		expect(triggered.pending).toHaveLength(1);
		expect(triggered.pending[0]).toMatchObject({
			jobId: "job-1",
			triggerId: "trigger-1",
			event: { id: "2", source: "github", type: "pull_request.opened", actor: "jonas" },
		});
		const completed = completePendingRoutineTrigger(triggered, triggered.pending[0].id);
		expect(completed.pending).toEqual([]);
		expect(completed.completedEventIds).toEqual([triggered.pending[0].id]);
	});

	it("persists cursors and pending dispatches per company", () => {
		const path = routineTriggerStatePath(root, join(root, "company"));
		const state = {
			version: 1 as const,
			githubCursors: { "owner/repo": "9" },
			pending: [],
			completedEventIds: [],
			customChecks: {},
		};
		writeRoutineTriggerState(path, state);
		expect(readRoutineTriggerState(path)).toEqual(state);
		expect(routineTriggerStatePath(root, join(root, "other"))).not.toBe(path);
	});

	it("routes a normalized adapter event only to matching custom triggers", () => {
		const customJob: ScheduledJob = {
			...job,
			id: "custom-job",
			triggers: [
				{
					id: "nordea-payment",
					kind: "custom",
					adapterId: "bank.nordea",
					event: "payment.settled",
					label: "Nordea payment",
				},
			],
		};
		const queued = queueCustomRoutineTrigger(
			[customJob],
			{ version: 1, githubCursors: {}, pending: [] },
			{
				id: "invoice-42",
				source: "bank.nordea",
				type: "payment.settled",
				occurredAt: "2026-08-15T02:00:00.000Z",
				summary: "Invoice 42 settled",
				payload: { amount: 42 },
			},
		);
		expect(queued.pending).toHaveLength(1);
		expect(queued.pending[0]).toMatchObject({ jobId: "custom-job", triggerId: "nordea-payment" });
		const completed = completePendingRoutineTrigger(queued, queued.pending[0].id);
		expect(queueCustomRoutineTrigger([customJob], completed, queued.pending[0].event).pending).toEqual([]);
	});

	it("schedules agent-built monitor checks without firing the owned routine", () => {
		const customJob: ScheduledJob = {
			...job,
			id: "monitored-job",
			staffAgentId: "6ba7b810-9dad-4d1d-80b4-00c04fd430c8",
			triggers: [
				{
					id: "large-payment",
					kind: "custom",
					adapterId: "agent.large-payment",
					event: "matched",
					label: "a large payment settles",
					monitor: {
						instructions: "Read new settled payments and compare the amount to DKK 50,000.",
						intervalMinutes: 15,
						connectorIds: ["nordea"],
					},
				},
			],
		};
		const state = { version: 1 as const, githubCursors: {}, pending: [], customChecks: {} };
		expect(dueCustomRoutineCheck([customJob], state, Date.parse("2026-08-15T02:00:00.000Z"))).toMatchObject({
			job: { id: "monitored-job" },
			trigger: { id: "large-payment" },
		});
		const checked = recordCustomRoutineCheck(
			state,
			customJob.id,
			"large-payment",
			{ success: true, checkpoint: '{"cursor":"payment-42"}' },
			"2026-08-15T02:00:00.000Z",
		);
		expect(dueCustomRoutineCheck([customJob], checked, Date.parse("2026-08-15T02:14:59.000Z"))).toBeUndefined();
		expect(dueCustomRoutineCheck([customJob], checked, Date.parse("2026-08-15T02:15:00.000Z"))).toMatchObject({
			checkpoint: '{"cursor":"payment-42"}',
		});
	});
});
