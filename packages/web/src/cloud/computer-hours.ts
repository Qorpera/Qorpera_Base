import type { Cloud } from "./client.ts";
import { boundedInteger, CloudShapeError, nonEmptyString, record, timestamp, uuid } from "./parse.ts";

/* A company's computer hours for one calendar month, in Danish time
 * (migration 20260928248000_runtime_computer_hours_meter; contract section 19,
 * 2026-09-28 amendment "computer hours"). Measured only: nothing is charged yet.
 * One computer hour is one hour of a standard machine (4 vCPU, 8 GiB); the
 * figures are standard seconds. */

export interface ComputerHoursByKind {
	companyMachines: number;
	agentMachines: number;
	codingMachines: number;
	runs: number;
}

export interface CompanyComputerHours {
	profileId: string;
	/** "YYYY-MM" */
	month: string;
	timeZone: string;
	usedSeconds: number;
	byKind: ComputerHoursByKind;
	awakeNow: ComputerHoursByKind;
	meteredUntil: string;
}

const MAX_SECONDS = 1_000_000_000_000;

function kinds(value: unknown, label: string): ComputerHoursByKind {
	const input = record(value, label);
	return {
		companyMachines: boundedInteger(input.companyMachines, label, 0, MAX_SECONDS),
		agentMachines: boundedInteger(input.agentMachines, label, 0, MAX_SECONDS),
		codingMachines: boundedInteger(input.codingMachines, label, 0, MAX_SECONDS),
		runs: boundedInteger(input.runs, label, 0, MAX_SECONDS),
	};
}

export function parseCompanyComputerHours(value: unknown): CompanyComputerHours {
	const input = record(value, "computer hours");
	if (input.schema !== "qorpera.company-computer-hours/v1") throw new CloudShapeError("computer hours");
	const month = nonEmptyString(input.month, "computer hours month", 7);
	if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new CloudShapeError("computer hours month");
	return {
		profileId: uuid(input.profileId, "computer hours company"),
		month,
		timeZone: nonEmptyString(input.timeZone, "computer hours time zone", 64),
		usedSeconds: boundedInteger(input.usedStandardSeconds, "computer hours used", 0, MAX_SECONDS),
		byKind: kinds(input.byKind, "computer hours by kind"),
		awakeNow: kinds(input.awakeNow, "machines awake now"),
		meteredUntil: timestamp(input.meteredUntil, "computer hours measured until"),
	};
}

export async function readCompanyComputerHours(cloud: Cloud, profileId: string): Promise<CompanyComputerHours> {
	return parseCompanyComputerHours(
		await cloud.rpc("qorpera_read_company_computer_hours", { p_profile_id: profileId }),
	);
}
