import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { officeDigest, verifyLxdOfficeImageProvenance } from "../src/lxd-office-image-provenance.ts";
import {
	assertLxdOfficePhysicalBinding,
	assertLxdOfficePhysicalImage,
	lxdOfficePhysicalPolicySha256,
	parseLxdOfficePhysicalPolicy,
} from "../src/lxd-office-physical-policy.ts";
import { officePhysicalFixture } from "./fixtures/office-physical-policy.ts";

describe("office image provenance and enrolled physical policy", () => {
	it("refuses the prior policy schema without infrastructure pins", () => {
		const f = officePhysicalFixture();
		expect(() =>
			parseLxdOfficePhysicalPolicy({ ...f.policy, schema: "qorpera.lxd-office-physical-policy/v1" }),
		).toThrow();
		const { infrastructure: _old, ...withoutPins } = f.policy;
		expect(() => parseLxdOfficePhysicalPolicy(withoutPins)).toThrow();
	});
	it("verifies separate office evidence and binds every provider plan field", () => {
		const f = officePhysicalFixture();
		expect(
			verifyLxdOfficeImageProvenance(f.envelope, f.policy.image.verificationKeySpki, f.policy.image.statementSha256),
		).toEqual(f.statement);
		expect(() => assertLxdOfficePhysicalImage(f.policy, f.envelope)).not.toThrow();
		expect(() => assertLxdOfficePhysicalBinding(f.policy, f.binding)).not.toThrow();
		for (const key of Object.keys(f.policy.guest)) {
			const changed = { ...f.binding, [key]: "different" };
			expect(() => assertLxdOfficePhysicalBinding(f.policy, changed)).toThrow();
		}
	});
	it("canonicalizes field order, copies nested configuration and freezes the resulting policy", () => {
		const f = officePhysicalFixture();
		const before = lxdOfficePhysicalPolicySha256(f.policy);
		const parsed = parseLxdOfficePhysicalPolicy(f.policy);
		const reordered = Object.fromEntries(Object.entries(f.policy).reverse());
		expect(lxdOfficePhysicalPolicySha256(reordered as typeof f.policy)).toBe(before);
		f.policy.host.serverName = "changed";
		f.policy.guest.cpus = 4;
		expect(parsed.host.serverName).toBe("office-host");
		expect(parsed.guest.cpus).toBe(2);
		for (const value of [parsed, ...Object.values(parsed).filter((v) => typeof v === "object")])
			expect(Object.isFrozen(value)).toBe(true);
	});
	it.each(["schema", "image", "source", "acceptance"])("rejects an altered provenance %s", (key) => {
		const f = officePhysicalFixture();
		expect(() =>
			verifyLxdOfficeImageProvenance(
				{ ...f.envelope, statement: { ...f.statement, [key]: {} } },
				f.policy.image.verificationKeySpki,
				f.policy.image.statementSha256,
			),
		).toThrow("LXD_OFFICE_IMAGE_PROVENANCE_UNCONFIRMED");
	});
	it.each([
		"virtualization",
		"bootMode",
		"secureBoot",
		"credentials",
		"computeIdentity",
		"companyState",
		"services",
		"testedAt",
		"evidenceSha256",
	])("rejects unsupported or unsigned acceptance %s even with a matching new digest", (field) => {
		const f = officePhysicalFixture();
		const statement = { ...f.statement, acceptance: { ...f.statement.acceptance, [field]: "different" } };
		expect(() =>
			verifyLxdOfficeImageProvenance(
				{ ...f.envelope, statement },
				f.policy.image.verificationKeySpki,
				officeDigest(statement),
			),
		).toThrow();
	});
	it("rejects a changed trust root, private/non-Ed25519 keys, bad signature and unsigned statement substitution", () => {
		const f = officePhysicalFixture();
		const verify = (
			envelope: unknown,
			key = f.policy.image.verificationKeySpki,
			digest = f.policy.image.statementSha256,
		) => verifyLxdOfficeImageProvenance(envelope, key, digest);
		const other = generateKeyPairSync("ed25519");
		expect(() =>
			verify(f.envelope, other.publicKey.export({ format: "der", type: "spki" }).toString("base64")),
		).toThrow();
		expect(() =>
			verify(f.envelope, other.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")),
		).toThrow();
		const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
		expect(() =>
			verify(f.envelope, rsa.publicKey.export({ format: "der", type: "spki" }).toString("base64")),
		).toThrow();
		for (const value of ["", "a".repeat(88), `${f.envelope.signature.value}\n`])
			expect(() => verify({ ...f.envelope, signature: { algorithm: "ed25519", value } })).toThrow();
		const statement = { ...f.statement, image: { ...f.statement.image, fingerprint: "9".repeat(64) } };
		expect(() => verify({ ...f.envelope, statement }, undefined, officeDigest(statement))).toThrow();
		expect(() => verify({ ...f.envelope, schema: "qorpera.lxd-runner-image-provenance-envelope/v2" })).toThrow();
		expect(() => verify({ ...f.envelope, extra: true })).toThrow();
	});
	it.each(["imageFingerprint", "bootstrapSha256"] as const)("rejects signed evidence for a different %s", (field) => {
		const f = officePhysicalFixture();
		f.policy.guest[field] = "9".repeat(64);
		expect(() => assertLxdOfficePhysicalImage(f.policy, f.envelope)).toThrow("LXD_OFFICE_IMAGE_POLICY_MISMATCH");
	});
	it("rejects correctly shaped binding or policy changes that do not match enrollment", () => {
		const f = officePhysicalFixture();
		for (const changed of [
			{ ...f.binding, cpus: 4 },
			{ ...f.binding, providerPolicySha256: "f".repeat(64) },
			{ ...f.binding, companyId: f.binding.environmentId },
		])
			expect(() => assertLxdOfficePhysicalBinding(f.policy, changed)).toThrow();
		f.policy.host.certificateSha256 = "3".repeat(64);
		expect(() => assertLxdOfficePhysicalBinding(f.policy, f.binding)).toThrow();
	});
	it.each([
		(p: ReturnType<typeof officePhysicalFixture>["policy"]) => {
			p.workbench.filesystem = "ext4";
		},
		(p: ReturnType<typeof officePhysicalFixture>["policy"]) => {
			p.workbench.mountPoint = "/mnt";
		},
		(p: ReturnType<typeof officePhysicalFixture>["policy"]) => {
			p.workbench.serverAddress = "nas.test";
		},
		(p: ReturnType<typeof officePhysicalFixture>["policy"]) => {
			p.workbench.uid = 0;
		},
		(p: ReturnType<typeof officePhysicalFixture>["policy"]) => {
			p.journal.filesystem = "nfs4";
		},
		(p: ReturnType<typeof officePhysicalFixture>["policy"]) => {
			p.journal.path = "/elsewhere";
		},
		(p: ReturnType<typeof officePhysicalFixture>["policy"]) => {
			p.host.socketPath = `${p.guest.workbenchSource}/socket`;
		},
		(p: ReturnType<typeof officePhysicalFixture>["policy"]) => {
			p.host.socketPath = "/run/../socket";
		},
	])("rejects unsupported host/storage topology %s", (change) => {
		const f = officePhysicalFixture();
		change(f.policy);
		expect(() => parseLxdOfficePhysicalPolicy(f.policy)).toThrow();
	});
});
