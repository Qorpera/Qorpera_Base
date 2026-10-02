import {
	companyAccountFields,
	companyAccountTotpCode,
	decodeCompanyAccountBase32,
	generateCompanyAccountPassword,
	parseCompanyAccountFields,
	parseCompanyAccountOtpauth,
	parseCompanyAccountRecoveryCodes,
} from "@qorpera/runtime/cloud-company-accounts";
import { describe, expect, it } from "vitest";

/** RFC 4648 base32 of ASCII text, as a test-side encoder (the module only decodes). */
function base32(value: string): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
	let bits = "";
	for (const byte of Buffer.from(value, "ascii")) bits += byte.toString(2).padStart(8, "0");
	while (bits.length % 5 !== 0) bits += "0";
	let out = "";
	for (let i = 0; i < bits.length; i += 5) out += alphabet[Number.parseInt(bits.slice(i, i + 5), 2)];
	return out;
}

describe("company account authenticator codes", () => {
	// RFC 6238 Appendix B: 8 digits, 30 s, the three algorithms with their own ASCII seeds.
	const seeds = {
		SHA1: base32("12345678901234567890"),
		SHA256: base32("12345678901234567890123456789012"),
		SHA512: base32("1234567890123456789012345678901234567890123456789012345678901234"),
	} as const;
	const vectors: [number, keyof typeof seeds, string][] = [
		[59, "SHA1", "94287082"],
		[59, "SHA256", "46119246"],
		[59, "SHA512", "90693936"],
		[1111111109, "SHA1", "07081804"],
		[1111111109, "SHA256", "68084774"],
		[1111111109, "SHA512", "25091201"],
		[1111111111, "SHA1", "14050471"],
		[1234567890, "SHA256", "91819424"],
		[2000000000, "SHA512", "38618901"],
		[20000000000, "SHA1", "65353130"],
	];
	it.each(vectors)("at %i s with %s gives %s", (seconds, algorithm, code) => {
		expect(companyAccountTotpCode({ seed: seeds[algorithm], digits: 8, period: 30, algorithm }, seconds * 1000)).toBe(
			code,
		);
	});

	it("gives six digits by default and the same code across one period", () => {
		const value = { seed: seeds.SHA1, digits: 6, period: 30, algorithm: "SHA1" } as const;
		expect(companyAccountTotpCode(value, 59_000)).toBe("287082");
		expect(companyAccountTotpCode(value, 30_000)).toBe(companyAccountTotpCode(value, 59_999));
		expect(companyAccountTotpCode(value, 60_000)).not.toBe(companyAccountTotpCode(value, 59_999));
	});

	it("reads the setup link a website's QR code carries, and refuses others", () => {
		expect(
			parseCompanyAccountOtpauth(
				`otpauth://totp/Vercel:agents%40nordlys.example?secret=${seeds.SHA1.toLowerCase()}&issuer=Vercel`,
			),
		).toEqual({ seed: seeds.SHA1, digits: 6, period: 30, algorithm: "SHA1" });
		expect(
			parseCompanyAccountOtpauth(`otpauth://totp/x?secret=${seeds.SHA256}&algorithm=sha256&digits=8&period=60`),
		).toEqual({ seed: seeds.SHA256, digits: 8, period: 60, algorithm: "SHA256" });
		// A repeated issuer or image is not read, so it does not matter.
		expect(
			parseCompanyAccountOtpauth(
				`otpauth://totp/x?secret=${seeds.SHA1}&issuer=Vercel&issuer=Vercel&image=a&image=b`,
			),
		).toEqual({ seed: seeds.SHA1, digits: 6, period: 30, algorithm: "SHA1" });
		expect(parseCompanyAccountOtpauth(`otpauth://totp/x?Secret=${seeds.SHA256}&Algorithm=SHA256&Digits=8`)).toEqual({
			seed: seeds.SHA256,
			digits: 8,
			period: 30,
			algorithm: "SHA256",
		});
		for (const link of [
			`otpauth://hotp/x?secret=${seeds.SHA1}&counter=1`,
			"otpauth://totp/x",
			`https://example.com/?secret=${seeds.SHA1}`,
			"otpauth://totp/x?secret=AAAA",
			`otpauth://totp/x?secret=${seeds.SHA1}&digits=4`,
			`otpauth://totp/x?secret=${seeds.SHA1}&algorithm=MD5`,
			`otpauth://totp/x?secret=${seeds.SHA1}&period=5`,
			`otpauth://totp/x?secret=${seeds.SHA1}&digits=0x8`,
			`otpauth://totp/x?secret=${seeds.SHA1}&digits=`,
			`otpauth://totp/x?secret=${seeds.SHA1}&secret=${seeds.SHA256}`,
			`otpauth://totp/x?secret=${seeds.SHA1}&algorithm=SHA1&ALGORITHM=SHA256`,
			"not a link",
		])
			expect(() => parseCompanyAccountOtpauth(link), link).toThrow(/Company account authenticator/);
	});

	it("decodes base32 as authenticator apps accept it, and refuses what is not base32", () => {
		expect(Buffer.from(decodeCompanyAccountBase32("gezd gnbv-gy3t qojq====")).toString("ascii")).toBe("1234567890");
		// 17 and 19 characters end a quantum after 1 or 3 characters, which RFC 4648 never produces.
		for (const bad of [
			"",
			"GEZ1",
			"GEZDGNBVGY3TQOJ!",
			"GEZDGNBVGY3TQOJQB",
			"GEZDGNBVGY3TQOJQA",
			"GEZDGNBVGY3TQOJQAAA",
		])
			expect(() => decodeCompanyAccountBase32(bad), bad).toThrow("Company account authenticator seed is malformed");
	});
});

