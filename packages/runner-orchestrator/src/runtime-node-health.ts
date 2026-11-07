import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, statfs } from "node:fs/promises";
import { type CpuInfo, cpus } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { officeDigest, officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import {
	assertLxdOfficeHostNamespace,
	readLxdOfficeProtectedFile,
	readLxdOfficeProtectedPackageArtifactFile,
} from "./lxd-office-physical-host.ts";
import { readRuntimeNodeHost } from "./runtime-node-host.ts";
import { parseRuntimeNodeInventoryPolicy } from "./runtime-node-inventory.ts";
import type { RuntimeNodeObserverRegistry } from "./runtime-node-observer.ts";

// The first installation (deploy/first-node/NODE-OBSERVER-INSTALLATION.md) runs
// from this fixed path, with its receipt beside it.
const INSTALLED_OBSERVER = "/opt/qorpera/node-observer/qorpera-node-observer.cjs",
	INSTALLED_RECEIPT = "/opt/qorpera/node-observer/installation.json";
const MAX = Number.MAX_SAFE_INTEGER;
const METRICS = ["cpu", "memory", "rootFilesystem", "network"] as const;
const ERRORS = [
	"CPU_SAMPLE_UNAVAILABLE",
	"MEMORY_SAMPLE_UNAVAILABLE",
	"ROOT_FILESYSTEM_UNAVAILABLE",
	"NETWORK_COUNTERS_UNAVAILABLE",
] as const;
function officeUuid(value: unknown): string {
	if (
		typeof value !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
	)
		throw new Error("NODE_HEALTH_ID_INVALID");
	return value;
}
/** How long the observer's health loop waits after each settled attempt. Health is diagnostics: admission,
 * placement and release never read it, so it does not need the inventory's five seconds. A sample costs a child
 * process (about 100 ms of CPU), one RPC and one receipt; at five seconds that was 2 % of a core per node and 200 MB
 * of WAL a day. The latest query calls a sample stale at 60 seconds. Samples land about 21 seconds apart, so one lost
 * report, or an observer freeze of up to about 38 seconds, stays inside that; two lost reports in a row read as stale
 * until the next sample. */
export const RUNTIME_NODE_HEALTH_WAIT_MS = 20_000;

export interface RuntimeNodeHealth {
	schema: "qorpera.runtime-node-health/v1";
	nodeId: string;
	machineIdSha256: string;
	policySha256: string;
	observerPackageSha256: string | null;
	bootId: string | null;
	observationId: string;
	observedAt: string;
	cpu: { usedBasisPoints: number; from: string; until: string } | null;
	memory: { totalBytes: number; availableBytes: number } | null;
	rootFilesystem: { totalBytes: number; freeBytes: number; availableBytes: number } | null;
	network: {
		receivedBytes: number;
		sentBytes: number;
		receiveErrors: number;
		sendErrors: number;
		receiveDrops: number;
		sendDrops: number;
	} | null;
	errors: string[];
}
function integer(value: unknown, maximum = MAX): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum)
		throw new Error("NODE_HEALTH_VALUE_INVALID");
	return value as number;
}
function timestamp(value: unknown): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
		throw new Error("NODE_HEALTH_TIME_INVALID");
	return value;
}
export function parseRuntimeNodeHealth(value: unknown): RuntimeNodeHealth {
	const r = officeRecord(value, [
		"schema",
		"nodeId",
		"machineIdSha256",
		"policySha256",
		"observerPackageSha256",
		"bootId",
		"observationId",
		"observedAt",
		...METRICS,
		"errors",
	]);
	if (
		r.schema !== "qorpera.runtime-node-health/v1" ||
		!Array.isArray(r.errors) ||
		!r.errors.every((e) => typeof e === "string") ||
		new Set(r.errors).size !== r.errors.length
	)
		throw new Error("NODE_HEALTH_INVALID");
	const result: RuntimeNodeHealth = {
		schema: r.schema,
		nodeId: officeUuid(r.nodeId),
		machineIdSha256: officeSha(r.machineIdSha256),
		policySha256: officeSha(r.policySha256),
		observerPackageSha256: r.observerPackageSha256 === null ? null : officeSha(r.observerPackageSha256),
		bootId: r.bootId === null ? null : officeUuid(r.bootId),
		observationId: officeUuid(r.observationId),
		observedAt: timestamp(r.observedAt),
		cpu: null,
		memory: null,
		rootFilesystem: null,
		network: null,
		errors: [...r.errors],
	};
	if (r.bootId === null) {
		if (
			METRICS.some((k) => r[k] !== null) ||
			result.observerPackageSha256 !== null ||
			result.errors.join() !== "COLLECTION_UNCONFIRMED"
		)
			throw new Error("NODE_HEALTH_UNCONFIRMED_SHAPE");
		return result;
	}
	if (result.observerPackageSha256 === null) throw new Error("NODE_HEALTH_SOFTWARE_UNKNOWN");
	if (result.errors.some((e) => !(ERRORS as readonly string[]).includes(e)))
		throw new Error("NODE_HEALTH_ERROR_INVALID");
	for (const [index, key] of METRICS.entries())
		if ((r[key] === null) !== result.errors.includes(ERRORS[index]!)) throw new Error("NODE_HEALTH_MISSING_REASON");
	if (r.cpu !== null) {
		const c = officeRecord(r.cpu, ["usedBasisPoints", "from", "until"]);
		result.cpu = {
			usedBasisPoints: integer(c.usedBasisPoints, 10000),
			from: timestamp(c.from),
			until: timestamp(c.until),
		};
		const span = Date.parse(result.cpu.until) - Date.parse(result.cpu.from);
		if (
			span < 500 ||
			span > 5000 ||
			Date.parse(result.cpu.until) > Date.parse(result.observedAt) ||
			Date.parse(result.observedAt) - Date.parse(result.cpu.from) > 10000
		)
			throw new Error("NODE_HEALTH_CPU_WINDOW_INVALID");
	}
	if (r.memory !== null) {
		const m = officeRecord(r.memory, ["totalBytes", "availableBytes"]);
		result.memory = { totalBytes: integer(m.totalBytes), availableBytes: integer(m.availableBytes) };
		if (!result.memory.totalBytes || result.memory.availableBytes > result.memory.totalBytes)
			throw new Error("NODE_HEALTH_MEMORY_INVALID");
	}
	if (r.rootFilesystem !== null) {
		const d = officeRecord(r.rootFilesystem, ["totalBytes", "freeBytes", "availableBytes"]);
		result.rootFilesystem = {
			totalBytes: integer(d.totalBytes),
			freeBytes: integer(d.freeBytes),
			availableBytes: integer(d.availableBytes),
		};
		if (
			!result.rootFilesystem.totalBytes ||
			result.rootFilesystem.freeBytes > result.rootFilesystem.totalBytes ||
			result.rootFilesystem.availableBytes > result.rootFilesystem.freeBytes
		)
			throw new Error("NODE_HEALTH_DISK_INVALID");
	}
	if (r.network !== null) {
		const keys = ["receivedBytes", "sentBytes", "receiveErrors", "sendErrors", "receiveDrops", "sendDrops"] as const;
		const n = officeRecord(r.network, [...keys]);
		result.network = Object.fromEntries(keys.map((k) => [k, integer(n[k])])) as NonNullable<
			RuntimeNodeHealth["network"]
		>;
	}
	return result;
}

