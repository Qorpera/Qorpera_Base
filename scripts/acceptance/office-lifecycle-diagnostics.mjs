import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { officeCustodyMachines } from "./office-lifecycle-custody.mjs";

const states = new Set(["pending", "running", "stopped", "armed", "stopping", "succeeded", "failed", "unknown", "not_dispatched", "abandoned_before_dispatch", "registered", "dispatched", "accepted", "settled", "dispatch", "copied", "active", "starting", "closed", "start", "stop", "create", "delete"]);
const startupLogs = ["disk.workbench.log", "qemu.early.log", "qemu.log"];
const logSignatures = {
	sandbox_entry_failed: /Error entering sandbox|Failed to enter sandbox/,
	shared_root_chdir_failed: /ChdirNewRoot|ChrootChdir/,
	shared_root_open_failed: /OpenNewRoot|BindMountSharedDir/,
	permission_denied: /Permission denied|PermissionDenied|\bEACCES\b/,
	operation_not_permitted: /Operation not permitted|\bEPERM\b/,
	missing_path: /No such file or directory|\bENOENT\b/,
	vhost_user_failure: /(?:vhost-user|vhost_user)[^\r\n]{0,80}(?:failed|error|disconnect)/i,
	connection_refused: /Connection refused|ConnectionRefused|\bECONNREFUSED\b/,
	connection_reset: /Connection reset|ConnectionReset|\bECONNRESET\b/,
	resource_exhausted: /Cannot allocate memory|Too many open files|No space left on device/,
	io_failure: /Input\/output error|Stale file handle/,
	backend_waiting: /Waiting for vhost-user socket connection/,
};

/** Never export arbitrary log lines: QEMU diagnostics can include arguments,
 * paths and credentials. Exact source prefixes are fingerprinted; fixed error
 * signatures expose startup failure classes without copying their payload. */
export function officeStartupLogDiagnostic(value, complete = true) {
	const bytes = Buffer.from(value ?? "").subarray(0, 16384), text = bytes.toString("utf8");
	return { capturedBytes: bytes.length, complete: complete && Buffer.byteLength(value ?? "") <= 16384,
		capturedSha256: createHash("sha256").update(bytes).digest("hex"),
		signatures: Object.entries(logSignatures).filter(([, pattern]) => pattern.test(text)).map(([name]) => name),
		errnos: [...new Set([...text.matchAll(/(?:os error |code: )(\d{1,4})\b/g)].map((match) => Number(match[1])))].slice(0, 16) };
}

export function officeProcessDiagnostic(pid, status, wchan) {
	if (!Number.isSafeInteger(pid) || pid < 1 || Buffer.byteLength(status) > 8192 || Buffer.byteLength(wchan) > 128) return null;
	const name = /^Name:\s*(qemu-system-[a-z0-9_-]{1,16}|qemu-kvm|virtiofsd)\s*$/m.exec(status)?.[1];
	const state = /^State:\s*([RSDZTWtXIP])\s/m.exec(status)?.[1];
	const uid = /^Uid:\s*([0-9]+)\s/m.exec(status)?.[1], gid = /^Gid:\s*([0-9]+)\s/m.exec(status)?.[1];
	if (!name || !state || uid === undefined || gid === undefined) return null;
	return { pid, name, state, uid: Number(uid), gid: Number(gid),
		waitChannel: /^[a-zA-Z0-9_]{1,80}$/.test(wchan.trim()) ? wchan.trim() : "unavailable" };
}

/** The caller supplies the same protected policy used for owned cleanup.
 * Fixed log names and a verified allocation prevent a prefix from authorizing
 * diagnostics of another instance. The command port is read-only. */
export function officeStartupDiagnostics({ machineName, policy, policySha256, command }) {
	const result = { available: false, logs: [] };
	if (!/^qorpera-office-[0-9a-f]{32}$/.test(machineName ?? "") || policy?.guest?.project !== "default") return result;
	const inspect = () => {
		const reply = command(["query", `/1.0/instances/${machineName}?project=default`]);
		if (reply.status !== 0) throw new Error("Office diagnostic ownership unavailable");
		return officeCustodyMachines([{ ...JSON.parse(reply.stdout), project: "default" }], policy, policySha256)[0];
	};
	try {
		const before = inspect();
		for (const name of startupLogs) {
			const reply = command(["query", `/1.0/instances/${machineName}/logs/${name}?project=default`], 16384);
			result.logs.push({ name, available: reply.status === 0 || reply.error?.code === "ENOBUFS",
				...officeStartupLogDiagnostic(reply.stdout, reply.status === 0 && !reply.error) });
		}
		const after = inspect();
		if (before.physicalId !== after.physicalId || before.name !== machineName || after.name !== machineName) return { available: false, logs: [], identityChanged: true };
		return { ...result, available: true, physicalId: before.physicalId };
	} catch { return { available: false, logs: [] }; }
}

