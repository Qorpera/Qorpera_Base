import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";

const root = "/opt/qorpera-office-image-acceptance";
const [endpoint, expectedCa, expectedManager, expectedInstallation] = process.argv.slice(2);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function run(file, args, timeout = 30000) {
	const result = spawnSync(file, args, { encoding: "utf8", timeout, maxBuffer: 1024 ** 2 });
	assert.equal(result.status, 0, `${file}: ${result.stderr}`);
	return result.stdout.trim();
}
assert.equal(process.getuid(), 0);
for (const [path, expected] of [["/usr/local/share/qorpera-acceptance/ca.pem", expectedCa], ["/etc/systemd/system.conf.d/90-qorpera-acceptance-ca.conf", expectedManager], ["/opt/qorpera-office/installation.json", expectedInstallation]]) {
	const info = await lstat(path);
	assert(info.isFile() && info.uid === 0 && info.gid === 0 && info.nlink === 1 && (info.mode & 0o6022) === 0);
	assert.equal(digest(await readFile(path)), expected);
}
const receipt = JSON.parse(await readFile("/opt/qorpera-office/installation.json", "utf8"));
for (const artifact of receipt.files) {
	const info = await lstat(artifact.path);
	assert(info.isFile() && info.uid === 0 && info.gid === 0 && info.nlink === 1);
	assert.equal(info.mode & 0o7777, artifact.mode);
	assert.equal(digest(await readFile(artifact.path)), artifact.sha256);
}
const dependencies = JSON.parse(run("/usr/bin/node", ["/opt/qorpera-office/qorpera-office-image-install.cjs", "--measure-dependencies"]));
assert.deepEqual(dependencies, receipt.dependencies);
const secureBoot = await readFile("/sys/firmware/efi/efivars/SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c");
const setupMode = await readFile("/sys/firmware/efi/efivars/SetupMode-8be4df61-93ca-11d2-aa0d-00e098032b8c");
assert.equal(secureBoot.length, 5); assert.equal(secureBoot[4], 1);
assert.equal(setupMode.length, 5); assert.equal(setupMode[4], 0);
const mokutil = run("mokutil", ["--sb-state"]);
assert.equal(mokutil, "SecureBoot enabled");
assert.equal(run("systemd-detect-virt", []), "kvm");
for (const path of ["/etc/qorpera-office/boots", "/etc/qorpera-office/credentials", "/var/lib/qorpera-office"]) assert.deepEqual(await readdir(path), []);
for (const path of ["/var/lib/qorpera", "/var/lib/qorpera-native-provider", "/qorpera/company-live", "/etc/qorpera", "/root/.codex", "/root/.pi"]) {
	await assert.rejects(lstat(path), { code: "ENOENT" });
}
const hostnamePolicies = {};
for (const unit of ["qorpera-company-computer.service", "qorpera-company-computer-preparation.service"]) {
	assert.equal(run("systemctl", ["show", unit, "--property=ActiveState", "--value"]), "inactive");
	assert.equal(run("systemctl", ["show", unit, "--property=DropInPaths", "--value"]), "");
	const objectPath = `/org/freedesktop/systemd1/unit/${unit.replaceAll("-", "_2d").replaceAll(".", "_2e")}`;
	hostnamePolicies[unit] = run("busctl", ["get-property", "org.freedesktop.systemd1", objectPath, "org.freedesktop.systemd1.Service", "ProtectHostnameEx"]);
	assert.equal(hostnamePolicies[unit], '(ss) "private" ""');
}
assert.equal(run("systemctl", ["show", "qorpera-company-computer.service", "--property=UnitFileState", "--value"]), "disabled");
assert.equal(run("/usr/bin/node", [`${root}/consumer.mjs`]), "OFFICE_IMAGE_PREPARATION_CONSUMER_ACCEPTED");
const refused = spawnSync("systemctl", ["start", "qorpera-company-computer.service"], { encoding: "utf8", timeout: 30000 });
assert.notEqual(refused.status, 0);
assert.equal(run("systemctl", ["show", "qorpera-company-computer.service", "--property=MainPID", "--value"]), "0");
run("systemctl", ["stop", "qorpera-company-computer.service"]);
run("systemctl", ["stop", "run-qorpera\\x2doffice-private.mount"]);
const nodeTrust = JSON.parse(run("systemd-run", ["--quiet", "--wait", "--pipe", "--collect", "--unit=qorpera-office-image-trust-proof", "--uid=qorpera-office", "--gid=qorpera-office", "/usr/bin/node", `${root}/trust-probe.mjs`, endpoint]));
const evidence = { schema: "qorpera.office-image-final-boot/v1", bootId: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(), virtualization: "kvm", secureBoot: secureBoot[4], setupMode: setupMode[4], mokutil, nodeTrust, hostnamePolicies, installedFiles: receipt.files.length, dependenciesUnchanged: true, credentials: "absent", computeIdentity: "absent", companyState: "absent", services: "fail-closed", caSha256: expectedCa, managerConfigurationSha256: expectedManager, installationReceiptSha256: expectedInstallation };
await writeFile(`${root}/trust-proof.json`, `${JSON.stringify(evidence)}\n`, { flag: "wx", mode: 0o444 });
console.log("OFFICE_IMAGE_SECURE_BOOT_AND_NODE_TRUST_VERIFIED");