describe("company account passwords", () => {
	it("draws 24 characters with every class by default, and honours the website's length and symbols", () => {
		const password = generateCompanyAccountPassword();
		expect(password).toHaveLength(24);
		for (const set of [/[a-z]/, /[A-Z]/, /[0-9]/, /[-_.!@#%+=]/]) expect(password).toMatch(set);
		expect(password).toMatch(/^[A-Za-z0-9\-_.!@#%+=]+$/);
		const plain = generateCompanyAccountPassword({ length: 12, symbols: false });
		expect(plain).toMatch(/^[A-Za-z0-9]{12}$/);
		for (const set of [/[a-z]/, /[A-Z]/, /[0-9]/]) expect(plain).toMatch(set);
		expect(new Set(Array.from({ length: 50 }, () => generateCompanyAccountPassword())).size).toBe(50);
		for (const length of [11, 65, 12.5])
			expect(() => generateCompanyAccountPassword({ length })).toThrow(
				"Company account password length is malformed",
			);
	});

	it("never takes a modulo-biased byte: bytes above the last full multiple are drawn again", () => {
		// 26 letters: 256 - 256 % 26 = 234, so 250 is drawn again and 0 then picks "a".
		const bytes = [250, 0, 250, 0, 0, 0, ...Array.from({ length: 200 }, () => 1)];
		const password = generateCompanyAccountPassword({ length: 12, symbols: false }, () =>
			Uint8Array.of(bytes.shift() ?? 1),
		);
		expect(password).toHaveLength(12);
		expect(password).toContain("a");
		expect(password).toContain("A");
		// Plain modulo would have turned the first 250 into "q" (250 % 26 = 16).
		expect(password).not.toContain("q");
	});
});

describe("company account envelope fields", () => {
	const seed = base32("12345678901234567890");
	it("round-trips every part, and seals only the parts it has", () => {
		const secret = {
			password: "Pw-1234567890abcd",
			passwordPrevious: "Old-1234567890abc",
			totp: { seed, digits: 6, period: 30, algorithm: "SHA1" },
			recoveryCodes: [
				{ code: "abcd-efgh", used: false },
				{ code: "ijkl-mnop", used: true },
			],
		} as const;
		const fields = companyAccountFields(secret);
		expect(Object.keys(fields).sort()).toEqual(["password", "password_previous", "recovery_codes", "totp"]);
		expect(parseCompanyAccountFields(fields)).toEqual(secret);
		expect(companyAccountFields({ password: "only-a-password-1" })).toEqual({ password: "only-a-password-1" });
	});

	it("refuses unknown fields, bad JSON and malformed parts", () => {
		const cases: Record<string, string>[] = [
			{ password: "x", token: "y" },
			{ password: "x", totp: "{" },
			{ password: "" },
			{ password: "line\nbreak" },
			{
				password: "x",
				totp: JSON.stringify({ seed: seed.toLowerCase(), digits: 6, period: 30, algorithm: "SHA1" }),
			},
			{ password: "x", totp: JSON.stringify({ seed, digits: 6, period: 30, algorithm: "SHA1", extra: 1 }) },
			{ password: "x", recovery_codes: JSON.stringify([]) },
			{ password: "x", recovery_codes: JSON.stringify([{ code: "ab", used: false }]) },
			{
				password: "x",
				recovery_codes: JSON.stringify([
					{ code: "abcd", used: false },
					{ code: "abcd", used: false },
				]),
			},
		];
		for (const fields of cases)
			expect(() => parseCompanyAccountFields(fields), JSON.stringify(fields)).toThrow(/Company account/);
	});

	it("reads recovery codes as websites show or download them", () => {
		expect(parseCompanyAccountRecoveryCodes("1. abcd-efgh\n2) ijkl mnop\r\n\nqrst-uvwx, abcd-efgh")).toEqual([
			{ code: "abcd-efgh", used: false },
			{ code: "ijklmnop", used: false },
			{ code: "qrst-uvwx", used: false },
		]);
		expect(() => parseCompanyAccountRecoveryCodes("\n\n")).toThrow("Company account recovery codes are malformed");
		expect(() => parseCompanyAccountRecoveryCodes("ok-code-1\nbad code!")).toThrow(
			"Company account recovery codes are malformed",
		);
	});
});
