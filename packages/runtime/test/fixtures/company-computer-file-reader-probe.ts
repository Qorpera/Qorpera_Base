import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { link, mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readCompanyComputerWorkbenchFile } from "../../src/cloud-company-computer-file-reader.ts";

assert.equal(process.platform, "linux");
assert.equal(process.getuid!(), 1000);
const base = await mkdtemp("/tmp/office-file-"),
	rootPath = join(base, "workbench"),
	outside = join(base, "outside");
await mkdir(rootPath, { mode: 0o700 });
await mkdir(outside, { mode: 0o700 });
const root = await open(rootPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
const signal = new AbortController().signal;
const read = (path: string) => readCompanyComputerWorkbenchFile(root, path, signal);
let refused = 0;
async function rejects(path: string) {
	await assert.rejects(read(path));
	refused++;
}
try {
	await mkdir(join(rootPath, "output"), { mode: 0o700 });
	const bytes = Buffer.from([0, 255, 1, 2, 10]);
	const name = 'output/`quote` $(value) "name".bin';
	await writeFile(join(rootPath, name), bytes, { mode: 0o600 });
	assert.deepEqual(Buffer.from(await read(name)), bytes);
	await writeFile(join(rootPath, "empty"), "", { mode: 0o600 });
	assert.equal((await read("empty")).length, 0);
	await writeFile(join(outside, "secret"), "PRIVATE_SENTINEL", { mode: 0o600 });
	await symlink(join(outside, "secret"), join(rootPath, "file-link"));
	await rejects("file-link");
	await symlink(outside, join(rootPath, "dir-link"));
	await rejects("dir-link/secret");
	await link(join(outside, "secret"), join(rootPath, "hard-link"));
	await rejects("hard-link");
	await rejects("../outside/secret");
	await rejects("/etc/passwd");
	await rejects("output");
	assert.equal(spawnSync("mkfifo", [join(rootPath, "fifo")]).status, 0);
	await rejects("fifo");
	const large = await open(join(rootPath, "large"), "wx", 0o600);
	await large.truncate(8 * 1024 * 1024 + 1);
	await large.close();
	await rejects("large");
	const changed = join(rootPath, "changing");
	await writeFile(changed, Buffer.alloc(131072, 1), { mode: 0o600 });
	// Deterministic fault injection between real reads: mutate the actual inode.
	const prototype = Object.getPrototypeOf(root),
		originalRead = prototype.read;
	let mutate = true;
	prototype.read = async function (...args: unknown[]) {
		const result = await originalRead.apply(this, args);
		if (mutate) {
			mutate = false;
			await writeFile(changed, Buffer.alloc(131072, 2));
		}
		return result;
	};
	try {
		await rejects("changing");
	} finally {
		prototype.read = originalRead;
	}
	// A retained directory descriptor must not release bytes after being moved
	// outside the workbench, even though the descriptor itself remains usable.
	await mkdir(join(rootPath, "moving"), { mode: 0o700 });
	await writeFile(join(rootPath, "moving/file"), bytes, { mode: 0o600 });
	let move = true;
	prototype.read = async function (...args: unknown[]) {
		const result = await originalRead.apply(this, args);
		if (move) {
			move = false;
			await rename(join(rootPath, "moving"), join(outside, "moved"));
		}
		return result;
	};
	try {
		await rejects("moving/file");
	} finally {
		prototype.read = originalRead;
	}
	const stop = new AbortController();
	stop.abort();
	await assert.rejects(readCompanyComputerWorkbenchFile(root, "empty", stop.signal));
	refused++;
	assert.equal(await readFile(join(outside, "secret"), "utf8"), "PRIVATE_SENTINEL");
	console.log(
		JSON.stringify({
			schema: "qorpera.office-file-reader-proof/v1",
			uid: process.getuid!(),
			binaryBytes: bytes.length,
			emptyFile: true,
			refused,
			privateSentinelUnchanged: true,
			production: false,
		}),
	);
} finally {
	await root.close();
	await rm(base, { recursive: true, force: true });
}
