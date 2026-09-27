import { spawnSync } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const states = new Set(["pending", "running", "stopped", "armed", "stopping", "succeeded", "failed", "unknown", "not_dispatched", "abandoned_before_dispatch", "registered", "dispatched", "accepted", "settled", "dispatch", "copied", "active", "starting", "closed", "start", "stop", "create", "delete"]);

/** Export selected state only. Journal payloads may contain bearer credentials. */
export function officeJournalDiagnostic(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const result = {};
	if (typeof value.schema === "string" && /^qorpera\.[a-z-]+\/v[1-9][0-9]*$/.test(value.schema)) result.schema = value.schema;
	for (const key of ["state", "kind", "action", "phase"]) if (states.has(value[key])) result[key] = value[key];
	for (const key of ["startDispatched", "startSettled", "startSucceeded", "stopped", "closed"]) if (typeof value[key] === "boolean") result[key] = value[key];
	return result;
}

/** Bounded read-only failure snapshot before physical cleanup changes state. */
export async function officeLifecycleDiagnostics({ journal, machineName, provider }) {
	const result = { provider: { exitCode: provider?.exitCode ?? null, signalCode: provider?.signalCode ?? null }, journal: [] };
	const operations = new Set();
	const visit = async (directory, depth) => {
		for (const entry of (await readdir(directory, { withFileTypes: true })).slice(0, 256)) {
			if (result.journal.length >= 128) return;
			const path = join(directory, entry.name);
			if (entry.isDirectory() && depth < 2) { await visit(path, depth + 1); continue; }
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			try {
				if ((await lstat(path)).size > 131072) continue;
				const value = JSON.parse(await readFile(path, "utf8"));
				const summary = officeJournalDiagnostic(value);
				const operationId = value?.startReference?.operationId ?? value?.operationId;
				if (typeof operationId === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(operationId)) operations.add(operationId);
				if (Object.keys(summary).length) result.journal.push(summary);
			} catch { /* A concurrent publication or malformed record is not authority. */ }
		}
	};
	try { await visit(journal, 0); } catch { result.journalUnavailable = true; }
	try { await visit("/var/lib/qorpera-office-computer-guard", 0); } catch { result.guardUnavailable = true; }
	if (!/^qorpera-office-[0-9a-f]{32}$/.test(machineName ?? "")) return result;
	const command = (args) => spawnSync("lxc", args, { encoding: "utf8", timeout: 15000, maxBuffer: 262144 });
	result.operations = [];
	for (const operationId of [...operations].slice(0, 16)) {
		const inspected = command(["query", `/1.0/operations/${operationId}`]);
		try {
			const value = JSON.parse(inspected.stdout);
			result.operations.push({ statusCode: Number.isSafeInteger(value.status_code) ? value.status_code : null,
				status: ["Pending", "Running", "Success", "Failure", "Cancelled", "Cancelling"].includes(value.status) ? value.status : "unknown" });
		} catch { result.operations.push({ available: false }); }
	}
	const physical = command(["query", `/1.0/instances/${machineName}/state`]);
	try {
		const value = JSON.parse(physical.stdout);
		result.physicalState = ["Running", "Stopped", "Starting", "Stopping", "Frozen", "Error"].includes(value.status) ? value.status : "unknown";
	} catch { result.physicalState = "unavailable"; }
	const units = ["qorpera-company-computer.service", "qorpera-company-computer-preparation.service"];
	result.services = [];
	for (const unit of units) {
		const inspected = command(["exec", machineName, "--", "systemctl", "show", unit, "--property=ActiveState,SubState,Result,ExecMainCode,ExecMainStatus"]);
		const properties = Object.fromEntries(String(inspected.stdout ?? "").split("\n").flatMap(line => {
			const match = /^(ActiveState|SubState|Result|ExecMainCode|ExecMainStatus)=([a-z0-9-]{1,64})$/.exec(line);
			return match ? [[match[1], match[2]]] : [];
		}));
		result.services.push({ unit, available: inspected.status === 0, ...properties });
	}
	return result;
}
