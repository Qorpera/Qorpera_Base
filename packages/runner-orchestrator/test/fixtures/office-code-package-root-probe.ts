import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { chmod, chown, link, lstat, mkdir, open, readFile, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACTS,
	COMPANY_COMPUTER_CODE_PACKAGE_CAPABILITIES,
	COMPANY_COMPUTER_CODE_PACKAGE_RESET_ARTIFACTS,
	companyComputerResetRestorablePath,
} from "@qorpera/contracts";
import { parseRecoveryDirectoryMount } from "../../../runtime/src/cloud-identity-recovery-filesystems.ts";
import {
	bootFixtureEncode as encode,
	bootFixtureHash as hash,
} from "../../../runtime/test/fixtures/company-computer-boot-configuration.ts";
import { resetInvocationFixture } from "../../../runtime/test/fixtures/company-computer-reset-invocation.ts";
import { OFFICE_CODE_PACKAGE_LOADER, officeCodePackageStage } from "../../src/lxd-office-code-package-loader.ts";
import { verifyLxdOfficeCodePackageProvision } from "../../src/lxd-office-code-package-provision-verification.ts";
import {
	OFFICE_IMAGE_EXECUTABLES,
	OFFICE_IMAGE_PACKAGE_FILES,
	officeImageDestination,
	renderOfficeImageMount,
} from "../../src/lxd-office-image-installation.ts";
import { officeCanonical, officeDigest } from "../../src/lxd-office-image-provenance.ts";

const root = "/run/qorpera-office-preparation",
	mountPoint = "/var/lib/qorpera-office",
	scenario = process.argv[2] ?? "normal";
const fd = await open(mountPoint, "r");
const mount = parseRecoveryDirectoryMount(
	await readFile("/proc/self/mountinfo", "utf8"),
	await readFile(`/proc/self/fdinfo/${fd.fd}`, "utf8"),
);
await fd.close();
const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
const f = resetInvocationFixture({ bootId, mount: { ...mount, mountPoint } });
async function put(path: string, bytes: Buffer, mode: number) {
	await mkdir(dirname(path), { recursive: true, mode: 0o755 });
	await writeFile(path, bytes, { mode });
	await chmod(path, mode);
}
for (const [path, file] of f.originFiles) await put(path, file.bytes, file.mode);
// The image's tmpfiles fragment (qorpera-office-preparation.conf) creates this
// directory root-only and empty on every boot, so a recreated root carries it.
const credentials = "/etc/qorpera-office/credentials";
await mkdir(credentials, { mode: 0o700 });
await chmod(credentials, 0o700);
/** No predecessor credential was restored: still the image's private empty directory. */
const assertNoOldCredentials = () => {
	const s = lstatSync(credentials);
	assert.ok(s.isDirectory() && s.uid === 0 && s.gid === 0 && (s.mode & 0o7777) === 0o700);
	assert.deepEqual(readdirSync(credentials), []);
};
await mkdir(f.historyDirectory, { recursive: true, mode: 0o700 });
for (const [path, bytes] of f.archiveFiles) await put(path, bytes, 0o600);
for (const path of [dirname(f.receipt.layout.workbenchRoot), ...Object.values(f.receipt.layout)]) {
	await mkdir(path, { mode: 0o700 });
	await chown(path, 1000, 1000);
}
const note = `${f.receipt.layout.workbenchRoot}/proof-note`;
await writeFile(note, "edited before package provisioning", { mode: 0o600 });
await chown(note, 1000, 1000);
const noteBefore = await lstat(note);
await put(`${root}/control.lock`, Buffer.alloc(0), 0o600);
const planReset = {
	schema: "qorpera.lxd-office-reset-plan/v1",
	resetId: f.input.resetId,
	intentId: randomUUID(),
	predecessor: f.input.predecessor,
	predecessorRootIncarnationId: null,
	rootIncarnationId: f.input.rootIncarnationId,
	successorActivationId: f.input.activationId,
	providerBindingSha256: hash(Buffer.from("binding")),
	preparationObservationSha256: f.request.request.attestation.preparationObservationSha256,
	nodeId: null,
	commands: {
		stopCommandId: randomUUID(),
		deleteCommandId: randomUUID(),
		createCommandId: randomUUID(),
		startCommandId: randomUUID(),
	},
	custody: { archiveRoot: "/srv/proof-reset-archive" },
};
const unlistedBlob = scenario.startsWith("unlisted-history")
	? [...f.archiveFiles.keys()].find((path) => /\/[0-9a-f]{64}\.json$/.test(path))
	: undefined;
