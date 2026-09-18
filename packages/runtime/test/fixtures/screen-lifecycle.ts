import type { CompanyComputerStartupIdentity } from "@qorpera/contracts";
import { computerId, computerScope } from "./company-computer.ts";

export const screenStartup = (): CompanyComputerStartupIdentity => ({
	scope: computerScope(),
	computerGeneration: 1,
	allocationId: computerId(70),
	instanceSha256: "a".repeat(64),
	imageSha256: "b".repeat(64),
	bootstrapSha256: "c".repeat(64),
	bootId: computerId(71),
	configurationSha256: "d".repeat(64),
	serviceInvocationId: "e".repeat(32),
});
export function screenReceipt(args: Record<string, unknown>) {
	const event = args.p_event as Record<string, unknown>;
	return {
		schema: "qorpera.runtime-screen-event-receipt/v1",
		lifetimeId: event.lifetimeId,
		eventId: event.eventId,
		sequence: event.sequence,
		state: event.state,
		observedAt: event.observedAt,
		recordedAt: new Date().toISOString(),
	};
}
