import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { PaidComputerGuardClient } from "../../packages/runner-orchestrator/src/computer-paid-guard-ipc.ts";
import { readPaidComputerHostClock } from "../../packages/runner-orchestrator/src/computer-paid-guard-lxd.ts";
import { parsePaidComputerArm, type PaidComputerPermit } from "../../packages/runner-orchestrator/src/computer-paid-guard.ts";
import { LxdUnixClient } from "../../packages/runner-orchestrator/src/lxd-client.ts";
import type { RuntimePaidComputerMachine } from "../../packages/runner-orchestrator/src/runtime-paid-machine.ts";

// Synthetic control-plane receipts exercise the real guard/clock/LXD boundary.
// They are not proof of SQL funding, billing, provider enrollment or office admission.
const guard = new PaidComputerGuardClient("/run/qorpera-paid-computer-guard/control.sock");
const statePath = "/var/lib/qorpera-paid-lxd-acceptance/arm.json";
const signal = AbortSignal.timeout(20000);
const action = process.argv[2];
if (action === "start") {
	const clock = await readPaidComputerHostClock();
	const instanceName = "qorpera-paid-acceptance";
	const instance = await new LxdUnixClient("/var/snap/lxd/common/lxd/unix.socket").getInstance("default", instanceName, signal);
	if (!instance || instance.status !== "Stopped" || instance.type !== "virtual-machine") throw new Error("ACCEPTANCE_VM_NOT_STOPPED");
	const config = Object.fromEntries(Object.entries(instance.config).filter(([key]) => !key.startsWith("image.") && !key.startsWith("volatile.")));
	const machine: RuntimePaidComputerMachine = {
		kind: "runtime", allocationId: randomUUID(), nodeId: randomUUID(),
		instanceSha256: createHash("sha256").update(JSON.stringify({ config, devices: instance.devices, instanceName })).digest("hex"),
		providerKind: "office", physicalTarget: { kind: "lxd", project: "default", instanceName, profiles: instance.profiles, config, devices: instance.devices },
		cpuMillis: 2000, memoryBytes: 1073741824, physicalInstanceId: instance.config["volatile.uuid"]!,
		hostMachineIdSha256: clock.hostMachineIdSha256, hostBootId: clock.hostBootId,
	};
	const permitId = randomUUID();
	const prepareRequestText = JSON.stringify({ requestId: permitId, allocationId: machine.allocationId, machineIdSha256: clock.hostMachineIdSha256, hostBootId: clock.hostBootId, instanceSha256: machine.instanceSha256 });
	const prepareSha256 = createHash("sha256").update(prepareRequestText).digest("hex");
	const prestart = await guard.registerPrestart({ schema: "qorpera.computer-prestart-intent/v1", permitId, allocationId: machine.allocationId, instanceSha256: machine.instanceSha256, hostMachineIdSha256: clock.hostMachineIdSha256, hostBootId: clock.hostBootId, prepareSha256, prepareRequestText }, signal);
	const permit: PaidComputerPermit = {
		schema: "qorpera.computer-usage-permit/v2", prestart: { guardIncarnationId: prestart.guardIncarnationId, prepareSha256 }, mode: "paid",
		permitId, allocationId: machine.allocationId, instanceSha256: machine.instanceSha256, nodeId: machine.nodeId,
		epoch: randomUUID(), generation: 1, reservationId: randomUUID(), hostBootId: clock.hostBootId,
		guestBootId: null, physicalId: null, issuedAt: new Date().toISOString(), deadline: new Date(Date.now() + 180000).toISOString(),
		state: "prepared", validForMs: 180000, windowMs: 300000, stopReserveMs: 30000, tariffVersion: 1,
		cpuMillis: machine.cpuMillis, memoryBytes: machine.memoryBytes,
	};
	const arm = { machine, permit, requestStartedUptimeMs: prestart.requestStartedUptimeMs };
	await writeFile(statePath, JSON.stringify(arm), { mode: 0o600, flag: "wx" });
	const armed = await guard.arm(arm, signal);
	const start = await guard.start(permitId, 1, signal);
	console.log(JSON.stringify({ armed, start }));
} else {
	const arm = parsePaidComputerArm(JSON.parse(await readFile(statePath, "utf8")));
	if (action === "status") console.log(JSON.stringify(await guard.status(arm.permit.permitId, signal)));
	else if (action === "rearm") {
		// Same generation with a newly sampled request clock must not extend custody.
		console.log(JSON.stringify(await guard.arm({ ...arm, requestStartedUptimeMs: (await readPaidComputerHostClock()).uptimeMs }, signal)));
	} else throw new Error("ACCEPTANCE_ACTION_INVALID");
}
