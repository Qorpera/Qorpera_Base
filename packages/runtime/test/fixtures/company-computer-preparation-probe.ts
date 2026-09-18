import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
	chmod,
	lchown,
	link,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	rmdir,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { type CompanyComputerPreparationRequest, parseCompanyComputerPreparationRequest } from "@qorpera/contracts";
import { prepareCompanyComputerGuest } from "../../src/cloud-company-computer-preparation.ts";
import { runCompanyComputerPreparationMain } from "../../src/cloud-company-computer-preparation-main.ts";
import { parseRecoveryDirectoryMount } from "../../src/cloud-identity-recovery-filesystems.ts";

const mode = process.argv[2],
	scenario = process.argv[3];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const mountPoint = "/var/lib/qorpera-office";
const root = `${mountPoint}/.qorpera-adopted-${id(1)}`;
const requestPath = "/etc/qorpera-office/preparation.json";
if (mode === "--child") {
	assert.equal(process.getuid!(), 1000);
	if (scenario === "cancelled") {
		const request = JSON.parse(await readFile(requestPath, "utf8"));
		await assert.rejects(
			prepareCompanyComputerGuest(request, AbortSignal.abort(new Error("cancelled"))),
			/cancelled/,
		);
		console.log(JSON.stringify({ state: "cancelled" }));
	} else {
		const result = await runCompanyComputerPreparationMain();
		console.log(JSON.stringify(result));
	}
} else if (mode === "--parent") {
	assert.equal(process.platform, "linux");
	assert.equal(process.getuid!(), 0);
	const paths = [".", "desktop", "profiles", "profiles/profile", "screens", "screens/screen", "workbench"];
	const content =
		scenario === "empty"
			? new Map<string, Buffer>()
			: new Map([
					["workbench/note.bin", Buffer.alloc(1024 * 1024 + 17, 29)],
					["desktop/settings", Buffer.from("persistent settings")],
					["profiles/profile/Cookies", Buffer.from("synthetic cookie")],
					["screens/screen/state", Buffer.from("screen state")],
				]);
	for (const path of paths) await mkdir(path === "." ? root : `${root}/${path}`, { recursive: true, mode: 0o700 });
	for (const [path, bytes] of content) await writeFile(`${root}/${path}`, bytes, { mode: 0o600 });
	const entries: CompanyComputerPreparationRequest["entries"][number][] = [
		...paths.map((path) => ({ path, kind: "directory" as const, mode: 0o700, bytes: 0, sha256: null })),
		...[...content].map(([path, bytes]) => ({
			path,
			kind: "file" as const,
			mode: 0o600,
			bytes: bytes.length,
			sha256: createHash("sha256").update(bytes).digest("hex"),
		})),
	];
	const fd = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
	let workbenchMount: ReturnType<typeof parseRecoveryDirectoryMount>;
	try {
		workbenchMount = parseRecoveryDirectoryMount(
			await readFile("/proc/self/mountinfo", "utf8"),
			await readFile(`/proc/self/fdinfo/${fd.fd}`, "utf8"),
		);
	} finally {
		await fd.close();
	}
	const request = parseCompanyComputerPreparationRequest({
		schema: "qorpera.office-guest-preparation/v1",
		scope: { companyId: id(2), environmentId: id(3), companyComputerId: id(4), logicalComputerId: id(5) },
		computerGeneration: 1,
		allocationId: id(6),
		instanceSha256: "a".repeat(64),
		imageSha256: "b".repeat(64),
		bootstrapSha256: "c".repeat(64),
		bootId: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
		uid: 1000,
		gid: 1000,
		copy: {
			adoptionId: id(1),
			observationSha256: "d".repeat(64),
			planSha256: "e".repeat(64),
			reviewSha256: "f".repeat(64),
			outputInventorySha256: "a".repeat(64),
		},
		workbenchMount,
		limits: { memoryBytes: 256 * 1024 ** 2, pids: 64, cpuQuota: 100000, cpuPeriod: 100000 },
		entries,
	});
	const mainFile = `${root}/workbench/note.bin`;
	if (scenario === "file-change") await writeFile(mainFile, Buffer.alloc(1024 * 1024 + 17, 30));
	if (scenario === "missing") await unlink(mainFile);
	if (scenario === "extra") await writeFile(`${root}/workbench/unexpected`, "extra", { mode: 0o600 });
	if (scenario === "symlink-file") {
		await unlink(mainFile);
		await symlink("elsewhere", mainFile);
	}
	if (scenario === "symlink-directory") {
		await unlink(`${root}/screens/screen/state`);
		await rmdir(`${root}/screens/screen`);
		await symlink("../profiles/profile", `${root}/screens/screen`);
	}
	if (scenario === "hardlink") await link(mainFile, `${root}/workbench/alias`);
	if (scenario === "fifo") {
		await unlink(mainFile);
		assert.equal(spawnSync("mkfifo", ["-m", "600", mainFile]).status, 0);
	}
	if (scenario === "wrong-mode") await chmod(mainFile, 0o644);
	async function own(path: string): Promise<void> {
		const info = await lstat(path);
		if (info.isDirectory()) {
			for (const name of await readdir(path)) await own(`${path}/${name}`);
			await chmod(path, 0o700);
		}
		await lchown(path, scenario === "foreign-owner" && path === mainFile ? 1001 : 1000, 1000);
	}
	await own(mountPoint);
	const configured = {
		...request,
		...(scenario === "wrong-boot" ? { bootId: id(99) } : {}),
		...(scenario === "wrong-mount" ? { workbenchMount: { ...request.workbenchMount, source: "wrong-source" } } : {}),
	};
	const bytes = Buffer.from(JSON.stringify(configured));
	await writeFile(requestPath, bytes, { mode: scenario === "unsafe-request" ? 0o666 : 0o444 });
	if (scenario === "unsafe-request") await chmod(requestPath, 0o666);
	if (scenario === "request-symlink") {
		await writeFile("/etc/qorpera-office/other.json", bytes, { mode: 0o444 });
		await unlink(requestPath);
		await symlink("other.json", requestPath);
	}
	const run = () =>
		spawnSync(
			"setpriv",
			[
				"--reuid=1000",
				"--regid=1000",
				"--clear-groups",
				"--bounding-set=-all",
				process.execPath,
				"/probe.mjs",
				"--child",
				scenario,
			],
			{
				encoding: "utf8",
				timeout: 20000,
				env: { ...process.env, INVOCATION_ID: scenario === "missing-invocation" ? "" : "a".repeat(32) },
			},
		);
	const result = run();
	if (["normal", "empty"].includes(scenario)) {
		assert.equal(result.status, 0, result.stderr);
		const prepared = JSON.parse(result.stdout);
		assert.equal(prepared.state, "prepared");
		assert.equal(prepared.invocationId, "a".repeat(32));
		assert.equal(prepared.requestSha256, createHash("sha256").update(bytes).digest("hex"));
		assert.equal(prepared.contentSha256, createHash("sha256").update(JSON.stringify(request.entries)).digest("hex"));
		assert.equal(prepared.entries, request.entries.length);
		assert.deepEqual(JSON.parse(run().stdout), prepared);
		for (const [path, bytes] of content) assert.deepEqual(await readFile(`${root}/${path}`), bytes);
		assert(!result.stdout.includes("synthetic cookie"));
	} else if (scenario === "cancelled") {
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), { state: "cancelled" });
	} else {
		assert.notEqual(result.status, 0, result.stdout);
		assert.equal(result.signal, null, result.stderr);
		assert(!result.stdout.includes('"state":"prepared"'));
	}
	assert.deepEqual(await readdir(mountPoint), [`.qorpera-adopted-${id(1)}`]);
	console.log(
		JSON.stringify({
			schema: "qorpera.office-preparation-linux-proof/v1",
			scenario,
			actualLinuxReadOnlyProbe: true,
			actualProtectedRequest: true,
			syntheticSystemdInvocation: true,
			actualSystemdUnitExecution: false,
			actualPersistentFilesystem: true,
			syntheticCopyAndVmAuthority: true,
			realProviderCalls: false,
			activated: false,
		}),
	);
} else throw new Error("Unknown preparation probe mode");
