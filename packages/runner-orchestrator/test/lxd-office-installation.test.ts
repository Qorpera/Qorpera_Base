import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	assertOfficeInstallationUpgrade,
	OFFICE_CONFIG_ROOT,
	OFFICE_INSTALL_ARTIFACTS,
	type OfficeInstallDocument,
	officeInstallHash,
	officeSystemdPath,
	parseOfficeInstallationManifest,
	parseOfficeInstallationReceipt,
	parseOfficeInstallationSpec,
	validateOfficeInstallationDocuments,
} from "../src/lxd-office-installation.ts";
import { lxdOfficePhysicalPolicySha256 } from "../src/lxd-office-physical-policy.ts";
import { officePhysicalFixture } from "./fixtures/office-physical-policy.ts";

const template = readFileSync(
	new URL("../../../deploy/first-node/qorpera-office-provider.service.in", import.meta.url),
	"utf8",
);
const certificate = readFileSync(
	new URL("../../../deploy/cloud-secret-broker/supabase-prod-ca-2021.crt", import.meta.url),
);
function fixture() {
	const { policy, envelope } = officePhysicalFixture();
	const key = Buffer.from("synthetic-infrastructure-token-".repeat(3));
	const service = {
		schema: "qorpera.lxd-office-provider-service/v1",
		policyPath: `${OFFICE_CONFIG_ROOT}/policy.json`,
		provenancePath: `${OFFICE_CONFIG_ROOT}/provenance.json`,
		planPath: `${OFFICE_CONFIG_ROOT}/review.json`,
		registryUrl: "https://registry.example.test",
		registryCredential: {
			path: `${OFFICE_CONFIG_ROOT}/registry.credential`,
			bytes: key.length,
			sha256: officeInstallHash(key),
		},
		inventoryLimits: {
			maxEntries: 100,
			maxDepth: 4,
			maxFileBytes: 1024,
			maxTotalBytes: 4096,
			maxManifestBytes: 65536,
		},
		pollIntervalMs: 1000,
	};
	const documents: Record<OfficeInstallDocument, Buffer> = {
		service: Buffer.from(JSON.stringify(service)),
		policy: Buffer.from(JSON.stringify(policy)),
		provenance: Buffer.from(JSON.stringify(envelope)),
		registry: key,
		registryCa: certificate,
	};
	const raw = {
		schema: "qorpera.lxd-office-provider-installation/v1",
		packageRoot: "/srv/install/package",
		packageManifestSha256: "a".repeat(64),
		providerPolicySha256: lxdOfficePhysicalPolicySha256(policy),
		documents: Object.fromEntries(
			Object.entries(documents).map(([name, bytes]) => [
				name,
				{ path: `/srv/install/${name}`, bytes: bytes.length, sha256: officeInstallHash(bytes) },
			]),
		),
	};
	return { raw, documents, service, policy };
}

