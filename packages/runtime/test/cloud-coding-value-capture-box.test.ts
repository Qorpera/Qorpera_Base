import { generateKeyPairSync } from "node:crypto";
import {
	type CodingValueCapture,
	type CodingValueCaptureIdentity,
	codingValueFinder,
	codingValueMatches,
	codingValuePattern,
	openCodingValueCapture,
	sealCodingValueCapture,
} from "@qorpera/runtime/cloud-coding-value-capture-box";
import {
	EVENT_HOOK_CAPTURE_LIFETIME_MS,
	openEventHookCapture,
	sealEventHookCapture,
} from "@qorpera/runtime/cloud-event-hook-capture-box";
import { describe, expect, it } from "vitest";

// 20260930695000: a coding value read off its service's page is sealed to the value's capture key, as E3c seals a
// Stripe hook's signing secret, under its own schemas and info.

/** The services' patterns as the migration seeds them. */
const SEEDED = {
	npm: "^npm_[A-Za-z0-9]{36}$",
	github: "^(github_pat_[A-Za-z0-9_]{82}|ghp_[A-Za-z0-9]{36})$",
	stripe: "^(sk|rk)_(test|live)_[A-Za-z0-9]{24,247}$",
	resend: "^re_[A-Za-z0-9_]{20,64}$",
};
const identity: CodingValueCaptureIdentity = {
	companyId: "79900000-0000-4000-8000-000000000010",
	companyComputerId: "79900000-0000-4000-8000-000000000020",
	computerGeneration: 3,
	receiptId: "79900000-0000-4000-8000-000000000030",
	service: "npm",
	variable: "npm_token",
};
const token = `npm_${"Ab12Cd34Ef".repeat(3)}Gh12Kl`;
const npm = codingValuePattern(SEEDED.npm);
const capture = { value: token, site: "www.npmjs.com" };
const now = 1_790_000_000_000;

function recipient() {
	const pair = generateKeyPairSync("x25519");
	const raw = pair.publicKey.export({ format: "der", type: "spki" }).subarray(12);
	return { privateKey: pair.privateKey, publicKey: Buffer.from(raw).toString("base64url") };
}

async function opened(key: ReturnType<typeof recipient>, box: unknown, expected = identity, at = now + 1000) {
	return openCodingValueCapture(
		key.privateKey,
		key.publicKey,
		box,
		expected,
		async (got) => ({ ...got, value: got.value.toString("utf8") }),
		at,
	);
}

describe("coding value capture box", () => {
	it("opens only with the key it was sealed to, for exactly that call, and zeroes the value after", async () => {
		const key = recipient();
		const box = sealCodingValueCapture(capture, npm, key.publicKey, identity, now);
		expect(JSON.stringify(box)).not.toContain("npm_");
		expect(JSON.stringify(box)).not.toContain("npmjs");
		await expect(opened(key, box)).resolves.toEqual({ value: token, site: "www.npmjs.com", capturedAtMs: now });
		let seen: CodingValueCapture | undefined;
		await expect(
			openCodingValueCapture(
				key.privateKey,
				key.publicKey,
				box,
				identity,
				async (got) => {
					seen = got;
					throw new Error("vault refused");
				},
				now,
			),
		).rejects.toThrow("vault refused");
		expect(seen?.value.every((byte) => byte === 0)).toBe(true);
		await expect(opened(recipient(), box)).rejects.toThrow("Coding value capture box does not open here");
		for (const [name, other] of Object.entries({
			companyId: "79900000-0000-4000-8000-000000000011",
			companyComputerId: "79900000-0000-4000-8000-000000000021",
			computerGeneration: 4,
			receiptId: "79900000-0000-4000-8000-000000000031",
			service: "github",
			variable: "npm_auth_token",
		}))
			await expect(opened(key, box, { ...identity, [name]: other }), name).rejects.toThrow(
				"Coding value capture box does not open here",
			);
	});

	it("is stored within a hook capture's lifetime or never", async () => {
		const key = recipient();
		const box = sealCodingValueCapture(capture, npm, key.publicKey, identity, now);
		await expect(opened(key, box, identity, now + EVENT_HOOK_CAPTURE_LIFETIME_MS)).resolves.toMatchObject({
			capturedAtMs: now,
		});
		await expect(opened(key, box, identity, now + EVENT_HOOK_CAPTURE_LIFETIME_MS + 1)).rejects.toThrow(
			"Coding value capture expired",
		);
		await expect(opened(key, box, identity, now - 60_001)).rejects.toThrow("Coding value capture expired");
	});

	it("seals only a whole value of the service's pattern, read on a host", () => {
		const key = recipient();
		for (const value of [`${token}x`, token.slice(0, -1), `sk_live_${"a".repeat(30)}`, `${token}\n`, ""])
			expect(() => sealCodingValueCapture({ ...capture, value }, npm, key.publicKey, identity, now), value).toThrow(
				"Coding value capture value is malformed",
			);
		for (const site of ["https://www.npmjs.com", "localhost", "WWW.npmjs.com"])
			expect(() => sealCodingValueCapture({ ...capture, site }, npm, key.publicKey, identity, now), site).toThrow(
				"Coding value capture site is malformed",
			);
		for (const bad of [{ service: "NPM" }, { variable: "NPM_TOKEN" }, { computerGeneration: 0 }])
			expect(() => sealCodingValueCapture(capture, npm, key.publicKey, { ...identity, ...bad }, now)).toThrow(
				"Coding value capture identity is malformed",
			);
		expect(() => sealCodingValueCapture(capture, npm, "not-a-key", identity, now)).toThrow(
			"Coding value capture key is malformed",
		);
	});

	it("never opens as a hook's capture box, nor a hook's box as a coding value", async () => {
		const key = recipient();
		const hookIdentity = {
			...identity,
			hookId: "79900000-0000-4000-8000-000000000040",
			field: "signing_secret" as const,
		};
		const value = sealCodingValueCapture(capture, npm, key.publicKey, identity, now);
		const asHook = (box: unknown) =>
			openEventHookCapture(key.privateKey, key.publicKey, box, hookIdentity, async () => "opened", now);
		await expect(asHook(value)).rejects.toThrow("Hook capture box is malformed");
		await expect(asHook({ ...value, schema: "qorpera.event-hook-capture-box/v1" })).rejects.toThrow(
			"Hook capture box does not open here",
		);
		const hook = sealEventHookCapture(
			{ value: "whsec_Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56", site: "dashboard.stripe.com" },
			key.publicKey,
			hookIdentity,
			now,
		);
		await expect(opened(key, hook)).rejects.toThrow("Coding value capture box is malformed");
		await expect(opened(key, { ...hook, schema: "qorpera.coding-value-capture-box/v1" })).rejects.toThrow(
			"Coding value capture box does not open here",
		);
	});
});

