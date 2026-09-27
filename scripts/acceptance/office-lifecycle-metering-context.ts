import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { PaidComputerGuardClient } from "../../packages/runner-orchestrator/src/computer-paid-guard-ipc.ts";
import { isRuntimePaidComputerMachine, parsePaidComputerGuardRecord, parsePaidComputerPrestartRecord } from "../../packages/runner-orchestrator/src/computer-paid-guard.ts";
import { computerPrestartRequest } from "../../packages/runner-orchestrator/src/computer-prestart-control.ts";
import { type LxdOfficeGuestBinding, lxdOfficeGuestPlan } from "../../packages/runner-orchestrator/src/lxd-office-guest.ts";
import { checkDirectory, readRecord } from "../../packages/runner-orchestrator/src/lxd-office-journal-files.ts";
import type { RuntimeComputerContext } from "../../packages/runner-orchestrator/src/runtime-computer-controller.ts";

/** Read the existing paid-start context while the caller owns the provider's
 * adoption flock. Never reconstruct or author its officeIntent, and never fund,
 * start, stop, acknowledge, or archive while selecting this identity. */
export async function readOfficeLifecycleMeteringContext(options: {
	binding: LxdOfficeGuestBinding;
	journalRoot: string;
	guard: Pick<PaidComputerGuardClient, "latest" | "prestartStatus">;
	signal: AbortSignal;
}): Promise<RuntimeComputerContext> {
	try {
		const { binding, request, instanceSha256 } = lxdOfficeGuestPlan(options.binding);
		const base: RuntimeComputerContext = { allocationId: binding.allocationId, providerKind: "office", providerId: binding.providerId,
			policySha256: binding.providerPolicySha256, instanceSha256, bootstrapSha256: binding.bootstrapSha256,
			runId: null, runnerId: null, officeId: binding.companyComputerId, computerGeneration: binding.computerGeneration };
		options.signal.throwIfAborted();
		await checkDirectory(options.journalRoot);
		const guarded = parsePaidComputerGuardRecord(await options.guard.latest(binding.allocationId, options.signal));
		if (!isRuntimePaidComputerMachine(guarded.machine) || guarded.machine.providerKind !== "office" ||
			guarded.machine.allocationId !== binding.allocationId || guarded.machine.instanceSha256 !== instanceSha256 ||
			guarded.phase !== "running" || !guarded.startSettled || guarded.startSucceeded !== true || guarded.usageRequired !== true ||
			guarded.permit.schema !== "qorpera.computer-usage-permit/v2" ||
			!isDeepStrictEqual(guarded.machine.physicalTarget, { kind: "lxd", project: binding.project, instanceName: request.name,
				profiles: request.profiles, config: request.config, devices: request.devices })) throw new Error();
		const permitId = guarded.permit.permitId;
		const path = join(options.journalRoot, `paid-start-${binding.allocationId}-${permitId}.json`);
		const retained = await readRecord(path, 131072);
		options.signal.throwIfAborted();
		const row = retained.value as { schema?: unknown; commandId?: unknown; context?: unknown } | null;
		if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).sort().join() !== "commandId,context,schema" ||
			row.schema !== "qorpera.office-paid-start/v1" || row.commandId !== permitId ||
			!row.context || typeof row.context !== "object" || Array.isArray(row.context)) throw new Error();
		const { officeIntent, ...actualBase } = row.context as Record<string, unknown>;
		if (!isDeepStrictEqual(actualBase, base) || !officeIntent || typeof officeIntent !== "object" || Array.isArray(officeIntent) ||
			Object.keys(officeIntent).length === 0) throw new Error();
		const prestart = parsePaidComputerPrestartRecord(await options.guard.prestartStatus(permitId, options.signal));
		if (prestart.state !== "dispatched" || prestart.intent.permitId !== permitId ||
			prestart.intent.allocationId !== binding.allocationId || prestart.intent.instanceSha256 !== instanceSha256 ||
			prestart.intent.hostBootId !== guarded.machine.hostBootId || prestart.intent.hostMachineIdSha256 !== guarded.machine.hostMachineIdSha256 ||
			prestart.guardIncarnationId !== guarded.permit.prestart?.guardIncarnationId ||
			prestart.intent.prepareSha256 !== guarded.permit.prestart.prepareSha256 ||
			!isDeepStrictEqual(computerPrestartRequest(prestart), { ...row.context,
				schema: "qorpera.runtime-computer-prepare/v3", usageProducer: "guard-v1", requestId: permitId,
				machineIdSha256: guarded.machine.hostMachineIdSha256, hostBootId: guarded.machine.hostBootId,
				windowMs: guarded.permit.windowMs, stopReserveMs: guarded.permit.stopReserveMs })) throw new Error();
		const reread = await readRecord(path, 131072);
		await checkDirectory(options.journalRoot);
		if (!reread.bytes.equals(retained.bytes) ||
			!isDeepStrictEqual(await options.guard.prestartStatus(permitId, options.signal), prestart) ||
			!isDeepStrictEqual(await options.guard.latest(binding.allocationId, options.signal), guarded)) throw new Error();
		options.signal.throwIfAborted();
		return structuredClone(row.context) as RuntimeComputerContext;
	} catch (error) {
		options.signal.throwIfAborted();
		throw new Error("OFFICE_ACCEPTANCE_METERING_CONTEXT_UNCONFIRMED", { cause: error });
	}
}

export type OfficeMeteringStage = "configuration" | "credential" | "paid-context" | "workload-probe";
const codes = new Set(["OFFICE_ACCEPTANCE_METERING_CONTEXT_UNCONFIRMED", "RUNTIME_COMPUTER_PRESTART_DIFFERS",
	"RUNTIME_COMPUTER_RPC_UNCONFIRMED", "RUNTIME_COMPUTER_STOP_UNCONFIRMED", "RUNTIME_COMPUTER_PERMIT_DIFFERS",
	"RUNTIME_COMPUTER_GUARD_DIFFERS", "RUNTIME_COMPUTER_CLOSURE_DIFFERS"]);

/** Only fixed stage and code literals cross the child stdout boundary. No
 * error text, cause, path, request, credential or private stderr is retained. */
export function officeLifecycleMeteringFailure(stage: OfficeMeteringStage, error: unknown) {
	return { schema: "qorpera.office-acceptance-metering-failure/v1", stage,
		code: error instanceof Error && codes.has(error.message) ? error.message : "WITHHELD" };
}