describe("office provider installation boundary", () => {
	it("binds the full enrolled configuration and renders the process-owned existing journal lock", () => {
		const f = fixture();
		const result = validateOfficeInstallationDocuments(parseOfficeInstallationSpec(f.raw), f.documents, template);
		expect(result.uid).toBe(f.policy.workbench.uid);
		expect(result.gid).toBe(f.policy.workbench.gid);
		expect(result.unit).toContain(`qorpera-office-provider "${f.policy.journal.path}/adoption.lock"`);
		expect(result.unit).toContain('exec 3<"$$1"');
		expect(result.unit).not.toContain("@JOURNAL_LOCK@");
		expect(result.unit).toContain(
			`RequiresMountsFor="${f.policy.journal.mountPoint}" "${f.policy.workbench.mountPoint}"`,
		);
		expect(result.unit).not.toContain("@JOURNAL_MOUNT@");
		expect(result.unit).not.toContain("@WORKBENCH_MOUNT@");
	});
	it("refuses templates that omit or duplicate a required mount dependency binding", () => {
		const f = fixture();
		for (const marker of ["@JOURNAL_MOUNT@", "@WORKBENCH_MOUNT@"]) {
			for (const replacement of ["/wrong/mount", `${marker} ${marker}`]) {
				expect(() =>
					validateOfficeInstallationDocuments(
						parseOfficeInstallationSpec(f.raw),
						f.documents,
						template.replace(marker, replacement),
					),
				).toThrow("OFFICE_INSTALL_UNIT_INVALID");
			}
		}
	});
	it("refuses changed bytes and cross-policy or destination substitutions even when hashes are repinned", () => {
		const f = fixture(),
			spec = parseOfficeInstallationSpec(f.raw);
		expect(() =>
			validateOfficeInstallationDocuments(spec, { ...f.documents, registry: Buffer.from("other") }, template),
		).toThrow();
		expect(() =>
			validateOfficeInstallationDocuments({ ...spec, providerPolicySha256: "b".repeat(64) }, f.documents, template),
		).toThrow("POLICY_MISMATCH");
		const replaced = Buffer.from(JSON.stringify({ ...f.service, planPath: "/tmp/unprotected-review" }));
		expect(() =>
			validateOfficeInstallationDocuments(
				{
					...spec,
					documents: {
						...spec.documents,
						service: { ...spec.documents.service, bytes: replaced.length, sha256: officeInstallHash(replaced) },
					},
				},
				{ ...f.documents, service: replaced },
				template,
			),
		).toThrow("CONFIG_MISMATCH");
	});
	it("requires an exact closed artifact list and rejects traversal or partial packages", () => {
		const manifest = {
			schema: "qorpera.lxd-office-provider-package/v1",
			runtime: { node: ">=22.19.0", platform: "linux" },
			artifacts: OFFICE_INSTALL_ARTIFACTS.map((file) => ({ file, bytes: 1, sha256: "a".repeat(64) })),
		};
		expect(parseOfficeInstallationManifest(manifest)).toHaveLength(OFFICE_INSTALL_ARTIFACTS.length);
		expect(() => parseOfficeInstallationManifest({ ...manifest, artifacts: manifest.artifacts.slice(1) })).toThrow();
		expect(() =>
			parseOfficeInstallationManifest({
				...manifest,
				artifacts: manifest.artifacts.map((a, i) => (i ? a : { ...a, file: "../outside" })),
			}),
		).toThrow();
		const f = fixture();
		expect(() => parseOfficeInstallationSpec({ ...f.raw, startService: true })).toThrow();
		expect(() =>
			parseOfficeInstallationSpec({ ...f.raw, documents: { ...f.raw.documents, policy: f.raw.documents.service } }),
		).toThrow();
	});
	it("quotes literal specifiers, environment expressions and quotes without admitting controls", () => {
		expect(officeSystemdPath(`/srv/%n-\${HOME}-"journal"/adoption.lock`)).toBe(
			'"/srv/%%n-$${HOME}-\\"journal\\"/adoption.lock"',
		);
		expect(() => officeSystemdPath("/srv/journal\nExecStart=/bad")).toThrow();
		expect(officeSystemdPath(`/srv/%n-\${HOME}-"journal"/mounted-data`, "dependency")).toBe(
			`"/srv/%%n-\${HOME}-\\"journal\\"/mounted-data"`,
		);
	});
});

