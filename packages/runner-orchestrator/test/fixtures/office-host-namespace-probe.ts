import assert from "node:assert/strict";
import { readFile, readlink } from "node:fs/promises";
import { assertLxdOfficeHostNamespace } from "../../src/lxd-office-physical-host.ts";

async function main(): Promise<void> {
	assert.equal(process.platform, "linux");
	assert.notEqual(process.geteuid?.(), 0);
	await assert.rejects(
		readlink("/proc/1/ns/mnt"),
		(error: NodeJS.ErrnoException) => error.code === "EACCES" || error.code === "EPERM",
	);
	const status = await readFile("/proc/self/status", "utf8");
	for (const name of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"])
		assert.match(status, new RegExp(`^${name}:\\s+0+$`, "m"));
	assert.match(status, /^NoNewPrivs:\s+1$/m);
	const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
	if (process.argv[2] === "reject") {
		await assert.rejects(assertLxdOfficeHostNamespace(bootId));
		console.log("HOST_NAMESPACE_REJECTED");
	} else {
		assert.equal(await assertLxdOfficeHostNamespace(bootId), await readlink("/proc/self/ns/mnt"));
		console.log("HOST_NAMESPACE_ACCEPTED_WITH_ZERO_CAPABILITIES");
	}
}

void main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
