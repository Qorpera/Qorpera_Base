import type { Cloud } from "./client.ts";
import { boundedInteger, CloudShapeError, oneOf, record, timestamp, uuid } from "./parse.ts";

/* The company's memory choice (scope reset 17 Oct, C5; CLIENT-CONTRACT.md "Company memory (2) — C5"):
 * Agent notebooks, the default, or Shared context, a beta that is only offered to some companies.
 * Any member reads it; owners and admins choose. A choice applies to runs that start after it: a run
 * keeps the mode it started with until it ends. Switching deletes and rewrites nothing. */

export const COMPANY_MEMORY_MODES = ["notebooks", "tree"] as const;
export type CompanyMemoryMode = (typeof COMPANY_MEMORY_MODES)[number];

export interface CompanyMemory {
	profileId: string;
	/** The company's choice; "notebooks" until someone chooses. */
	mode: CompanyMemoryMode;
	/** When it was last chosen; null until the first choice. */
	setAt: string | null;
	/** What new runs get: "tree" only while the choice is "tree" and the beta is offered. */
	effective: CompanyMemoryMode;
	/** False: Shared context is shown, unavailable, and choosing it is refused. */
	betaOffered: boolean;
	/** Owners and admins choose; every other member reads. */
	canManage: boolean;
	/** Queued or running runs in the other mode than `effective`: each finishes in its own. */
	runsInOtherMode: number;
}

function flag(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") throw new CloudShapeError(label);
	return value;
}

export function parseCompanyMemory(value: unknown, profileId: string): CompanyMemory {
	const input = record(value, "company memory");
	if (input.schema !== "qorpera.company-memory-mode/v1") throw new CloudShapeError("company memory");
	const company = uuid(input.profileId, "company memory company");
	if (company !== profileId.toLowerCase()) throw new CloudShapeError("company memory company");
	return {
		profileId: company,
		mode: oneOf(input.mode, COMPANY_MEMORY_MODES, "company memory mode"),
		setAt: input.setAt === null ? null : timestamp(input.setAt, "company memory chosen at"),
		effective: oneOf(input.effective, COMPANY_MEMORY_MODES, "company memory for new runs"),
		betaOffered: flag(input.betaOffered, "company memory beta offer"),
		canManage: flag(input.canManage, "company memory manager"),
		runsInOtherMode: boundedInteger(input.runsInOtherMode, "runs in the other memory", 0, 2_147_483_647),
	};
}

export async function readCompanyMemory(cloud: Pick<Cloud, "rpc">, profileId: string): Promise<CompanyMemory> {
	return parseCompanyMemory(await cloud.rpc("qorpera_company_memory_mode", { p_profile_id: profileId }), profileId);
}

/** The same choice again changes nothing (its time stays). */
export async function chooseCompanyMemory(
	cloud: Pick<Cloud, "rpc">,
	profileId: string,
	mode: CompanyMemoryMode,
): Promise<CompanyMemory> {
	return parseCompanyMemory(
		await cloud.rpc("qorpera_set_company_memory_mode", { p_profile_id: profileId, p_mode: mode }),
		profileId,
	);
}