describe("office provider upgrade over a retained journal", () => {
	const receipt = {
		schema: "qorpera.lxd-office-provider-installation-receipt/v1",
		packageManifestSha256: "1".repeat(64),
		providerPolicySha256: "2".repeat(64),
		uid: 20041,
		gid: 20041,
		files: [
			{
				path: "/opt/qorpera/office-provider/qorpera-office-provider.cjs",
				bytes: 10,
				sha256: "3".repeat(64),
				mode: 292,
				gid: 0,
			},
			{ path: "/etc/qorpera/office-provider/service.json", bytes: 5, sha256: "4".repeat(64), mode: 292, gid: 0 },
			{
				path: "/etc/systemd/system/qorpera-office-provider.service",
				bytes: 7,
				sha256: "5".repeat(64),
				mode: 420,
				gid: 0,
			},
		],
	};
	const targets = [
		{ path: "/opt/qorpera/office-provider/qorpera-office-provider.cjs", sha256: "9".repeat(64), bytes: 11 },
		{ path: "/opt/qorpera/office-provider/qorpera-office-software-update.cjs", sha256: "8".repeat(64), bytes: 12 },
		{ path: "/etc/qorpera/office-provider/service.json", sha256: "4".repeat(64), bytes: 5 },
		{ path: "/etc/systemd/system/qorpera-office-provider.service", sha256: "5".repeat(64), bytes: 7 },
	];
	const expected = { providerPolicySha256: "2".repeat(64), uid: 20041, gid: 20041 };
	it("parses an explicit previous installation reference and a closed receipt", () => {
		const f = fixture();
		expect(parseOfficeInstallationSpec(f.raw).previousInstallation).toBeUndefined();
		const upgrade = parseOfficeInstallationSpec({
			...f.raw,
			previousInstallation: { path: "/root/previous/installation.json", bytes: 1990, sha256: "6".repeat(64) },
		});
		expect(upgrade.previousInstallation).toEqual({
			path: "/root/previous/installation.json",
			bytes: 1990,
			sha256: "6".repeat(64),
		});
		expect(() =>
			parseOfficeInstallationSpec({
				...f.raw,
				previousInstallation: { path: "relative", bytes: 1, sha256: "6".repeat(64) },
			}),
		).toThrow();
		expect(parseOfficeInstallationReceipt(receipt).files).toHaveLength(3);
		expect(() => parseOfficeInstallationReceipt({ ...receipt, schema: "other" })).toThrow();
		expect(() => parseOfficeInstallationReceipt({ ...receipt, files: [] })).toThrow();
		expect(() =>
			parseOfficeInstallationReceipt({ ...receipt, files: [receipt.files[0], receipt.files[0]] }),
		).toThrow();
	});
	it("admits an upgrade only with identical documents and the previous package moved aside", async () => {
		const parsed = parseOfficeInstallationReceipt(receipt);
		await expect(
			assertOfficeInstallationUpgrade(parsed, expected, targets, async () => false),
		).resolves.toBeUndefined();
		await expect(
			assertOfficeInstallationUpgrade(parsed, { ...expected, uid: 1 }, targets, async () => false),
		).rejects.toThrow("OFFICE_INSTALL_PREVIOUS_RECEIPT_MISMATCH");
		await expect(
			assertOfficeInstallationUpgrade(
				parsed,
				{ ...expected, providerPolicySha256: "7".repeat(64) },
				targets,
				async () => false,
			),
		).rejects.toThrow("OFFICE_INSTALL_PREVIOUS_RECEIPT_MISMATCH");
		await expect(
			assertOfficeInstallationUpgrade(parsed, expected, targets, async (path) =>
				path.endsWith("qorpera-office-provider.cjs"),
			),
		).rejects.toThrow("OFFICE_INSTALL_PREVIOUS_PACKAGE_PRESENT");
		const changedDocument = targets.map((t) =>
			t.path.endsWith("service.json") ? { ...t, sha256: "a".repeat(64) } : t,
		);
		await expect(
			assertOfficeInstallationUpgrade(parsed, expected, changedDocument, async () => false),
		).rejects.toThrow("OFFICE_INSTALL_PREVIOUS_DOCUMENTS_CHANGED");
		// A document revised after the receipt is admitted only when the new target
		// already exists on disk with exactly the new bytes.
		await expect(
			assertOfficeInstallationUpgrade(
				parsed,
				expected,
				changedDocument,
				async () => false,
				async (path) => path.endsWith("service.json"),
			),
		).resolves.toBeUndefined();
		await expect(
			assertOfficeInstallationUpgrade(
				parsed,
				expected,
				changedDocument,
				async () => false,
				async (path) => path.endsWith(".service"),
			),
		).rejects.toThrow("OFFICE_INSTALL_PREVIOUS_DOCUMENTS_CHANGED");
		const changedUnit = targets.map((t) => (t.path.endsWith(".service") ? { ...t, bytes: 8 } : t));
		await expect(assertOfficeInstallationUpgrade(parsed, expected, changedUnit, async () => false)).rejects.toThrow(
			"OFFICE_INSTALL_PREVIOUS_DOCUMENTS_CHANGED",
		);
		const missingTarget = targets.filter((t) => !t.path.endsWith("service.json"));
		await expect(assertOfficeInstallationUpgrade(parsed, expected, missingTarget, async () => false)).rejects.toThrow(
			"OFFICE_INSTALL_PREVIOUS_DOCUMENTS_CHANGED",
		);
	});
});