if (scenario.startsWith("unlisted-history")) assert.ok(unlistedBlob);
const historyFiles = [
	...f.archiveFiles.entries(),
	...[...f.originFiles.entries()].map(([p, v]) => [p, v.bytes] as const),
]
	.filter(([path]) => path !== unlistedBlob)
	.map(([path, bytes]) => ({
		path,
		bytes: bytes.length,
		sha256: hash(bytes),
		mode: path === "/etc/qorpera-office/adoption.json" ? 0o444 : 0o600,
	}))
	.sort((a, b) => (a.path < b.path ? -1 : 1));
const custody = {
	schema: "qorpera.office-reset-custody/v1",
	resetId: planReset.resetId,
	rootIncarnationId: planReset.rootIncarnationId,
	predecessorActivationId: planReset.predecessor.activationId,
	outbox: { manifestSha256: hash(Buffer.from("outbox")), recordCount: 0, totalBytes: 1 },
	history: {
		manifestSha256: hash(f.archiveFiles.get(`${f.historyDirectory}/manifest.json`)!),
		files: historyFiles,
		totalBytes: historyFiles.reduce((n, a) => n + a.bytes, 0),
	},
	journalHeadSha256: hash(Buffer.from("journal")),
	nas: {
		workbenchSource: mountPoint,
		adoptionId: f.original.copy.adoptionId,
		layoutSha256: hash(Buffer.from("layout")),
	},
};
const phaseHash = (phase: string, observation: object) =>
	officeDigest({ schema: "qorpera.office-reset-phase-evidence/v1", resetId: planReset.resetId, phase, observation });
const restored = historyFiles.filter((a) => companyComputerResetRestorablePath(a.path));
const restore = {
	schema: "qorpera.office-reset-restore/v1",
	resetId: planReset.resetId,
	rootIncarnationId: planReset.rootIncarnationId,
	custodySha256: phaseHash("custodied", custody),
	bootId,
	outbox: { manifestSha256: custody.outbox.manifestSha256, fileCount: 1, totalBytes: 1 },
	history: { fileCount: restored.length, totalBytes: restored.reduce((n, a) => n + a.bytes, 0) },
	nas: { reattached: true, layoutSha256: custody.nas.layoutSha256 },
	state: "restored",
};
const baselineBytes = new Map<string, Buffer>(),
	targetBytes = new Map<string, Buffer>();
const baseNames = [
	...OFFICE_IMAGE_PACKAGE_FILES,
	"node_modules/playwright-core/package.json",
	"node_modules/playwright-core/index.mjs",
	"node_modules/playwright-core/browsers.json",
	"wallpapers/qorpera-screen-pebble.png",
];
if (scenario === "real-artifacts") {
	for (const item of JSON.parse(await readFile("/fixture-base/manifest.json", "utf8")).artifacts)
		baselineBytes.set(item.file, await readFile(`/fixture-base/${item.file}`));
	for (const item of JSON.parse(await readFile("/fixture-target/manifest.json", "utf8")).artifacts)
		targetBytes.set(item.file, await readFile(`/fixture-target/${item.file}`));
} else {
	for (const name of baseNames) baselineBytes.set(name, Buffer.from(`original:${name}`));
	baselineBytes.set(
		"qorpera-office-private.mount.in",
		Buffer.from("[Mount]\nOptions=uid=@OFFICE_UID@,gid=@OFFICE_GID@\n"),
	);
	if (scenario === "compatible-noop")
		for (const name of COMPANY_COMPUTER_CODE_PACKAGE_RESET_ARTIFACTS)
			baselineBytes.set(name, Buffer.from(`original:${name}`));
	for (const [name, bytes] of baselineBytes) targetBytes.set(name, bytes);
	if (scenario !== "compatible-noop")
		for (const name of COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACTS)
			targetBytes.set(name, Buffer.from(`provisioned:${name}`));
}
const mountTemplate = baselineBytes.get("qorpera-office-private.mount.in")!;
const manifest = (map: Map<string, Buffer>) => ({
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
	artifacts: [...map].map(([file, bytes]) => ({ file, bytes: bytes.length, sha256: hash(bytes) })),
});
const base =
		scenario === "real-artifacts"
			? await readFile("/fixture-base/manifest.json")
			: Buffer.from(JSON.stringify(manifest(baselineBytes))),
	target =
		scenario === "real-artifacts"
			? await readFile("/fixture-target/manifest.json")
			: Buffer.from(JSON.stringify(manifest(targetBytes)));
