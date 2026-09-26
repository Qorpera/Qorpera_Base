import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, chown, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// This fixture exercises a real NFS mount and the production descriptor check.
// It does not claim remote NAS durability, office admission or guest custody.
assert.equal(process.platform, "linux");
assert.equal(process.getuid(), 0);
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
assert(process.argv.length === 4 && process.argv[2] === "--out");
const out = resolve(process.argv[3]);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const root = "/srv/qorpera-office-acceptance";
const exportsFile = "/etc/exports.d/qorpera-office-acceptance.exports";
const source = "127.0.0.1:/";
const workbench = `${root}/workbench`;
const journal = `${root}/journal`;
const evidence = { schema: "qorpera.office-host-storage-acceptance/v1", commit: process.env.GITHUB_SHA, passed: false,
	scope: "Real local NFSv4 and durable journal mounts; production descriptor validation. No remote NAS durability, guest or office admission proof." };
let workbenchMounted = false;
let journalMounted = false;
let exportInstalled = false;
let rootCreated = false;
function run(command, args, timeout = 30000) {
	const result = spawnSync(command, args, { cwd: repository, encoding: "utf8", timeout, maxBuffer: 1024 * 1024 });
	assert.equal(result.status, 0, `${command} failed: ${String(result.stderr || result.error).slice(0, 2000)}`);
	return result.stdout.trim();
}
try {
	await mkdir(out, { recursive: true, mode: 0o755 });
	// Refuse to reuse or delete any preexisting fixture; the host is disposable.
	await mkdir(root, { mode: 0o755 });
	rootCreated = true;
	for (const directory of ["export", "workbench", "journal"]) await mkdir(`${root}/${directory}`, { mode: 0o700 });
	await chown(`${root}/export`, 1100, 1100);
	await writeFile(`${root}/export/sentinel`, "qorpera-real-nfs-acceptance\n", { mode: 0o600 });
	await chown(`${root}/export/sentinel`, 1100, 1100);
	await mkdir("/etc/exports.d", { recursive: true, mode: 0o755 });
	assert.equal(run("exportfs", []), "", "Disposable host must have no existing NFS exports");
	await writeFile(exportsFile, `${root}/export 127.0.0.1(rw,sync,root_squash,no_subtree_check,fsid=0)\n`, { mode: 0o644, flag: "wx" });
	exportInstalled = true;
	run("systemctl", ["start", "nfs-server"]);
	run("exportfs", ["-ra"]);
	run("mount", ["-t", "nfs4", "-o", "vers=4.2,proto=tcp,hard,nosuid,nodev", source, workbench]);
	workbenchMounted = true;
	// A separate real ext4 mount gives journal root=/ without a bind-root fiction.
	run("truncate", ["-s", "64M", `${root}/journal.ext4`]);
	run("mkfs.ext4", ["-q", "-F", `${root}/journal.ext4`]);
	run("mount", ["-o", "loop,nosuid,nodev", `${root}/journal.ext4`, journal]);
	journalMounted = true;
	await chmod(journal, 0o700);
	await chown(journal, 1100, 1100);
	// The exported owner cannot traverse the runner's private home directory.
	// Keep this non-secret executable under our own traversable fixture root.
	const probe = join(root, "storage-probe.mjs");
	await build({ entryPoints: [join(repository, "scripts/acceptance/office-host-storage-probe.ts")], outfile: probe,
		bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "silent" });
	evidence.observation = JSON.parse(run("setpriv", ["--reuid=1100", "--regid=1100", "--clear-groups", process.execPath, probe, workbench, journal]));
	// Read as the exported workbench owner: root squashing stays enabled.
	assert.equal(run("setpriv", ["--reuid=1100", "--regid=1100", "--clear-groups", "cat", `${workbench}/sentinel`]), "qorpera-real-nfs-acceptance");
	evidence.ownerRead = true;
	evidence.passed = true;
} catch (error) {
	evidence.error = String(error);
	process.exitCode = 1;
} finally {
	try {
		if (workbenchMounted) run("umount", [workbench]);
		if (journalMounted) run("umount", [journal]);
		if (exportInstalled) { await unlink(exportsFile); run("exportfs", ["-ra"]); }
		if (rootCreated) await rm(root, { recursive: true });
	} catch (error) { evidence.cleanupError = String(error); evidence.passed = false; process.exitCode = 1; }
	await writeFile(join(out, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 });
	console.log(JSON.stringify(evidence));
}
