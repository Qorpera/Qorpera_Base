import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import {
	COMPANY_COMPUTER_SERVICE_SOFTWARE_FILES,
	COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH,
	type CompanyComputerServiceSoftwareFile,
} from "@qorpera/contracts";
import { OFFICE_IMAGE_PACKAGE_FILES } from "../../src/lxd-office-image-installation.ts";
import { officeCanonical, officeDigest } from "../../src/lxd-office-image-provenance.ts";

const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
/** Guest code entries a guest-code fixture revises next to the service: one
 * control bundle under /opt/qorpera-office and one desktop script under
 * /usr/local/bin, so both destination roots and modes are exercised. */
export const OFFICE_SOFTWARE_GUEST_CODE_FIXTURE_FILES = [
	"qorpera-company-computer-configuration-control.mjs",
	"qorpera-screen-session",
] as const;
type PackageManifest = { artifacts: Array<{ file: string; bytes: number; sha256: string }> };
/** Replace the fixture guest code entries in `next` with fresh bytes and
 * return the statement file lists plus the bytes an installer must stage. */
export function officeGuestCodeFixtureFiles(previous: PackageManifest, next: PackageManifest) {
	const previousFiles: CompanyComputerServiceSoftwareFile[] = [],
		nextFiles: CompanyComputerServiceSoftwareFile[] = [],
		bytes: Record<string, Buffer> = {};
	for (const [index, file] of OFFICE_SOFTWARE_GUEST_CODE_FIXTURE_FILES.entries()) {
		const known = COMPANY_COMPUTER_SERVICE_SOFTWARE_FILES[file];
		const before = previous.artifacts.find((artifact) => artifact.file === file);
		const at = next.artifacts.findIndex((artifact) => artifact.file === file);
		if (!known || !before || at < 0) throw new Error("fixture manifest lacks a guest code entry");
		const content = Buffer.alloc(40 + index, 0x30 + index);
		bytes[file] = content;
		next.artifacts[at] = { ...next.artifacts[at], bytes: content.length, sha256: hash(content) };
		previousFiles.push({ file, path: known.path, bytes: before.bytes, sha256: before.sha256, mode: known.mode });
		nextFiles.push({ file, path: known.path, bytes: content.length, sha256: hash(content), mode: known.mode });
	}
	return { previousFiles, nextFiles, bytes };
}
export function officeSoftwareFixture(options: { guestCode?: boolean } = {}) {
	const keys = generateKeyPairSync("ed25519");
	const previous = {
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
		].map((file) => ({ file, bytes: 123, sha256: hash(file) })),
	};
	const next = structuredClone(previous);
	next.artifacts[0] = { ...next.artifacts[0], bytes: 234, sha256: hash("new service") };
	const guest = options.guestCode ? officeGuestCodeFixtureFiles(previous, next) : undefined;
	const manifests = { previous: Buffer.from(JSON.stringify(previous)), next: Buffer.from(JSON.stringify(next)) };
	const statement = {
		schema: "qorpera.office-service-software-statement/v1",
		base: {
			sourceCommit: "1".repeat(40),
			imageSha256: hash("original image"),
			bootstrapSha256: hash("bootstrap"),
			packageManifestSha256: hash(manifests.previous),
		},
		previous: {
			sourceCommit: "1".repeat(40),
			packageManifestSha256: hash(manifests.previous),
			service: {
				path: COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH,
				bytes: previous.artifacts[0].bytes,
				sha256: previous.artifacts[0].sha256,
			},
			...(guest ? { files: guest.previousFiles } : {}),
		},
		next: {
			packageManifestSha256: hash(manifests.next),
			service: {
				path: COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH,
				bytes: next.artifacts[0].bytes,
				sha256: next.artifacts[0].sha256,
			},
			...(guest ? { files: guest.nextFiles } : {}),
		},
		source: { repository: "https://example.test/source", commit: "a".repeat(40), tree: "clean" },
		acceptance: {
			testedAt: "2026-09-12T00:00:00.000Z",
			evidenceSha256: hash("reviewed evidence"),
			change: guest ? "guest-code" : "service-only",
		},
	};
	const plan = {
		schema: "qorpera.office-service-software-plan/v1",
		updateId: randomUUID(),
		successorActivationId: randomUUID(),
		stopAcknowledgementSha256: hash("stop"),
		statementSha256: officeDigest(statement),
		predecessor: {
			schema: "qorpera.office-lifecycle-request/v1",
			action: "service_restart",
			transitionId: randomUUID(),
			activationId: randomUUID(),
			providerId: randomUUID(),
			providerPolicySha256: hash("policy"),
			startup: {
				scope: {
					companyId: randomUUID(),
					environmentId: randomUUID(),
					companyComputerId: randomUUID(),
					logicalComputerId: randomUUID(),
				},
				computerGeneration: 1,
				allocationId: randomUUID(),
				instanceSha256: hash("instance"),
				imageSha256: statement.base.imageSha256,
				bootstrapSha256: statement.base.bootstrapSha256,
				bootId: randomUUID(),
				configurationSha256: hash("config"),
				serviceInvocationId: "b".repeat(32),
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
	const receipt = {
		schema: "qorpera.office-service-software-receipt/v1",
		plan,
		planSha256: trust.planSha256,
		state: "installed",
		service: { ...statement.next.service },
		...(guest ? { files: structuredClone(guest.nextFiles) } : {}),
		installedAt: "2026-09-12T01:00:00.000Z",
	};
	return {
		keys,
		previous,
		next,
		manifests,
		statement,
		envelope,
		plan,
		trust,
		receipt,
		guestBytes: guest?.bytes ?? {},
	};
}
