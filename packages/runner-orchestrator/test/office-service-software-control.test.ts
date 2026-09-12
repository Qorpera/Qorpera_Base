import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	installOfficeSoftwareWithinChallenge,
	parseOfficeSoftwareControlArgs,
} from "../../../deploy/lxd-company-computer-guest/office-service-software-control.ts";
import { OFFICE_IMAGE_PACKAGE_FILES } from "../src/lxd-office-image-installation.ts";
import { officeCanonical, officeDigest } from "../src/lxd-office-image-provenance.ts";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function fixture() {
	const keys = generateKeyPairSync("ed25519"),
		serviceBytes = Buffer.from("new fixture");
	const manifest = (content: Buffer) =>
		Buffer.from(
			JSON.stringify({
				schema: "qorpera.company-computer-package/v1",
				platform: "linux",
				minimumNode: "22.19.0",
				playwright: "1.62.1",
				imagePrerequisites: [
					"cgroup-v2",
					"systemd-credentials",
					"unprivileged-user-namespaces",
					"bubblewrap",
					"tini",
					"xfce",
					"tigervnc",
					"chromium",
				],
				artifacts: [
					...OFFICE_IMAGE_PACKAGE_FILES,
					"node_modules/playwright-core/package.json",
					"node_modules/playwright-core/index.mjs",
					"node_modules/playwright-core/browsers.json",
					"wallpapers/qorpera-screen-pebble.png",
				].map((file, index) => ({
					file,
					bytes: index === 0 ? content.length : 1,
					sha256: sha(index === 0 ? content : file),
				})),
			}),
		);
	const previous = Buffer.from("old fixture"),
		manifests = { previous: manifest(previous), next: manifest(serviceBytes) };
	const artifact = (bytes: Buffer) => ({
		path: "/opt/qorpera-office/qorpera-company-computer-service.mjs",
		bytes: bytes.length,
		sha256: sha(bytes),
	});
	const statement = {
		schema: "qorpera.office-service-software-statement/v1",
		base: {
			imageSha256: sha("image"),
			bootstrapSha256: sha("bootstrap"),
			packageManifestSha256: sha(manifests.previous),
			sourceCommit: "1".repeat(40),
		},
		previous: {
			packageManifestSha256: sha(manifests.previous),
			sourceCommit: "1".repeat(40),
			service: artifact(previous),
		},
		next: { packageManifestSha256: sha(manifests.next), service: artifact(serviceBytes) },
		source: { repository: "https://example.test/source", commit: "2".repeat(40), tree: "clean" },
		acceptance: { testedAt: "2026-01-01T00:00:00.000Z", evidenceSha256: sha("fixture"), change: "service-only" },
	};
	const plan = {
		schema: "qorpera.office-service-software-plan/v1",
		updateId: randomUUID(),
		successorActivationId: randomUUID(),
		stopAcknowledgementSha256: sha("stop"),
		statementSha256: officeDigest(statement),
		predecessor: {
			schema: "qorpera.office-lifecycle-request/v1",
			action: "service_restart",
			transitionId: randomUUID(),
			activationId: randomUUID(),
			providerId: randomUUID(),
			providerPolicySha256: sha("policy"),
			startup: {
				scope: {
					companyId: randomUUID(),
					environmentId: randomUUID(),
					companyComputerId: randomUUID(),
					logicalComputerId: randomUUID(),
				},
				computerGeneration: 1,
				allocationId: randomUUID(),
				instanceSha256: sha("instance"),
				imageSha256: statement.base.imageSha256,
				bootstrapSha256: statement.base.bootstrapSha256,
				bootId: randomUUID(),
				configurationSha256: sha("config"),
				serviceInvocationId: "1".repeat(32),
			},
		},
	};
	const envelope = {
		schema: "qorpera.office-service-software-envelope/v1",
		statement,
		signature: {
			algorithm: "ed25519",
			value: sign(null, Buffer.from(officeCanonical(statement)), keys.privateKey).toString("base64"),
		},
	};
	const trust = {
		verificationKeySpki: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
		statementSha256: officeDigest(statement),
		planSha256: officeDigest(plan),
	};
	const expected = { challengeId: randomUUID(), targetRevision: 1, capabilityRevision: 1 };
	const challenge = {
		schema: "qorpera.office-software-install-challenge/v1",
		...expected,
		plan,
		planSha256: trust.planSha256,
		statement,
		validForMs: 5000,
	};
	return { options: { envelope, plan, trust, manifests, serviceBytes }, expected, challenge };
}
describe("temporary root software control assembly", () => {
	it("accepts only a closed command and independent tool/trust digests", () => {
		const args = [randomUUID(), sha("request"), randomUUID(), sha("tool"), sha("trust")];
		expect(parseOfficeSoftwareControlArgs(args).locked).toBe(false);
		expect(parseOfficeSoftwareControlArgs(["--locked", ...args]).locked).toBe(true);
		for (const change of [args.slice(1), [...args, "extra"], [...args.slice(0, 3), "/arbitrary/tool", args[4]]])
			expect(() => parseOfficeSoftwareControlArgs(change)).toThrow();
	});
	it("rechecks local custody around current authority and gives the installer one bounded signal", async () => {
		const f = fixture(),
			trace: string[] = [];
		await installOfficeSoftwareWithinChallenge(
			f.options,
			f.expected,
			{
				verifyLocal: async () => {
					trace.push("local");
				},
				check: async () => {
					trace.push("check");
					return f.challenge;
				},
				install: async (options, signal) => {
					trace.push("install");
					expect(signal.aborted).toBe(false);
					await options.authorize(signal);
					throw new Error("fixture completed");
				},
			},
			new AbortController().signal,
		).catch((error) => expect(error.message).toBe("fixture completed"));
		expect(trace).toEqual(["local", "check", "local", "install", "local", "check", "local"]);
	});
	it.each([
		"challengeId",
		"planSha256",
		"plan",
		"statement",
		"targetRevision",
		"capabilityRevision",
		"validForMs",
		"schema",
		"extra",
	])("refuses changed %s before installation", async (key) => {
		const f = fixture(),
			install = vi.fn();
		const changed = { ...f.challenge, [key]: key.endsWith("Revision") ? 2 : key === "validForMs" ? 5001 : "changed" };
		await expect(
			installOfficeSoftwareWithinChallenge(
				f.options,
				f.expected,
				{ verifyLocal: async () => {}, check: async () => changed, install },
				new AbortController().signal,
			),
		).rejects.toThrow();
		expect(install).not.toHaveBeenCalled();
	});
	it("withholds installation when local full-service stop/custody verification fails", async () => {
		const f = fixture(),
			install = vi.fn(),
			check = vi.fn();
		await expect(
			installOfficeSoftwareWithinChallenge(
				f.options,
				f.expected,
				{
					verifyLocal: async () => {
						throw new Error("populated cgroup");
					},
					check,
					install,
				},
				new AbortController().signal,
			),
		).rejects.toThrow();
		expect(check).not.toHaveBeenCalled();
		expect(install).not.toHaveBeenCalled();
	});
	it("does not reset the original challenge clock on successful refresh", async () => {
		const f = fixture();
		let clock = 0;
		const spy = vi.spyOn(performance, "now").mockImplementation(() => clock);
		try {
			await expect(
				installOfficeSoftwareWithinChallenge(
					f.options,
					f.expected,
					{
						verifyLocal: async () => {},
						check: async () => f.challenge,
						install: async (options, signal) => {
							clock = 4900;
							await options.authorize(signal);
							clock = 5000;
							await options.authorize(signal);
							throw new Error("should not arrive");
						},
					},
					new AbortController().signal,
				),
			).rejects.toThrow("OFFICE_SOFTWARE_CONTROL_EXPIRED");
		} finally {
			spy.mockRestore();
		}
	});
	it("counts time spent on the initial challenge RPC", async () => {
		const f = fixture();
		let clock = 0;
		const spy = vi.spyOn(performance, "now").mockImplementation(() => clock),
			install = vi.fn();
		try {
			await expect(
				installOfficeSoftwareWithinChallenge(
					f.options,
					f.expected,
					{
						verifyLocal: async () => {},
						check: async () => {
							clock = 5000;
							return f.challenge;
						},
						install,
					},
					new AbortController().signal,
				),
			).rejects.toThrow("OFFICE_SOFTWARE_CONTROL_EXPIRED");
			expect(install).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});
});
