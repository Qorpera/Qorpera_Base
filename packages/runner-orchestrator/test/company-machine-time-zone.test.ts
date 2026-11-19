import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	COMPANY_MACHINE_DESKTOP_TIME_ZONE,
	COMPANY_MACHINE_TIME_ZONE_PATTERN,
	companyMachineDesktopTimeZone,
} from "../src/company-machine-time-zone.ts";

const source = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

describe("the time zone a machine's desktop shows (20260930739000)", () => {
	it("is the company's zone exactly as SQL lists it, when it has a zone name's shape", () => {
		for (const zone of [
			"UTC",
			"Europe/Copenhagen",
			"America/New_York",
			"America/Argentina/Buenos_Aires",
			"America/North_Dakota/New_Salem",
			"America/Port-au-Prince",
			"Etc/GMT+12",
			"Etc/GMT-14",
			"GMT0",
			"A".repeat(64),
		])
			expect(companyMachineDesktopTimeZone(zone)).toBe(zone);
	});

	it("is nothing for a company whose zone is not known, an SQL without the key, or an answer that is no name", () => {
		for (const zone of [undefined, null, "", 0, 7, true, [], ["Europe/Copenhagen"], {}, { toString: () => "UTC" }])
			expect(companyMachineDesktopTimeZone(zone)).toBeUndefined();
	});

	it("never lets a word leave that the machine could not use as a file's name under its zones", () => {
		for (const zone of [
			"Europe/Copenhagen\n",
			"\nEurope/Copenhagen",
			"Europe/Copenhagen\nEurope/Paris",
			"Europe/Copenhagen ",
			" Europe/Copenhagen",
			"Europe Copenhagen",
			"Europe/Copenhagen\0",
			"../../etc/passwd",
			"..",
			".",
			"Europe/../Europe/Copenhagen",
			"Europe/./Copenhagen",
			"/Europe/Copenhagen",
			"/etc/localtime",
			"Europe/Copenhagen/",
			"Europe//Copenhagen",
			"a/b/c/d",
			"posix/America/Argentina/Buenos_Aires",
			"Europe/Copenhagen;reboot",
			"Europe/Copenhagen$(reboot)",
			"Europe/Copenhagen`reboot`",
			"Europe/Copenhagen'",
			'Europe/Copenhagen"',
			"Europe\\Copenhagen",
			"Europe/København",
			"Europe/Copenhagen​",
			"<UTC>",
			"UTC,M3.5.0",
			"A".repeat(65),
			`${"A".repeat(40)}/${"B".repeat(40)}`,
		])
			expect(companyMachineDesktopTimeZone(zone)).toBeUndefined();
	});

	it("holds SQL and the machine's desktop to the same shape, and writes the file the desktop reads", () => {
		const desktop = source("deploy/machine/desktop");
		expect(desktop).toContain(`TIMEZONE=${COMPANY_MACHINE_DESKTOP_TIME_ZONE}\n`);
		// The pattern as PostgreSQL and bash write it: the same expression without JavaScript's own marks.
		const shape = COMPANY_MACHINE_TIME_ZONE_PATTERN.source.replace("(?:\\/", "(/");
		expect(desktop).toContain(`plain='${shape}'`);
		expect(COMPANY_MACHINE_TIME_ZONE_PATTERN.flags).toBe("");
		const migration = source("supabase/migrations/20260930739000_company_time_zone.sql");
		// The column's own check and the function a browser's word comes in through.
		expect(migration).toContain(`(char_length(time_zone) between 1 and 64 and time_zone ~ '${shape}'));`);
		expect(migration).toContain(
			`if p_time_zone is null or char_length(p_time_zone) not between 1 and 64\n\t\tor p_time_zone !~ '${shape}'\n\t\tor not public.qorpera_runtime_time_zone_name_valid(p_time_zone) then`,
		);
	});
});
