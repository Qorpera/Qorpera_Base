/** Agent-owned routine management intent. The desktop host applies successful
 * calls to synchronized Company File routine definitions. */

import type { AgentTool } from "@qorpera/pi-agent-core";
import { type Static, Type } from "typebox";
import { brokeredCompanyOperation } from "../company-operation-broker-client.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export const MANAGE_ROUTINE_TOOL_NAME = "manage_routine";

const routineKey = Type.String({
	minLength: 1,
	maxLength: 128,
	pattern: "^[a-z0-9][a-z0-9._-]{0,127}$",
	description: "Stable idempotency key reused whenever this agent changes the same routine",
});
const effort = Type.Optional(
	Type.Union([
		Type.Literal("low"),
		Type.Literal("medium"),
		Type.Literal("high"),
		Type.Literal("xhigh"),
		Type.Literal("max"),
	]),
);
const reviewerStaffIds = Type.Optional(
	Type.Array(
		Type.String({
			pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
		}),
		{
			maxItems: 20,
			uniqueItems: true,
			description:
				"Staff agents who must review this routine's Company File output before publication. Omit to preserve the current policy; use an empty list to publish automatically.",
		},
	),
);
const routineWeekday = Type.Union([
	Type.Literal("sunday"),
	Type.Literal("monday"),
	Type.Literal("tuesday"),
	Type.Literal("wednesday"),
	Type.Literal("thursday"),
	Type.Literal("friday"),
	Type.Literal("saturday"),
]);
const routineWeekdays = Type.Union([
	Type.Array(routineWeekday, { minItems: 1, maxItems: 7, uniqueItems: true }),
	Type.String({
		minLength: 1,
		maxLength: 160,
		description:
			"Weekdays as a JSON array or comma-separated list. String input is accepted because some model tool transports serialize arrays.",
	}),
]);
const manageRoutineSchema = Type.Union([
	Type.Object(
		{
			action: Type.Literal("upsert"),
			routineKey,
			title: Type.String({ minLength: 1, maxLength: 160 }),
			instructions: Type.String({ minLength: 1, maxLength: 32_768 }),
			intervalMinutes: Type.Integer({ minimum: 5, maximum: 10_080 }),
			startAt: Type.Optional(
				Type.String({
					minLength: 20,
					maxLength: 64,
					description:
						"ISO 8601 timestamp for the first scheduled run. Include it when the routine should begin at a specific future date or time instead of running immediately.",
				}),
			),
			effort,
			reviewerStaffIds,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("upsert_weekly"),
			routineKey,
			title: Type.String({ minLength: 1, maxLength: 160 }),
			instructions: Type.String({ minLength: 1, maxLength: 32_768 }),
			weekdays: routineWeekdays,
			localTime: Type.String({
				pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$",
				description: "Wall-clock time in 24-hour HH:MM form",
			}),
			timeZone: Type.Optional(
				Type.String({
					minLength: 1,
					maxLength: 100,
					description: "Use auto for the computer's current timezone, or an explicit IANA timezone",
				}),
			),
			effort,
			reviewerStaffIds,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("upsert_event"),
			routineKey,
			title: Type.String({ minLength: 1, maxLength: 160 }),
			instructions: Type.String({ minLength: 1, maxLength: 32_768 }),
			eventDescription: Type.String({ minLength: 1, maxLength: 2_000 }),
			sourceHints: Type.Optional(
				Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { minItems: 1, maxItems: 8 }),
			),
			checkEveryMinutes: Type.Optional(Type.Integer({ minimum: 5, maximum: 10_080 })),
			effort,
			reviewerStaffIds,
		},
		{ additionalProperties: false },
	),
	Type.Object({ action: Type.Literal("pause"), routineKey }, { additionalProperties: false }),
	Type.Object({ action: Type.Literal("resume"), routineKey }, { additionalProperties: false }),
	Type.Object({ action: Type.Literal("remove"), routineKey }, { additionalProperties: false }),
]);

export type ManageRoutineToolInput = Static<typeof manageRoutineSchema>;

const ROUTINE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const WEEKDAYS = new Set(["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]);

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function boundedText(value: unknown, maximumBytes: number): value is string {
	return (
		typeof value === "string" &&
		Boolean(value.trim()) &&
		value === value.trim() &&
		Buffer.byteLength(value, "utf-8") <= maximumBytes &&
		!/[\u0000-\u001f\u007f]/.test(value)
	);
}

function validStartAt(value: unknown): value is string {
	return value === undefined || (boundedText(value, 64) && Number.isFinite(Date.parse(value)));
}

function validTimeZone(value: unknown): value is string | undefined {
	if (value === undefined || value === "auto") return true;
	if (!boundedText(value, 100)) return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
		return true;
	} catch {
		return false;
	}
}

function validReviewerStaffIds(value: unknown): value is string[] | undefined {
	return (
		value === undefined ||
		(Array.isArray(value) &&
			value.length <= 20 &&
			new Set(value).size === value.length &&
			value.every(
				(id) =>
					typeof id === "string" &&
					/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id),
			))
	);
}

function normalizeWeekdays(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		const parsed: unknown = JSON.parse(value);
		if (Array.isArray(parsed)) return parsed;
	} catch {
		// Plain comma-separated weekday names are also accepted.
	}
	return value
		.split(",")
		.map((weekday) => weekday.trim().toLowerCase())
		.filter(Boolean);
}

function normalizeManageRoutineInput(input: ManageRoutineToolInput): unknown {
	const value = recordValue(input);
	if (value?.action !== "upsert_weekly") return input;
	return { ...value, weekdays: normalizeWeekdays(value.weekdays) };
}

