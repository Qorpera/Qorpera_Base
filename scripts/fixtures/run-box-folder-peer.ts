/** The node's side of the run box proof (scripts/test-run-box-systemd.mjs), bundled into one file and run inside the
 * disposable systemd container: this repository's folder service over a Unix socket, with the folder core in memory
 * (the folder service tests' FakeCore) and a stand-in for the vsock bridge that names the execution host. The box's
 * real folder unit mounts it with the real folder program; only its `--connect` differs (no vsock in a container).
 *
 *   node run-box-folder-peer.cjs <socket> <share root> <view id> <pass>
 *
 * Prints READY once it serves. SIGUSR1 writes a new version of docs/plan.md, as a member's edit would. */
import { chmod } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { NasObjects } from "../../packages/object-gateway/src/folder-service/objects.ts";
import { encodeJson, Kind } from "../../packages/object-gateway/src/folder-service/protocol.ts";
import { createFolderServer } from "../../packages/object-gateway/src/folder-service/server.ts";
import { FolderService } from "../../packages/object-gateway/src/folder-service/service.ts";
import {
	EXEC_HOST,
	FakeCore,
	folder,
	grants,
	storeFile,
} from "../../packages/object-gateway/test/folder-service-fixtures.ts";

const [socketPath, share, viewId, pass] = process.argv.slice(2);
if (!socketPath || !share || !viewId || !pass) throw new Error("Usage: run-box-folder-peer <socket> <share> <view id> <pass>");

const core = new FakeCore();
core.seed([
	folder("docs"),
	await storeFile(share, "docs/plan.md", "the plan, version one\n", 1),
	await storeFile(share, "readme.md", "hello from the company folder\n", 1),
	await storeFile(share, "tools/run.sh", "#!/bin/sh\necho ran\n", 1, 4, { executable: true }),
]);
core.openView(viewId, pass);
// A run box view acts as the run's agent: the core lists each entry with its read receipt.
core.receipts = () => ({
	resourceId: "7a6e2a1c-4b1d-4c2e-9f3a-5d6c7b8a9e01",
	resourceRevision: 1,
	grantId: "7a6e2a1c-4b1d-4c2e-9f3a-5d6c7b8a9e02",
	grantRevision: 1,
});
const service = new FolderService({ core, objects: new NasObjects({ root: share, cacheBytes: 64 * 1024 * 1024 }), grants: grants() });
const internal = `${socketPath}.service`;
const server = createFolderServer(service, () => {});
await new Promise<void>((done) => server.listen(internal, done));
// The bridge's part: name the execution host, then pass bytes through.
const bridge = createServer((machine) => {
	const upstream = connect(internal, () => {
		upstream.write(encodeJson(Kind.bridge, { cid: 7, lookup: "found", machine: EXEC_HOST }));
		machine.pipe(upstream);
		upstream.pipe(machine);
	});
	machine.on("error", () => upstream.destroy());
	upstream.on("error", () => machine.destroy());
	machine.on("close", () => upstream.destroy());
	upstream.on("close", () => machine.destroy());
});
await new Promise<void>((done) => bridge.listen(socketPath, done));
await chmod(socketPath, 0o600);
service.start();
process.on("SIGUSR1", () => {
	void storeFile(share, "docs/plan.md", "the plan, version two\n", 2).then((entry) => core.write(entry));
});
process.on("SIGTERM", () => process.exit(0));
console.log("READY");
