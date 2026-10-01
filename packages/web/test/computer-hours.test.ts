import { describe, expect, it } from "vitest";
import { parseCompanyComputerHours, readCompanyComputerHours } from "../src/cloud/computer-hours.ts";

const P = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const reply = (overrides: Record<string, unknown> = {}) => ({
	schema: "qorpera.company-computer-hours/v1",
	profileId: P,
	month: "2026-09",
	timeZone: "Europe/Copenhagen",
	usedStandardSeconds: 149_400,
	byKind: { companyMachines: 79_200, agentMachines: 0, codingMachines: 10_800, runs: 52_200 },
	awakeNow: { companyMachines: 1, agentMachines: 0, codingMachines: 0, runs: 2 },
	meteredUntil: "2026-09-28T18:00:00.123456+00:00",
	...overrides,
});

describe("company computer hours", () => {
	it("reads the month the cloud measured", () => {
		expect(parseCompanyComputerHours(reply())).toEqual({
			profileId: P,
			month: "2026-09",
			timeZone: "Europe/Copenhagen",
			usedSeconds: 149_400,
			byKind: { companyMachines: 79_200, agentMachines: 0, codingMachines: 10_800, runs: 52_200 },
			awakeNow: { companyMachines: 1, agentMachines: 0, codingMachines: 0, runs: 2 },
			meteredUntil: "2026-09-28T18:00:00.123456+00:00",
			waitingForHours: false,
		});
	});

	it("reads the company's hours left from the live switch on, and nothing before it", () => {
		expect(parseCompanyComputerHours(reply()).hoursLeft).toBeUndefined();
		expect(parseCompanyComputerHours(reply({ hoursLeft: null })).hoursLeft).toBeUndefined();
		expect(parseCompanyComputerHours(reply({ hoursLeft: { complimentary: true } })).hoursLeft).toEqual({
			complimentary: true,
		});
		const left = {
			leftSeconds: -3600,
			freeSeconds: 0,
			planSeconds: 0,
			creditSeconds: 0,
			owedSeconds: 3600,
		};
		expect(parseCompanyComputerHours(reply({ hoursLeft: left })).hoursLeft).toEqual({
			complimentary: false,
			...left,
		});
		const founders = [
			{ userId: P, planSeconds: 7200, creditSeconds: null },
			{ userId: P.replace("a", "b"), planSeconds: null, creditSeconds: 72_000 },
			{ userId: null, planSeconds: null, creditSeconds: 3600 },
		];
		expect(parseCompanyComputerHours(reply({ hoursLeft: { ...left, founders } })).hoursLeft).toEqual({
			complimentary: false,
			...left,
			founders: [
				{ userId: P, planSeconds: 7200 },
				{ userId: P.replace("a", "b"), creditSeconds: 72_000 },
				{ creditSeconds: 3600 },
			],
		});
		expect(() => parseCompanyComputerHours(reply({ hoursLeft: { ...left, freeSeconds: -1 } }))).toThrow(
			"free hours left",
		);
	});

	it("reads whether the company waits for computer hours, and an older reply as not waiting", () => {
		expect(parseCompanyComputerHours(reply({ waitingForHours: true })).waitingForHours).toBe(true);
		expect(parseCompanyComputerHours(reply({ waitingForHours: false })).waitingForHours).toBe(false);
		expect(parseCompanyComputerHours(reply()).waitingForHours).toBe(false);
	});

	it("refuses another schema or a malformed figure", () => {
		expect(() => parseCompanyComputerHours(reply({ schema: "qorpera.company-computer-hours/v2" }))).toThrow(
			"computer hours",
		);
		expect(() => parseCompanyComputerHours(reply({ month: "2026-13" }))).toThrow("computer hours month");
		expect(() => parseCompanyComputerHours(reply({ usedStandardSeconds: -1 }))).toThrow("computer hours used");
		expect(() => parseCompanyComputerHours(reply({ usedStandardSeconds: 1.5 }))).toThrow("computer hours used");
		expect(() => parseCompanyComputerHours(reply({ byKind: { companyMachines: 1 } }))).toThrow(
			"computer hours by kind",
		);
	});

	it("asks the cloud for one company", async () => {
		const calls: [string, unknown][] = [];
		const cloud = {
			rpc: async (name: string, args?: unknown) => {
				calls.push([name, args]);
				return reply();
			},
		};
		const hours = await readCompanyComputerHours(cloud as never, P);
		expect(calls).toEqual([["qorpera_read_company_computer_hours", { p_profile_id: P }]]);
		expect(hours.usedSeconds).toBe(149_400);
	});
});