export function runtimeNodeCpuUsage(
	before: CpuInfo[],
	after: CpuInfo[],
	from: string,
	until: string,
): NonNullable<RuntimeNodeHealth["cpu"]> {
	if (!before.length || before.length !== after.length || before.length > 1024)
		throw new Error("CPU_SAMPLE_UNAVAILABLE");
	let total = 0,
		idle = 0;
	for (let i = 0; i < before.length; i++)
		for (const key of ["user", "nice", "sys", "idle", "irq"] as const) {
			const delta = integer(after[i]!.times[key]) - integer(before[i]!.times[key]);
			if (delta < 0) throw new Error("CPU_SAMPLE_UNAVAILABLE");
			total = integer(total + delta);
			if (key === "idle") idle = integer(idle + delta);
		}
	if (!total) throw new Error("CPU_SAMPLE_UNAVAILABLE");
	return { usedBasisPoints: Math.round(((total - idle) / total) * 10000), from, until };
}
export function runtimeNodeMemory(text: string): NonNullable<RuntimeNodeHealth["memory"]> {
	const field = (key: string) => {
		const matches = [...text.matchAll(new RegExp(`^${key}:\\s+([0-9]+) kB$`, "gm"))];
		if (matches.length !== 1) throw new Error("MEMORY_SAMPLE_UNAVAILABLE");
		return integer(Number(matches[0]![1]) * 1024);
	};
	const totalBytes = field("MemTotal"),
		availableBytes = field("MemAvailable");
	if (!totalBytes || availableBytes > totalBytes) throw new Error("MEMORY_SAMPLE_UNAVAILABLE");
	return { totalBytes, availableBytes };
}
export function runtimeNodeNetwork(text: string): NonNullable<RuntimeNodeHealth["network"]> {
	const result = { receivedBytes: 0, sentBytes: 0, receiveErrors: 0, sendErrors: 0, receiveDrops: 0, sendDrops: 0 };
	const lines = text.trimEnd().split("\n");
	if (lines.length < 3 || !lines[0]!.includes("Receive") || !lines[0]!.includes("Transmit"))
		throw new Error("NETWORK_COUNTERS_UNAVAILABLE");
	const names = new Set<string>();
	for (const line of lines.slice(2)) {
		const match = /^\s*([^\s:]{1,64}):\s*([0-9\s]+)$/.exec(line);
		if (!match || names.has(match[1]!)) throw new Error("NETWORK_COUNTERS_UNAVAILABLE");
		names.add(match[1]!);
		const fields = match[2]!
			.trim()
			.split(/\s+/)
			.map((v) => integer(Number(v)));
		if (fields.length !== 16) throw new Error("NETWORK_COUNTERS_UNAVAILABLE");
		if (match[1] === "lo") continue;
		for (const [key, index] of [
			["receivedBytes", 0],
			["sentBytes", 8],
			["receiveErrors", 2],
			["sendErrors", 10],
			["receiveDrops", 3],
			["sendDrops", 11],
		] as const)
			result[key] = integer(result[key] + fields[index]!);
	}
	if (![...names].some((name) => name !== "lo")) throw new Error("NETWORK_COUNTERS_UNAVAILABLE");
	return result;
}

