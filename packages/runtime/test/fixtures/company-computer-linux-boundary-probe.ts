import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, chown, mkdir, open, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { CompanyComputerLinuxBoundary } from "../../src/cloud-company-computer-linux-boundary.ts";
import {
	assertCompanyComputerImageArtifact,
	openCompanyComputerLinuxDirectory,
} from "../../src/cloud-company-computer-linux-host.ts";
import { parseRecoveryDirectoryMount } from "../../src/cloud-identity-recovery-filesystems.ts";
import { computerBinding, computerId, computerScope } from "./company-computer.ts";

const directory = "/run/office-attestation";
const signal = AbortSignal.timeout(30000);
const adopted = `/srv/.qorpera-adopted-${computerId(72)}`;
const layout = {
	workbenchRoot: `${adopted}/workbench`,
	desktopHome: `${adopted}/desktop`,
	screenStateRoot: `${adopted}/screens`,
	browserProfilesRoot: `${adopted}/profiles`,
};
async function mount(path: string) {
	const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
	try {
		return parseRecoveryDirectoryMount(
			await readFile("/proc/self/mountinfo", "utf8"),
			await readFile(`/proc/self/fdinfo/${fd.fd}`, "utf8"),
		);
	} finally {
		await fd.close();
	}
}
// Root bootstrap is a disposable attester fixture, not a provider migration.
// It records explicitly empty roots before uid 1000 can create working state.
if (process.argv.includes("--prepare")) {
	assert.equal(process.getuid?.(), 0);
	for (const path of [adopted, ...Object.values(layout)]) {
		await mkdir(path, { mode: 0o700 });
	}
	for (const path of [...Object.values(layout), adopted]) await chown(path, 1000, 1000);
	await chmod("/srv", 0o700);
	await chown("/srv", 1000, 1000);
	const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
	const workbenchMount = await mount(layout.workbenchRoot);
	const privateWorkbenchMount = await mount("/run/office-private-workbench");
	const inventory: Record<string, string[]> = {};
	for (const path of [...Object.values(layout), privateWorkbenchMount.mountPoint]) {
		inventory[path] = await readdir(path);
		assert.deepEqual(inventory[path], []);
	}
	const receipt = {
		schema: "qorpera.office-state-adoption/v1",
		state: "complete",
		scope: computerScope(),
		computerGeneration: 1,
		allocationId: computerId(70),
		instanceSha256: "a".repeat(64),
		imageSha256: "b".repeat(64),
		bootstrapSha256: "c".repeat(64),
		bootId,
		layout,
		workbenchMount,
		disposition: "verified_empty",
		inventorySha256: createHash("sha256").update(JSON.stringify(inventory)).digest("hex"),
		reviewSha256: createHash("sha256").update("synthetic approved empty fixture review").digest("hex"),
	};
	const bytes = JSON.stringify(receipt);
	const wrongMountBytes = JSON.stringify({ ...receipt, workbenchMount: { ...workbenchMount, source: "wrong-mount" } });
	await writeFile(`${directory}/wrong-mount.json`, wrongMountBytes, { flag: "wx", mode: 0o444 });
	for (const name of ["adoption.json", "unsafe.json"])
		await writeFile(`${directory}/${name}`, bytes, { flag: "wx", mode: 0o444 });
	await chown(`${directory}/unsafe.json`, 1000, 1000);
	await symlink(`${directory}/adoption.json`, `${directory}/alias.json`);
	await writeFile(
		`${directory}/config.json`,
		JSON.stringify({
			wrongMountReceiptSha256: createHash("sha256").update(wrongMountBytes).digest("hex"),
			scope: computerScope(),
			computerGeneration: 1,
			layout,
			workbenchMount,
			privateWorkbenchMount,
			limits: { memoryBytes: 2147483648, pids: 512, cpuQuota: 200000, cpuPeriod: 100000 },
			displayRuntimeRoot: "/run/office-screens",
			browserRuntimeRoot: "/run/office-browser",
			captureRoot: "/run/office-captures",
			attestation: {
				allocationId: receipt.allocationId,
				instanceSha256: receipt.instanceSha256,
				imageSha256: receipt.imageSha256,
				bootstrapSha256: receipt.bootstrapSha256,
				bootId,
				adoptionReceiptPath: `${directory}/adoption.json`,
				adoptionReceiptSha256: createHash("sha256").update(bytes).digest("hex"),
			},
		}),
		{ flag: "wx", mode: 0o444 },
	);
} else {
	assert.equal(process.getuid?.(), 1000);
	const config = JSON.parse(await readFile(`${directory}/config.json`, "utf8")) as Omit<
		ConstructorParameters<typeof CompanyComputerLinuxBoundary>[0],
		"registry"
	> & { wrongMountReceiptSha256: string };
	let reads = 0;
	let active = true;
	const registry = {
		async call(method: string, args: Record<string, unknown>) {
			reads++;
			assert.equal(method, "qorpera_check_runtime_office_guest_binding");
			assert.deepEqual(args, {
				p_scope: computerScope(),
				p_computer_generation: 1,
				p_allocation_id: computerId(70),
				p_instance_sha256: "a".repeat(64),
				p_image_sha256: "b".repeat(64),
				p_bootstrap_sha256: "c".repeat(64),
			});
			if (!active) throw new Error("synthetic allocation revoked");
			return { state: "authorized", computerGeneration: 1, validForMs: 5000 };
		},
	};
	const boundary = new CompanyComputerLinuxBoundary({ ...config, registry });
	await boundary.assertOfficeReady(signal);
	await writeFile(`${layout.workbenchRoot}/normal-work.txt`, "work after completed empty adoption");
	await boundary.assertReady(computerBinding(), signal);
	assert.equal(reads, 2);
	// NAS and adoption ancestors are private service-owned directories. They
	// must not become authority for executable/attestation image artifacts.
	await assert.rejects(
		assertCompanyComputerImageArtifact(`${layout.workbenchRoot}/normal-work.txt`),
		/UNSAFE_OFFICE_IMAGE_ARTIFACT/,
	);
	await chmod(adopted, 0o755);
	await assert.rejects(boundary.assertOfficeReady(signal), /OFFICE_GUEST_READINESS_UNCONFIRMED/);
	await chmod(adopted, 0o700);
	await chmod(layout.workbenchRoot, 0o770);
	await assert.rejects(openCompanyComputerLinuxDirectory(layout.workbenchRoot, false), /UNSAFE_OFFICE_DIRECTORY/);
	await chmod(layout.workbenchRoot, 0o700);
	await symlink(adopted, "/srv/alias");
	await assert.rejects(openCompanyComputerLinuxDirectory("/srv/alias/workbench", true));
	assert.equal(reads, 2);
	await assert.rejects(writeFile(config.attestation.adoptionReceiptPath, "forged"), { code: "EACCES" });
	for (const name of ["unsafe.json", "alias.json"])
		await assert.rejects(
			new CompanyComputerLinuxBoundary({
				...config,
				registry,
				attestation: { ...config.attestation, adoptionReceiptPath: `${directory}/${name}` },
			}).assertOfficeReady(signal),
			/OFFICE_GUEST_READINESS_UNCONFIRMED/,
		);
	await assert.rejects(
		new CompanyComputerLinuxBoundary({
			...config,
			registry,
			attestation: { ...config.attestation, bootId: computerId(99) },
		}).assertOfficeReady(signal),
		/OFFICE_GUEST_READINESS_UNCONFIRMED/,
	);
	await assert.rejects(
		new CompanyComputerLinuxBoundary({
			...config,
			registry,
			workbenchMount: { ...config.workbenchMount, source: "wrong-mount" },
			attestation: {
				...config.attestation,
				adoptionReceiptPath: `${directory}/wrong-mount.json`,
				adoptionReceiptSha256: config.wrongMountReceiptSha256,
			},
		}).assertOfficeReady(signal),
		/OFFICE_GUEST_READINESS_UNCONFIRMED/,
	);
	assert.equal(reads, 2);
	active = false;
	await assert.rejects(boundary.assertOfficeReady(signal), /OFFICE_GUEST_READINESS_UNCONFIRMED/);
	assert.equal(reads, 3);
	assert.equal(
		await readFile(`${layout.workbenchRoot}/normal-work.txt`, "utf8"),
		"work after completed empty adoption",
	);
	console.log(
		JSON.stringify({
			schema: "qorpera.office-linux-boundary-proof/v1",
			platform: process.platform,
			arch: process.arch,
			realKernelAndFilesystemChecks: true,
			privateServiceOwnedNasAndAdoptionParents: true,
			unsafeStateParentsRejected: true,
			stateCannotSupplyImageArtifacts: true,
			rootOwnedReceiptRequired: true,
			aliasRejected: true,
			bootChangeRejected: true,
			mountChangeRejected: true,
			currentCloudAuthorityRequired: true,
			existingWorkPreserved: true,
			syntheticProviderAndAdoptionAttestation: true,
			syntheticCloudAuthority: true,
			realProviderCalls: false,
		}),
	);
}
