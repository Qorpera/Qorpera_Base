import { officeRecord, officeSha } from "./lxd-office-image-provenance.ts";

export interface ComputerUsageSample {
	schema: "qorpera.computer-usage-sample/v1";
	nodeId: string;
	machineIdSha256: string;
	allocationId: string;
	instanceSha256: string;
	observationId: string;
	observerId: string;
	previousObservationId: string | null;
	hostBootId: string;
	physicalId: string | null;
	guestBootId: string | null;
	uptimeMs: number | null;
	observedAt: string;
	state: "running" | "gap";
	reason: "running" | "not_running" | "missing" | "unconfirmed";
}
export type ComputerUsageMethod = "qorpera_observe_computer_usage" | "qorpera_read_node_computer_usage";
export interface ComputerUsageRegistry {
	call(method: ComputerUsageMethod, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}
export function usageUuid(value: unknown): string {
	if (
		typeof value !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
	)
		throw new Error("COMPUTER_USAGE_ID_INVALID");
	return value;
}
export function parseComputerUsageSample(value: unknown): ComputerUsageSample {
	const r = officeRecord(value, [
		"schema",
		"nodeId",
		"machineIdSha256",
		"allocationId",
		"instanceSha256",
		"observationId",
		"observerId",
		"previousObservationId",
		"hostBootId",
		"physicalId",
		"guestBootId",
		"uptimeMs",
		"observedAt",
		"state",
		"reason",
	]);
	if (
		r.schema !== "qorpera.computer-usage-sample/v1" ||
		(r.state !== "running" && r.state !== "gap") ||
		typeof r.reason !== "string" ||
		!["running", "not_running", "missing", "unconfirmed"].includes(r.reason) ||
		typeof r.observedAt !== "string" ||
		!Number.isFinite(Date.parse(r.observedAt)) ||
		new Date(r.observedAt).toISOString() !== r.observedAt ||
		(r.uptimeMs !== null && (!Number.isSafeInteger(r.uptimeMs) || Number(r.uptimeMs) < 0)) ||
		(r.state === "running"
			? r.reason !== "running" || r.physicalId === null || r.guestBootId === null || r.uptimeMs === null
			: r.reason === "running" || r.guestBootId !== null || r.uptimeMs !== null)
	)
		throw new Error("COMPUTER_USAGE_SAMPLE_INVALID");
	return {
		schema: r.schema,
		nodeId: usageUuid(r.nodeId),
		machineIdSha256: officeSha(r.machineIdSha256),
		allocationId: usageUuid(r.allocationId),
		instanceSha256: officeSha(r.instanceSha256),
		observationId: usageUuid(r.observationId),
		observerId: usageUuid(r.observerId),
		previousObservationId: r.previousObservationId === null ? null : usageUuid(r.previousObservationId),
		hostBootId: usageUuid(r.hostBootId),
		physicalId: r.physicalId === null ? null : usageUuid(r.physicalId),
		guestBootId: r.guestBootId === null ? null : usageUuid(r.guestBootId),
		uptimeMs: r.uptimeMs as number | null,
		observedAt: r.observedAt,
		state: r.state,
		reason: r.reason as ComputerUsageSample["reason"],
	};
}