// Only fixed kernel metadata is read. Paths and interface names never leave
// the probe. A blocked filesystem read is bounded by the parent process kill.
async function kernel(path: string, limit: number): Promise<string> {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const bytes = Buffer.alloc(limit + 1);
		let used = 0;
		while (used < bytes.length) {
			const r = await file.read(bytes, used, bytes.length - used, null);
			if (!r.bytesRead) break;
			used += r.bytesRead;
		}
		if (used > limit) throw new Error("NODE_HEALTH_KERNEL_LIMIT");
		return new TextDecoder("utf8", { fatal: true }).decode(bytes.subarray(0, used));
	} finally {
		await file.close();
	}
}

/** The software a sample names. The first installation's receipt names its
 * package, policy and account. A cut's observer (deploy/agent-exit/ROLLOUT.md
 * step 4) is one file next to the running one, with no receipt: it names the
 * SHA-256 of its own root-owned bytes, which its account cannot change. */
export async function runtimeNodeObserverSoftware(observer: string, policySha256: string): Promise<string> {
	if (observer !== INSTALLED_OBSERVER)
		return createHash("sha256")
			.update(await readLxdOfficeProtectedPackageArtifactFile(observer, 8 * 1024 ** 2))
			.digest("hex");
	const installation = officeRecord(
		JSON.parse(
			new TextDecoder("utf8", { fatal: true }).decode(await readLxdOfficeProtectedFile(INSTALLED_RECEIPT, 65536)),
		),
		["schema", "packageManifestSha256", "policySha256", "uid", "gid", "files"],
	);
	if (
		installation.schema !== "qorpera.node-observer-installation-receipt/v1" ||
		installation.policySha256 !== policySha256 ||
		installation.uid !== process.geteuid?.() ||
		installation.gid !== process.getegid?.()
	)
		throw new Error("NODE_HEALTH_INSTALLATION_DIFFERS");
	return officeSha(installation.packageManifestSha256);
}

