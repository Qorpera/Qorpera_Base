import type { CompanyComputerStartupIdentity } from "@qorpera/contracts";

/** Trusted provider composition: obtain a fresh capability-bound challenge,
 * independently measure the exact root process/code, and acknowledge it before
 * the original inspection deadline. This port never starts or activates. */
export type LxdOfficeInvocationMeasurement = (
	activationId: string,
	startup: Readonly<CompanyComputerStartupIdentity>,
	deadline: number,
	signal: AbortSignal,
) => Promise<void>;
