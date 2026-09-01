import {
	compileRoutineTrigger,
	parseRoutinePolicy,
	planRoutineSchedule,
	policyInteger,
	policyKeys,
	policyRecord,
	type RoutineScheduleContext,
	type RoutineSchedulePlan,
	routineInstant,
	routineUuid,
} from "./routine-policy.ts";

export interface RoutinePolicyControl {
	/** Existing orchestrator discovery supplies bounded, current File projections. */
	readScheduleContext(routineId: string, signal?: AbortSignal): Promise<RoutineScheduleContext>;
	/** CAS, current authority, cursor advancement and existing queue inserts are ONE durable transaction. */
	commitSchedulePlan(plan: RoutineSchedulePlan, signal?: AbortSignal): Promise<void>;
}

/** Supply the existing authenticated control transport. No credentials or retry loop live here. */
export type RoutinePolicyRpc = (
	name: "qorpera_step8_read_schedule_context" | "qorpera_step8_commit_schedule",
	arguments_: Readonly<Record<string, unknown>>,
	signal?: AbortSignal,
) => Promise<unknown>;

export function createRoutinePolicyControl(rpc: RoutinePolicyRpc | undefined): RoutinePolicyControl {
	if (!rpc) throw new Error("Routine policy RPC transport is unavailable");
	return {
		async readScheduleContext(routineId, signal) {
			signal?.throwIfAborted();
			const input = policyRecord(
				await rpc("qorpera_step8_read_schedule_context", { p_routine_id: routineUuid(routineId) }, signal),
				"schedule context",
			);
			policyKeys(input, [
				"routineId",
				"version",
				"epoch",
				"status",
				"suspended",
				"activeSince",
				"observedThrough",
				"lastScheduledFor",
				"trigger",
				"policy",
			]);
			if (
				input.routineId !== routineId ||
				typeof input.suspended !== "boolean" ||
				(input.status !== "active" && input.status !== "paused" && input.status !== "retired")
			)
				throw new Error("Invalid routine state binding");
			const policy = parseRoutinePolicy(input.policy),
				trigger = compileRoutineTrigger([input.trigger], policy);
			if (trigger.kind !== "schedule") throw new Error("Schedule control returned a listener");
			routineInstant(input.activeSince);
			routineInstant(input.observedThrough);
			if (input.lastScheduledFor !== null) routineInstant(input.lastScheduledFor);
			return {
				routineId,
				version: policyInteger(input.version, 1, Number.MAX_SAFE_INTEGER),
				epoch: policyInteger(input.epoch, 1, Number.MAX_SAFE_INTEGER),
				status: input.status,
				suspended: input.suspended,
				activeSince: input.activeSince as string,
				observedThrough: input.observedThrough as string,
				lastScheduledFor: input.lastScheduledFor as string | null,
				trigger,
				policy,
			};
		},
		async commitSchedulePlan(plan, signal) {
			signal?.throwIfAborted();
			const receipt = policyRecord(
				await rpc("qorpera_step8_commit_schedule", { p_plan: plan }, signal),
				"schedule commit receipt",
			);
			if (receipt.status !== "committed" && receipt.status !== "duplicate" && receipt.status !== "clock-regressed")
				throw new Error("Schedule commit was not acknowledged");
		},
	};
}

/** Call from the existing reconciler; this owns no timers, work queue or in-memory cursor. */
export async function reconcileRoutinePolicy(
	control: RoutinePolicyControl | undefined,
	routineId: string,
	now: string,
	signal?: AbortSignal,
): Promise<RoutineSchedulePlan> {
	if (!control) throw new Error("Routine policy control adapter is unavailable");
	routineUuid(routineId);
	signal?.throwIfAborted();
	const context = await control.readScheduleContext(routineId, signal);
	if (context.routineId !== routineId) throw new Error("Routine policy identity mismatch");
	const plan = planRoutineSchedule(context, now);
	signal?.throwIfAborted();
	await control.commitSchedulePlan(plan, signal);
	return plan;
}

export interface RoutineSuspensionNotification {
	id: string;
	routineId: string;
	routineVersion: number;
	memberId: string;
	sessionId: string;
}

export function routineSuspensionNotificationText(intent: RoutineSuspensionNotification): string {
	return `Routine ${routineUuid(intent.routineId)} was suspended after repeated authentication failures. Reauthorize its connection and resume the routine.`;
}

export interface AuthorizedRoutineNotificationSender {
	/** An adapter around the existing authorized event/send machinery; it must bind, not impersonate, its actor. */
	send(
		input: { intentId: string; memberId: string; sessionId: string; idempotencyKey: string; text: string },
		signal?: AbortSignal,
	): Promise<{ messageId: string }>;
	/** Verify the durable canonical send receipt in SQL before acknowledging the intent. */
	acknowledge(intentId: string, messageId: string, signal?: AbortSignal): Promise<void>;
}

/** A lost response retries the SAME send key. An absent sender leaves the durable intent pending. */
export async function deliverRoutineSuspensionNotification(
	intent: RoutineSuspensionNotification,
	sender: AuthorizedRoutineNotificationSender | undefined,
	signal?: AbortSignal,
): Promise<void> {
	if (!sender) throw new Error("Authorized routine notification sender is unavailable");
	routineUuid(intent.id);
	routineUuid(intent.memberId);
	routineUuid(intent.sessionId);
	signal?.throwIfAborted();
	const result = await sender.send(
		{
			intentId: intent.id,
			memberId: intent.memberId,
			sessionId: intent.sessionId,
			idempotencyKey: `routine-auth:${intent.id}`,
			text: routineSuspensionNotificationText(intent),
		},
		signal,
	);
	routineUuid(result.messageId);
	await sender.acknowledge(intent.id, result.messageId, signal);
}
