import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { isUuid, SHA256_HEX_PATTERN } from "@qorpera/contracts";
import type { LxdCodeHostClient, LxdCreateInstanceRequest, LxdInstanceRecord, LxdProjectRecord } from "./lxd-client.ts";

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const GiB = 1024 ** 3;
const STOPPED = 102,
	RUNNING = 103;

/** A company's code host (step 5e): the VM on a node where the company's code area is worked on, through the
 * company folder (5d) and nothing else. It has no NIC, no profile and no device but its scratch root disk. */
export const CODE_HOST_SCHEMA = "qorpera.code-host/v1";
export const CODE_HOST_INSTANCE = "code-host";
/** One LXD project per company with a code host on the node (Q8), named by the company: the coding executor makes
 * it on the company's first job there. Nothing else lives in it. */
export const CODE_HOST_PROJECT = /^qorpera-codehost-([0-9a-f]{32})$/;

export function codeHostProject(companyId: string): string {
	if (!isUuid(companyId)) throw new Error("INVALID_CODE_HOST_COMPANY");
	return `qorpera-codehost-${companyId.replaceAll("-", "")}`;
}

/** The company a code host project is for; undefined for any other name. */
export function codeHostCompany(project: string): string | undefined {
	const hex = CODE_HOST_PROJECT.exec(project)?.[1];
	if (!hex) return undefined;
	const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
	return isUuid(id) ? id : undefined;
}

/** A node's code hosts: each made from this image with these limits, at most `running` of them started at once.
 * The node reserves `running` times the limits whether any runs or not, like the build space. The same block is
 * the node inventory policy's `codeHosts` and the coding executor's `codeHost`. */
export interface CodeHostPolicy {
	imageFingerprint: string;
	storagePool: string;
	cpus: number;
	memoryBytes: number;
	rootDiskBytes: number;
	running: number;
}
export const CODE_HOST_POLICY_KEYS = [
	"imageFingerprint",
	"storagePool",
	"cpus",
	"memoryBytes",
	"rootDiskBytes",
	"running",
] as const;

export function parseCodeHostPolicy(value: unknown): Readonly<CodeHostPolicy> {
	const input = value as Record<string, unknown>;
	const whole = (n: unknown, min: number, max: number, unit = 1) =>
		Number.isSafeInteger(n) && (n as number) >= min && (n as number) <= max && (n as number) % unit === 0;
	if (
		!input ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		Object.keys(input).sort().join() !== [...CODE_HOST_POLICY_KEYS].sort().join() ||
		typeof input.imageFingerprint !== "string" ||
		!SHA256_HEX_PATTERN.test(input.imageFingerprint) ||
		typeof input.storagePool !== "string" ||
		!NAME.test(input.storagePool) ||
		!whole(input.cpus, 1, 64) ||
		!whole(input.memoryBytes, GiB, 1024 * GiB, GiB) ||
		!whole(input.rootDiskBytes, 10 * GiB, 2048 * GiB, GiB) ||
		!whole(input.running, 1, 64)
	)
		throw new Error("INVALID_CODE_HOST_POLICY");
	return Object.freeze(
		Object.fromEntries(CODE_HOST_POLICY_KEYS.map((key) => [key, input[key]])),
	) as unknown as CodeHostPolicy;
}

/** What a node reserves for its code hosts. */
export function codeHostReservation(policy: CodeHostPolicy | undefined): { cpuMillis: number; memoryBytes: number } {
	return policy
		? { cpuMillis: policy.running * policy.cpus * 1000, memoryBytes: policy.running * policy.memoryBytes }
		: { cpuMillis: 0, memoryBytes: 0 };
}