/** Read only the owned service's current-boot journal. Even schema-shaped
 * guest input is reprojected by the production diagnostic allowlist. */
export function officeServiceDiagnostics({ machineName, policy, policySha256, command, project }) {
	if (!/^qorpera-office-[0-9a-f]{32}$/.test(machineName ?? "") || policy?.guest?.project !== "default") return { available: false };
	const inspect = () => {
		const reply = command(["query", `/1.0/instances/${machineName}?project=default`]);
		if (reply.status !== 0) throw new Error("Office diagnostic ownership unavailable");
		return officeCustodyMachines([{ ...JSON.parse(reply.stdout), project: "default" }], policy, policySha256)[0];
	};
	try {
		const before = inspect();
		if (before.name !== machineName) return { available: false };
		const reply = command(["exec", machineName, "--project", "default", "--", "journalctl", "--boot=0", "--unit=qorpera-company-computer.service", "--lines=64", "--output=cat", "--no-pager"], 65536);
		const after = inspect();
		if (before.physicalId !== after.physicalId || after.name !== machineName) return { available: false, identityChanged: true };
		if (reply.status !== 0 || reply.error || Buffer.byteLength(reply.stdout ?? "") > 65536) return { available: false, complete: false };
		return { available: true, complete: true, failures: project(reply.stdout) };
	} catch { return { available: false }; }
}

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
export async function officeLifecycleDiagnostics({ journal, machineName, provider, policy, policySha256, toolsPath }) {
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
	const deadline = performance.now() + 30000;
	const command = (args, maxBuffer = 262144) => {
		const remaining = deadline - performance.now();
		return remaining <= 0 ? { status: null, stdout: "" } : spawnSync("lxc", args, {
			encoding: "utf8", timeout: Math.max(1, Math.min(3000, Math.floor(remaining))), maxBuffer, killSignal: "SIGKILL" });
	};
	result.startup = officeStartupDiagnostics({ machineName, policy, policySha256, command });
	result.serviceFailure = officeServiceDiagnostics({ machineName, policy, policySha256, command, project: text => {
		const projected = spawnSync(process.execPath, [toolsPath, "service-diagnostics"], { input: text, encoding: "utf8", timeout: 3000, maxBuffer: 16384, killSignal: "SIGKILL" });
		if (projected.status !== 0 || projected.error) throw new Error("Office service diagnostic unavailable");
		return JSON.parse(projected.stdout);
	} });
	result.operations = [];
	for (const operationId of [...operations].slice(0, 16)) {
		const inspected = command(["query", `/1.0/operations/${operationId}`]);
		try {
			const value = JSON.parse(inspected.stdout);
			result.operations.push({ statusCode: Number.isSafeInteger(value.status_code) ? value.status_code : null,
				status: ["Pending", "Running", "Success", "Failure", "Cancelled", "Cancelling"].includes(value.status) ? value.status : "unknown" });
		} catch { result.operations.push({ available: false }); }
	}
	const physical = command(["query", `/1.0/instances/${machineName}/state?project=default`]);
	try {
		const value = JSON.parse(physical.stdout);
		result.physicalState = ["Running", "Stopped", "Starting", "Stopping", "Frozen", "Error"].includes(value.status) ? value.status : "unknown";
		if (result.startup.available && Number.isSafeInteger(value.pid) && value.pid > 0) {
			const read = async (name, maximum) => {
				const file = await open(`/proc/${value.pid}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
				try { const bytes = Buffer.alloc(maximum + 1); const { bytesRead } = await file.read(bytes, 0, bytes.length, 0); return bytes.subarray(0, bytesRead).toString("utf8"); }
				finally { await file.close(); }
			};
			try {
				const summary = officeProcessDiagnostic(value.pid, await read("status", 8192), await read("wchan", 128));
				const stateAfter = command(["query", `/1.0/instances/${machineName}/state?project=default`]);
				const instanceAfter = command(["query", `/1.0/instances/${machineName}?project=default`]);
				const owned = officeCustodyMachines([{ ...JSON.parse(instanceAfter.stdout), project: "default" }], policy, policySha256)[0];
				result.process = stateAfter.status === 0 && instanceAfter.status === 0 && JSON.parse(stateAfter.stdout).pid === value.pid
					&& owned.physicalId === result.startup.physicalId ? summary : null;
			}
			catch { result.process = null; }
		}
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