const dependencies = {
	osReleaseSha256: hash(Buffer.from("os")),
	dpkgManifestSha256: hash(Buffer.from("dpkg")),
	browserTreeSha256: hash(Buffer.from("browser")),
	executables: Object.fromEntries(OFFICE_IMAGE_EXECUTABLES.map((p) => [p, hash(Buffer.from(p))])),
};
await put("/tmp/code-package-dependencies.json", encode(dependencies), 0o600);
const installed = [];
for (const [name, input] of baselineBytes) {
	const dest = (COMPANY_COMPUTER_CODE_PACKAGE_RESET_ARTIFACTS as readonly string[]).includes(name)
			? { path: `/opt/qorpera-office/${name}`, mode: 0o444 }
			: officeImageDestination(name),
		bytes =
			name === "qorpera-office-private.mount.in"
				? Buffer.from(renderOfficeImageMount(input.toString(), 1000, 1000))
				: input;
	await put(dest.path, bytes, dest.mode);
	installed.push({ path: dest.path, mode: dest.mode, bytes: bytes.length, sha256: hash(bytes) });
}
for (const name of ["qorpera-company-computer.service", "qorpera-company-computer-preparation.service"]) {
	const path = `/opt/qorpera-office/${name}`,
		bytes = baselineBytes.get(name)!;
	await put(path, bytes, 0o444);
	installed.push({ path, mode: 0o444, bytes: bytes.length, sha256: hash(bytes) });
}
const bwrap = Buffer.from("/usr/bin/bwrap");
await put("/usr/local/lib/qorpera/qorpera-browser-bwrap", bwrap, 0o555);
installed.push({
	path: "/usr/local/lib/qorpera/qorpera-browser-bwrap",
	mode: 0o555,
	bytes: bwrap.length,
	sha256: hash(bwrap),
});
const baseReceipt = encode({
	schema: "qorpera.office-image-installation-receipt/v1",
	specSha256: hash(Buffer.from("spec")),
	packageManifestSha256: hash(base),
	architecture: "x64",
	uid: 1000,
	gid: 1000,
	dependencies,
	files: installed,
});
await put("/opt/qorpera-office/installation.json", baseReceipt, 0o444);
const tool = await readFile("/fixture-tool.cjs");
const measure = await readFile("/fixture-measure.cjs");
const serviceBytes = targetBytes.get("qorpera-company-computer-service.mjs")!;
const statement = {
	schema: "qorpera.office-code-package-provision-statement/v1",
	base: {
		imageSha256: f.original.imageSha256,
		bootstrapSha256: f.original.bootstrapSha256,
		packageManifestSha256: hash(base),
		sourceCommit: "a".repeat(40),
	},
	target: {
		packageManifestSha256: hash(target),
		sourceCommit: "b".repeat(40),
		runtimeBundle: { id: "qorpera.cloud-runtime", version: 24, sha256: hash(Buffer.from("bundle")) },
		service: {
			path: "/opt/qorpera-office/qorpera-company-computer-service.mjs",
			bytes: serviceBytes.length,
			sha256: hash(serviceBytes),
		},
		capabilities: [...COMPANY_COMPUTER_CODE_PACKAGE_CAPABILITIES],
	},
	tools: {
		bootstrap: { bytes: tool.length, sha256: hash(tool) },
		measure: { bytes: measure.length, sha256: hash(measure) },
	},
	compatibility: {
		baseInstallationReceiptSha256: hash(baseReceipt),
		unchangedExternalDependenciesSha256: officeDigest(dependencies),
	},
	acceptance: {
		testedAt: "2026-09-12T00:00:00.000Z",
		evidenceSha256: hash(Buffer.from("fixture proof")),
		change: "code-only-package",
	},
};
const plan = {
	schema: "qorpera.lxd-office-code-package-provision-plan/v1",
	provisionId: randomUUID(),
	resetId: planReset.resetId,
	resetPlanSha256: officeDigest(planReset),
	providerBindingSha256: planReset.providerBindingSha256,
	rootIncarnationId: planReset.rootIncarnationId,
	successorActivationId: planReset.successorActivationId,
	statementSha256: officeDigest(statement),
	expectedSoftwareRevision: null,
	targetRevision: 1,
	installCommandId: randomUUID(),
};
const keys = generateKeyPairSync("ed25519"),
	envelope = {
		schema: "qorpera.office-code-package-provision-envelope/v1",
		statement,
		signature: {
			algorithm: "ed25519",
			value: sign(null, Buffer.from(officeCanonical(statement)), keys.privateKey).toString("base64"),
		},
	};
