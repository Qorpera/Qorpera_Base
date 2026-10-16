import type { CloudRunnerExecutionUsage } from "@qorpera/cloud-client/cloud-runner-usage";
import type { JsonValue } from "@qorpera/contracts";

export interface CloudRunnerSandboxLimits {
	wallTimeMs: number;
	memoryBytes: number;
	cpuCount: number;
	maxPids: number;
	maxInputBytes: number;
	maxOutputBytes: number;
	maxResultBytes: number;
}

export const DEFAULT_CLOUD_RUNNER_SANDBOX_LIMITS: Readonly<CloudRunnerSandboxLimits> = Object.freeze({
	// No runner lane enforces this 24 h wall time since the whole-tree sandbox lane went (legacy
	// sweep C-R7): native company runs have no wall-clock deadline (founder, 2026-09-24).
	wallTimeMs: 24 * 60 * 60 * 1000,
	memoryBytes: 2 * 1024 * 1024 * 1024,
	cpuCount: 2,
	maxPids: 256,
	maxInputBytes: 16 * 1024 * 1024 * 1024,
	maxOutputBytes: 256 * 1024 * 1024,
	maxResultBytes: 32 * 1024,
});

export interface CloudRunnerSandboxGuarantees {
	boundary: "test" | "rootless_container" | "virtual_machine" | "microvm";
	hostFilesystem: "none";
	inputFilesystem: "read_only";
	companyCheckout: "job_private";
	outputFilesystem: "job_private";
	network: "deny_by_default";
	environment: "allowlist_only";
	privileges: "unprivileged";
	resourceLimits: "kernel_enforced";
	termination: "boundary_destroyed";
}

export interface CloudRunnerSandboxProcess {
	readonly result: Promise<JsonValue>;
	terminate(reason: "cancelled" | "deadline_exceeded"): Promise<void>;
}

export interface CloudRunnerOutputFile {
	path: string;
	sha256: string;
	bytes: number;
	executable: boolean;
}

export interface CloudRunnerExecutionResult {
	result: JsonValue;
	outputFiles: readonly CloudRunnerOutputFile[];
	outputBytes: number;
	usage: CloudRunnerExecutionUsage;
	outputSnapshotId?: string;
}

function requiredSafeInteger(value: number, label: string, minimum: number, maximum: number): void {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${label} is outside the supported range`);
	}
}

export function resolveCloudRunnerSandboxLimits(
	overrides: Partial<CloudRunnerSandboxLimits> | undefined,
): CloudRunnerSandboxLimits {
	const limits = { ...DEFAULT_CLOUD_RUNNER_SANDBOX_LIMITS, ...overrides };
	requiredSafeInteger(limits.wallTimeMs, "Sandbox wall time", 10, 24 * 60 * 60 * 1000);
	requiredSafeInteger(limits.memoryBytes, "Sandbox memory", 64 * 1024 * 1024, 256 * 1024 * 1024 * 1024);
	if (!Number.isFinite(limits.cpuCount) || limits.cpuCount < 0.1 || limits.cpuCount > 64) {
		throw new Error("Sandbox CPU count is outside the supported range");
	}
	requiredSafeInteger(limits.maxPids, "Sandbox process count", 1, 4096);
	requiredSafeInteger(
		limits.maxInputBytes,
		"Sandbox input bytes",
		1,
		DEFAULT_CLOUD_RUNNER_SANDBOX_LIMITS.maxInputBytes,
	);
	requiredSafeInteger(
		limits.maxOutputBytes,
		"Sandbox output bytes",
		0,
		DEFAULT_CLOUD_RUNNER_SANDBOX_LIMITS.maxOutputBytes,
	);
	requiredSafeInteger(limits.maxResultBytes, "Sandbox result bytes", 2, 64 * 1024);
	return limits;
}
