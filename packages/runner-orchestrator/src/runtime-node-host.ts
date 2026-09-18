import { createHash } from "node:crypto";
import { cpus, totalmem } from "node:os";
import { readLxdOfficeProtectedFile } from "./lxd-office-physical-host.ts";

export interface RuntimeNodeHost {
	machineIdSha256: string;
	cpuMillis: number;
	memoryBytes: number;
}

/** Fixed protected local host identity; never a caller-selected path or a
 * member/model assertion. This is hardware evidence, not an inventory or a
 * capacity grant. The host publisher must account for all physical resources. */
export async function readRuntimeNodeHost(signal: AbortSignal): Promise<RuntimeNodeHost> {
	signal.throwIfAborted();
	const started = performance.now();
	try {
		if (process.platform !== "linux") throw new Error();
		const machine = new TextDecoder("utf8", { fatal: true }).decode(
			await readLxdOfficeProtectedFile("/etc/machine-id", 64),
		);
		const cpuMillis = cpus().length * 1000,
			memoryBytes = totalmem();
		signal.throwIfAborted();
		if (
			!/^[0-9a-f]{32}\n?$/.test(machine) ||
			/^0{32}\n?$/.test(machine) ||
			!Number.isSafeInteger(cpuMillis) ||
			cpuMillis < 1000 ||
			cpuMillis > 1024000 ||
			!Number.isSafeInteger(memoryBytes) ||
			memoryBytes < 1048576 ||
			memoryBytes > 1125899906842624 ||
			performance.now() - started >= 5000
		)
			throw new Error();
		return { machineIdSha256: createHash("sha256").update(machine.trim()).digest("hex"), cpuMillis, memoryBytes };
	} catch {
		throw new Error("RUNTIME_NODE_HOST_UNCONFIRMED");
	}
}
