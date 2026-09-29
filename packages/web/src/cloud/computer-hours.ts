import type { Cloud } from "./client.ts";
import { array, boundedInteger, CloudShapeError, nonEmptyString, record, timestamp, uuid } from "./parse.ts";

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

/** One founder's share of what pays for the company's hours, shown to founders only. */
export interface HoursLeftFounder {
	/** Absent for the packs of members who are no longer founders (one line, without a name). */
	userId?: string;
	/** Left in the founder's current plan period (the whole plan, shared by every company it pays for). */
	planSeconds?: number;
	/** Left in the packs this founder bought for the company. */
	creditSeconds?: number;
}

/** The company's hours left, from the live switch on (migration 20260929330000_company_hours_left_read). */
export type CompanyHoursLeft =
	| { complimentary: true }
	| {
			complimentary: false;
			/** Zero or less when the company is out of hours; below zero by what it owes. */
			leftSeconds: number;
			freeSeconds: number;
			planSeconds: number;
			creditSeconds: number;
			owedSeconds: number;
			/** Present for a founder reading it: who pays. */
			founders?: HoursLeftFounder[];
	  };

export interface CompanyComputerHours {
	profileId: string;
	/** "YYYY-MM" */
	month: string;
	timeZone: string;
	usedSeconds: number;
	byKind: ComputerHoursByKind;
	awakeNow: ComputerHoursByKind;
	meteredUntil: string;
	/** The company is out of computer hours: new work waits until hours are added (the zero
	 * rule, migration 20260928249200). False while the rule is off, and from older backends. */
	waitingForHours: boolean;
	/** Absent before the live switch (members see only measured hours) and from older backends. */
	hoursLeft?: CompanyHoursLeft;
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

function optionalSeconds(value: unknown, label: string): number | undefined {
	return value === null || value === undefined ? undefined : boundedInteger(value, label, 0, MAX_SECONDS);
}

function hoursLeft(value: unknown): CompanyHoursLeft {
	const input = record(value, "computer hours left");
	if (input.complimentary === true) return { complimentary: true };
	const founders =
		input.founders === undefined
			? undefined
			: array(input.founders, "computer hours founders").map((entry) => {
					const founder = record(entry, "computer hours founder");
					const planSeconds = optionalSeconds(founder.planSeconds, "founder plan hours");
					const creditSeconds = optionalSeconds(founder.creditSeconds, "founder pack hours");
					return {
						...(founder.userId === null || founder.userId === undefined
							? {}
							: { userId: uuid(founder.userId, "computer hours founder") }),
						...(planSeconds === undefined ? {} : { planSeconds }),
						...(creditSeconds === undefined ? {} : { creditSeconds }),
					};
				});
	return {
		complimentary: false,
		leftSeconds: boundedInteger(input.leftSeconds, "computer hours left", -MAX_SECONDS, MAX_SECONDS),
		freeSeconds: boundedInteger(input.freeSeconds, "free hours left", 0, MAX_SECONDS),
		planSeconds: boundedInteger(input.planSeconds, "plan hours left", 0, MAX_SECONDS),
		creditSeconds: boundedInteger(input.creditSeconds, "pack hours left", 0, MAX_SECONDS),
		owedSeconds: boundedInteger(input.owedSeconds, "hours owed", 0, MAX_SECONDS),
		...(founders ? { founders } : {}),
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
		waitingForHours: input.waitingForHours === true,
		...(input.hoursLeft === null || input.hoursLeft === undefined ? {} : { hoursLeft: hoursLeft(input.hoursLeft) }),
	};
}

export async function readCompanyComputerHours(cloud: Cloud, profileId: string): Promise<CompanyComputerHours> {
	return parseCompanyComputerHours(
		await cloud.rpc("qorpera_read_company_computer_hours", { p_profile_id: profileId }),
	);
}
