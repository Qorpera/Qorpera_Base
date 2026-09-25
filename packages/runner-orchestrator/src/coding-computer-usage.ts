import type { CodingSessionClaim } from "./coding-executor.ts";
import type { CodingMachineJournalPlan, LxdCodingMachineBinding } from "./coding-machine.ts";
import type { LxdOperationReference } from "./lxd-client.ts";

/** Paid run authority is additional to session, repository and node authority.
 * Every physical start/stop is dispatched through the independent local guard. */
export interface CodingComputerUsage {
	ensure(claim: CodingSessionClaim, machine: Readonly<LxdCodingMachineBinding>, signal: AbortSignal): Promise<void>;
	manages(machineId: string): boolean;
	ownsStart(machineId: string, signal: AbortSignal): Promise<boolean>;
	abandonClaim(
		claim: CodingSessionClaim,
		machine: Readonly<LxdCodingMachineBinding>,
		signal: AbortSignal,
	): Promise<void>;
	start(machineId: string, signal: AbortSignal): Promise<LxdOperationReference>;
	stop(machineId: string, signal: AbortSignal): Promise<LxdOperationReference>;
	observe(machineId: string, signal: AbortSignal): Promise<void>;
	maintain(signal: AbortSignal): Promise<void>;
	externalStop(journal: CodingMachineJournalPlan, signal: AbortSignal): Promise<LxdOperationReference | null>;
	externalStart(
		journal: CodingMachineJournalPlan,
		signal: AbortSignal,
	): Promise<{
		reference: LxdOperationReference;
		settled: boolean;
		stopReference: LxdOperationReference | null;
	} | null>;
}
