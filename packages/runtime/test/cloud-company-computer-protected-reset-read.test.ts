import {
	COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
	COMPANY_COMPUTER_RESET_CONFIGURATION_MAX_BYTES,
} from "@qorpera/contracts";
import { describe, expect, it } from "vitest";
import { readCompanyComputerPreparationProtected } from "../src/cloud-company-computer-preparation-control.ts";

const root = "/run/qorpera-office-preparation";
describe("protected reset packet read ceiling", () => {
	it.each([
		`${root}/incoming-${"a".repeat(64)}.json`,
		`${root}/reset-configuration-incoming-${"a".repeat(63)}.json`,
		`${root}/reset-configuration-incoming-${"A".repeat(64)}.json`,
		`${root}/reset-configuration-incoming-${"a".repeat(64)}.json/extra`,
		`${root}/nested/reset-configuration-incoming-${"a".repeat(64)}.json`,
		`/tmp/reset-configuration-incoming-${"a".repeat(64)}.json`,
		"/etc/qorpera-office/preparation.json",
	])("preserves the original ceiling for %s before filesystem access", async (path) => {
		await expect(
			readCompanyComputerPreparationProtected(path, COMPANY_COMPUTER_PREPARATION_MAX_BYTES + 1),
		).rejects.toThrow("OFFICE_PREPARATION_CONTROL_READ_LIMIT");
	});
	it.each([NaN, -1, Infinity, COMPANY_COMPUTER_RESET_CONFIGURATION_MAX_BYTES + 1])(
		"rejects an invalid reset read budget %s",
		async (limit) => {
			await expect(
				readCompanyComputerPreparationProtected(
					`${root}/reset-configuration-incoming-${"a".repeat(64)}.json`,
					limit,
				),
			).rejects.toThrow("OFFICE_PREPARATION_CONTROL_READ_LIMIT");
		},
	);
});