/** The probe is the running observer's own file (`process.argv[1]`), so it
 * reads the same configuration paths as the observer that started it. */
export async function collectRuntimeNodeHealth(
	signal: AbortSignal,
	observer: string | undefined = process.argv[1],
): Promise<RuntimeNodeHealth> {
	if (process.platform !== "linux" || !process.geteuid?.()) throw new Error("NODE_HEALTH_UNPRIVILEGED_LINUX_REQUIRED");
	if (typeof observer !== "string") throw new Error("NODE_HEALTH_OBSERVER_UNKNOWN");
	const config = officeRecord(
		JSON.parse(
			new TextDecoder("utf8", { fatal: true }).decode(
				await readLxdOfficeProtectedFile("/etc/qorpera/node-observer.json", 65536),
			),
		),
		["registryUrl", "policy"],
	);
	const policy = parseRuntimeNodeInventoryPolicy(config.policy),
		host = await readRuntimeNodeHost(signal);
	const policySha256 = officeDigest(policy),
		observerPackageSha256 = await runtimeNodeObserverSoftware(observer, policySha256);
	if (host.machineIdSha256 !== policy.host.machineIdSha256) throw new Error("NODE_HEALTH_HOST_DIFFERS");
	const bootId = officeUuid((await kernel("/proc/sys/kernel/random/boot_id", 64)).trim());
	const namespace = await assertLxdOfficeHostNamespace(bootId);
	const before = cpus(),
		from = new Date().toISOString();
	await delay(1000, undefined, { signal });
	const after = cpus(),
		until = new Date().toISOString();
	const samples = await Promise.allSettled([
		Promise.resolve().then(() => runtimeNodeCpuUsage(before, after, from, until)),
		kernel("/proc/meminfo", 65536).then(runtimeNodeMemory),
		statfs("/", { bigint: true }).then((s) => ({
			totalBytes: integer(Number(s.blocks * s.bsize)),
			freeBytes: integer(Number(s.bfree * s.bsize)),
			availableBytes: integer(Number(s.bavail * s.bsize)),
		})),
		kernel("/proc/net/dev", 262144).then(runtimeNodeNetwork),
	]);
	signal.throwIfAborted();
	if (
		(await kernel("/proc/sys/kernel/random/boot_id", 64)).trim() !== bootId ||
		(await assertLxdOfficeHostNamespace(bootId)) !== namespace ||
		(await readRuntimeNodeHost(signal)).machineIdSha256 !== host.machineIdSha256
	)
		throw new Error("NODE_HEALTH_HOST_CHANGED");
	const values = Object.fromEntries(
		METRICS.map((key, index) => {
			const sample = samples[index]!;
			return [key, sample.status === "fulfilled" ? sample.value : null];
		}),
	);
	return parseRuntimeNodeHealth({
		schema: "qorpera.runtime-node-health/v1",
		nodeId: policy.nodeId,
		machineIdSha256: host.machineIdSha256,
		policySha256,
		observerPackageSha256,
		bootId,
		observationId: randomUUID(),
		observedAt: new Date().toISOString(),
		...values,
		errors: samples.flatMap((r, index) => (r.status === "rejected" ? [ERRORS[index]!] : [])),
	});
}