function assertManageRoutineInput(input: unknown): asserts input is ManageRoutineToolInput {
	const value = recordValue(input);
	if (!value || typeof value.routineKey !== "string" || !ROUTINE_KEY_PATTERN.test(value.routineKey)) {
		throw new Error("manage_routine requires a valid stable routineKey");
	}
	if (value.action === "upsert") {
		if (
			Object.keys(value).some(
				(key) =>
					![
						"action",
						"routineKey",
						"title",
						"instructions",
						"intervalMinutes",
						"startAt",
						"effort",
						"reviewerStaffIds",
					].includes(key),
			) ||
			!boundedText(value.title, 160) ||
			!boundedText(value.instructions, 32 * 1024) ||
			typeof value.intervalMinutes !== "number" ||
			!Number.isInteger(value.intervalMinutes) ||
			value.intervalMinutes < 5 ||
			value.intervalMinutes > 10_080 ||
			!validStartAt(value.startAt) ||
			(value.effort !== undefined && (typeof value.effort !== "string" || !EFFORTS.has(value.effort))) ||
			!validReviewerStaffIds(value.reviewerStaffIds)
		) {
			throw new Error("manage_routine upsert input is invalid");
		}
		return;
	}
	if (value.action === "upsert_weekly") {
		if (
			Object.keys(value).some(
				(key) =>
					![
						"action",
						"routineKey",
						"title",
						"instructions",
						"weekdays",
						"localTime",
						"timeZone",
						"effort",
						"reviewerStaffIds",
					].includes(key),
			) ||
			!boundedText(value.title, 160) ||
			!boundedText(value.instructions, 32 * 1024) ||
			!Array.isArray(value.weekdays) ||
			value.weekdays.length < 1 ||
			value.weekdays.length > 7 ||
			new Set(value.weekdays).size !== value.weekdays.length ||
			!value.weekdays.every((weekday) => typeof weekday === "string" && WEEKDAYS.has(weekday)) ||
			typeof value.localTime !== "string" ||
			!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.localTime) ||
			!validTimeZone(value.timeZone) ||
			(value.effort !== undefined && (typeof value.effort !== "string" || !EFFORTS.has(value.effort))) ||
			!validReviewerStaffIds(value.reviewerStaffIds)
		) {
			throw new Error("manage_routine weekly input is invalid");
		}
		return;
	}
	if (value.action === "upsert_event") {
		if (
			Object.keys(value).some(
				(key) =>
					![
						"action",
						"routineKey",
						"title",
						"instructions",
						"eventDescription",
						"sourceHints",
						"checkEveryMinutes",
						"effort",
						"reviewerStaffIds",
					].includes(key),
			) ||
			!boundedText(value.title, 160) ||
			!boundedText(value.instructions, 32 * 1024) ||
			!boundedText(value.eventDescription, 2_000) ||
			(value.sourceHints !== undefined &&
				(!Array.isArray(value.sourceHints) ||
					value.sourceHints.length < 1 ||
					value.sourceHints.length > 8 ||
					!value.sourceHints.every((hint) => boundedText(hint, 120)))) ||
			(value.checkEveryMinutes !== undefined &&
				(typeof value.checkEveryMinutes !== "number" ||
					!Number.isInteger(value.checkEveryMinutes) ||
					value.checkEveryMinutes < 5 ||
					value.checkEveryMinutes > 10_080)) ||
			(value.effort !== undefined && (typeof value.effort !== "string" || !EFFORTS.has(value.effort))) ||
			!validReviewerStaffIds(value.reviewerStaffIds)
		) {
			throw new Error("manage_routine event input is invalid");
		}
		return;
	}
	if (
		(value.action !== "pause" && value.action !== "resume" && value.action !== "remove") ||
		Object.keys(value).some((key) => key !== "action" && key !== "routineKey")
	) {
		throw new Error("manage_routine action is invalid");
	}
}

export function createManageRoutineToolDefinition(): ToolDefinition<typeof manageRoutineSchema, undefined> {
	return {
		name: MANAGE_ROUTINE_TOOL_NAME,
		label: "manage routine",
		description:
			"Create, update, pause, resume, or remove one of your own recurring routines. Use upsert for a fixed elapsed-time cadence. Set startAt to the exact ISO 8601 timestamp of its first desired run when it should not run immediately. Use upsert_weekly for weekday and wall-clock schedules so they remain correct across daylight-saving changes; timeZone defaults to auto, meaning the computer's current timezone, and may instead be an explicit IANA timezone. Use upsert_event for a plain-English event the company should react to; a silent background builder will inspect company files and connectors, install the smallest viable monitor, and either create the trigger or report a concrete failure. In an attended conversation, use this only after the founder explicitly agrees to the exact recurring work and cadence or event, or explicitly asks for the management action. Never infer consent from general enthusiasm, never call it during unattended work, and reuse the same routineKey so retries update instead of duplicate. Scheduled work defaults to high effort.",
		promptSnippet: "Manage your own agreed recurring work with an idempotent routine key",
		parameters: manageRoutineSchema,
		async execute(_toolCallId, input: ManageRoutineToolInput) {
			const normalized = normalizeManageRoutineInput(input);
			assertManageRoutineInput(normalized);
			const result = await brokeredCompanyOperation("manage_routine", normalized);
			return {
				content: [
					{
						type: "text",
						text: result.message,
					},
				],
				details: undefined,
			};
		},
	};
}

export function createManageRoutineTool(): AgentTool<typeof manageRoutineSchema> {
	return wrapToolDefinition(createManageRoutineToolDefinition());
}