const trust = {
	verificationKeySpki: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
	statementSha256: plan.statementSha256,
	planSha256: officeDigest(plan),
	...statement.compatibility,
};
const request = {
	schema: "qorpera.office-code-package-provision-request/v1",
	plan,
	planSha256: trust.planSha256,
	bootId,
	restoreSha256: phaseHash("restored", restore),
	challengeId: randomUUID(),
	targetRevision: 1,
	capabilityRevision: 1,
	targetManifestSha256: hash(target),
};
const packet = Buffer.from(
		officeCanonical({
			schema: "qorpera.office-code-package-control/v1",
			request,
			resetPlan: planReset,
			custody,
			restore,
			originPreparationSha256: hash(encode(f.original)),
			envelope,
		}),
	),
	trustBytes = Buffer.from(officeCanonical(trust));
const stage = officeCodePackageStage(plan.provisionId);
await mkdir(stage, { mode: 0o700 });
for (const [name, bytes] of Object.entries({
	"packet.json": packet,
	"original-preparation.json": encode(f.original),
	"trust.json": trustBytes,
	"base-manifest.json": base,
	"target-manifest.json": target,
	"base-installation.json": baseReceipt,
	"base-mount-template": mountTemplate,
	"bootstrap.cjs": tool,
	"measure.cjs": measure,
}))
	await put(`${stage}/${name}`, bytes, 0o400);
for (const name of COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACTS)
	await put(`${stage}/artifacts/${name}`, targetBytes.get(name)!, 0o400);
const verified = verifyLxdOfficeCodePackageProvision(
	envelope,
	plan,
	trust,
	{ base, target, baseInstallationReceipt: baseReceipt, baseMountTemplate: mountTemplate },
	planReset,
);
if (scenario !== "compatible-noop")
	for (const name of COMPANY_COMPUTER_CODE_PACKAGE_RESET_ARTIFACTS)
		await assert.rejects(lstat(`/opt/qorpera-office/${name}`), { code: "ENOENT" });