export function codeHostRequest(policy: CodeHostPolicy, companyId: string): LxdCreateInstanceRequest {
	codeHostProject(companyId);
	return {
		name: CODE_HOST_INSTANCE,
		type: "virtual-machine",
		profiles: [],
		source: { type: "image", fingerprint: policy.imageFingerprint },
		config: {
			"boot.mode": "uefi-secureboot",
			"boot.autostart": "false",
			"security.devlxd": "false",
			"limits.cpu": String(policy.cpus),
			"limits.memory": String(policy.memoryBytes),
			"user.qorpera.schema": CODE_HOST_SCHEMA,
			"user.qorpera.company_id": companyId,
		},
		// No NIC: the code host reaches the folder service over vsock only. The disk is scratch; the code area lives
		// in the folder.
		devices: { root: { type: "disk", path: "/", pool: policy.storagePool, size: String(policy.rootDiskBytes) } },
	};
}

/** The instance is its project's code host exactly as codeHostRequest makes it under this policy: the company
 * marker is the project's, the image and limits are the policy's, and it has only the root disk. LXD's own
 * `volatile.*` keys and the `image.*` keys it copies from the image are the only others. */
export function codeHostInstanceMatches(policy: CodeHostPolicy, project: string, instance: LxdInstanceRecord): boolean {
	const companyId = codeHostCompany(project);
	if (!companyId || instance.name !== CODE_HOST_INSTANCE || instance.type !== "virtual-machine") return false;
	const request = codeHostRequest(policy, companyId);
	return (
		isDeepStrictEqual(instance.profiles, []) &&
		isDeepStrictEqual(instance.devices, request.devices) &&
		isDeepStrictEqual(instance.expandedDevices, request.devices) &&
		[instance.config, instance.expandedConfig].every(
			(config) =>
				config["volatile.base_image"] === policy.imageFingerprint &&
				Object.entries(request.config).every(([key, value]) => config[key] === value) &&
				Object.keys(config).every(
					(key) => Object.hasOwn(request.config, key) || key.startsWith("image.") || key.startsWith("volatile."),
				),
		)
	);
}

/** A code host project's settings. Every feature is named, since LXD turns on the ones a new project leaves out.
 * Images come from the default project's store; the project's own default profile stays empty and unused; LXD
 * itself refuses a NIC, a host path, low-level VM keys and a second instance there. */
export const CODE_HOST_PROJECT_CONFIG: Readonly<Record<string, string>> = Object.freeze({
	"features.images": "false",
	"features.profiles": "true",
	"features.storage.volumes": "true",
	"features.storage.buckets": "true",
	"features.networks": "false",
	"features.networks.zones": "false",
	restricted: "true",
	"restricted.devices.nic": "block",
	"restricted.devices.disk": "managed",
	"restricted.virtual-machines.lowlevel": "block",
	"limits.instances": "1",
	"limits.virtual-machines": "1",
	"limits.containers": "0",
});

/** The project is a code host project exactly as the executor makes it, and holds nothing but its default profile
 * and its code host (the VM and the VM's root volume). */
export function codeHostProjectMatches(project: LxdProjectRecord): boolean {
	if (!codeHostCompany(project.name) || !isDeepStrictEqual(project.config, CODE_HOST_PROJECT_CONFIG)) return false;
	const query = `?project=${project.name}`;
	return project.usedBy.every(
		(url) =>
			url === `/1.0/instances/${CODE_HOST_INSTANCE}${query}` ||
			url === `/1.0/profiles/default${query}` ||
			(url.startsWith("/1.0/storage-pools/") &&
				url.endsWith(`/volumes/virtual-machine/${CODE_HOST_INSTANCE}${query}`) &&
				NAME.test(url.slice(19, -`/volumes/virtual-machine/${CODE_HOST_INSTANCE}${query}`.length))),
	);
}

export type CodeHostEvent =
	| { event: "code-host"; step: "project-made" | "replaced" | "outdated" | "stopped" | "removed"; project: string }
	| { event: "code-host-error"; step: "refused" | "stop" | "housekeep"; project: string; error?: unknown };

export interface LxdCodeHostsOptions {
	client: LxdCodeHostClient;
	policy: CodeHostPolicy;
	/** A code host stops this long after its last job ends. Default 10 minutes. */
	idleStopMs?: number;
	/** How long a started code host may take until its agent runs a command, and a stop may take. Default 2 minutes. */
	agentWaitMs?: number;
	log?: (event: CodeHostEvent) => void;
}

