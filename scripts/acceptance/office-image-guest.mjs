import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";

const root = "/opt/qorpera-office-image-acceptance";
const pkg = `${root}/package`;
const installer = `${pkg}/qorpera-office-image-install.cjs`;
const specPath = `${root}/spec.json`;
const unit = "qorpera-company-computer.service";
const mountUnit = "run-qorpera\\x2doffice-private.mount";
const probeUnit = "qorpera-office-image-credential-proof.service";
const resultPath = "/run/office-image-credentials.json";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function exec(file, args, timeout = 120000) { return spawnSync(file, args, { encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024 }); }
function run(file, args, timeout) { const r = exec(file, args, timeout); assert.equal(r.status, 0, `${file}: ${r.stderr}`); return r.stdout.trim(); }
const ctl = (...args) => run("/usr/bin/systemctl", args);
const prop = (name, key) => ctl("show", name, `--property=${key}`, "--value");
const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim().replaceAll("-", "");
assert.match(boot, /^[0-9a-f]{32}$/);
assert.equal(process.getuid(), 0);
const stage = process.argv[2];
if (stage === "install") {
	const manifest = await readFile(`${pkg}/manifest.json`);
	const dependencies = JSON.parse(run("/usr/bin/node", [installer, "--measure-dependencies"]));
	const spec = { schema: "qorpera.office-image-installation/v1", packageRoot: pkg, packageManifestSha256: hash(manifest), uid: 1100, gid: 1100, architecture: process.arch, dependencies };
	await writeFile(specPath, JSON.stringify(spec), { mode: 0o444, flag: "wx" });
	run("/usr/bin/node", [`${root}/inputs.mjs`, specPath]);
	const check = JSON.parse(run("/usr/bin/node", [installer, "--check", "--spec", specPath]));
	assert.equal(check.state, "unconfigured-inactive");
	run("/usr/bin/node", [installer, "--apply", "--spec", specPath]);
	const receipt = JSON.parse(await readFile("/opt/qorpera-office/installation.json", "utf8"));
	for (const file of receipt.files) {
		const info = await lstat(file.path);
		assert.equal(hash(await readFile(file.path)), file.sha256);
		assert.equal(info.uid, 0); assert.equal(info.gid, 0); assert.equal(info.mode & 0o7777, file.mode);
	}
	for (const name of [unit, mountUnit, "qorpera-company-computer-preparation.service"]) assert.equal(prop(name, "ActiveState"), "inactive");
	const hostnamePolicies = {};
	for (const name of [unit, "qorpera-company-computer-preparation.service"]) {
		// ProtectHostname is a legacy boolean even on systemd259. The extended
		// D-Bus property retains the exact namespace mode and optional hostname.
		assert.equal(prop(name, "ProtectHostname"), "yes");
		const objectPath = `/org/freedesktop/systemd1/unit/${name.replaceAll("-", "_2d").replaceAll(".", "_2e")}`;
		hostnamePolicies[name] = run("busctl", ["get-property", "org.freedesktop.systemd1", objectPath, "org.freedesktop.systemd1.Service", "ProtectHostnameEx"]);
		assert.equal(hostnamePolicies[name], '(ss) "private" ""', "The real systemd manager must retain the exact private hostname policy");
	}
	assert.equal(prop(unit, "UnitFileState"), "disabled");
	assert.equal(run("/usr/bin/node", [`${root}/consumer.mjs`]), "OFFICE_IMAGE_PREPARATION_CONSUMER_ACCEPTED");
	ctl("start", mountUnit);
	const mount = run("findmnt", ["-n", "-o", "FSTYPE,SOURCE,OPTIONS", "--target", "/run/qorpera-office/private"]);
	for (const option of ["tmpfs", "nosuid", "nodev", "noexec", "uid=1100", "gid=1100"]) assert(mount.includes(option), mount);
	ctl("stop", mountUnit);
	assert.notEqual(exec("/usr/bin/systemctl", ["start", unit]).status, 0);
	assert.equal(prop(unit, "MainPID"), "0");
	ctl("stop", unit); ctl("stop", mountUnit);
	await writeFile(`${root}/install-proof.json`, JSON.stringify({ dependencies, packageManifestSha256: hash(manifest), installationReceiptSha256: hash(await readFile("/opt/qorpera-office/installation.json")), installedFiles: receipt.files.length, hostnamePolicies, actualPreparationManager: true, actualPrivateTmpfs: true, unconfiguredStartRefused: true }), { mode: 0o444 });
	console.log("OFFICE_IMAGE_INSTALLED_AND_VERIFIED");
} else if (stage === "credentials-before" || stage === "credentials-after") {
	const lines = (await readFile(`/etc/systemd/system/${unit}`, "utf8")).split("\n").filter((line) => line.startsWith("LoadCredential="));
	assert.equal(lines.length, 6);
	const files = lines.map((line) => { assert.match(line, /^LoadCredential=[a-z-]+:\/etc\/qorpera-office\/boots\/%b\/credentials\/[a-z.-]+$/); const [name, path] = line.slice(15).split(":"); return { name, file: path.split("/").at(-1) }; });
	if (stage === "credentials-before") {
		await writeFile(`/etc/systemd/system/${probeUnit}`, `[Service]\nType=oneshot\nUser=qorpera-office\nGroup=qorpera-office\n${lines.join("\n")}\nExecStart=/usr/bin/node ${root}/credential-child.mjs\nStandardOutput=file:${resultPath}\n`, { mode: 0o644, flag: "wx" });
		ctl("daemon-reload");
	} else {
		const before = JSON.parse(await readFile(`${root}/credentials-before.json`, "utf8"));
		assert.notEqual(boot, before.boot, "A real cold boot must change the kernel boot ID");
		assert.notEqual(exec("/usr/bin/systemctl", ["start", probeUnit]).status, 0);
		assert.equal(prop(probeUnit, "ExecMainStatus"), "243");
		assert.equal((await readFile(resultPath)).length, 0, "No process may start using the old boot or original fallback credentials");
		ctl("reset-failed", probeUnit);
	}
	const current = `/etc/qorpera-office/boots/${boot}`;
	await mkdir(`${current}/credentials`, { recursive: true, mode: 0o700 });
	await chmod(current, 0o755);
	const expected = {};
	for (const { name, file } of files) {
		const secret = randomBytes(32).toString("hex"); expected[name] = hash(secret);
		await writeFile(`${current}/credentials/${file}`, secret, { mode: 0o400, flag: "wx" });
		if (stage === "credentials-before") await writeFile(`/etc/qorpera-office/credentials/${file}`, "unusable old original fallback", { mode: 0o400, flag: "wx" });
	}
	ctl("start", probeUnit);
	assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), expected);
	await writeFile(`${root}/${stage}.json`, JSON.stringify({ boot, hashes: expected, actualSystemd: true, currentBootSelected: true, ...(stage === "credentials-after" ? { previousBootRefused: true, originalFallbackRefused: true } : {}) }), { mode: 0o444 });
	console.log(`OFFICE_IMAGE_${stage.toUpperCase().replaceAll("-", "_")}_VERIFIED`);
} else if (stage === "clean") {
	ctl("stop", probeUnit);
	await rm(`/etc/systemd/system/${probeUnit}`);
	ctl("daemon-reload");
	for (const directory of ["/etc/qorpera-office/boots", "/etc/qorpera-office/credentials"]) for (const entry of await readdir(directory)) await rm(`${directory}/${entry}`, { recursive: true });
	await rm(resultPath, { force: true });
	for (const name of [unit, mountUnit, "qorpera-company-computer-preparation.service"]) assert.equal(prop(name, "ActiveState"), "inactive");
	assert.equal(prop(unit, "UnitFileState"), "disabled");
	run("/usr/bin/node", [installer, "--check", "--spec", specPath]);
	console.log("OFFICE_IMAGE_UNCONFIGURED_AFTER_COLD_BOOT_PROOF");
} else throw new Error("OFFICE_IMAGE_ACCEPTANCE_STAGE_INVALID");