export async function collectRuntimeNodeHealthProcess(
	signal: AbortSignal,
	observer: string | undefined = process.argv[1],
): Promise<RuntimeNodeHealth> {
	signal.throwIfAborted();
	if (typeof observer !== "string") throw new Error("NODE_HEALTH_COLLECTION_UNCONFIRMED");
	return new Promise((resolve, reject) => {
		// The running observer's own file: the first installation's fixed path, or
		// the file a cut's drop-in starts. The probe checks its custody itself.
		const child = spawn(
			process.execPath,
			["--jitless", "--disable-proto=throw", "--disallow-code-generation-from-strings", observer, "--health-probe"],
			{ env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "ignore"] },
		);
		let failed = false,
			size = 0;
		const chunks: Buffer[] = [];
		const stop = () => {
			failed = true;
			child.kill("SIGKILL");
		};
		const timer = setTimeout(stop, 5000);
		signal.addEventListener("abort", stop, { once: true });
		child.once("error", () => {
			failed = true;
		});
		child.stdout.on("data", (bytes: Buffer) => {
			size += bytes.length;
			if (size > 32768) stop();
			else chunks.push(bytes);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			signal.removeEventListener("abort", stop);
			try {
				if (failed || code !== 0 || signal.aborted) throw new Error();
				resolve(parseRuntimeNodeHealth(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
			} catch {
				reject(new Error("NODE_HEALTH_COLLECTION_UNCONFIRMED"));
			}
		});
		if (signal.aborted) stop();
	});
}

export class RuntimeNodeHealthPublisher {
	#pending = false;
	readonly nodeId: string;
	readonly machineIdSha256: string;
	readonly policySha256: string;
	readonly registry: RuntimeNodeObserverRegistry;
	readonly collect: (signal: AbortSignal) => Promise<RuntimeNodeHealth>;
	constructor(
		nodeId: string,
		machineIdSha256: string,
		policySha256: string,
		registry: RuntimeNodeObserverRegistry,
		collect: (signal: AbortSignal) => Promise<RuntimeNodeHealth> = collectRuntimeNodeHealthProcess,
	) {
		officeUuid(nodeId);
		officeSha(machineIdSha256);
		officeSha(policySha256);
		this.nodeId = nodeId;
		this.machineIdSha256 = machineIdSha256;
		this.policySha256 = policySha256;
		this.registry = registry;
		this.collect = collect;
	}
	async observe(signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		if (this.#pending) throw new Error("NODE_HEALTH_BUSY");
		this.#pending = true;
		try {
			let observation: RuntimeNodeHealth;
			try {
				observation = parseRuntimeNodeHealth(await this.collect(signal));
				if (
					observation.nodeId !== this.nodeId ||
					observation.machineIdSha256 !== this.machineIdSha256 ||
					observation.policySha256 !== this.policySha256
				)
					throw new Error();
			} catch {
				signal.throwIfAborted();
				observation = {
					schema: "qorpera.runtime-node-health/v1",
					nodeId: this.nodeId,
					machineIdSha256: this.machineIdSha256,
					policySha256: this.policySha256,
					observerPackageSha256: null,
					bootId: null,
					observationId: randomUUID(),
					observedAt: new Date().toISOString(),
					cpu: null,
					memory: null,
					rootFilesystem: null,
					network: null,
					errors: ["COLLECTION_UNCONFIRMED"],
				};
			}
			signal.throwIfAborted();
			const receipt = officeRecord(
				await this.registry.call("qorpera_observe_runtime_node_health", { p_observation: observation }, signal),
				["nodeId", "observationId", "observedAt"],
			);
			signal.throwIfAborted();
			if (
				receipt.nodeId !== this.nodeId ||
				receipt.observationId !== observation.observationId ||
				typeof receipt.observedAt !== "string" ||
				Date.parse(receipt.observedAt) !== Date.parse(observation.observedAt)
			)
				throw new Error("NODE_HEALTH_PUBLICATION_UNCONFIRMED");
		} finally {
			this.#pending = false;
		}
	}
}
