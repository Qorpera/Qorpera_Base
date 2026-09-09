import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, chown, mkdir, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { captureLxdOfficeHostNamespace } from "../../src/lxd-office-host-namespace.ts";
import { inspectLxdHostInventorySocket } from "../../src/lxd-office-physical-host.ts";
import { readRuntimeNodeHost } from "../../src/runtime-node-host.ts";

// Actual Linux custody checks in a disposable offline container. Its machine
// ID and sockets are explicit fixture resources, never a production host.
async function main() {
	assert.equal(process.platform, "linux");
	assert.equal(process.getuid!(), 0);
	const machine = "1234567890abcdef1234567890abcdef";
	await writeFile("/etc/machine-id", `${machine}\n`, { mode: 0o444 });
	await captureLxdOfficeHostNamespace();
	const host = {
		machineIdSha256: createHash("sha256").update(machine).digest("hex"),
		socketPath: "/fixture/lxd.socket",
		socketGid: 2000,
	};
	await assert.rejects(inspectLxdHostInventorySocket(host, new AbortController().signal), /UNPRIVILEGED/);
	await mkdir("/fixture/unsafe", { mode: 0o777 });
	await chmod("/fixture/unsafe", 0o777);
	const servers = [];
	for (const path of [host.socketPath, "/fixture/writable.socket", "/fixture/unsafe/lxd.socket"]) {
		const server = createServer();
		await new Promise<void>((done) => server.listen(path, done));
		servers.push(server);
		await chown(path, 0, 2000);
		await chmod(path, path.includes("writable") ? 0o666 : 0o660);
	}
	await symlink(host.socketPath, "/fixture/linked.socket");
	process.setgroups!([2000]);
	process.setgid!(1000);
	process.setuid!(1000);
	const first = await inspectLxdHostInventorySocket(host, new AbortController().signal);
	assert.deepEqual(await inspectLxdHostInventorySocket(host, new AbortController().signal), first);
	assert.equal(first.socket.uid, 0);
	assert.equal(first.socket.gid, 2000);
	assert.equal(first.socket.mode & 0o7777, 0o660);
	const hardware = await readRuntimeNodeHost(new AbortController().signal);
	assert.equal(hardware.machineIdSha256, host.machineIdSha256);
	assert(hardware.cpuMillis >= 1000 && hardware.memoryBytes > 0);
	for (const altered of [
		{ ...host, socketGid: 2001 },
		{ ...host, machineIdSha256: "a".repeat(64) },
		...["writable.socket", "unsafe/lxd.socket", "linked.socket"].map((name) => ({
			...host,
			socketPath: `/fixture/${name}`,
		})),
	])
		await assert.rejects(inspectLxdHostInventorySocket(altered, new AbortController().signal));
	await assert.rejects(inspectLxdHostInventorySocket(host, AbortSignal.abort()));
	for (const server of servers) await new Promise<void>((done) => server.close(() => done()));
	console.log(
		JSON.stringify({
			schema: "qorpera.node-inventory-host-proof/v1",
			actualLinuxCustody: true,
			nonRootObservation: true,
			protectedSocket: true,
			bootAndNamespace: true,
			machineIdHashed: true,
			unprotectedAndSubstitutedPathsRefused: true,
			hardwareMeasured: true,
			host: "disposable fixture",
		}),
	);
}
main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
