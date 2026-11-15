import type { Cloud } from "./client.ts";
import { boundedInteger, CloudShapeError, oneOf, record, timestamp, uuid } from "./parse.ts";

/* Whether the company can run, for its members (migration 20260930765000, `qorpera_read_company_standing`): a company
 * whose routines stand still cannot write its own reading, so the platform says it. An app that reads `reading` (the
 * `map` kit) is handed it (app/company-reading.ts) and turns grey while `stopped`; `since` is set whenever a routine
 * wake waits, stopped or not. */

/** Why the company stands still: the first login that is not ready among the members its waiting wakes are paid by;
 * null when every one of them is ready. */
export type StandingWhy = "login_full" | "sign_in" | "no_login";

export interface CompanyStanding {
	readonly stopped: boolean;
	/** When the oldest due routine wake began to wait; null when none waits. */
	readonly since: string | null;
	readonly why: StandingWhy | null;
	/** The member whose login holds the company, when `why` says. */
	readonly member: string | null;
	/** When a full login opens again, when known. */
	readonly resetsAt: string | null;
	/** Routine wakes that are due and still wait. */
	readonly waiting: number;
}

/** Every `why` the read answers. */
export const STANDING_WHY: readonly StandingWhy[] = ["login_full", "sign_in", "no_login"];
/** Every key of the read's answer (test/company-reading.test.ts holds them to the migration's own). */
export const STANDING_KEYS = ["schema", "stopped", "since", "why", "member", "resetsAt", "waiting"] as const;

export function parseCompanyStanding(value: unknown): CompanyStanding {
	const input = record(value, "standing");
	if (input.schema !== "qorpera.company-standing/v1" || typeof input.stopped !== "boolean")
		throw new CloudShapeError("standing");
	const nullable = <T>(item: unknown, read: (item: unknown) => T): T | null =>
		item === null || item === undefined ? null : read(item);
	return {
		stopped: input.stopped,
		since: nullable(input.since, (item) => timestamp(item, "standing since")),
		why: nullable(input.why, (item) => oneOf(item, STANDING_WHY, "standing why")),
		member: nullable(input.member, (item) => uuid(item, "standing member")),
		resetsAt: nullable(input.resetsAt, (item) => timestamp(item, "standing reset")),
		waiting: boundedInteger(input.waiting ?? 0, "standing waiting", 0, Number.MAX_SAFE_INTEGER),
	};
}

export function readCompanyStanding(cloud: Cloud, profileId: string): Promise<CompanyStanding> {
	return cloud
		.rpc("qorpera_read_company_standing", { p_profile_id: profileId })
		.then((value) => parseCompanyStanding(value));
}
