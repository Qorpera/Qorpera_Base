import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_COMPANY_ICON_ID,
	forgetCompanyIcon,
	isCompanyIconId,
	readCompanyIcon,
	writeCompanyIcon,
} from "../src/company-appearance.ts";

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
	const root = join(tmpdir(), `qorpera-company-appearance-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	temporaryRoots.push(root);
	return root;
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("company appearance", () => {
	const founder = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
	const other = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";

	it("uses the selected company icon only for its owning account", () => {
		const userData = temporaryRoot();
		const company = join(userData, "company-a");
		expect(readCompanyIcon(userData, founder, company)).toBe(DEFAULT_COMPANY_ICON_ID);
		writeCompanyIcon(userData, founder, company, "hop-mono-cloud");
		expect(readCompanyIcon(userData, founder, company)).toBe("hop-mono-cloud");
		expect(readCompanyIcon(userData, other, company)).toBe(DEFAULT_COMPANY_ICON_ID);
		forgetCompanyIcon(userData, founder, company);
		expect(readCompanyIcon(userData, founder, company)).toBe(DEFAULT_COMPANY_ICON_ID);
	});

	it("reads legacy profile appearance state until the company record is next written", () => {
		const userData = temporaryRoot();
		const company = join(userData, "company-a");
		mkdirSync(userData, { recursive: true });
		writeFileSync(
			join(userData, "profile-appearances.json"),
			JSON.stringify({
				schema: "qorpera.profile-appearances/v1",
				profiles: {
					[process.platform === "win32" ? resolve(company).toLowerCase() : resolve(company)]: {
						userId: founder,
						iconId: "hop-blue-steel",
					},
				},
			}),
			"utf-8",
		);
		expect(readCompanyIcon(userData, founder, company)).toBe("hop-blue-steel");
		writeCompanyIcon(userData, founder, company, "hop-mono-cloud");
		expect(readCompanyIcon(userData, founder, company)).toBe("hop-mono-cloud");
	});

	it("rejects unknown company icon identifiers", () => {
		expect(isCompanyIconId("hop-blue-steel")).toBe(true);
		expect(isCompanyIconId("agent-gem")).toBe(false);
	});
});