export interface CodeHostLease {
	readonly companyId: string;
	readonly project: string;
	readonly name: typeof CODE_HOST_INSTANCE;
}

interface Host {
	readonly companyId: string;
	readonly project: string;
	jobs: number;
	/** Counted against the policy's `running`: the VM is started, or may be. */
	started: boolean;
	lastUsed: number;
	idle: NodeJS.Timeout | undefined;
	/** The host's lifecycle steps (start, stop, removal), one at a time. */
	steps: Promise<unknown>;
}

/** The coding executor's code hosts on its node. A company's jobs share its code host: the first starts it (and
 * makes its project and VM when missing, or the VM again when made under another policy), and it stops
 * `idleStopMs` after the last. At most the policy's `running` are started at once: a job for another company
 * stops the least recently used idle one, else waits its turn. The executor only ever touches projects named like
 * a code host's, and refuses (logs, touches nothing) one whose settings differ or that holds anything else. */
export class LxdCodeHosts {
	readonly #client: LxdCodeHostClient;
	readonly #policy: Readonly<CodeHostPolicy>;
	readonly #idleStopMs: number;
	readonly #agentWaitMs: number;
	readonly #log: (event: CodeHostEvent) => void;
	readonly #hosts = new Map<string, Host>();
	/** Jobs waiting for a start, first come first served. */
	readonly #turns: object[] = [];
	readonly #waiting = new Set<() => void>();
	#used = 0;
	#closed = false;

	constructor(options: LxdCodeHostsOptions) {
		const idleStopMs = options.idleStopMs ?? 600_000,
			agentWaitMs = options.agentWaitMs ?? 120_000;
		if (![idleStopMs, agentWaitMs].every((ms) => Number.isSafeInteger(ms) && ms >= 1 && ms <= 86_400_000))
			throw new Error("INVALID_CODE_HOST_POLICY");
		this.#client = options.client;
		this.#policy = parseCodeHostPolicy(options.policy);
		this.#idleStopMs = idleStopMs;
		this.#agentWaitMs = agentWaitMs;
		this.#log = options.log ?? (() => undefined);
	}

