import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, chown, link, mkdir, open, readFile, symlink, writeFile } from "node:fs/promises";
import { LxdOfficePhysicalGate } from "../../src/lxd-office-physical-gate.ts";
import {
	assertLxdOfficeHostMount,
	readLxdOfficeCredentialFile,
	readLxdOfficeProtectedFile,
	readLxdOfficeProtectedImageManifestFile,
} from "../../src/lxd-office-physical-host.ts";
import { officePhysicalFixture } from "./office-physical-policy.ts";

// Runs only inside the disposable offline Linux container. Root prepares its
// synthetic files, then observations run as uid/gid 1000. Supplementary group
// 1001 proves that credentials must use the dedicated primary group.
assert.equal(process.platform, "linux");
assert.equal(process.getuid!(), 0);
const root = "/fixture";
await mkdir(`${root}/unsafe`, { mode: 0o777 });
await chmod(`${root}/unsafe`, 0o777);
const { policy, envelope, binding } = officePhysicalFixture();
const valid = Buffer.from(JSON.stringify(policy));
for (const [name, bytes] of Object.entries({
	"policy.json": valid,
	"image-manifest.json": Buffer.alloc(100000, 32),
	"large-image-manifest.json": Buffer.alloc(1024 ** 2 + 1, 32),
	"evidence.json": Buffer.from(JSON.stringify(envelope)),
	"writable.json": valid,
	"group-writable.json": valid,
	"user-owned.json": valid,
	"hardlink.json": valid,
	"oversize.json": Buffer.alloc(16385),
	"unsafe/config.json": valid,
	"invalid-utf8.json": Buffer.from([255]),
}))
	await writeFile(`${root}/${name}`, bytes, { mode: 0o644 });
await chmod(`${root}/writable.json`, 0o666);
await chmod(`${root}/group-writable.json`, 0o664);
await chown(`${root}/user-owned.json`, 1000, 1000);
await link(`${root}/hardlink.json`, `${root}/other-link.json`);
await symlink(`${root}/policy.json`, `${root}/symlink.json`);
await mkdir(`${root}/directory.json`);
assert.equal(spawnSync("/usr/bin/mkfifo", [`${root}/fifo.json`]).status, 0);
for (const [name, mode, uid, gid] of [
	["private", 0o440, 0, 1000],
	["public", 0o444, 0, 1000],
	["writable-secret", 0o640, 0, 1000],
	["user-secret", 0o440, 1000, 1000],
	["wrong-group", 0o440, 0, 1001],
	["root-only", 0o400, 0, 0],
	["linked-secret", 0o440, 0, 1000],
] as const) {
	await writeFile(`${root}/${name}`, "synthetic-local-credential", { mode });
	await chown(`${root}/${name}`, uid, gid);
}
await link(`${root}/linked-secret`, `${root}/linked-secret-other`);
await symlink(`${root}/private`, `${root}/secret-symlink`);
assert.equal((await readLxdOfficeCredentialFile(`${root}/root-only`, 128)).toString(), "synthetic-local-credential");
process.setgroups!([1001]);
process.setgid!(1000);
process.setuid!(1000);
assert.equal(process.getuid!(), 1000);
assert.equal(process.getgid!(), 1000);
const results: string[] = [];
assert.equal((await readFile(`${root}/wrong-group`)).toString(), "synthetic-local-credential");
assert.equal((await readLxdOfficeCredentialFile(`${root}/private`, 128)).toString(), "synthetic-local-credential");
results.push("root-only and dedicated-primary-group credential custody");
for (const name of [
	"public",
	"writable-secret",
	"user-secret",
	"wrong-group",
	"root-only",
	"linked-secret",
	"secret-symlink",
	"fifo.json",
	"directory.json",
	"unsafe/config.json",
]) {
	await assert.rejects(readLxdOfficeCredentialFile(`${root}/${name}`, 128));
	results.push(`refused credential ${name}`);
}
assert.deepEqual(await readLxdOfficeProtectedFile(`${root}/policy.json`, 16384), valid);
results.push("protected root-owned file read as unprivileged uid");
assert.equal((await readLxdOfficeProtectedImageManifestFile(`${root}/image-manifest.json`)).length, 100000);
await assert.rejects(readLxdOfficeProtectedImageManifestFile(`${root}/large-image-manifest.json`));
await assert.rejects(readLxdOfficeProtectedFile(`${root}/image-manifest.json`, 100000), /INVALID_OFFICE_FILE_LIMIT/);
for (const name of ["writable.json", "user-owned.json", "symlink.json", "hardlink.json", "unsafe/config.json"])
	await assert.rejects(readLxdOfficeProtectedImageManifestFile(`${root}/${name}`));
results.push("bounded public image inventory preserves protected reader custody and generic ceiling");
for (const name of [
	"writable.json",
	"group-writable.json",
	"user-owned.json",
	"hardlink.json",
	"oversize.json",
	"unsafe/config.json",
	"symlink.json",
	"directory.json",
	"fifo.json",
]) {
	await assert.rejects(readLxdOfficeProtectedFile(`${root}/${name}`, 16384));
	results.push(`refused ${name}`);
}
const signal = new AbortController().signal;
const gate = await LxdOfficePhysicalGate.open(`${root}/policy.json`, `${root}/evidence.json`, signal);
results.push("protected policy plus synthetic provenance loaded");
await assert.rejects(LxdOfficePhysicalGate.open(`${root}/invalid-utf8.json`, `${root}/evidence.json`, signal));
results.push("invalid UTF8 configuration refused");
// This container is not the enrolled Linux/LXD/NAS host. A loaded policy must
// not turn those synthetic configuration bytes into physical admission.
await assert.rejects(gate.check(binding, signal));
results.push("configuration alone cannot admit the disposable container");
const directory = await open(root);
try {
	const mountInfo = await readFile("/proc/self/mountinfo", "utf8");
	const fdInfo = await readFile(`/proc/self/fdinfo/${directory.fd}`, "utf8");
	const id = /^mnt_id:\s+(\d+)$/m.exec(fdInfo)![1];
	const line = mountInfo.split("\n").find((entry) => entry.startsWith(`${id} `))!;
	const [before, after] = line.split(" - ");
	const prefix = before.split(" ");
	const suffix = after.split(" ");
	assertLxdOfficeHostMount(
		mountInfo,
		fdInfo,
		{ root: "/", mountPoint: prefix[4], filesystem: suffix[0], source: suffix[1] },
		root,
	);
	results.push("actual Linux descriptor matched to actual mount");
	assert.throws(() =>
		assertLxdOfficeHostMount(mountInfo, fdInfo, policy.workbench, root, policy.workbench.serverAddress),
	);
	results.push("actual local tmpfs cannot stand in for pinned NAS");
} finally {
	await directory.close();
}
process.stdout.write(
	`${JSON.stringify({ status: "passed", uid: process.getuid!(), checks: results.length, results, physicalNasOrLxdAdmission: false })}\n`,
);
