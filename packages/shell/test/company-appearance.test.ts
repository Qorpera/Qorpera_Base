import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	const picture = `data:image/png;base64,${Buffer.from("89504e470d0a1a0a", "hex").toString("base64")}` as const;

	it("uses the selected company picture only for its owning account", () => {
		const userData = temporaryRoot();
		const company = join(userData, "company-a");
		expect(readCompanyIcon(userData, founder, company)).toBe(DEFAULT_COMPANY_ICON_ID);
		writeCompanyIcon(userData, founder, company, picture);
		expect(readCompanyIcon(userData, founder, company)).toBe(picture);
		expect(readCompanyIcon(userData, other, company)).toBe(DEFAULT_COMPANY_ICON_ID);
		forgetCompanyIcon(userData, founder, company);
		expect(readCompanyIcon(userData, founder, company)).toBe(DEFAULT_COMPANY_ICON_ID);
	});

	it("replaces a custom picture with the anonymous icon", () => {
		const userData = temporaryRoot();
		const company = join(userData, "company-a");
		writeCompanyIcon(userData, founder, company, picture);
		writeCompanyIcon(userData, founder, company, DEFAULT_COMPANY_ICON_ID);
		expect(readCompanyIcon(userData, founder, company)).toBe(DEFAULT_COMPANY_ICON_ID);
	});

	it("accepts supported pictures and rejects malformed or oversized data", () => {
		expect(isCompanyIconId(DEFAULT_COMPANY_ICON_ID)).toBe(true);
		expect(isCompanyIconId(picture)).toBe(true);
		expect(isCompanyIconId("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
		expect(isCompanyIconId("data:image/png;base64,PHN2Zz4=")).toBe(false);
		expect(isCompanyIconId(`data:image/png;base64,${Buffer.alloc(1024 * 1024 + 1).toString("base64")}`)).toBe(false);
	});
});