const timings: Array<{ purpose: string; mode: string; elapsedMs: number; status: number | null }> = [];
const run = (args: string[], purpose = "bootstrap") => {
	const started = performance.now();
	const result = spawnSync(
		"/usr/bin/node",
		[
			"-e",
			OFFICE_CODE_PACKAGE_LOADER,
			purpose,
			plan.provisionId,
			hash(purpose === "bootstrap" ? tool : measure),
			String((purpose === "bootstrap" ? tool : measure).length),
			...args,
		],
		{ cwd: "/", env: {}, encoding: "utf8", timeout: 30000 },
	);
	timings.push({ purpose, mode: args[0], elapsedMs: Math.round(performance.now() - started), status: result.status });
	return result;
};
const checked = (args: string[], purpose = "bootstrap") => {
	const r = run(args, purpose);
	if (r.status !== 0 && purpose === "bootstrap" && args[0] === "install") {
		assert.equal(readFileSync(note, "utf8"), "edited before package provisioning");
		assert.equal(statSync(note).ino, noteBefore.ino);
		assertNoOldCredentials();
		console.log(
			JSON.stringify({
				scenario,
				failedInstall: true,
				targetFilesMatching: verified.targetInstalledArtifacts.filter(
					(a) => existsSync(a.path) && hash(readFileSync(a.path)) === a.sha256,
				).length,
				targetFilesExpected: verified.targetInstalledArtifacts.length,
				claimRetained: existsSync(`/etc/qorpera-office/code-packages/${plan.provisionId}/claim.json`),
				installedReceipt: existsSync(`/etc/qorpera-office/code-packages/${plan.provisionId}/installed.json`),
				nasPreserved: true,
				noOldCredentials: true,
				timings,
			}),
		);
	}
	assert.equal(r.status, 0, `${purpose}:${args[0]} ${r.stderr} ${JSON.stringify(timings)}`);
	return JSON.parse(r.stdout.trim());
};
const preflightId = randomUUID();
if (scenario === "bad-stage")
	await writeFile(`${stage}/artifacts/${COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACTS[0]}`, "tampered");
if (scenario === "old-credentials")
	await put(`${credentials}/config.json`, Buffer.from("predecessor configuration"), 0o400);
if (scenario === "open-credentials") await chmod(credentials, 0o755);
if (scenario === "bad-target-owner")
	await chown("/opt/qorpera-office/qorpera-company-computer-service.mjs", 1000, 1000);
const servicePath = "/opt/qorpera-office/qorpera-company-computer-service.mjs";
if (scenario === "base-hardlink") await link(servicePath, "/opt/qorpera-office/linked-code");
if (scenario === "base-symlink") {
	await rename(servicePath, "/opt/qorpera-office/moved-code");
	await symlink("/opt/qorpera-office/moved-code", servicePath);
}
if (scenario === "base-writable") await chmod(servicePath, 0o666);
if (scenario === "unlisted-history-mutation") await writeFile("/tmp/code-package-history-fault", unlistedBlob!);
if (scenario === "changed-history")
	await writeFile("/tmp/code-package-history-fault", `${f.historyDirectory}/manifest.json`);
