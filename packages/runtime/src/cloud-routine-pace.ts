import { createHash } from "node:crypto";

/*
 * Spread start times (deploy/first-node/RUNTIME-COMPANY-PACE.md §3). Agents set their routines at round times, and all
 * like 09:00, so a company's agents would all start at once. Each agent has its own offset of 1 to 20 minutes, from its
 * id, and a start time it sets on the hour or half hour moves that much later: a weekly time of day, a first run, a
 * dynamic routine's next run, a listener's latest time. The offset is the same in every save, so a repeated save is
 * the same request. The follow-up tick in SQL waits the same offset (qorpera_routine_agent_offset_minutes).
 */

/** The agent's offset in minutes, 1 to 20: the first 32 bits of the md5 of its lowercase id, modulo 20, plus 1. */
export function cloudRoutineAgentOffsetMinutes(staffAgentId: string): number {
	const hex = createHash("md5").update(staffAgentId.toLowerCase()).digest("hex");
	return (Number.parseInt(hex.slice(0, 8), 16) % 20) + 1;
}

/** An instant still ahead and on the hour or half hour, moved by the offset. Any other instant is kept, and so is one
 * the move would take to or past `end` (the routine's end). */
export function cloudRoutineSpreadInstant(at: string, offsetMinutes: number, end?: string | null): string {
	const ms = Date.parse(at);
	const moved = ms + offsetMinutes * 60_000;
	if (!(ms > Date.now()) || ms % 1_800_000 !== 0 || (end && moved >= Date.parse(end))) return at;
	return new Date(moved).toISOString();
}

/** A time of day (HH:MM) on the hour or half hour, moved by the offset within its hour. */
export function cloudRoutineSpreadLocalTime(value: string, offsetMinutes: number): string {
	const minute = Number(value.slice(3));
	return minute % 30 ? value : `${value.slice(0, 3)}${String(minute + offsetMinutes).padStart(2, "0")}`;
}
