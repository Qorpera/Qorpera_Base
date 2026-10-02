import {
	COMPANY_ACCOUNT_FILL_LIFETIME_MS,
	type CompanyAccountFillIdentity,
	CompanyComputerFillKey,
	parseCompanyComputerFillPublicKey,
	sealCompanyAccountFill,
} from "@qorpera/runtime/cloud-company-account-fill-box";
import { describe, expect, it } from "vitest";

const identity: CompanyAccountFillIdentity = {
	companyId: "79900000-0000-4000-8000-000000000010",
	companyComputerId: "79900000-0000-4000-8000-000000000020",
	computerGeneration: 3,
	receiptId: "79900000-0000-4000-8000-000000000030",
	accountId: "79900000-0000-4000-8000-000000000040",
	field: "password",
};
const fill = { value: "Pw-1234567890abcdEFGH", hosts: ["vercel.com", "accounts.vercel.com"] };
const now = 1_790_000_000_000;

describe("company account fill box", () => {
	it("opens only in the computer it was sealed to, for exactly that call, with the hosts inside", () => {
		const key = new CompanyComputerFillKey();
		const box = sealCompanyAccountFill(fill, key.publicKey, identity, now);
		expect(JSON.stringify(box)).not.toContain(fill.value);
		expect(JSON.stringify(box)).not.toContain("vercel");
		expect(key.open(box, identity, now + 1000)).toEqual({
			field: "password",
			value: fill.value,
			hosts: fill.hosts,
			notAfterMs: now + COMPANY_ACCOUNT_FILL_LIFETIME_MS,
		});
		expect(() => new CompanyComputerFillKey().open(box, identity, now)).toThrow(
			"Company account fill box does not open here",
		);
		for (const [name, other] of Object.entries({
			companyId: "79900000-0000-4000-8000-000000000011",
			companyComputerId: "79900000-0000-4000-8000-000000000021",
			computerGeneration: 4,
			receiptId: "79900000-0000-4000-8000-000000000031",
			accountId: "79900000-0000-4000-8000-000000000041",
			field: "code",
		}))
			expect(() => key.open(box, { ...identity, [name]: other }, now), name).toThrow(
				"Company account fill box does not open here",
			);
	});

	it("refuses a box after its lifetime, and any changed byte", () => {
		const key = new CompanyComputerFillKey();
		const box = sealCompanyAccountFill(fill, key.publicKey, identity, now);
		expect(() => key.open(box, identity, now + COMPANY_ACCOUNT_FILL_LIFETIME_MS + 1)).toThrow(
			"Company account fill expired",
		);
		for (const part of ["ciphertext", "iv", "tag", "ephemeralPublicKey"]) {
			const bytes = Buffer.from(box[part]!, "base64url");
			bytes[0] = bytes[0]! ^ 1;
			expect(() => key.open({ ...box, [part]: bytes.toString("base64url") }, identity, now), part).toThrow(
				"Company account fill box does not open here",
			);
		}
	});

	it("refuses a malformed box, a low-order key and a malformed recipient", () => {
		const key = new CompanyComputerFillKey();
		const box = sealCompanyAccountFill(fill, key.publicKey, identity, now);
		for (const bad of [
			null,
			[],
			{ ...box, schema: "other" },
			{ ...box, extra: "x" },
			{ ...box, iv: `${box.iv}=` },
			{ ...box, tag: "AAAA" },
			{ ...box, ciphertext: "" },
		])
			expect(() => key.open(bad, identity, now), JSON.stringify(bad)).toThrow(/Company account fill box/);
		expect(() =>
			key.open({ ...box, ephemeralPublicKey: Buffer.alloc(32).toString("base64url") }, identity, now),
		).toThrow();
		for (const recipient of ["", "AAAA", `${key.publicKey}A`, Buffer.alloc(33).toString("base64url")])
			expect(() => sealCompanyAccountFill(fill, recipient, identity, now), recipient).toThrow(
				"Company Computer fill key is malformed",
			);
		expect(() => sealCompanyAccountFill(fill, Buffer.alloc(32).toString("base64url"), identity, now)).toThrow();
		expect(parseCompanyComputerFillPublicKey(key.publicKey).asymmetricKeyType).toBe("x25519");
	});

	it("seals only a typeable value for known hosts and a well-formed call", () => {
		const key = new CompanyComputerFillKey();
		for (const bad of [
			{ value: "", hosts: fill.hosts },
			{ value: "a\nb", hosts: fill.hosts },
			{ value: "x".repeat(257), hosts: fill.hosts },
			{ value: "x", hosts: [] },
			{ value: "x", hosts: ["Vercel.com"] },
			{ value: "x", hosts: ["vercel.com", "vercel.com"] },
			{ value: "x", hosts: ["https://vercel.com"] },
		])
			expect(() => sealCompanyAccountFill(bad, key.publicKey, identity, now), JSON.stringify(bad)).toThrow(
				/Company account fill/,
			);
		for (const [name, bad] of Object.entries({
			companyId: "x",
			receiptId: "79900000-0000-4000-8000-00000000003A",
			computerGeneration: 0,
			field: "token",
		}))
			expect(
				() => sealCompanyAccountFill(fill, key.publicKey, { ...identity, [name]: bad } as never, now),
				name,
			).toThrow("Company account fill identity is malformed");
	});
});
