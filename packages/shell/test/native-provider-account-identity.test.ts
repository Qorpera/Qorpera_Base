import { createHash } from "node:crypto";
import { nativeProviderAccountIdentity } from "@qorpera/runtime/native-provider-account";
import { describe, expect, it } from "vitest";

const metadata = (account_id: unknown, access_token = "private-access", refresh_token = "private-refresh") =>
	JSON.stringify({ tokens: { account_id, access_token, refresh_token } });

describe("native provider account quota identity", () => {
	it("uses the domain-separated account ID hash and stays stable across token rotations", () => {
		const accountId = "10000000-0000-4000-8000-000000000001";
		const first = nativeProviderAccountIdentity(metadata(accountId));
		const rotated = nativeProviderAccountIdentity(metadata(accountId, "rotated-access", "rotated-refresh"));
		expect(first).toMatch(/^[a-f0-9]{64}$/);
		expect(rotated).toBe(first);
		expect(first).toBe(createHash("sha256").update(`openai-account:${accountId}`).digest("hex"));
		expect(first).not.toContain(accountId);
		expect(first).not.toContain("private");
	});

	it("keeps different provider accounts distinct even with identical token metadata", () => {
		expect(nativeProviderAccountIdentity(metadata("account-a"))).not.toBe(
			nativeProviderAccountIdentity(metadata("account-b")),
		);
	});

	it("accepts bounded opaque account identifiers without changing their case", () => {
		expect(nativeProviderAccountIdentity(metadata("org.Account_1:tenant-2"))).toMatch(/^[a-f0-9]{64}$/);
		expect(nativeProviderAccountIdentity(metadata("a".repeat(256)))).toMatch(/^[a-f0-9]{64}$/);
		expect(nativeProviderAccountIdentity(metadata("ACCOUNT-A"))).not.toBe(
			nativeProviderAccountIdentity(metadata("account-a")),
		);
	});

	it.each([
		undefined,
		null,
		123,
		{},
		[],
		"",
		"a".repeat(257),
		" account-a",
		"account-a ",
		"account a",
		"account\nprivate",
		"account\rprivate",
		"account\0private",
		"account\tprivate",
		"account\u007f",
		"accøunt",
		"https://example.com/account",
		"account?query",
	])("does not produce an identity from malformed account IDs (%j)", (accountId) => {
		expect(nativeProviderAccountIdentity(metadata(accountId))).toBeUndefined();
	});

	it.each([
		"not-json",
		"null",
		"[]",
		"{}",
		'{"tokens":[]}',
		'{"account_id":"wrong-level"}',
		'{"tokens":{"id_token":"private","access_token":"private"}}',
		`${" ".repeat(256 * 1024)}{}`,
	])("returns unknown for missing or malformed official credential metadata", (value) => {
		expect(nativeProviderAccountIdentity(value)).toBeUndefined();
	});
});
