import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	OFFICE_CONFIG_ROOT,
	OFFICE_INSTALL_ARTIFACTS,
	type OfficeInstallDocument,
	officeInstallHash,
	officeSystemdPath,
	parseOfficeInstallationManifest,
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
		expect(parseOfficeInstallationManifest(manifest)).toHaveLength(5);
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
	});
});