	/** Runs `job` while the company's code host is started and its agent answers. */
	async use<T>(companyId: string, signal: AbortSignal, job: (host: CodeHostLease) => Promise<T>): Promise<T> {
		if (this.#closed) throw new Error("CODE_HOSTS_CLOSED");
		const host = this.#host(companyId);
		signal.throwIfAborted();
		host.jobs += 1;
		clearTimeout(host.idle);
		host.idle = undefined;
		try {
			await this.#step(host, () => this.#start(host, signal));
			return await job({ companyId: host.companyId, project: host.project, name: CODE_HOST_INSTANCE });
		} finally {
			host.jobs -= 1;
			host.lastUsed = ++this.#used;
			this.#rest(host);
		}
	}

	/** At the executor's start: every code host still started is stopped, since one without its executor would keep
	 * its views open, and one made under another policy goes. Returns how many were stopped. */
	async housekeep(signal: AbortSignal): Promise<number> {
		let stopped = 0;
		for (const name of await this.#client.listProjectNames(signal)) {
			const companyId = codeHostCompany(name);
			if (!companyId) continue;
			const host = this.#host(companyId);
			try {
				await this.#step(host, async () => {
					if (host.jobs > 0 || !(await this.#project(host, signal, false))) return;
					clearTimeout(host.idle);
					host.idle = undefined;
					if (await this.#halt(host, signal)) stopped += 1;
					// A cut changed the image or the limits: the node's observer reports the old VM as unmanaged, so the
					// node would stay unavailable until the company's next job. Its disk is scratch.
					const instance = await this.#client.getInstance(host.project, CODE_HOST_INSTANCE, signal);
					if (instance && !codeHostInstanceMatches(this.#policy, host.project, instance)) {
						await this.#client.deleteInstance(host.project, CODE_HOST_INSTANCE, signal);
						this.#log({ event: "code-host", step: "outdated", project: host.project });
					}
				});
			} catch (error) {
				if (signal.aborted) throw error;
				this.#log({ event: "code-host-error", step: "housekeep", project: name, error });
			}
		}
		return stopped;
	}

	/** The company's deletion, after its runs ended: its code host and project go. False when it had none. */
	async remove(companyId: string, signal: AbortSignal): Promise<boolean> {
		const host = this.#host(companyId);
		return this.#step(host, async () => {
			if (host.jobs > 0) throw new Error("CODE_HOST_BUSY");
			if (!(await this.#project(host, signal, false))) return false;
			clearTimeout(host.idle);
			host.idle = undefined;
			await this.#halt(host, signal);
			if (await this.#client.getInstance(host.project, CODE_HOST_INSTANCE, signal))
				await this.#client.deleteInstance(host.project, CODE_HOST_INSTANCE, signal);
			await this.#client.deleteProject(host.project, signal);
			this.#log({ event: "code-host", step: "removed", project: host.project });
			return true;
		});
	}

	/** At the executor's end: no new job starts, and each code host stops once its jobs end. */
	async close(): Promise<void> {
		this.#closed = true;
		await Promise.all(
			[...this.#hosts.values()].map((host) => this.#step(host, () => this.#stopIdle(host)).catch(() => undefined)),
		);
	}

	#host(companyId: string): Host {
		const project = codeHostProject(companyId);
		let host = this.#hosts.get(companyId);
		if (!host) {
			host = { companyId, project, jobs: 0, started: false, lastUsed: 0, idle: undefined, steps: Promise.resolve() };
			this.#hosts.set(companyId, host);
		}
		return host;
	}

	#step<T>(host: Host, step: () => Promise<T>): Promise<T> {
		const run = host.steps.then(step, step);
		host.steps = run.catch(() => undefined);
		return run;
	}

	async #start(host: Host, signal: AbortSignal): Promise<void> {
		// A refused project is never touched: it is checked before anything else.
		await this.#project(host, signal, true);
		const fresh = !host.started;
		await this.#turn(host, signal);
		try {
			let instance = await this.#client.getInstance(host.project, CODE_HOST_INSTANCE, signal);
			if (instance && !codeHostInstanceMatches(this.#policy, host.project, instance)) {
				// Made under another policy (another image, other limits): its disk is scratch.
				if (instance.statusCode !== STOPPED)
					await this.#client.setInstancePower(host.project, CODE_HOST_INSTANCE, "stop", signal);
				await this.#client.deleteInstance(host.project, CODE_HOST_INSTANCE, signal);
				this.#log({ event: "code-host", step: "replaced", project: host.project });
				instance = undefined;
			}
			if (!instance) {
				await this.#client.createInstance(host.project, codeHostRequest(this.#policy, host.companyId), signal);
				instance = await this.#client.getInstance(host.project, CODE_HOST_INSTANCE, signal);
				if (!instance || !codeHostInstanceMatches(this.#policy, host.project, instance))
					throw new Error("CODE_HOST_DIFFERS");
			}
			if (instance.statusCode === STOPPED)
				await this.#client.setInstancePower(host.project, CODE_HOST_INSTANCE, "start", signal);
			else if (instance.statusCode !== RUNNING) throw new Error("CODE_HOST_STATE_UNAVAILABLE");
			await this.#agent(host, signal);
		} catch (error) {
			// Started for this job only: stop it again rather than hold a start until it idles out.
			if (fresh) await this.#halt(host, AbortSignal.timeout(this.#agentWaitMs)).catch(() => undefined);
			throw error;
		}
	}

	/** Checks the company's project (making it when `make` and missing); false when there is none. */
	async #project(host: Host, signal: AbortSignal, make: boolean): Promise<boolean> {
		let project = await this.#client.getProject(host.project, signal);
		if (!project && make) {
			await this.#client.createProject(host.project, CODE_HOST_PROJECT_CONFIG, signal);
			this.#log({ event: "code-host", step: "project-made", project: host.project });
			project = await this.#client.getProject(host.project, signal);
			if (!project) throw new Error("CODE_HOST_PROJECT_UNAVAILABLE");
		}
		if (!project) return false;
		if (!codeHostProjectMatches(project)) {
			this.#log({ event: "code-host-error", step: "refused", project: host.project });
			throw new Error("CODE_HOST_PROJECT_DIFFERS");
		}
		return true;
	}

	/** Takes one of the policy's `running` starts for the host: a free one, or the least recently used idle host's. */
	async #turn(host: Host, signal: AbortSignal): Promise<void> {
		if (host.started) return;
		const turn = {};
		this.#turns.push(turn);
		try {
			for (;;) {
				if (this.#turns[0] === turn) {
					const hosts = [...this.#hosts.values()];
					if (hosts.filter((h) => h.started).length < this.#policy.running) {
						host.started = true;
						return;
					}
					const idle = hosts.filter((h) => h.started && h.jobs === 0).sort((a, b) => a.lastUsed - b.lastUsed)[0];
					if (idle) {
						await this.#step(idle, () => this.#stopIdle(idle));
						continue;
					}
				}
				await this.#changed(signal);
			}
		} finally {
			this.#turns.splice(this.#turns.indexOf(turn), 1);
			this.#notify();
		}
	}

	#changed(signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		return new Promise((resolve, reject) => {
			const done = () => {
				signal.removeEventListener("abort", abort);
				resolve();
			};
			const abort = () => {
				this.#waiting.delete(done);
				reject(signal.reason);
			};
			this.#waiting.add(done);
			signal.addEventListener("abort", abort, { once: true });
		});
	}

	#notify(): void {
		const waiting = [...this.#waiting];
		this.#waiting.clear();
		for (const done of waiting) done();
	}

	/** Polls until the agent runs a command: LXD answers exec only once the VM's agent is up. */
	async #agent(host: Host, signal: AbortSignal): Promise<void> {
		const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.#agentWaitMs)]);
		for (;;) {
			try {
				await this.#client.execInstance(host.project, CODE_HOST_INSTANCE, ["/bin/true"], deadline);
				return;
			} catch (error) {
				signal.throwIfAborted();
				if (deadline.aborted) throw new Error("CODE_HOST_AGENT_UNAVAILABLE");
				if (!(error instanceof Error) || error.message !== "LXD instance agent not running") throw error;
			}
			await delay(1000, undefined, { signal: deadline }).catch(() => undefined);
		}
	}

