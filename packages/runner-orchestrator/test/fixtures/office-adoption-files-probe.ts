import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, chown, lstat, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import {
	executeLxdOfficeAdoptionFiles,
	type LxdOfficeAdoptionFilesOptions,
} from "../../src/lxd-office-adoption-files.ts";
import { planLxdOfficeAdoption } from "../../src/lxd-office-adoption-plan.ts";
import { assertOfficeStorageMaintenanceHandoff } from "../../src/lxd-office-adoption-worker.ts";
import { officeDigest } from "../../src/lxd-office-image-provenance.ts";
import type { LxdOfficeStorageObservation } from "../../src/lxd-office-inventory-worker.ts";
import { readLxdOfficeProtectedFile } from "../../src/lxd-office-physical-host.ts";
import { lxdOfficeProviderBindingSha256 } from "../../src/lxd-office-start-control.ts";
import { inspectOfficeStorage, type OfficeInventoryLimits } from "../../src/lxd-office-storage-inventory.ts";
import { officePhysicalFixture } from "./office-physical-policy.ts";

const mode = process.argv[2];
const scenario = process.argv[3];
const root = "/fixture";
const journal = "/journal";
const source = {
	root,
	uid: 1000,
	gid: 1000,
	mount: { mountPoint: root, root: "/" as const, filesystem: "tmpfs", source: "tmpfs" },
};
const limits: OfficeInventoryLimits = {
	maxEntries: 1000,
	maxDepth: 16,
	maxFileBytes: 1024 ** 2,
	maxTotalBytes: 8 * 1024 ** 2,
	maxManifestBytes: 1024 ** 2,
};
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const signal = () => AbortSignal.timeout(50000);
if (mode === "--inventory") {
	assert.equal(process.getuid!(), 1000);
	console.log(JSON.stringify(await inspectOfficeStorage(source, limits, signal())));
} else if (mode === "--execute") {
	assert.equal(process.getuid!(), 1000);
	assert.notEqual(process.pid, 1);
	const config = JSON.parse(await readFile("/review/config.json", "utf8")) as LxdOfficeAdoptionFilesOptions;
	const plan = planLxdOfficeAdoption(config.input, config.binding, config.observation);
	let inspected = 0;
	const result = await executeLxdOfficeAdoptionFiles(
		config,
		{
			async assertWritable(candidate, review, checked) {
				// Synthetic live cloud/VM/profile/export authority. Only the file IO,
				// protected document and kernel lock are real in this offline proof.
				inspected++;
				if (scenario === "revoked") throw new Error("synthetic authority revoked");
				assertOfficeStorageMaintenanceHandoff(
					await readLxdOfficeProtectedFile("/review/maintenance.json", 16384),
					config.observation,
					candidate,
					review,
				);
				checked.throwIfAborted();
				let kill = false;
				const stage = `${root}/.qorpera-adoption-staging-${plan.adoptionId}`;
				if (scenario === "kill-temporary" || scenario === "kill-promoted") {
					let names: string[] = [];
					try {
						names = await readdir(stage);
					} catch {
						/* Not created yet. */
					}
					for (const name of names) {
						const stat = await lstat(`${stage}/${name}`);
						if (scenario === "kill-temporary" && stat.size > 0 && stat.nlink === 1) kill = true;
						if (scenario === "kill-promoted" && stat.nlink === 2) kill = true;
					}
				}
				if (scenario === "kill-result") {
					try {
						await lstat(`${journal}/adoption-result-${plan.adoptionId}.json`);
						kill = true;
					} catch {
						/* Not published yet. */
					}
				}
				if (kill) process.kill(process.pid, "SIGKILL");
			},
		},
		signal(),
	);
	assert(inspected > 0);
	console.log(JSON.stringify(result));
} else if (mode === "--mutate") {
	assert.equal(process.getuid!(), 1000);
	const config = JSON.parse(await readFile("/review/config.json", "utf8")) as LxdOfficeAdoptionFilesOptions;
	const plan = planLxdOfficeAdoption(config.input, config.binding, config.observation);
	if (scenario === "source-change")
		await writeFile(`${root}/legacy/workbench/note.txt`, "changed source", { flag: "a" });
	if (scenario === "target-change")
		await writeFile(`${root}/${plan.destinationName}/workbench/note.txt`, "changed target", { flag: "a" });
	if (scenario === "journal-loss") await unlink(`${journal}/adoption-${plan.adoptionId}.json`);
} else if (mode === "--verify") {
	assert.equal(process.getuid!(), 1000);
	const config = JSON.parse(await readFile("/review/config.json", "utf8")) as LxdOfficeAdoptionFilesOptions;
	const plan = planLxdOfficeAdoption(config.input, config.binding, config.observation);
	const original = await readFile("/review/source-note.bin");
	const failed =
		["unlocked", "revoked", "review-unsafe", "source-change"].includes(scenario) ||
		scenario.startsWith("maintenance-");
	if (scenario !== "empty") {
		const actualSource = await readFile(`${root}/legacy/workbench/note.txt`);
		assert.deepEqual(
			actualSource,
			scenario === "source-change" ? Buffer.concat([original, Buffer.from("changed source")]) : original,
		);
		assert.equal(await readFile(`${root}/legacy/profiles/screen-7/Cookies`, "utf8"), "synthetic-profile-cookie");
		assert.equal(await readFile(`${root}/loose.txt`, "utf8"), "quarantined original");
	}
	if (failed) {
		assert(!(await readdir(root)).some((name) => name.startsWith(".qorpera-adopt")));
	} else {
		const result = JSON.parse(await readFile(`${journal}/adoption-result-${plan.adoptionId}.json`, "utf8"));
		assert.equal(result.planSha256, officeDigest(plan));
		const staged = await readdir(`${root}/.qorpera-adoption-staging-${plan.adoptionId}`);
		assert.deepEqual(staged, []);
		if (scenario !== "empty") {
			assert.deepEqual(
				await readFile(`${root}/${plan.destinationName}/workbench/note.txt`),
				scenario === "target-change" ? Buffer.concat([original, Buffer.from("changed target")]) : original,
			);
			assert.equal((await lstat(`${root}/${plan.destinationName}/workbench/note.txt`)).mode & 0o7777, 0o600);
			assert.equal(
				await readFile(`${root}/${plan.destinationName}/screens/${id(4)}/settings`, "utf8"),
				"desktop settings",
			);
			if (scenario === "quarantine-profile")
				assert.deepEqual(await readdir(`${root}/${plan.destinationName}/profiles`), []);
			else
				assert.equal(
					await readFile(`${root}/${plan.destinationName}/profiles/${id(6)}/Cookies`, "utf8"),
					"synthetic-profile-cookie",
				);
		}
	}
} else if (mode === "--parent") {
	assert.equal(process.platform, "linux");
	assert.equal(process.getuid!(), 0);
	const child = (mode: string, test = scenario, locked = false) =>
		spawnSync(
			locked ? "/usr/bin/flock" : process.execPath,
			[
				...(locked ? ["--nonblock", "--no-fork", `${journal}/adoption.lock`, process.execPath] : []),
				"/probe.mjs",
				mode,
				test,
			],
			{ uid: 1000, gid: 1000, encoding: "utf8", timeout: 55000 },
		);
	const ok = (result: ReturnType<typeof child>) => {
		assert.equal(result.status, 0, result.stderr);
		return result.stdout;
	};
	const original = Buffer.alloc(512 * 1024 + 17, 23);
	await writeFile("/review/source-note.bin", original, { mode: 0o444 });
	if (scenario !== "empty") {
		for (const path of [
			"legacy",
			"legacy/workbench",
			"legacy/screens",
			"legacy/screens/screen-7",
			"legacy/profiles",
			"legacy/profiles/screen-7",
		])
			await mkdir(`${root}/${path}`, { mode: 0o700 });
		await writeFile(`${root}/legacy/workbench/note.txt`, original, { mode: 0o600 });
		await writeFile(`${root}/legacy/screens/screen-7/settings`, "desktop settings", { mode: 0o600 });
		await writeFile(`${root}/legacy/profiles/screen-7/Cookies`, "synthetic-profile-cookie", { mode: 0o600 });
		await writeFile(`${root}/loose.txt`, "quarantined original", { mode: 0o600 });
	}
	async function own(path: string): Promise<void> {
		const info = await lstat(path);
		if (info.isDirectory()) for (const name of await readdir(path)) await own(`${path}/${name}`);
		await chown(path, 1000, 1000);
	}
	await chmod(root, 0o700);
	await own(root);
	await writeFile(`${journal}/adoption.lock`, "", { mode: 0o600 });
	await chmod(journal, 0o700);
	await own(journal);
	const binding = { ...officePhysicalFixture().binding, workbenchSource: root };
	const scope = {
		companyId: binding.companyId,
		environmentId: binding.environmentId,
		companyComputerId: binding.companyComputerId,
		logicalComputerId: binding.logicalComputerId,
	};
	const observation: LxdOfficeStorageObservation = {
		schema: "qorpera.lxd-office-storage-observation/v1",
		intentId: id(1),
		allocationId: binding.allocationId,
		providerBindingSha256: lxdOfficeProviderBindingSha256(binding),
		hostBootId: id(2),
		inventory: JSON.parse(ok(child("--inventory"))),
	};
	const input = {
		schema: "qorpera.lxd-office-adoption-input/v1",
		adoptionId: id(3),
		shared: { workbench: scenario === "empty" ? null : "legacy/workbench", desktopHome: null },
		legacy:
			scenario === "empty"
				? null
				: {
						roots: { screenStateRoot: "legacy/screens", browserProfilesRoot: "legacy/profiles" },
						mappings: [
							{
								legacy: { ...scope, screenId: id(4), staffAgentId: id(5), screenOrdinal: 7 },
								binding: {
									...scope,
									screenId: id(4),
									staffAgentId: id(5),
									screenOrdinal: 1,
									screenGeneration: 1,
									computerGeneration: 1,
								},
								browserProfile:
									scenario === "quarantine-profile" ? null : { profileId: id(6), grantId: id(7), version: 1 },
							},
						],
					},
		quarantine: scenario === "empty" ? [] : ["loose.txt"],
	};
	const plan = planLxdOfficeAdoption(input, binding, observation);
	const config: LxdOfficeAdoptionFilesOptions = {
		binding,
		observation,
		input,
		source,
		limits,
		journalRoot: journal,
		reviewPath: "/review/approved.json",
	};
	await writeFile("/review/config.json", JSON.stringify(config), { mode: 0o444 });
	const maintenance = Buffer.from(
		JSON.stringify({
			schema: "qorpera.lxd-office-storage-maintenance/v1",
			state: "exclusive_writers_confirmed",
			hostBootId: observation.hostBootId,
			providerBindingSha256: observation.providerBindingSha256,
			observationSha256: officeDigest(observation),
			planSha256: officeDigest(plan),
		}),
	);
	await writeFile("/review/maintenance.json", maintenance, { mode: 0o444 });
	await writeFile(
		config.reviewPath,
		JSON.stringify({
			schema: "qorpera.lxd-office-storage-review/v1",
			reviewId: id(8),
			decision: scenario === "empty" ? "initialize_empty" : "migrate_existing",
			observationSha256: officeDigest(observation),
			planSha256: officeDigest(plan),
			writerFence: {
				state: "exclusive_writers_confirmed",
				evidenceSha256: createHash("sha256").update(maintenance).digest("hex"),
			},
		}),
		{ mode: 0o444 },
	);
	if (scenario === "review-unsafe") await chmod(config.reviewPath, 0o666);
	if (scenario === "maintenance-unsafe") await chmod("/review/maintenance.json", 0o666);
	if (scenario === "maintenance-owner") await chown("/review/maintenance.json", 1000, 1000);
	if (scenario === "maintenance-missing") await unlink("/review/maintenance.json");
	if (scenario === "maintenance-changed") {
		await unlink("/review/maintenance.json");
		await writeFile("/review/maintenance.json", `${maintenance}\n`, { mode: 0o444 });
	}
	if (scenario === "source-change") ok(child("--mutate"));
	const first = child("--execute", scenario, scenario !== "unlocked");
	if (scenario.startsWith("kill-")) {
		assert.equal(first.signal, "SIGKILL", first.stderr);
		const resumed = JSON.parse(ok(child("--execute", "normal", true)));
		assert.deepEqual(JSON.parse(ok(child("--execute", "normal", true))), resumed);
	} else if (
		["unlocked", "revoked", "review-unsafe", "source-change"].includes(scenario) ||
		scenario.startsWith("maintenance-")
	) {
		assert.notEqual(first.status, 0);
		assert.equal(first.signal, null);
		assert.match(
			first.stderr,
			/KERNEL_LOCK_REQUIRED|synthetic authority revoked|OFFICE_HOST_FILE_UNPROTECTED|OFFICE_ADOPTION_SOURCE_CHANGED|OFFICE_ADOPTION_MAINTENANCE_HANDOFF_REQUIRED|ENOENT/,
		);
	} else {
		const result = JSON.parse(ok(first));
		assert.equal(result.state, "copied");
		assert.deepEqual(JSON.parse(ok(child("--execute", "normal", true))), result);
		if (["target-change", "journal-loss"].includes(scenario)) {
			ok(child("--mutate"));
			const refused = child("--execute", "normal", true);
			assert.notEqual(refused.status, 0);
			assert.match(refused.stderr, /OFFICE_ADOPTION_FILE_CHANGED|OFFICE_ADOPTION_SOURCE_CHANGED/);
		}
	}
	ok(child("--verify"));
	console.log(
		JSON.stringify({
			schema: "qorpera.office-adoption-files-proof/v1",
			scenario,
			actualLinuxFilesAndFlock: true,
			actualProtectedMaintenanceRead: true,
			actualSigkill: scenario.startsWith("kill-"),
			sourcePreserved: true,
			liveGuard: "synthetic",
			operatorApproval: "synthetic",
			actualNas: false,
			guestStarted: false,
			completedGuestReceipt: false,
		}),
	);
} else throw new Error("Unknown adoption fixture mode");
