import assert from "node:assert/strict";
import { resolve } from "node:path";

export function workloadGuardDiagnosticsPlugin(repository) {
	return { name: "acceptance-guard-clock-diagnostics", setup(build) {
		build.onResolve({ filter: /^\.\/computer-paid-usage-lxd\.ts$/ }, (args) => {
			if (args.importer !== resolve(repository, "packages/runner-orchestrator/src/computer-paid-guard-service.ts")) return;
			return { path: resolve(repository, "scripts/acceptance/workload-usage-guard-diagnostics.ts") };
		});
	} };
}

const uuid = (value) => value === null || (typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value));
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;
const fields = ["schema", "captureId", "allocationId", "physicalId", "startedAt", "durationMs", "confirmed", "aborted", "code", "hostBracketMs", "steps"];
const stepFields = ["phase", "durationMs", "returned", "hostMachineIdSha256", "bootId", "uptimeMs", "state"];
const phases = ["host-before", "physical-before", "guest-clock", "physical-after", "host-after"];
const codes = ["CONFIRMED", "ABORTED", "HOST_CLOCK_FAILED", "GUEST_CLOCK_FAILED", "PHYSICAL_INSPECTION_FAILED", "HOST_IDENTITY_DIFFERS", "PHYSICAL_NOT_RUNNING", "HOST_CLOCK_BACKWARD", "HOST_BRACKET_EXCEEDED", "CAPTURE_UNCONFIRMED"];
/** Unit logs are untrusted input. Retain a fixed recent ring plus earlier
 * failures, with no raw lines, unknown keys, errors or free-form strings. */
export function collectWorkloadGuardDiagnostics(text) {
	assert(Buffer.byteLength(text) <= 4 * 1024 ** 2, "GUARD_DIAGNOSTIC_LIMIT");
	const records = [], seen = new Set(); let discarded = 0;
	for (const line of text.split("\n").slice(-2048)) {
		if (Buffer.byteLength(line) > 4096) { discarded++; continue; }
		let value; try { value = JSON.parse(line); } catch { continue; }
		if (!value || value.schema !== "qorpera.acceptance-guard-capture/v1") continue;
		if (Object.keys(value).sort().join() !== [...fields].sort().join() || !uuid(value.captureId) || value.captureId === null ||
			!uuid(value.allocationId) || !uuid(value.physicalId) || typeof value.startedAt !== "string" ||
			!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.startedAt) || !Number.isFinite(Date.parse(value.startedAt)) ||
			!nonnegative(value.durationMs) || typeof value.confirmed !== "boolean" || typeof value.aborted !== "boolean" ||
			!codes.includes(value.code) || (value.confirmed !== (value.code === "CONFIRMED")) ||
			(value.hostBracketMs !== null && !Number.isSafeInteger(value.hostBracketMs)) || !Array.isArray(value.steps) || value.steps.length > 5 ||
			value.steps.some((step, index) => !step || Object.keys(step).sort().join() !== [...stepFields].sort().join() || step.phase !== phases[index] ||
				!nonnegative(step.durationMs) || typeof step.returned !== "boolean" || !uuid(step.bootId) ||
				(step.uptimeMs !== null && !nonnegative(step.uptimeMs)) || ![null, "running", "stopped", "absent", "other"].includes(step.state) ||
				(step.hostMachineIdSha256 !== null && (typeof step.hostMachineIdSha256 !== "string" || !/^[0-9a-f]{64}$/.test(step.hostMachineIdSha256))))) {
			discarded++; continue;
		}
		if (!seen.has(value.captureId)) { records.push(value); seen.add(value.captureId); }
	}
	const recent = records.slice(-32), failures = records.filter(record => !record.confirmed).slice(-16);
	const retained = records.filter(record => recent.includes(record) || failures.includes(record));
	return { schema: "qorpera.acceptance-guard-captures/v1", observedCaptures: records.length, discarded,
		retainedCaptures: retained, omittedCaptures: records.length - retained.length };
}
