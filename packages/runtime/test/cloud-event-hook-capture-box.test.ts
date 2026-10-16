import { generateKeyPairSync } from "node:crypto";
import { CompanyComputerFillKey, sealCompanyAccountFill } from "@qorpera/runtime/cloud-company-account-fill-box";
import {
	EVENT_HOOK_CAPTURE_LIFETIME_MS,
	type EventHookCapture,
	type EventHookCaptureIdentity,
	openEventHookCapture,
	sealEventHookCapture,
} from "@qorpera/runtime/cloud-event-hook-capture-box";
import { describe, expect, it } from "vitest";

const identity: EventHookCaptureIdentity = {
	companyId: "79900000-0000-4000-8000-000000000010",
	companyComputerId: "79900000-0000-4000-8000-000000000020",
	computerGeneration: 3,
	receiptId: "79900000-0000-4000-8000-000000000030",
	hookId: "79900000-0000-4000-8000-000000000040",
	field: "signing_secret",
};
const capture = { value: "whsec_Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56", site: "dashboard.stripe.com" };
const now = 1_790_000_000_000;

function recipient() {
	const pair = generateKeyPairSync("x25519");
	const raw = pair.publicKey.export({ format: "der", type: "spki" }).subarray(12);
	return { privateKey: pair.privateKey, publicKey: Buffer.from(raw).toString("base64url") };
}

async function opened(key: ReturnType<typeof recipient>, box: unknown, expected = identity, at = now + 1000) {
	return openEventHookCapture(
		key.privateKey,
		key.publicKey,
		box,
		expected,
		async (got) => ({ ...got, value: got.value.toString("utf8") }),
		at,
	);
}

describe("event hook capture box", () => {
	it("opens only with the key it was sealed to, for exactly that call, and zeroes the value after", async () => {
		const key = recipient();
		const box = sealEventHookCapture(capture, key.publicKey, identity, now);
		expect(JSON.stringify(box)).not.toContain("whsec_");
		expect(JSON.stringify(box)).not.toContain("stripe");
		await expect(opened(key, box)).resolves.toEqual({
			field: "signing_secret",
			value: capture.value,
			site: capture.site,
			capturedAtMs: now,
		});
		let seen: EventHookCapture | undefined;
		await openEventHookCapture(
			key.privateKey,
			key.publicKey,
			box,
			identity,
			async (got) => {
				seen = got;
			},
			now,
		);
		expect(seen?.value.every((byte) => byte === 0)).toBe(true);
		// Zeroed when the callback throws, too.
		await expect(
			openEventHookCapture(
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
		await expect(opened(recipient(), box)).rejects.toThrow("Hook capture box does not open here");
		for (const [name, other] of Object.entries({
			companyId: "79900000-0000-4000-8000-000000000011",
			companyComputerId: "79900000-0000-4000-8000-000000000021",
			computerGeneration: 4,
			receiptId: "79900000-0000-4000-8000-000000000031",
			hookId: "79900000-0000-4000-8000-000000000041",
		}))
			await expect(opened(key, box, { ...identity, [name]: other }), name).rejects.toThrow(
				"Hook capture box does not open here",
			);
	});

	it("is stored within its lifetime or never, and allows a minute of clock drift", async () => {
		const key = recipient();
		const box = sealEventHookCapture(capture, key.publicKey, identity, now);
		await expect(opened(key, box, identity, now + EVENT_HOOK_CAPTURE_LIFETIME_MS)).resolves.toMatchObject({
			capturedAtMs: now,
		});
		await expect(opened(key, box, identity, now + EVENT_HOOK_CAPTURE_LIFETIME_MS + 1)).rejects.toThrow(
			"Hook capture expired",
		);
		await expect(opened(key, box, identity, now - 60_000)).resolves.toMatchObject({ capturedAtMs: now });
		await expect(opened(key, box, identity, now - 60_001)).rejects.toThrow("Hook capture expired");
	});

	it("seals only a Stripe signing secret read on a host", () => {
		const key = recipient();
		for (const value of ["sk_live_Ab12Cd34Ef56Gh78Ij90", "whsec_short", "whsec_Ab12Cd34Ef56Gh78\nIj90", ""])
			expect(() => sealEventHookCapture({ ...capture, value }, key.publicKey, identity, now), value).toThrow(
				"Hook capture value is malformed",
			);
		for (const site of ["https://dashboard.stripe.com", "localhost", "Dashboard.Stripe.com"])
			expect(() => sealEventHookCapture({ ...capture, site }, key.publicKey, identity, now), site).toThrow(
				"Hook capture site is malformed",
			);
		expect(() =>
			sealEventHookCapture(capture, key.publicKey, { ...identity, field: "password" as "signing_secret" }, now),
		).toThrow("Hook capture identity is malformed");
		expect(() => sealEventHookCapture(capture, "not-a-key", identity, now)).toThrow("Hook capture key is malformed");
	});

	it("never opens as a company account fill box, nor a fill box as a capture", async () => {
		const fillKey = new CompanyComputerFillKey();
		const fillIdentity = { ...identity };
		const sealed = sealEventHookCapture(capture, fillKey.publicKey, identity, now);
		expect(() => fillKey.open(sealed, fillIdentity, now)).toThrow("Company account fill box is malformed");
		// Relabelled, it still fails: the schemas and the key derivation's info differ.
		expect(() =>
			fillKey.open({ ...sealed, schema: "qorpera.company-account-fill-box/v1" }, fillIdentity, now),
		).toThrow("Company account fill box does not open here");

		const key = recipient();
		const fill = sealCompanyAccountFill(
			{ value: capture.value, hosts: [capture.site] },
			key.publicKey,
			fillIdentity,
			now,
		);
		await expect(opened(key, fill)).rejects.toThrow("Hook capture box is malformed");
		await expect(opened(key, { ...fill, schema: "qorpera.event-hook-capture-box/v1" })).rejects.toThrow(
			"Hook capture box does not open here",
		);
	});

	it("refuses a box with extra, missing or re-encoded parts", async () => {
		const key = recipient();
		const box = sealEventHookCapture(capture, key.publicKey, identity, now);
		const { tag: _tag, ...missing } = box;
		for (const bad of [null, [], "box", missing, { ...box, extra: "x" }, { ...box, iv: `${box.iv}=` }])
			await expect(opened(key, bad)).rejects.toThrow("Hook capture box is malformed");
	});
});