	/** An idle host's stop, `idleStopMs` after its last job or for another company's start. */
	async #stopIdle(host: Host): Promise<void> {
		if (!host.started || host.jobs > 0) return;
		clearTimeout(host.idle);
		host.idle = undefined;
		try {
			await this.#halt(host, AbortSignal.timeout(this.#agentWaitMs));
		} catch (error) {
			this.#log({ event: "code-host-error", step: "stop", project: host.project, error });
			if (!this.#closed) this.#rest(host);
			throw error;
		}
	}

	/** Stops the VM if it runs and gives back its start; true when it ran. */
	async #halt(host: Host, signal: AbortSignal): Promise<boolean> {
		const instance = await this.#client.getInstance(host.project, CODE_HOST_INSTANCE, signal);
		const running = !!instance && instance.statusCode !== STOPPED;
		if (running) await this.#client.setInstancePower(host.project, CODE_HOST_INSTANCE, "stop", signal);
		host.started = false;
		this.#notify();
		if (running) this.#log({ event: "code-host", step: "stopped", project: host.project });
		return running;
	}

	/** After a host's last job: it may be stopped for another company now, and stops by itself later. */
	#rest(host: Host): void {
		if (host.jobs > 0) return;
		this.#notify();
		if (!host.started) return;
		const stop = () => void this.#step(host, () => this.#stopIdle(host)).catch(() => undefined);
		clearTimeout(host.idle);
		host.idle = undefined;
		if (this.#closed) {
			stop();
			return;
		}
		host.idle = setTimeout(stop, this.#idleStopMs);
		host.idle.unref();
	}
}
