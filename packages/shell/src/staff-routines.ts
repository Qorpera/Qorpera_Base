import {
	deleteScheduledJob,
	findStaffScheduledJob,
	type RoutineWeekday,
	type ScheduledJob,
	type ScheduledJobEffort,
	updateScheduledJob,
	upsertStaffScheduledJob,
} from "@qorpera/pi-coding-agent/company-connections";

export type StaffRoutineOperation =
	| {
			action: "upsert";
			routineKey: string;
			title: string;
			instructions: string;
			intervalMinutes: number;
			startAt?: string;
			effort?: ScheduledJobEffort;
			reviewerStaffIds?: string[];
	  }
	| {
			action: "upsert_event";
			routineKey: string;
			title: string;
			instructions: string;
			eventDescription: string;
			sourceHints: string[];
			checkEveryMinutes: number;
			effort?: ScheduledJobEffort;
			reviewerStaffIds?: string[];
	  }
	| {
			action: "upsert_weekly";
			routineKey: string;
			title: string;
			instructions: string;
			weekdays: RoutineWeekday[];
			localTime: string;
			timeZone?: string;
			effort?: ScheduledJobEffort;
			reviewerStaffIds?: string[];
	  }
	| { action: "pause" | "resume" | "remove"; routineKey: string };

export type StaffRoutineOperationResult =
	| { action: "upsert" | "pause" | "resume"; job: ScheduledJob }
	| { action: "remove"; removedJobId: string };

/** Apply an attached agent's explicit routine operation within its own
 * ownership scope. The stable key makes upsert retries update in place. */
export function applyStaffRoutineOperation(
	root: string,
	staffAgentId: string,
	operation: StaffRoutineOperation,
	runningJobId?: string,
): StaffRoutineOperationResult {
	if (operation.action === "upsert_event") {
		throw new Error("Event routines must be installed by the custom-trigger builder");
	}
	if (operation.action === "upsert" || operation.action === "upsert_weekly") {
		return {
			action: "upsert",
			job: upsertStaffScheduledJob(root, staffAgentId, operation.routineKey, {
				title: operation.title,
				prompt: operation.instructions,
				triggers:
					operation.action === "upsert_weekly"
						? [
								{
									kind: "schedule",
									intervalMinutes: 7 * 24 * 60,
									weekdays: operation.weekdays,
									localTime: operation.localTime,
									timeZone: operation.timeZone ?? "auto",
								},
							]
						: [
								{
									kind: "schedule",
									intervalMinutes: operation.intervalMinutes,
									...(operation.startAt ? { startAt: operation.startAt } : {}),
								},
							],
				enabled: true,
				effort: operation.effort ?? "high",
				...(operation.reviewerStaffIds === undefined
					? {}
					: {
							publication:
								operation.reviewerStaffIds.length === 0
									? ({ mode: "automatic" } as const)
									: ({ mode: "review", reviewerStaffIds: operation.reviewerStaffIds } as const),
						}),
			}),
		};
	}
	const job = findStaffScheduledJob(root, staffAgentId, operation.routineKey);
	if (!job) throw new Error(`Unknown agent routine: ${operation.routineKey}`);
	if (operation.action === "remove") {
		if (runningJobId === job.id) throw new Error("A running routine cannot remove itself");
		if (!deleteScheduledJob(root, job.id)) throw new Error(`Unknown scheduled job: ${job.id}`);
		return { action: "remove", removedJobId: job.id };
	}
	return {
		action: operation.action,
		job: updateScheduledJob(root, job.id, { enabled: operation.action === "resume" }),
	};
}
