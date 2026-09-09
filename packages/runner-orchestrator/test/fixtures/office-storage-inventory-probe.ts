import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, chown, link, mkdir, open, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { officeDigest } from "../../src/lxd-office-image-provenance.ts";
import type { LxdOfficeStorageObservation } from "../../src/lxd-office-inventory-worker.ts";
import { inspectOfficeStorage, type OfficeInventoryLimits } from "../../src/lxd-office-storage-inventory.ts";
import { readLxdOfficeStorageReview } from "../../src/lxd-office-storage-review.ts";

// Offline disposable tmpfs proof. It does not stand in for NFS, a writer
// fence, LXD, operator review, migration or an adopted-guest receipt.
assert.equal(process.platform, "linux");
assert.equal(process.getuid!(), 0);
const root = "/fixture";
// Explicitly synthetic operator evidence exercises the protected loader; it
// is not an actual approval, writer fence or adoption completion receipt.
const reviewed: LxdOfficeStorageObservation = {
	schema: "qorpera.lxd-office-storage-observation/v1",
	intentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	allocationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
	providerBindingSha256: "c".repeat(64),
	hostBootId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
	inventory: { schema: "qorpera.office-storage-inventory/v1", root, mountId: "111", entries: [], totalBytes: 0 },
};
const reviewBytes = JSON.stringify({
	schema: "qorpera.lxd-office-storage-review/v1",
	reviewId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
	decision: "migrate_existing",
	observationSha256: officeDigest(reviewed),
	planSha256: "f".repeat(64),
	writerFence: { state: "exclusive_writers_confirmed", evidenceSha256: "1".repeat(64) },
});
if (!process.argv.includes("--nested")) {
	for (const name of ["approved", "unsafe"])
		await writeFile(`/review/${name}.json`, reviewBytes, { mode: 0o444, flag: "wx" });
	await chown("/review/unsafe.json", 1000, 1000);
	await symlink("/review/approved.json", "/review/alias.json");
}
await chmod(root, 0o700);
if (!process.argv.includes("--nested")) await writeFile(`${root}/foreign`, "root-owned", { mode: 0o600 });
await chown(root, 1000, 1000);
process.setgroups!([]);
process.setgid!(1000);
process.setuid!(1000);
const limits: OfficeInventoryLimits = {
	maxEntries: 1000,
	maxDepth: 16,
	maxFileBytes: 16 * 1024 ** 2,
	maxTotalBytes: 24 * 1024 ** 2,
	maxManifestBytes: 1024 ** 2,
};
const source = {
	root,
	uid: 1000,
	gid: 1000,
	mount: { mountPoint: root, root: "/" as const, filesystem: "tmpfs", source: "tmpfs" },
};
const signal = () => AbortSignal.timeout(30000);
const inventory = (bounds = limits) => inspectOfficeStorage(source, bounds, signal());
const results: string[] = [];
if (process.argv.includes("--nested")) {
	await assert.rejects(inventory(), /OFFICE_HOST_MOUNT_MISMATCH/);
	console.log(
		JSON.stringify({
			schema: "qorpera.office-storage-inventory-proof/v1",
			checks: ["real nested mount refused"],
			actualNas: false,
		}),
	);
} else {
	const approved = await readLxdOfficeStorageReview("/review/approved.json", reviewed, "f".repeat(64), signal());
	assert.equal(approved.reviewSha256, createHash("sha256").update(reviewBytes).digest("hex"));
	await assert.rejects(writeFile("/review/approved.json", "forged"), { code: "EACCES" });
	for (const path of ["/review/unsafe.json", "/review/alias.json"])
		await assert.rejects(readLxdOfficeStorageReview(path, reviewed, "f".repeat(64), signal()));
	await assert.rejects(
		readLxdOfficeStorageReview(
			"/review/approved.json",
			{ ...reviewed, hostBootId: reviewed.intentId },
			"f".repeat(64),
			signal(),
		),
		/REVIEW_MISMATCH/,
	);
	results.push("protected operator document hash, ownership, alias, write and replay checks (synthetic approval)");
	await assert.rejects(inventory(), /OWNER_OR_MODE_UNSAFE/);
	results.push("foreign-owned file refused");
	await rm(`${root}/foreign`);
	const empty = await inventory();
	assert.deepEqual(
		empty.entries.map((entry) => [entry.path, entry.kind, entry.bytes, entry.sha256]),
		[[".", "directory", 0, null]],
	);
	assert.equal(empty.totalBytes, 0);
	assert.equal(officeDigest(await inventory()), officeDigest(empty));
	results.push("actual empty inventory and stable second inspection");
	await mkdir(`${root}/work`, { mode: 0o700 });
	await mkdir(`${root}/profiles`, { mode: 0o700 });
	const binary = Buffer.alloc(256 * 1024 + 11, 173);
	await writeFile(`${root}/work/å space.bin`, binary, { mode: 0o600 });
	await writeFile(`${root}/profiles/empty`, "", { mode: 0o400 });
	const scanned = await inventory();
	assert.equal(scanned.totalBytes, binary.length);
	assert.deepEqual(
		scanned.entries.map((entry) => entry.path),
		[".", "profiles", "profiles/empty", "work", "work/å space.bin"],
	);
	assert.equal(
		scanned.entries.find((entry) => entry.path.endsWith(".bin"))!.sha256,
		createHash("sha256").update(binary).digest("hex"),
	);
	assert.equal(
		scanned.entries.find((entry) => entry.path === "profiles/empty")!.sha256,
		createHash("sha256").update("").digest("hex"),
	);
	assert.equal(officeDigest(await inventory()), officeDigest(scanned));
	assert(Object.isFrozen(scanned.entries));
	assert(Object.isFrozen(scanned.entries[0]));
	assert.deepEqual(await readFile(`${root}/work/å space.bin`), binary);
	results.push("streamed binary and empty-file hashes, deterministic Unicode paths, bytes preserved");
	for (const [name, replacement] of Object.entries({
		maxEntries: 1,
		maxDepth: 1,
		maxFileBytes: 1,
		maxTotalBytes: 1,
		maxManifestBytes: 128,
	})) {
		const bounds = { ...limits, [name]: replacement };
		if (name === "maxTotalBytes") bounds.maxFileBytes = 1;
		await assert.rejects(inventory(bounds), /OFFICE_INVENTORY_LIMIT_EXCEEDED/);
		results.push(`bounded ${name}`);
	}
	for (const mount of [
		{ ...source.mount, filesystem: "nfs4" },
		{ ...source.mount, source: "wrong-source" },
	]) {
		await assert.rejects(inspectOfficeStorage({ ...source, mount }, limits, signal()), /OFFICE_HOST_MOUNT_MISMATCH/);
	}
	results.push("local storage cannot impersonate NAS or another source");
	for (const kind of [
		"symlink",
		"hardlink",
		"fifo",
		"control-name",
		"invalid-utf8",
		"writable",
		"setuid",
		"unreadable",
		"socket",
	] as const) {
		const path =
			kind === "control-name"
				? `${root}/bad\nname`
				: kind === "invalid-utf8"
					? Buffer.concat([Buffer.from(`${root}/bad-`), Buffer.from([255])])
					: `${root}/bad`;
		let server: ReturnType<typeof createServer> | undefined;
		if (kind === "symlink") await symlink("/etc/passwd", path);
		else if (kind === "hardlink") await link(`${root}/work/å space.bin`, path);
		else if (kind === "fifo") assert.equal(spawnSync("/usr/bin/mkfifo", [String(path)]).status, 0);
		else if (kind === "socket") {
			server = createServer();
			await new Promise<void>((resolve, reject) => {
				server!.once("error", reject);
				server!.listen(String(path), resolve);
			});
		} else {
			await writeFile(path, "do not adopt", { mode: 0o600 });
			if (kind === "writable") await chmod(path, 0o666);
			if (kind === "setuid") await chmod(path, 0o4700);
			if (kind === "unreadable") await chmod(path, 0);
		}
		try {
			await assert.rejects(inventory());
			results.push(`refused ${kind}`);
		} finally {
			if (server)
				await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
			await rm(path, { force: true });
		}
	}
	await chmod(root, 0o777);
	await assert.rejects(inventory(), /ROOT_UNPROTECTED/);
	await chmod(root, 0o700);
	results.push("unsafe root mode refused");
	await symlink(root, `${root}/alias`);
	await assert.rejects(
		inspectOfficeStorage(
			{ ...source, root: `${root}/alias`, mount: { ...source.mount, mountPoint: `${root}/alias` } },
			limits,
			signal(),
		),
	);
	await rm(`${root}/alias`);
	results.push("root symlink refused");
	const controller = new AbortController();
	const running = inspectOfficeStorage(source, limits, controller.signal);
	controller.abort();
	const blocked = inspectOfficeStorage(source, limits, signal());
	await Promise.all([assert.rejects(running, /INSPECTION_ABORTED/), assert.rejects(blocked, /INSPECTION_PENDING/)]);
	// Drain the real outstanding open/fstat callbacks; no replacement scan is
	// launched while the module still reports its pending syscall.
	for (let attempt = 0; ; attempt++) {
		try {
			await inventory();
			break;
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "OFFICE_INVENTORY_INSPECTION_PENDING" || attempt >= 100)
				throw error;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}
	results.push("cancellation retains the process-wide pending scan until settlement");
	await writeFile(`${root}/changing`, Buffer.alloc(12 * 1024 ** 2, 1), { mode: 0o600 });
	const writer = await open(`${root}/changing`, "r+");
	let active = true;
	const changes = (async () => {
		let value = 0;
		while (active) {
			await writer.write(Buffer.from([value++ % 256]), 0, 1, 0);
			await new Promise((resolve) => setImmediate(resolve));
		}
	})();
	try {
		await assert.rejects(inventory(), /OFFICE_INVENTORY_CHANGED/);
	} finally {
		active = false;
		await changes;
		await writer.close();
	}
	await rm(`${root}/changing`);
	results.push("concurrent content changes refused");
	assert.deepEqual((await readdir(root)).sort(), ["profiles", "work"]);
	assert.deepEqual(await readFile(`${root}/work/å space.bin`), binary);
	console.log(
		JSON.stringify({
			schema: "qorpera.office-storage-inventory-proof/v1",
			platform: process.platform,
			uid: process.getuid!(),
			checks: results,
			actualFilesystemAndMountChecks: true,
			actualNas: false,
			guestBooted: false,
			adoptionPerformed: false,
		}),
	);
}