describe("a service's pattern", () => {
	it("reads each seeded pattern as PostgreSQL does, the whole value only", () => {
		const github = codingValuePattern(SEEDED.github);
		const stripe = codingValuePattern(SEEDED.stripe);
		const resend = codingValuePattern(SEEDED.resend);
		expect(codingValueMatches(token, npm)).toBe(true);
		expect(codingValueMatches(`ghp_${"a1".repeat(18)}`, github)).toBe(true);
		expect(codingValueMatches(`github_pat_${"A_1".repeat(27)}x`, github)).toBe(true);
		expect(codingValueMatches(`sk_live_${"Ab1".repeat(10)}`, stripe)).toBe(true);
		expect(codingValueMatches(`rk_test_${"Ab1".repeat(8)}`, stripe)).toBe(true);
		expect(codingValueMatches("re_c1tpEyD8_NKFusih9vKVQknRAQfmFcWCv", resend)).toBe(true);
		for (const [value, pattern] of [
			[`x${token}`, npm],
			[`${token}0`, npm],
			[`ghp_${"a1".repeat(18)}0`, github],
			[`pk_live_${"Ab1".repeat(10)}`, stripe],
			[`sk_live_${"Ab1".repeat(7)}`, stripe],
			[`sk_live_${"Ab1".repeat(10)}-`, stripe],
			["re_short", resend],
		] as const)
			expect(codingValueMatches(value, pattern), value).toBe(false);
	});

	it("refuses a pattern whose meaning differs between the two dialects, or that is no pattern", () => {
		for (const source of [
			"npm_[A-Za-z0-9]{36}",
			"^npm_[A-Za-z0-9]{36}",
			"^npm_\\w{36}$",
			"^npm_.{36}$",
			"^npm_[[:alnum:]]{36}$",
			"^npm_[^ ]{36}$",
			"^(?:npm)_[a-z]{36}$",
			"^npm_[z-a]{36}$",
			"^npm_[a-z]{,36}$",
			"^+$",
			`^${"a".repeat(512)}$`,
			42,
		])
			expect(() => codingValuePattern(source), String(source)).toThrow("Coding value pattern is malformed");
		// Alternation at the top level holds the whole value to one branch, never a branch's end alone.
		const either = codingValuePattern("^abcdefgh|ijklmnop$");
		expect(codingValueMatches("abcdefgh", either)).toBe(true);
		expect(codingValueMatches("abcdefghXYZ", either)).toBe(false);
	});

	it("finds a value where it starts a word, never inside one", () => {
		const finder = codingValueFinder(SEEDED.stripe);
		const key = `sk_live_${"Ab1".repeat(10)}`;
		expect([...`Secret key ${key} Copy`.matchAll(finder)].map((match) => match[0])).toEqual([key]);
		expect([...`NAME=${key}`.matchAll(finder)].map((match) => match[0])).toEqual([key]);
		expect([...`desk_live_${"Ab1".repeat(10)}`.matchAll(finder)]).toEqual([]);
	});
});
