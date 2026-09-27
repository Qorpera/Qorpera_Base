import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	chmod,
	chown,
	link,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	symlink,
	truncate,
	writeFile,
} from "node:fs/promises";
import { COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH as path } from "@qorpera/contracts";
import { openCompanyComputerInstalledServiceSoftware } from "../../src/cloud-company-computer-service-software-file.ts";

import { assertLinuxRootProbeCustody } from "./linux-root-probe-custody.ts";

assert.equal(process.platform, "linux", "Physical filesystem probe requires Linux");
assert.equal(process.getuid?.(), 0, "Physical ownership probe requires isolated root");
await assertLinuxRootProbeCustody();

const directory = "/opt/qorpera-office",
	body = Buffer.from("export const reviewed = 1;\n");
const signal = () => new AbortController().signal;
async function fixture() {
	await rm(directory, { recursive: true, force: true });
	await rm(`${directory}-old`, { recursive: true, force: true });
	await mkdir(directory, { mode: 0o755 });
	await writeFile(path, body, { mode: 0o444 });
}
let checks = 0;
await fixture();
const descriptorCount = (await readdir("/proc/self/fd")).length;
{
	const measured = await openCompanyComputerInstalledServiceSoftware(signal());
	try {
		assert.deepEqual(measured.service, {
			path,
			bytes: body.length,
			sha256: createHash("sha256").update(body).digest("hex"),
		});
		await measured.verify();
		assert.deepEqual(await readFile(path), body);
	} finally {
		await measured.close();
	}
	checks++;
}
for (const fault of [
	"symlink",
	"hardlink",
	"mode",
	"owner",
	"group",
	"empty",
	"large",
	"parent-mode",
	"parent-link",
	"directory",
]) {
	await fixture();
	if (fault === "symlink") {
		await rename(path, `${path}.saved`);
		await symlink(`${path}.saved`, path);
	}
	if (fault === "hardlink") await link(path, `${path}.linked`);
	if (fault === "mode") await chmod(path, 0o644);
	if (fault === "owner") await chown(path, 1000, 0);
	if (fault === "group") await chown(path, 0, 1000);
	if (fault === "empty") await truncate(path, 0);
	if (fault === "large") await truncate(path, 33554433);
	if (fault === "parent-mode") await chmod(directory, 0o777);
	if (fault === "parent-link") {
		await rename(directory, `${directory}-old`);
		await symlink(`${directory}-old`, directory);
	}
	if (fault === "directory") {
		await rm(path);
		await mkdir(path, { mode: 0o444 });
	}
	await assert.rejects(openCompanyComputerInstalledServiceSoftware(signal()));
	checks++;
}
for (const fault of ["replacement", "rewrite", "parent-replacement", "mode-after-open"]) {
	await fixture();
	const measured = await openCompanyComputerInstalledServiceSoftware(signal());
	try {
		if (fault === "replacement") {
			await rename(path, `${path}.saved`);
			await writeFile(path, body, { mode: 0o444 });
		}
		if (fault === "rewrite") await writeFile(path, body);
		if (fault === "parent-replacement") {
			await rename(directory, `${directory}-old`);
			await mkdir(directory, { mode: 0o755 });
			await writeFile(path, body, { mode: 0o444 });
		}
		if (fault === "mode-after-open") await chmod(path, 0o644);
		await assert.rejects(measured.verify());
	} finally {
		await measured.close();
	}
	checks++;
}
await fixture();
{
	const controller = new AbortController(),
		measured = await openCompanyComputerInstalledServiceSoftware(controller.signal);
	controller.abort();
	try {
		await assert.rejects(measured.verify());
	} finally {
		await measured.close();
	}
	checks++;
}
// Actual fd read interference after the first chunk must invalidate measurement.
{
	await fixture();
	const handle = await open(path, "r");
	const prototype = Object.getPrototypeOf(handle) as { read: typeof handle.read },
		original = prototype.read;
	await handle.close();
	let injected = false;
	prototype.read = async function (this: typeof handle, ...args: Parameters<typeof original>) {
		const result = await original.apply(this, args);
		if (!injected) {
			injected = true;
			await writeFile(path, Buffer.concat([body, Buffer.from("changed")]));
		}
		return result;
	} as typeof original;
	try {
		await assert.rejects(openCompanyComputerInstalledServiceSoftware(signal()));
		assert(injected);
	} finally {
		prototype.read = original;
	}
	checks++;
}
assert.equal((await readdir("/proc/self/fd")).length, descriptorCount, "measurement leaked descriptors");
console.log(
	JSON.stringify({ checks, actualLinuxFileDescriptors: true, fixedRootOwnedPath: true, runtimeOrSqlAuthority: false }),
);
