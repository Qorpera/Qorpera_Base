import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const repository = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
	source = process.env.QORPERA_CODE_PACKAGE_SOURCE ?? repository,
	tag = process.env.QORPERA_OFFICE_TEST_IMAGE;
if (!tag || process.argv.length !== 2) throw new Error("Select existing QORPERA_OFFICE_TEST_IMAGE; no arguments");
const inspected = spawnSync("docker", ["image", "inspect", tag, "--format", "{{.Id}}"], {
	encoding: "utf8",
	timeout: 10000,
});
assert.equal(inspected.status, 0);
const image = inspected.stdout.trim();
assert.match(image, /^sha256:[a-f0-9]{64}$/);
const temporary = await mkdtemp(join(tmpdir(), "qorpera-code-root-")),
	container = `qorpera-code-root-${randomUUID()}`,
	volume = `${container}-nas`;
try {
	const probe = join(temporary, "probe.mjs"),
		tool = join(temporary, "tool.cjs"),
		measure = join(temporary, "measure.cjs"),
		adapter = join(repository, "packages/runner-orchestrator/test/fixtures/office-code-package-observations.ts");
	await build({
		absWorkingDir: repository,
		entryPoints: ["packages/runner-orchestrator/test/fixtures/office-code-package-root-probe.ts"],
		outfile: probe,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22.19",
		logLevel: "silent",
	});
	const entry =
		process.env.QORPERA_CODE_PACKAGE_DIAGNOSTIC === "1"
			? {
					stdin: {
						contents: `import {runOfficeCodePackageTool as run} from ${JSON.stringify(join(source, "deploy/lxd-company-computer-guest/office-code-package-control.ts"))}; export async function runOfficeCodePackageTool(...args){try{return await run(...args);}catch(error){process.stderr.write(String(error.stack)+'\\n');throw error;}}`,
						resolveDir: source,
						sourcefile: "proof-tool.ts",
						loader: "ts",
					},
				}
			: { entryPoints: ["deploy/lxd-company-computer-guest/office-code-package-control.ts"] };
	await build({
		absWorkingDir: source,
		...entry,
		outfile: tool,
		bundle: true,
		platform: "node",
		format: "cjs",
		target: "node22.19",
		logLevel: "silent",
		plugins: [
			{
				name: "explicit-synthetic-observations",
				setup(b) {
					b.onResolve(
						{
							filter:
								/cloud-company-computer-boot-configuration-control\.ts$|lxd-office-image-installation-host\.ts$/,
						},
						(args) => (args.importer.endsWith("office-code-package-material.ts") ? { path: adapter } : undefined),
					);
				},
			},
		],
	});
	await build({
		absWorkingDir: source,
		entryPoints: ["deploy/lxd-company-computer-guest/office-code-package-measure.ts"],
		outfile: measure,
		bundle: true,
		platform: "node",
		format: "cjs",
		target: "node22.19",
		logLevel: "silent",
		plugins: [
			{
				name: "explicit-synthetic-observations",
				setup(b) {
					b.onResolve(
						{
							filter:
								/cloud-company-computer-boot-configuration-control\.ts$|lxd-office-image-installation-host\.ts$/,
						},
						(args) => (args.importer.endsWith("office-code-package-material.ts") ? { path: adapter } : undefined),
					);
				},
			},
		],
	});
	const roots = [
		"/run/qorpera-office-preparation",
		"/etc/qorpera-office",
		"/opt/qorpera-office",
		"/etc/systemd/system",
		"/etc/apparmor.d",
		"/usr/lib/tmpfiles.d",
		"/usr/local/lib/qorpera",
		"/usr/local/share/qorpera",
		"/usr/local/bin",
		"/usr/share/backgrounds",
	];
	const mounts = roots.flatMap((path) => [
		"--tmpfs",
		`${path}:rw,nosuid,nodev,size=32m,mode=${path === "/run/qorpera-office-preparation" ? "0700" : "0755"}`,
	]);
	console.log(
		JSON.stringify({
			image,
			tools: Object.fromEntries(
				await Promise.all(
					[tool, measure].map(async (p) => [
						p.endsWith("measure.cjs") ? "measure" : "bootstrap",
						createHash("sha256")
							.update(await readFile(p))
							.digest("hex"),
					]),
				),
			),
			network: "none",
			readOnlyRoot: true,
			syntheticSystemdDependenciesSqlAndPriorReset: true,
			deployed: false,
		}),
	);
	assert.equal(
		Boolean(process.env.QORPERA_CODE_PACKAGE_BASE),
		Boolean(process.env.QORPERA_CODE_PACKAGE_TARGET),
		"Both fixture package paths required",
	);
	const packages =
		process.env.QORPERA_CODE_PACKAGE_BASE && process.env.QORPERA_CODE_PACKAGE_TARGET
			? [
					"--mount",
					`type=bind,src=${resolve(process.env.QORPERA_CODE_PACKAGE_BASE)},dst=/fixture-base,readonly`,
					"--mount",
					`type=bind,src=${resolve(process.env.QORPERA_CODE_PACKAGE_TARGET)},dst=/fixture-target,readonly`,
				]
			: [];
	const attempts = Number(process.env.QORPERA_CODE_PACKAGE_REPEAT ?? "1");
	assert.ok(Number.isInteger(attempts) && attempts >= 1 && attempts <= 15);
	const failures = [];
	const scenarios = [
		...(packages.length ? ["real-artifacts"] : []),
		"normal",
		"compatible-noop",
		"bad-stage",
		"old-credentials",
		"open-credentials",
		"bad-target-owner",
		"base-hardlink",
		"base-symlink",
		"base-writable",
		"changed-nas",
		"changed-history",
		"unlisted-history",
		"unlisted-history-mutation",
		"wrong-nonce",
		"expired-probe",
		"partial-claim",
		"mutated-after-preflight",
		"noncode-after-preflight",
		"external-after-preflight",
		"credentials-after-preflight",
		"observation-external",
		"observation-mutated",
		"observation-replay",
		"observation-expired",
		"recovery-complete",
		"recovery-partial",
		"recovery-no-claim",
		"recovery-corrupt-claim",
		"recovery-noncanonical-claim",
		"recovery-corrupt-receipt",
	].filter((s) => !process.env.QORPERA_CODE_PACKAGE_SCENARIO || s === process.env.QORPERA_CODE_PACKAGE_SCENARIO);
	assert.ok(scenarios.length > 0, "Unknown proof scenario");
	for (let attempt = 1; attempt <= attempts; attempt++)
		for (const scenario of scenarios) {
			const result = spawnSync(
				"docker",
				[
					"run",
					"--name",
					container,
					"--rm",
					"--pull",
					"never",
					"--network",
					"none",
					"--read-only",
					"--memory",
					"512m",
					"--pids-limit",
					"64",
					"--cap-drop",
					"ALL",
					"--cap-add",
					"CHOWN",
					"--cap-add",
					"DAC_OVERRIDE",
					"--cap-add",
					"FOWNER",
					"--user",
					"0:0",
					...mounts,
					...packages,
					"--tmpfs",
					"/tmp:rw,nosuid,nodev,size=20m,mode=1777",
					"--mount",
					`type=volume,src=${volume},dst=/var/lib/qorpera-office`,
					"--mount",
					`type=bind,src=${probe},dst=/probe.mjs,readonly`,
					"--mount",
					`type=bind,src=${tool},dst=/fixture-tool.cjs,readonly`,
					"--mount",
					`type=bind,src=${measure},dst=/fixture-measure.cjs,readonly`,
					image,
					"node",
					"/probe.mjs",
					scenario,
				],
				{ stdio: "inherit", timeout: 120000 },
			);
			if (result.status === null) spawnSync("docker", ["rm", "-f", container], { stdio: "ignore", timeout: 10000 });
			if (result.status !== 0) failures.push({ scenario, attempt, status: result.status });
			console.log(JSON.stringify({ scenario, attempt, containerExit: result.status }));
			spawnSync("docker", ["volume", "rm", volume], { stdio: "ignore", timeout: 10000 });
		}
	assert.deepEqual(failures, [], "Code package full-root Linux proof failed");
} finally {
	spawnSync("docker", ["rm", "-f", container], { stdio: "ignore", timeout: 10000 });
	spawnSync("docker", ["volume", "rm", volume], { stdio: "ignore", timeout: 10000 });
	await rm(temporary, { recursive: true, force: true });
}