if (scenario === "changed-nas") await writeFile("/tmp/code-package-nas-fault", f.receipt.layout.workbenchRoot);
if (
	[
		"bad-stage",
		"old-credentials",
		"open-credentials",
		"bad-target-owner",
		"changed-nas",
		"changed-history",
		"unlisted-history-mutation",
		"base-hardlink",
		"base-symlink",
		"base-writable",
	].includes(scenario)
) {
	assert.notEqual(
		run(["preflight", hash(packet), hash(trustBytes), preflightId]).status,
		0,
		"unsafe preflight accepted",
	);
	await assert.rejects(lstat(`/etc/qorpera-office/code-packages/${plan.provisionId}/installed.json`), {
		code: "ENOENT",
	});
	console.log(
		JSON.stringify({
			scenario,
			actualRootRefusal: true,
			noInstallation: true,
			syntheticSystemdDependenciesSqlAndPriorReset: true,
		}),
	);
} else {
	const probe = checked(["preflight", hash(packet), hash(trustBytes), preflightId]);
	if (
		[
			"partial-claim",
			"mutated-after-preflight",
			"noncode-after-preflight",
			"external-after-preflight",
			"credentials-after-preflight",
		].includes(scenario)
	) {
		if (scenario === "partial-claim")
			await put(`/etc/qorpera-office/code-packages/${plan.provisionId}/claim.json`, Buffer.from("partial"), 0o400);
		else if (scenario === "credentials-after-preflight")
			await put(`${credentials}/config.json`, Buffer.from("predecessor configuration"), 0o400);
		else if (scenario === "mutated-after-preflight")
			await writeFile(`${stage}/artifacts/${COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACTS[0]}`, "mutated");
		else if (scenario === "external-after-preflight")
			await writeFile(
				"/tmp/code-package-dependencies.json",
				encode({ ...dependencies, browserTreeSha256: "0".repeat(64) }),
			);
		else await writeFile("/opt/qorpera-office/qorpera-company-computer.service", "mutated");
		assert.notEqual(run(["install", hash(packet), hash(trustBytes), preflightId, probe.nonce, "5000"]).status, 0);
		assert.notEqual(
			run(["preflight", hash(packet), hash(trustBytes), randomUUID()]).status,
			0,
			"failed claimed/base preflight renewed authority",
		);
		await assert.rejects(lstat(`/etc/qorpera-office/code-packages/${plan.provisionId}/installed.json`), {
			code: "ENOENT",
		});
		console.log(JSON.stringify({ scenario, actualRootRefusal: true, noInstalledReceipt: true }));
	} else if (scenario === "wrong-nonce" || scenario === "expired-probe") {
		assert.notEqual(
			run([
				"install",
				hash(packet),
				hash(trustBytes),
				preflightId,
				scenario === "wrong-nonce" ? randomUUID() : probe.nonce,
				scenario === "expired-probe" ? "1" : "5000",
			]).status,
			0,
			"invalid authority accepted",
		);
		assert.notEqual(run(["preflight", hash(packet), hash(trustBytes), preflightId]).status, 0, "same probe renewed");
		await assert.rejects(lstat(`/etc/qorpera-office/code-packages/${plan.provisionId}/claim.json`), {
			code: "ENOENT",
		});
		console.log(
			JSON.stringify({
				scenario,
				actualRootRefusal: true,
				noInstallationClaim: true,
				syntheticSystemdDependenciesSqlAndPriorReset: true,
			}),
		);
	} else {
		const receipt = checked(["install", hash(packet), hash(trustBytes), preflightId, probe.nonce, "5000"]);
		assert.equal(receipt.installedInventorySha256, verified.inventorySha256);
		for (const a of verified.targetInstalledArtifacts) {
			const bytes = await readFile(a.path);
			assert.equal(hash(bytes), a.sha256);
			assert.equal(bytes.length, a.bytes);
		}
		assert.notEqual(
			run(["install", hash(packet), hash(trustBytes), preflightId, probe.nonce, "5000"]).status,
			0,
			"installation replay accepted",
		);

		const journal = `/etc/qorpera-office/code-packages/${plan.provisionId}`;
		// Fixture recreates the durable on-disk state of lost final publication.
		// The real observation tool may append receipt metadata; code inodes must never change.
		if (scenario.startsWith("recovery-")) {
			await unlink(`${journal}/installed.json`);
			if (scenario === "recovery-partial")
				await writeFile(servicePath, baselineBytes.get("qorpera-company-computer-service.mjs")!);
			if (scenario === "recovery-no-claim") await unlink(`${journal}/claim.json`);
			if (scenario === "recovery-corrupt-claim") await writeFile(`${journal}/claim.json`, "{");
			if (scenario === "recovery-noncanonical-claim")
				await writeFile(
					`${journal}/claim.json`,
					Buffer.concat([await readFile(`${journal}/claim.json`), Buffer.from("\n")]),
				);
			if (scenario === "recovery-corrupt-receipt") await put(`${journal}/installed.json`, Buffer.from("{"), 0o400);
		}
		const codeBeforeObservation = await Promise.all(
			COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACTS.map(async (name) => ({
				name,
				ino: (await lstat(`/opt/qorpera-office/${name}`)).ino,
				sha256: hash(await readFile(`/opt/qorpera-office/${name}`)),
			})),
		);
		const observationMustReject = [
			"observation-mutated",
			"observation-expired",
			"observation-external",
			"recovery-partial",
			"recovery-no-claim",
			"recovery-corrupt-claim",
			"recovery-noncanonical-claim",
			"recovery-corrupt-receipt",
		].includes(scenario);
		const observationId = randomUUID(),
			observationProbe = checked(["probe", hash(packet), hash(trustBytes), observationId, bootId], "measure");
		const observation = {
			schema: "qorpera.office-code-package-observation-challenge/v1",
			provisionId: plan.provisionId,
			observationId,
			request,
			requestSha256: officeDigest(request),
			statement,
			targetRevision: request.targetRevision,
			capabilityRevision: request.capabilityRevision,
			validForMs: scenario === "observation-expired" ? 1 : 5000,
		};
		const observationBytes = encode(observation);
		await put(`${stage}/challenge-${observationId}.json`, observationBytes, 0o400);
		if (scenario === "observation-external")
			await writeFile(
				"/tmp/code-package-dependencies.json",
				encode({ ...dependencies, browserTreeSha256: "0".repeat(64) }),
			);
		if (scenario === "observation-mutated")
			await writeFile("/opt/qorpera-office/qorpera-company-computer-service.mjs", "post-install mutation");
		const observationArgs = [
			"observation",
			hash(packet),
			hash(trustBytes),
			observationId,
			observationProbe.nonce,
			String(observation.validForMs),
			hash(observationBytes),
		];
		if (observationMustReject) {
			assert.notEqual(run(observationArgs, "measure").status, 0, "unsafe observation accepted");
			await assert.rejects(lstat(`${stage}/observation-${observationId}.json`), { code: "ENOENT" });
		} else {
			const observed = checked(observationArgs, "measure");
			assert.equal(observed.inventorySha256, verified.inventorySha256);
			assert.deepEqual(observed.receipt, receipt);
			if (scenario === "observation-replay")
				assert.notEqual(run(observationArgs, "measure").status, 0, "measurement replay accepted");
		}

		if (scenario.startsWith("recovery-")) {
			for (const before of codeBeforeObservation) {
				assert.equal(
					(await lstat(`/opt/qorpera-office/${before.name}`)).ino,
					before.ino,
					"observation renamed code",
				);
				assert.equal(
					hash(await readFile(`/opt/qorpera-office/${before.name}`)),
					before.sha256,
					"observation rewrote code",
				);
			}
			if (scenario === "recovery-complete")
				assert.deepEqual(JSON.parse(await readFile(`${journal}/installed.json`, "utf8")), receipt);
			else if (scenario === "recovery-corrupt-receipt")
				assert.equal(await readFile(`${journal}/installed.json`, "utf8"), "{");
			else await assert.rejects(lstat(`${journal}/installed.json`), { code: "ENOENT" });
		}
		assert.equal(await readFile(note, "utf8"), "edited before package provisioning");
		assert.equal((await lstat(note)).ino, noteBefore.ino);
		assertNoOldCredentials();
		console.log(
			JSON.stringify({
				scenario,
				legacyBaseCodePackageInstall: true,
				independentObservation: !observationMustReject,
				recoveryWithoutCodeWrites: scenario === "recovery-complete",
				syntheticMissingReceiptPublication: scenario.startsWith("recovery-"),
				actualLinuxRootFiles: true,
				actualKernelFlock: true,
				missingHelpersInstalled: scenario === "compatible-noop" ? 0 : 3,
				codeFilesChanged: verified.changedArtifacts.length,
				timings,
				fullInventoryEntries: verified.targetInstalledArtifacts.length,
				fullInventoryBytes: verified.targetInstalledArtifacts.reduce((n, a) => n + a.bytes, 0),
				baseManifestSha256: hash(base),
				targetManifestSha256: hash(target),
				immutableFullInventoryVerified: true,
				repeatInstallDenied: true,
				nasBytesAndInodePreserved: true,
				oldCredentialsRestored: false,
				syntheticSystemdDependenciesSqlAndPriorReset: true,
				deployed: false,
			}),
		);
	}
}
