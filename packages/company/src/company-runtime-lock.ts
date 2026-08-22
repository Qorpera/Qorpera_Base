import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";

function normalizedPath(path: string): string {
	const resolved = resolve(path);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Resolve an existing company through aliases once, then use that physical identity everywhere. */
export function canonicalCompanyRoot(rootDir: string): string {
	return realpathSync(resolve(rootDir));
}

export function companyRuntimeLockPath(rootDir: string): string {
	const root = canonicalCompanyRoot(rootDir);
	const gitPath = spawnSync(
		"git",
		["-C", root, "rev-parse", "--path-format=absolute", "--git-path", "qorpera-runtime-locks"],
		{ encoding: "utf-8", shell: false },
	);
	if (gitPath.status !== 0 || !gitPath.stdout.trim()) {
		throw new Error("company transaction requires a valid Git repository");
	}
	const id = createHash("sha256").update(normalizedPath(root)).digest("hex");
	return join(gitPath.stdout.trim(), `${id}.json`);
}

export interface CompanyRuntimeLock {
	path: string;
	root: string;
	token: string;
	processInstance: string;
	release: () => void;
}

interface CompanyLockRecord {
	version: 3;
	pid: number;
	processInstance: string;
	root: string;
	token: string;
	mode: "runtime" | "product-registration";
}

const lockHeartbeats = new WeakMap<CompanyRuntimeLock, Worker>();
const COMPANY_LOCK_STALE_MS = 30_000;
const COMPANY_LOCK_HEARTBEAT_MS = 1_000;

function startCompanyLockHeartbeat(path: string, token: string): Worker {
	const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
	const worker = new Worker(new URL(`./company-lock-heartbeat${extension}`, import.meta.url), {
		workerData: { path, token, intervalMs: COMPANY_LOCK_HEARTBEAT_MS },
	});
	worker.unref();
	return worker;
}

function lockOwnerProcessIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function processInstanceIdentity(pid: number): string | undefined {
	if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
	if (process.platform === "win32") {
		const result = spawnSync(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`try { $p = [System.Diagnostics.Process]::GetProcessById(${pid}); [Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks) } catch { exit 3 }`,
			],
			{ encoding: "utf-8", shell: false, timeout: 5_000, windowsHide: true },
		);
		const ticks = result.status === 0 ? result.stdout.trim() : "";
		return /^\d{10,}$/.test(ticks) ? `windows:${ticks}` : undefined;
	}
	if (process.platform === "linux") {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
			const fields = stat
				.slice(stat.lastIndexOf(")") + 2)
				.trim()
				.split(/\s+/);
			const startTicks = fields[19];
			return /^\d+$/.test(startTicks ?? "") ? `linux:${startTicks}` : undefined;
		} catch {
			return undefined;
		}
	}
	if (process.platform === "darwin") {
		const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			encoding: "utf-8",
			shell: false,
			timeout: 5_000,
		});
		const startedAt = result.status === 0 ? result.stdout.trim().replace(/\s+/g, " ") : "";
		return startedAt ? `darwin:${createHash("sha256").update(startedAt).digest("hex")}` : undefined;
	}
	return undefined;
}

function acquireCompanyRuntimeLock(rootDir: string): CompanyRuntimeLock {
	const root = canonicalCompanyRoot(rootDir);
	const path = companyRuntimeLockPath(root);
	mkdirSync(dirname(path), { recursive: true });
	const token = randomUUID();
	const processInstance = processInstanceIdentity(process.pid);
	if (!processInstance) throw new Error("Could not establish the company lock process identity");
	const record: CompanyLockRecord = {
		version: 3,
		pid: process.pid,
		processInstance,
		root,
		token,
		mode: "runtime",
	};
	for (let attempt = 0; attempt < 3; attempt++) {
		let descriptor: number | undefined;
		try {
			descriptor = openSync(path, "wx");
			writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf-8");
			fsyncSync(descriptor);
			closeSync(descriptor);
			descriptor = undefined;
			const lock: CompanyRuntimeLock = {
				path,
				root,
				token,
				processInstance,
				release: () => {
					const heartbeat = lockHeartbeats.get(lock);
					if (!heartbeat) return;
					lockHeartbeats.delete(lock);
					try {
						heartbeat.postMessage("stop");
					} catch {}
					void heartbeat.terminate();
				},
			};
			lockHeartbeats.set(lock, startCompanyLockHeartbeat(path, token));
			return lock;
		} catch (error) {
			if (descriptor !== undefined) closeSync(descriptor);
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				rmSync(path, { force: true });
				throw error;
			}
			let modifiedAt: number;
			try {
				modifiedAt = statSync(path).mtimeMs;
			} catch (statError) {
				if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw statError;
			}
			const recentlyModified = Date.now() - modifiedAt <= COMPANY_LOCK_STALE_MS;
			let owner: Partial<CompanyLockRecord>;
			try {
				owner = JSON.parse(readFileSync(path, "utf-8")) as Partial<CompanyLockRecord>;
			} catch (readError) {
				if (recentlyModified) {
					throw new Error("Company transaction is already owned by another process", { cause: error });
				}
				throw new Error("Stale company transaction lock has invalid owner identity", { cause: readError });
			}
			if (
				owner.version !== 3 ||
				!Number.isSafeInteger(owner.pid) ||
				owner.pid! <= 0 ||
				typeof owner.processInstance !== "string" ||
				!/^(?:windows:\d+|linux:\d+|darwin:[0-9a-f]{64})$/.test(owner.processInstance) ||
				typeof owner.token !== "string" ||
				!/^[0-9a-f-]{36}$/i.test(owner.token) ||
				(owner.mode !== "runtime" && owner.mode !== "product-registration") ||
				normalizedPath(owner.root ?? "") !== normalizedPath(root)
			) {
				if (recentlyModified) {
					throw new Error("Company transaction is already owned by another process", { cause: error });
				}
				throw new Error("Stale company transaction lock has invalid owner identity");
			}
			if (lockOwnerProcessIsAlive(owner.pid!)) {
				const liveInstance = processInstanceIdentity(owner.pid!);
				if (!liveInstance) throw new Error("Could not validate the live company lock owner", { cause: error });
				if (liveInstance === owner.processInstance) {
					throw new Error(
						recentlyModified
							? "Company transaction is already owned by another process"
							: "Company transaction is already owned by another live process",
						{ cause: error },
					);
				}
			}
			try {
				renameSync(path, `${path}.stale-${Date.now()}-${randomUUID()}`);
			} catch (renameError) {
				if ((renameError as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw renameError;
			}
		}
	}
	throw new Error("Could not acquire the company transaction lock atomically");
}

export function claimCompanyRuntimeLock(rootDir: string): CompanyRuntimeLock {
	return acquireCompanyRuntimeLock(rootDir);
}

export function releaseCompanyRuntimeLock(lock: CompanyRuntimeLock): void {
	try {
		const record = JSON.parse(readFileSync(lock.path, "utf-8")) as Partial<CompanyLockRecord>;
		if (record.token !== lock.token || normalizedPath(record.root ?? "") !== normalizedPath(lock.root)) {
			throw new Error("company transaction lock ownership changed before release");
		}
		rmSync(lock.path, { force: true });
	} finally {
		lock.release();
	}
}
