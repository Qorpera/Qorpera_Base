import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { open, readFile, statfs, truncate, writeFile } from "node:fs/promises";
import { PaidComputerGuardClient } from "../../packages/runner-orchestrator/src/computer-paid-guard-ipc.ts";
import { readPaidComputerHostClock } from "../../packages/runner-orchestrator/src/computer-paid-guard-lxd.ts";
import { parsePaidComputerArm, type PaidComputerPermit, type PaidComputerPrestartRecord } from "../../packages/runner-orchestrator/src/computer-paid-guard.ts";
import { LxdUnixClient } from "../../packages/runner-orchestrator/src/lxd-client.ts";
import type { RuntimePaidComputerMachine } from "../../packages/runner-orchestrator/src/runtime-paid-machine.ts";

// Real physical custody with explicitly synthetic control-plane receipts.
// This fixture does not establish paid SQL funding or financial settlement.
const guard = new PaidComputerGuardClient("/run/qorpera-paid-computer-guard/control.sock");
const action = process.argv[2], scenario = process.argv[3];
assert(["full", "tail", "history"].includes(scenario));
const fixtureRoot = "/var/lib/qorpera-paid-lxd-disk-acceptance";
const statePath = `${fixtureRoot}/${scenario}-arm.json`;
const filler = "/var/lib/qorpera-paid-computer-guard/filler.bin";
const signal = () => AbortSignal.timeout(20000);
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function closure(entry: PaidComputerPrestartRecord) {
	return { schema: "qorpera.computer-abandonment-receipt/v1", permitId: entry.intent.permitId, state: "abandoned_before_dispatch", abandonment: entry.abandonment, reservationReleased: true, debitedUs: "0", releasedUs: "330000000" };
}
async function unused() {
	const host = await readPaidComputerHostClock(), permitId = randomUUID(), allocationId = randomUUID();
	const instanceSha256 = digest(`unused:${permitId}`);
	const prepareRequestText = JSON.stringify({ requestId: permitId, allocationId, machineIdSha256: host.hostMachineIdSha256, hostBootId: host.hostBootId, instanceSha256, fixturePadding: "x".repeat(2048) });
	const intent = { schema: "qorpera.computer-prestart-intent/v1" as const, permitId, allocationId, instanceSha256, hostMachineIdSha256: host.hostMachineIdSha256, hostBootId: host.hostBootId, prepareRequestText, prepareSha256: digest(prepareRequestText) };
	await guard.registerPrestart(intent, signal());
	return guard.abandonPrestart(intent, signal());
}
if (action === "fill") {
	const file = await open(filler, "wx", 0o600);
	let bytes = 0, errno = "";
	try {
		const block = Buffer.alloc(1024 * 1024, 0x61);
		while (bytes < 1024 ** 3) {
			try { bytes += (await file.write(block)).bytesWritten; }
			catch (error) { errno = String((error as NodeJS.ErrnoException).code); if (errno !== "ENOSPC") throw error; break; }
		}
		await file.sync().catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOSPC") throw error; errno = "ENOSPC"; });
		assert.equal(errno, "ENOSPC", "The isolated filesystem must actually reach ENOSPC");
		if (scenario === "tail") await file.truncate(Math.max(0, (await file.stat()).size - 16384));
		await file.sync();
	} finally { await file.close(); }
	const capacity = await statfs(filler);
	console.log(JSON.stringify({ errno, bytes, freeBytes: capacity.bavail * capacity.bsize }));
} else if (action === "free") {
	await truncate(filler, 0);
	const file = await open(filler, "r+");
	try { await file.sync(); } finally { await file.close(); }
	console.log(JSON.stringify({ freed: true }));
} else if (action === "padding") {
	const entries = [];
	for (let index = 0; index < 64; index++) entries.push(await unused());
	await writeFile(`${fixtureRoot}/padding.json`, JSON.stringify(entries), { mode: 0o600, flag: "wx" });
	console.log(JSON.stringify({ count: entries.length }));
} else if (action === "tail-archive") {
	const entries: PaidComputerPrestartRecord[] = JSON.parse(await readFile(`${fixtureRoot}/padding.json`, "utf8"));
	let rejected = false;
	try { await guard.archive(entries[0].intent.permitId, closure(entries[0]), signal()); }
	catch { rejected = true; }
	assert(rejected, "Archive anchor must fail on the genuinely full journal filesystem");
	console.log(JSON.stringify({ rejected, permitId: entries[0].intent.permitId }));
} else if (action === "history") {
	const entries: PaidComputerPrestartRecord[] = JSON.parse(await readFile(`${fixtureRoot}/padding.json`, "utf8"));
	for (const entry of entries) await guard.archive(entry.intent.permitId, closure(entry), signal());
	const start = Date.now(), count = 4097;
	for (let index = 0; index < count; index++) {
		const entry = await unused();
		await guard.archive(entry.intent.permitId, closure(entry), signal());
	}
	console.log(JSON.stringify({ count: count + entries.length, elapsedMs: Date.now() - start, generatedBy: "real register/abandon/archive IPC calls with synthetic zero-debit SQL acknowledgements" }));
} else if (action === "start") {
	const clock = await readPaidComputerHostClock(), instanceName = "qorpera-paid-disk-acceptance";
	const instance = await new LxdUnixClient("/var/snap/lxd/common/lxd/unix.socket").getInstance("default", instanceName, signal());
	assert(instance && instance.status === "Stopped" && instance.type === "virtual-machine");
	const config = Object.fromEntries(Object.entries(instance.config).filter(([key]) => !key.startsWith("image.") && !key.startsWith("volatile.")));
	const machine: RuntimePaidComputerMachine = {
		kind: "runtime", allocationId: randomUUID(), nodeId: randomUUID(), instanceSha256: digest(JSON.stringify({ config, devices: instance.devices, instanceName })),
		providerKind: "office", physicalTarget: { kind: "lxd", project: "default", instanceName, profiles: instance.profiles, config, devices: instance.devices },
		cpuMillis: 2000, memoryBytes: 1073741824, physicalInstanceId: instance.config["volatile.uuid"]!, hostMachineIdSha256: clock.hostMachineIdSha256, hostBootId: clock.hostBootId,
	};
	const permitId = randomUUID(), prepareRequestText = JSON.stringify({ requestId: permitId, allocationId: machine.allocationId, machineIdSha256: clock.hostMachineIdSha256, hostBootId: clock.hostBootId, instanceSha256: machine.instanceSha256 });
	const prepareSha256 = digest(prepareRequestText);
	const prestart = await guard.registerPrestart({ schema: "qorpera.computer-prestart-intent/v1", permitId, allocationId: machine.allocationId, instanceSha256: machine.instanceSha256, hostMachineIdSha256: clock.hostMachineIdSha256, hostBootId: clock.hostBootId, prepareSha256, prepareRequestText }, signal());
	const validForMs = scenario === "tail" ? 180000 : 90000;
	const permit: PaidComputerPermit = {
		schema: "qorpera.computer-usage-permit/v2", prestart: { guardIncarnationId: prestart.guardIncarnationId, prepareSha256 }, mode: "paid", permitId,
		allocationId: machine.allocationId, instanceSha256: machine.instanceSha256, nodeId: machine.nodeId, epoch: randomUUID(), generation: 1, reservationId: randomUUID(), hostBootId: clock.hostBootId,
		guestBootId: null, physicalId: null, issuedAt: new Date().toISOString(), deadline: new Date(Date.now() + validForMs).toISOString(), state: "prepared", validForMs, windowMs: 300000, stopReserveMs: 30000, tariffVersion: 1, cpuMillis: machine.cpuMillis, memoryBytes: machine.memoryBytes,
	};
	const arm = { machine, permit, requestStartedUptimeMs: prestart.requestStartedUptimeMs };
	await writeFile(statePath, JSON.stringify(arm), { mode: 0o600, flag: "wx" });
	const armed = await guard.arm(arm, signal()), start = await guard.start(permitId, 1, signal());
	console.log(JSON.stringify({ armed, start }));
} else {
	const arm = parsePaidComputerArm(JSON.parse(await readFile(statePath, "utf8")));
	if (action === "status") console.log(JSON.stringify(await guard.status(arm.permit.permitId, signal())));
	else if (action === "stop") console.log(JSON.stringify(await guard.stop(arm.permit.permitId, signal())));
	else throw new Error("ACCEPTANCE_ACTION_INVALID");
}
