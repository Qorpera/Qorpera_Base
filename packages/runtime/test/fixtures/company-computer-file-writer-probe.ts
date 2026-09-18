import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeCompanyComputerWorkbenchFile } from "../../src/cloud-company-computer-file-writer.ts";

assert.equal(process.platform, "linux");
assert.equal(process.getuid!(), 1000);
const base = await mkdtemp("/tmp/office-import-"),
	workbench = join(base, "workbench"),
	privateRoot = join(base, "screens"),
	outside = join(base, "outside");
for (const path of [workbench, privateRoot, outside]) await mkdir(path, { mode: 0o700 });
const root = await open(workbench, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
const staging = await open(privateRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bytes = Buffer.from([0, 255, 1, 10, 128]),
	signal = new AbortController().signal;
const put = (path: string, data = bytes, checked = signal) =>
	writeCompanyComputerWorkbenchFile(root, staging, { path, bytes: data, sha256: hash(data) }, checked);
let refused = 0;
async function rejects(path: string) {
	await assert.rejects(put(path));
	refused++;
}
try {
	await mkdir(join(workbench, "incoming"), { mode: 0o700 });
	const path = 'incoming/`literal` $(name); "file".bin';
	assert.deepEqual(await put(path), { path, bytes: bytes.length, sha256: hash(bytes) });
	assert.deepEqual(await readFile(join(workbench, path)), bytes);
	await put("empty", Buffer.alloc(0));
	assert.equal((await readFile(join(workbench, "empty"))).length, 0);
	await rejects(path);
	assert.deepEqual(await readFile(join(workbench, path)), bytes);
	await writeFile(join(outside, "sentinel"), "PRIVATE_SENTINEL");
	await symlink(outside, join(workbench, "directory-link"));
	await rejects("directory-link/new");
	await symlink(join(outside, "sentinel"), join(workbench, "file-link"));
	await rejects("file-link");
	for (const path of ["../outside/new", "/tmp/escape", "missing/new", "incoming"]) await rejects(path);
	await assert.rejects(
		writeCompanyComputerWorkbenchFile(root, root, { path: "unsafe", bytes, sha256: hash(bytes) }, signal),
	);
	refused++;
	await assert.rejects(
		writeCompanyComputerWorkbenchFile(root, staging, { path: "bad-hash", bytes, sha256: "f".repeat(64) }, signal),
	);
	refused++;
	await assert.rejects(put("too-large", Buffer.alloc(8 * 1024 * 1024 + 1)));
	refused++;
	const stop = new AbortController();
	stop.abort();
	await assert.rejects(put("cancelled", bytes, stop.signal));
	refused++;
	const contenders = await Promise.allSettled([put("race", Buffer.from("one")), put("race", Buffer.from("two"))]);
	assert.equal(contenders.filter((entry) => entry.status === "fulfilled").length, 1);
	assert.equal(contenders.filter((entry) => entry.status === "rejected").length, 1);
	const winner = contenders.findIndex((entry) => entry.status === "fulfilled");
	assert.equal(await readFile(join(workbench, "race"), "utf8"), winner === 0 ? "one" : "two");
	const prototype = Object.getPrototypeOf(root),
		originalWrite = prototype.write;
	let chunks = 0;
	prototype.write = async function (...args: unknown[]) {
		const result = await originalWrite.apply(this, args);
		chunks++;
		await assert.rejects(readFile(join(workbench, "atomic")), { code: "ENOENT" });
		return result;
	};
	try {
		await put("atomic", Buffer.alloc(131073, 7));
	} finally {
		prototype.write = originalWrite;
	}
	assert(chunks >= 3);
	assert.equal((await readFile(join(workbench, "atomic"))).length, 131073);
	await mkdir(join(workbench, "moving"), { mode: 0o700 });
	let move = true;
	prototype.write = async function (...args: unknown[]) {
		const result = await originalWrite.apply(this, args);
		if (move) {
			move = false;
			await rename(join(workbench, "moving"), join(outside, "moved"));
		}
		return result;
	};
	try {
		await rejects("moving/new");
	} finally {
		prototype.write = originalWrite;
	}
	await assert.rejects(readFile(join(outside, "moved/new")), { code: "ENOENT" });
	// Alter the public inode after publication: completion must fail, but the
	// writer must not delete a file that other work has already changed.
	const originalRead = prototype.read;
	let mutate = true;
	prototype.read = async function (...args: unknown[]) {
		const result = await originalRead.apply(this, args);
		if (mutate) {
			mutate = false;
			await writeFile(join(workbench, "changed"), "FOREIGN_WORK");
		}
		return result;
	};
	try {
		await rejects("changed");
	} finally {
		prototype.read = originalRead;
	}
	assert.equal(await readFile(join(workbench, "changed"), "utf8"), "FOREIGN_WORK");
	assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "PRIVATE_SENTINEL");
	assert.deepEqual(await readdir(privateRoot), []);
	console.log(
		JSON.stringify({
			schema: "qorpera.office-file-writer-proof/v1",
			uid: process.getuid!(),
			binaryBytes: bytes.length,
			emptyFile: true,
			refused,
			concurrentWinners: 1,
			atomicVisibility: true,
			privateSentinelUnchanged: true,
			changedPublicFilePreserved: true,
			stagingEmpty: true,
			mountAdmission: "fixture",
			production: false,
		}),
	);
} finally {
	await Promise.all([root.close(), staging.close()]);
	await rm(base, { recursive: true, force: true });
}
