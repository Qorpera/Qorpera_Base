import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	CODE_HOST_DELETION_RPCS,
	CODE_HOST_PROJECT_CONFIG,
	type CodeHostEvent,
	type CodeHostPolicy,
	codeHostCompany,
	codeHostInstanceMatches,
	codeHostProject,
	codeHostProjectMatches,
	codeHostRequest,
	controlCodeHostDeletions,
	LxdCodeHosts,
	parseCodeHostPolicy,
} from "../src/code-host.ts";
import type {
	LxdCodeHostClient,
	LxdCreateInstanceRequest,
	LxdInstancePowerAction,
	LxdInstanceRecord,
	LxdProjectRecord,
} from "../src/lxd-client.ts";

const GiB = 1024 ** 3;
const policy: CodeHostPolicy = {
	imageFingerprint: "c".repeat(64),
	storagePool: "qorpera-vm",
	cpus: 2,
	memoryBytes: 4 * GiB,
	rootDiskBytes: 20 * GiB,
	running: 2,
};
const company = (n: number) => `${String(n).repeat(8)}-0000-4000-8000-000000000000`;
const signal = () => new AbortController().signal;

/** LXD with code host projects: each holds its default profile, and the code host with its root volume. */
class FakeLxd implements LxdCodeHostClient {
	readonly projects = new Map<string, { config: Record<string, string>; extra: string[] }>();
	readonly instances = new Map<string, LxdInstanceRecord & { config: Record<string, string> }>();
	readonly calls: string[] = [];
	/** Exec answers "agent not running" this many times first. */
	agentDown = 0;
	/** What LXD makes differs from the request. */
	made?: (instance: LxdInstanceRecord & { config: Record<string, string> }) => void;
	/** The next this many stops fail. */
	failStop = 0;
	/** A stop of this project never ends by itself. */
	hangStop?: string;
	/** The project list never ends by itself. */
	hangList = false;
	/** Called on every exec, before it answers. */
	onExec?: () => void;
	async getProject(name: string): Promise<LxdProjectRecord | undefined> {
		const project = this.projects.get(name);
		if (!project) return undefined;
		const query = `?project=${name}`;
		return {
			name,
			config: { ...project.config },
			usedBy: [
				`/1.0/profiles/default${query}`,
				...(this.instances.has(name)
					? [
							`/1.0/instances/code-host${query}`,
							`/1.0/storage-pools/qorpera-vm/volumes/virtual-machine/code-host${query}`,
						]
					: []),
				...project.extra,
			],
		};
	}
	async createProject(name: string, config: Readonly<Record<string, string>>): Promise<void> {
		this.calls.push(`project ${name}`);
		this.projects.set(name, { config: { ...config }, extra: [] });
	}
	async deleteProject(name: string): Promise<boolean> {
		this.calls.push(`delete-project ${name}`);
		if (this.instances.has(name)) throw new Error("Only empty projects can be removed");
		return this.projects.delete(name);
	}
	async listProjectNames(signal?: AbortSignal): Promise<string[]> {
		if (this.hangList)
			await new Promise((_, reject) =>
				signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
			);
		return ["default", "qorpera-build", ...this.projects.keys()];
	}
	async getInstance(project: string, name: string): Promise<LxdInstanceRecord | undefined> {
		const instance = this.instances.get(project);
		return instance?.name === name ? structuredClone(instance) : undefined;
	}
	async createInstance(project: string, request: LxdCreateInstanceRequest): Promise<void> {
		this.calls.push(`create ${project}`);
		const config = {
			...request.config,
			"volatile.uuid": randomUUID(),
			"volatile.base_image": request.source.fingerprint,
			"image.os": "Ubuntu",
		};
		const instance = {
			name: request.name,
			type: request.type,
			status: "Stopped",
			statusCode: 102,
			config,
			expandedConfig: { ...config },
			profiles: [...request.profiles],
			devices: structuredClone(request.devices),
			expandedDevices: structuredClone(request.devices),
		};
		this.made?.(instance);
		this.instances.set(project, instance);
	}
	async setInstancePower(
		project: string,
		_name: string,
		action: LxdInstancePowerAction,
		signal?: AbortSignal,
	): Promise<void> {
		this.calls.push(`${action} ${project}`);
		const instance = this.instances.get(project);
		if (!instance) throw new Error("Instance not found");
		if (action === "stop" && this.hangStop === project)
			await new Promise((_, reject) =>
				signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
			);
		if (action === "stop" && this.failStop > 0) {
			this.failStop -= 1;
			throw new Error("Failed to stop instance");
		}
		instance.status = action === "start" ? "Running" : "Stopped";
		instance.statusCode = action === "start" ? 103 : 102;
	}
	async execInstance(project: string): Promise<void> {
		this.calls.push(`exec ${project}`);
		this.onExec?.();
		if (this.agentDown > 0) {
			this.agentDown -= 1;
			throw new Error("LXD instance agent not running");
		}
	}
	async deleteInstance(project: string): Promise<void> {
		this.calls.push(`delete ${project}`);
		this.instances.delete(project);
	}
	running(companyId: string): boolean {
		return this.instances.get(codeHostProject(companyId))?.statusCode === 103;
	}
}

function hosts(options: { running?: number; idleStopMs?: number; agentWaitMs?: number } = {}) {
	const lxd = new FakeLxd(),
		events: CodeHostEvent[] = [];
	const codeHosts = new LxdCodeHosts({
		client: lxd,
		policy: { ...policy, running: options.running ?? policy.running },
		idleStopMs: options.idleStopMs ?? 60_000,
		agentWaitMs: options.agentWaitMs ?? 60_000,
		log: (event) => events.push(event),
	});
	return { lxd, events, codeHosts };
}

/** A job that runs until it is let go. */
function held() {
	let release!: () => void;
	const done = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { job: () => done, release };
}

describe("code host names", () => {
	it("names one project per company, and reads the company back", () => {
		const project = codeHostProject(company(1));
		expect(project).toBe("qorpera-codehost-11111111000040008000000000000000");
		expect(codeHostCompany(project)).toBe(company(1));
		for (const other of [
			"default",
			"qorpera-build",
			`${project}0`,
			project.toUpperCase(),
			"qorpera-codehost-11111111000000008000000000000000",
		])
			expect(codeHostCompany(other)).toBeUndefined();
		const lettered = "abcdef12-0000-4000-8000-00000000000a";
		expect(codeHostProject(lettered)).toBe(`qorpera-codehost-${lettered.replaceAll("-", "")}`);
		expect(codeHostCompany(codeHostProject(lettered))).toBe(lettered);
		for (const bad of [
			"",
			"not-a-uuid",
			"ABCDEF12-0000-4000-8000-00000000000A",
			company(1).replaceAll("-", ""),
			"11111111-0000-0000-8000-000000000000",
			7,
		])
			expect(() => codeHostProject(bad as string)).toThrow("INVALID_CODE_HOST_COMPANY");
	});
});

describe("code host policy", () => {
	it("parses the block strictly and freezes it", () => {
		const parsed = parseCodeHostPolicy({ ...policy });
		expect(parsed).toEqual(policy);
		expect(Object.isFrozen(parsed)).toBe(true);
		const { running: _running, ...withoutRunning } = policy;
		for (const bad of [
			{ ...policy, extra: 1 },
			withoutRunning,
			{ ...policy, imageFingerprint: "c".repeat(63) },
			{ ...policy, storagePool: "../pool" },
			{ ...policy, cpus: 0 },
			{ ...policy, cpus: 65 },
			{ ...policy, cpus: "2" },
			{ ...policy, memoryBytes: GiB / 2 },
			{ ...policy, memoryBytes: 4 * GiB + 1 },
			{ ...policy, rootDiskBytes: 9 * GiB },
			{ ...policy, rootDiskBytes: 2049 * GiB },
			{ ...policy, running: 0 },
			{ ...policy, running: 1.5 },
			[],
			"policy",
			null,
		])
			expect(() => parseCodeHostPolicy(bad)).toThrow("INVALID_CODE_HOST_POLICY");
	});
	it("makes a VM with no NIC, no profile, no /dev/lxd and only its scratch root", () => {
		expect(codeHostRequest(policy, company(1))).toEqual({
			name: "code-host",
			type: "virtual-machine",
			profiles: [],
			source: { type: "image", fingerprint: policy.imageFingerprint },
			config: {
				"boot.mode": "uefi-secureboot",
				"boot.autostart": "false",
				"security.devlxd": "false",
				"limits.cpu": "2",
				"limits.memory": String(4 * GiB),
				"user.qorpera.schema": "qorpera.code-host/v1",
				"user.qorpera.company_id": company(1),
			},
			devices: { root: { type: "disk", path: "/", pool: "qorpera-vm", size: String(20 * GiB) } },
		});
	});
	it("matches a VM only exactly as it is made under the policy, in its own company's project", async () => {
		const lxd = new FakeLxd(),
			project = codeHostProject(company(1));
		await lxd.createInstance(project, codeHostRequest(policy, company(1)));
		const instance = (await lxd.getInstance(project, "code-host")) as LxdInstanceRecord;
		expect(codeHostInstanceMatches(policy, project, instance)).toBe(true);
		expect(codeHostInstanceMatches(policy, codeHostProject(company(2)), instance)).toBe(false);
		expect(codeHostInstanceMatches({ ...policy, cpus: 4 }, project, instance)).toBe(false);
		expect(codeHostInstanceMatches({ ...policy, imageFingerprint: "d".repeat(64) }, project, instance)).toBe(false);
		expect(codeHostInstanceMatches(policy, "default", instance)).toBe(false);
		const changed = (change: (i: LxdInstanceRecord & { config: Record<string, string> }) => void) => {
			const copy = structuredClone(instance) as LxdInstanceRecord & { config: Record<string, string> };
			change(copy);
			return codeHostInstanceMatches(policy, project, copy);
		};
		expect(
			changed((i) => {
				i.config["security.secureboot"] = "false";
			}),
		).toBe(false);
		expect(
			changed((i) => {
				i.config["volatile.eth0.hwaddr"] = "00:16:3e:00:00:01";
			}),
		).toBe(true);
		expect(
			changed((i) => {
				i.expandedDevices = { ...i.expandedDevices, eth0: { type: "nic", network: "lxdbr0" } };
			}),
		).toBe(false);
		expect(
			changed((i) => {
				i.type = "container";
			}),
		).toBe(false);
	});
	it("matches a project only with its exact settings, holding nothing but its code host", () => {
		const name = codeHostProject(company(1)),
			query = `?project=${name}`,
			project = (change: Partial<LxdProjectRecord> = {}): LxdProjectRecord => ({
				name,
				config: { ...CODE_HOST_PROJECT_CONFIG },
				usedBy: [
					`/1.0/profiles/default${query}`,
					`/1.0/instances/code-host${query}`,
					`/1.0/storage-pools/qorpera-vm/volumes/virtual-machine/code-host${query}`,
				],
				...change,
			});
		expect(codeHostProjectMatches(project())).toBe(true);
		expect(codeHostProjectMatches(project({ usedBy: [] }))).toBe(true);
		expect(codeHostProjectMatches(project({ name: "qorpera-build" }))).toBe(false);
		expect(
			codeHostProjectMatches(project({ config: { ...CODE_HOST_PROJECT_CONFIG, "features.images": "true" } })),
		).toBe(false);
		const { "limits.instances": _limit, ...withoutLimit } = CODE_HOST_PROJECT_CONFIG;
		expect(codeHostProjectMatches(project({ config: withoutLimit }))).toBe(false);
		for (const extra of [
			`/1.0/instances/other${query}`,
			`/1.0/profiles/extra${query}`,
			`/1.0/storage-pools/qorpera-vm/volumes/custom/data${query}`,
			`/1.0/storage-pools/../volumes/virtual-machine/code-host${query}`,
			`/1.0/networks/qorpera0${query}`,
			"/1.0/instances/code-host?project=default",
		])
			expect(codeHostProjectMatches(project({ usedBy: [...project().usedBy, extra] }))).toBe(false);
	});
});

describe("LxdCodeHosts", () => {
	it("makes the company's project and VM on its first job, starts it, and waits for its agent", async () => {
		const { lxd, events, codeHosts } = hosts();
		const project = codeHostProject(company(1));
		lxd.agentDown = 1;
		const lease = await codeHosts.use(company(1), signal(), async (host) => {
			expect(lxd.running(company(1))).toBe(true);
			return host;
		});
		expect(lease).toEqual({ companyId: company(1), project, name: "code-host" });
		expect(lxd.projects.get(project)?.config).toEqual(CODE_HOST_PROJECT_CONFIG);
		expect(lxd.calls).toEqual([
			`project ${project}`,
			`create ${project}`,
			`start ${project}`,
			...Array(2).fill(`exec ${project}`),
		]);
		expect(events).toEqual([{ event: "code-host", step: "project-made", project }]);
		// A second job finds it running.
		lxd.calls.length = 0;
		await codeHosts.use(company(1), signal(), async () => undefined);
		expect(lxd.calls).toEqual([`exec ${project}`]);
		await codeHosts.close();
	});
	it("stops a code host once its last job has been idle for idleStopMs", async () => {
		const { lxd, codeHosts } = hosts({ idleStopMs: 20 });
		const a = held(),
			b = held();
		const first = codeHosts.use(company(1), signal(), a.job),
			second = codeHosts.use(company(1), signal(), b.job);
		await vi.waitFor(() => expect(lxd.running(company(1))).toBe(true));
		a.release();
		await first;
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(lxd.running(company(1))).toBe(true);
		b.release();
		await second;
		await vi.waitFor(() => expect(lxd.running(company(1))).toBe(false));
	});
	it("starts at most `running`: another company stops the least recently used idle one, else waits", async () => {
		const { lxd, events, codeHosts } = hosts({ running: 2 });
		await codeHosts.use(company(1), signal(), async () => undefined);
		await codeHosts.use(company(2), signal(), async () => undefined);
		await codeHosts.use(company(1), signal(), async () => undefined);
		// Company 2 is the least recently used.
		const third = held();
		const running = codeHosts.use(company(3), signal(), third.job);
		await vi.waitFor(() => expect(lxd.running(company(3))).toBe(true));
		expect([lxd.running(company(1)), lxd.running(company(2))]).toEqual([true, false]);
		expect(events).toContainEqual({ event: "code-host", step: "stopped", project: codeHostProject(company(2)) });
		// Both started hosts busy: the next company waits for a job to end.
		const first = held();
		const busy = codeHosts.use(company(1), signal(), first.job);
		let started = false;
		const fourth = codeHosts.use(company(4), signal(), async () => {
			started = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect([started, lxd.running(company(4))]).toEqual([false, false]);
		third.release();
		await running;
		await fourth;
		expect([started, lxd.running(company(3)), lxd.running(company(1))]).toEqual([true, false, true]);
		first.release();
		await busy;
		await codeHosts.close();
	});
	it("gives up a waiting turn when the job is aborted", async () => {
		const { lxd, codeHosts } = hosts({ running: 1 });
		const first = held();
		const busy = codeHosts.use(company(1), signal(), first.job);
		await vi.waitFor(() => expect(lxd.running(company(1))).toBe(true));
		const abort = new AbortController();
		const waiting = codeHosts.use(company(2), abort.signal, async () => "ran");
		await new Promise((resolve) => setTimeout(resolve, 20));
		abort.abort(new Error("JOB_CANCELLED"));
		await expect(waiting).rejects.toThrow("JOB_CANCELLED");
		first.release();
		await busy;
		// The aborted turn holds nothing: the next company starts.
		await expect(codeHosts.use(company(3), signal(), async () => "ran")).resolves.toBe("ran");
		await codeHosts.close();
	});
	it("replaces a VM made under another policy; its disk is scratch", async () => {
		const { lxd, events, codeHosts } = hosts();
		const project = codeHostProject(company(1));
		await lxd.createProject(project, CODE_HOST_PROJECT_CONFIG);
		await lxd.createInstance(project, codeHostRequest({ ...policy, imageFingerprint: "d".repeat(64) }, company(1)));
		await lxd.setInstancePower(project, "code-host", "start");
		lxd.calls.length = 0;
		await codeHosts.use(company(1), signal(), async () => undefined);
		expect(lxd.calls).toEqual([
			`stop ${project}`,
			`delete ${project}`,
			`create ${project}`,
			`start ${project}`,
			`exec ${project}`,
		]);
		expect(events).toEqual([{ event: "code-host", step: "replaced", project }]);
		expect(lxd.instances.get(project)?.config["volatile.base_image"]).toBe(policy.imageFingerprint);
		await codeHosts.close();
	});
	it.each<[string, (lxd: FakeLxd, project: string) => void]>([
		[
			"other settings",
			(lxd, project) => {
				(lxd.projects.get(project) as { config: Record<string, string> }).config["features.networks"] = "true";
			},
		],
		[
			"something besides its code host",
			(lxd, project) => {
				lxd.projects.get(project)?.extra.push(`/1.0/instances/other?project=${project}`);
			},
		],
	])("refuses a project with %s and touches nothing", async (_, change) => {
		const { lxd, events, codeHosts } = hosts();
		const project = codeHostProject(company(1));
		await lxd.createProject(project, CODE_HOST_PROJECT_CONFIG);
		change(lxd, project);
		lxd.calls.length = 0;
		await expect(codeHosts.use(company(1), signal(), async () => "ran")).rejects.toThrow("CODE_HOST_PROJECT_DIFFERS");
		await expect(codeHosts.remove(company(1), signal())).rejects.toThrow("CODE_HOST_PROJECT_DIFFERS");
		expect(lxd.calls).toEqual([]);
		expect(events).toEqual(Array(2).fill({ event: "code-host-error", step: "refused", project }));
	});
	it("stops a host whose start failed, so it holds no start", async () => {
		const { lxd, codeHosts } = hosts({ running: 1 });
		lxd.made = (instance) => {
			instance.config["security.secureboot"] = "false";
		};
		await expect(codeHosts.use(company(1), signal(), async () => "ran")).rejects.toThrow("CODE_HOST_DIFFERS");
		lxd.made = undefined;
		await expect(codeHosts.use(company(2), signal(), async () => "ran")).resolves.toBe("ran");
		await codeHosts.close();
	});
	it("gives up on an agent that never answers, and stops the VM again", async () => {
		const { lxd, codeHosts } = hosts({ agentWaitMs: 50 });
		lxd.agentDown = Number.POSITIVE_INFINITY;
		await expect(codeHosts.use(company(1), signal(), async () => "ran")).rejects.toThrow(
			"CODE_HOST_AGENT_UNAVAILABLE",
		);
		expect(lxd.running(company(1))).toBe(false);
	});
	it("at the executor's start stops every started code host and deletes outdated ones, past a refused project", async () => {
		const { lxd, events, codeHosts } = hosts();
		const [running, outdated, refused, empty] = [1, 2, 3, 4].map((n) => codeHostProject(company(n)));
		for (const project of [running, outdated, refused, empty])
			await lxd.createProject(project, CODE_HOST_PROJECT_CONFIG);
		await lxd.createInstance(running, codeHostRequest(policy, company(1)));
		await lxd.setInstancePower(running, "code-host", "start");
		await lxd.createInstance(outdated, codeHostRequest({ ...policy, memoryBytes: 8 * GiB }, company(2)));
		await lxd.createInstance(refused, codeHostRequest(policy, company(3)));
		await lxd.setInstancePower(refused, "code-host", "start");
		(lxd.projects.get(refused) as { config: Record<string, string> }).config.restricted = "false";
		await expect(codeHosts.housekeep(signal())).resolves.toBe(1);
		expect([lxd.running(company(1)), lxd.instances.has(running)]).toEqual([false, true]);
		expect(lxd.instances.has(outdated)).toBe(false);
		expect(lxd.running(company(3))).toBe(true);
		expect(events).toEqual([
			{ event: "code-host", step: "stopped", project: running },
			{ event: "code-host", step: "outdated", project: outdated },
			{ event: "code-host-error", step: "refused", project: refused },
			{
				event: "code-host-error",
				step: "housekeep",
				project: refused,
				error: new Error("CODE_HOST_PROJECT_DIFFERS"),
			},
		]);
		// Only the refused project's code host still counts against `running`, since it may run: the next company
		// starts at once, and the one after stops that one rather than touch the refused project.
		events.length = 0;
		await codeHosts.use(company(5), signal(), async () => undefined);
		await codeHosts.use(company(6), signal(), async () => undefined);
		expect([3, 5, 6].map((n) => lxd.running(company(n)))).toEqual([true, false, true]);
		expect(events).toEqual([
			{ event: "code-host", step: "project-made", project: codeHostProject(company(5)) },
			{ event: "code-host", step: "project-made", project: codeHostProject(company(6)) },
			{ event: "code-host-error", step: "refused", project: refused },
			{ event: "code-host-error", step: "stop", project: refused, error: new Error("CODE_HOST_PROJECT_DIFFERS") },
			{ event: "code-host", step: "stopped", project: codeHostProject(company(5)) },
		]);
		await codeHosts.close();
		expect(lxd.running(company(3))).toBe(true);
	});
	it.each(["another company's start", "close"])(
		"keeps a code host whose stop failed at the executor's start counted, and stops it at %s",
		async (later) => {
			const { lxd, events, codeHosts } = hosts({ running: 1 });
			const [project, next] = [1, 2].map((n) => codeHostProject(company(n)));
			await lxd.createProject(project, CODE_HOST_PROJECT_CONFIG);
			await lxd.createInstance(project, codeHostRequest(policy, company(1)));
			await lxd.setInstancePower(project, "code-host", "start");
			lxd.calls.length = 0;
			lxd.failStop = 1;
			await expect(codeHosts.housekeep(signal())).resolves.toBe(0);
			expect(lxd.running(company(1))).toBe(true);
			expect(events).toEqual([
				{ event: "code-host-error", step: "housekeep", project, error: new Error("Failed to stop instance") },
			]);
			if (later === "close") {
				await codeHosts.close();
				expect(lxd.calls).toEqual([`stop ${project}`, `stop ${project}`]);
			} else {
				await codeHosts.use(company(2), signal(), async () => undefined);
				expect(lxd.calls).toEqual([
					`stop ${project}`,
					`project ${next}`,
					`stop ${project}`,
					`create ${next}`,
					`start ${next}`,
					`exec ${next}`,
				]);
				await codeHosts.close();
			}
			expect(lxd.running(company(1))).toBe(false);
		},
	);
	it("keeps the start of a code host whose project was changed after its use, and never stops it", async () => {
		const { lxd, events, codeHosts } = hosts({ running: 1, idleStopMs: 20 });
		const [project, next] = [1, 2].map((n) => codeHostProject(company(n)));
		await codeHosts.use(company(1), signal(), async () => undefined);
		(lxd.projects.get(project) as { config: Record<string, string> }).config.restricted = "false";
		lxd.calls.length = 0;
		// Its idle stop refuses the project, and so does its next job.
		await vi.waitFor(() => expect(events).toContainEqual({ event: "code-host-error", step: "refused", project }));
		await expect(codeHosts.use(company(1), signal(), async () => "ran")).rejects.toThrow("CODE_HOST_PROJECT_DIFFERS");
		// Another company waits for its start rather than stop the refused project's code host, until its job ends.
		const abort = new AbortController();
		const waiting = codeHosts.use(company(2), abort.signal, async () => "ran");
		await new Promise((resolve) => setTimeout(resolve, 60));
		abort.abort(new Error("JOB_CANCELLED"));
		await expect(waiting).rejects.toThrow("JOB_CANCELLED");
		await codeHosts.close();
		expect(lxd.running(company(1))).toBe(true);
		expect(lxd.calls).toEqual([`project ${next}`]);
		expect(events).not.toContainEqual({ event: "code-host", step: "stopped", project });
	});
	it("checks the project again after the wait for a start: one changed meanwhile is not touched, and keeps the start", async () => {
		const { lxd, events, codeHosts } = hosts({ running: 1 });
		const [busy, waited, next] = [1, 2, 3].map((n) => codeHostProject(company(n)));
		const first = held();
		const running = codeHosts.use(company(1), signal(), first.job);
		await vi.waitFor(() => expect(lxd.running(company(1))).toBe(true));
		// Company 2's project passes its first check, then its job waits for company 1's start.
		await lxd.createProject(waited, CODE_HOST_PROJECT_CONFIG);
		const waiting = codeHosts.use(company(2), signal(), async () => "ran");
		await new Promise((resolve) => setTimeout(resolve, 20));
		(lxd.projects.get(waited) as { config: Record<string, string> }).config.restricted = "false";
		lxd.calls.length = 0;
		first.release();
		await running;
		await expect(waiting).rejects.toThrow("CODE_HOST_PROJECT_DIFFERS");
		expect(lxd.calls).toEqual([`stop ${busy}`]);
		expect(events).toContainEqual({ event: "code-host-error", step: "refused", project: waited });
		// It may run (its project is not the executor's to judge now): another company waits rather than stop it.
		const abort = new AbortController();
		const third = codeHosts.use(company(3), abort.signal, async () => "ran");
		await new Promise((resolve) => setTimeout(resolve, 30));
		abort.abort(new Error("JOB_CANCELLED"));
		await expect(third).rejects.toThrow("JOB_CANCELLED");
		await codeHosts.close();
		expect(lxd.calls).toEqual([`stop ${busy}`, `project ${next}`]);
	});
	it.each(["its agent wait runs out", "its job is cancelled"])(
		"checks the project again before it stops a failed start: one changed while %s is not touched",
		async (end) => {
			const { lxd, events, codeHosts } = hosts({ running: 1, agentWaitMs: 50 });
			const project = codeHostProject(company(1));
			const abort = new AbortController();
			lxd.agentDown = Number.POSITIVE_INFINITY;
			lxd.onExec = () => {
				(lxd.projects.get(project) as { config: Record<string, string> }).config.restricted = "false";
				if (end === "its job is cancelled") abort.abort(new Error("JOB_CANCELLED"));
			};
			await expect(codeHosts.use(company(1), abort.signal, async () => "ran")).rejects.toThrow(
				end === "its job is cancelled" ? "JOB_CANCELLED" : "CODE_HOST_AGENT_UNAVAILABLE",
			);
			expect(lxd.running(company(1))).toBe(true);
			expect(events).toContainEqual({ event: "code-host-error", step: "refused", project });
			// It keeps its start: another company waits rather than stop it.
			lxd.onExec = undefined;
			lxd.agentDown = 0;
			const other = new AbortController();
			const waiting = codeHosts.use(company(2), other.signal, async () => "ran");
			await new Promise((resolve) => setTimeout(resolve, 30));
			other.abort(new Error("JOB_CANCELLED"));
			await expect(waiting).rejects.toThrow("JOB_CANCELLED");
			await codeHosts.close();
			expect(lxd.running(company(1))).toBe(true);
			expect(lxd.calls).not.toContain(`stop ${project}`);
		},
	);
	it("removes a company's code host and project after its runs ended", async () => {
		const { lxd, events, codeHosts } = hosts();
		const project = codeHostProject(company(1));
		await expect(codeHosts.remove(company(1), signal())).resolves.toBe(false);
		const job = held();
		const busy = codeHosts.use(company(1), signal(), job.job);
		await vi.waitFor(() => expect(lxd.running(company(1))).toBe(true));
		await expect(codeHosts.remove(company(1), signal())).rejects.toThrow("CODE_HOST_BUSY");
		job.release();
		await busy;
		await expect(codeHosts.remove(company(1), signal())).resolves.toBe(true);
		expect([lxd.instances.has(project), lxd.projects.has(project)]).toEqual([false, false]);
		expect(events.slice(-2)).toEqual([
			{ event: "code-host", step: "stopped", project },
			{ event: "code-host", step: "removed", project },
		]);
		await codeHosts.close();
	});
	it("removes the code hosts of the companies being deleted, and one in a job or made again on a later pass", async () => {
		const { lxd, events, codeHosts } = hosts({ running: 3 });
		const [deleted, kept, busy, refused] = [1, 2, 3, 4].map((n) => codeHostProject(company(n)));
		await codeHosts.use(company(1), signal(), async () => undefined);
		await codeHosts.use(company(2), signal(), async () => undefined);
		const job = held();
		const running = codeHosts.use(company(3), signal(), job.job);
		await vi.waitFor(() => expect(lxd.running(company(3))).toBe(true));
		await lxd.createProject(refused, CODE_HOST_PROJECT_CONFIG);
		(lxd.projects.get(refused) as { config: Record<string, string> }).config.restricted = "false";
		events.length = 0;
		const asked: string[][] = [];
		const deleting = async (companyIds: readonly string[]) => {
			asked.push([...companyIds]);
			return [1, 3, 4].map(company);
		};
		await expect(codeHosts.removeDeleting(deleting, signal())).resolves.toBe(1);
		expect(asked).toEqual([[1, 2, 3, 4].map(company)]);
		expect([deleted, kept, busy, refused].map((project) => lxd.projects.has(project))).toEqual([
			false,
			true,
			true,
			true,
		]);
		expect([2, 3].map((n) => lxd.running(company(n)))).toEqual([true, true]);
		expect(events).toEqual([
			{ event: "code-host", step: "stopped", project: deleted },
			{ event: "code-host", step: "removed", project: deleted },
			{ event: "code-host-error", step: "remove", project: busy, error: new Error("CODE_HOST_BUSY") },
			{ event: "code-host-error", step: "refused", project: refused },
			{ event: "code-host-error", step: "remove", project: refused, error: new Error("CODE_HOST_PROJECT_DIFFERS") },
		]);
		// The job ends, and a later job makes the removed one again: the next pass removes both.
		job.release();
		await running;
		await codeHosts.use(company(1), signal(), async () => undefined);
		events.length = 0;
		await expect(codeHosts.removeDeleting(deleting, signal())).resolves.toBe(2);
		expect(asked[1]).toEqual([2, 3, 4, 1].map(company));
		expect([deleted, kept, busy, refused].map((project) => lxd.projects.has(project))).toEqual([
			false,
			true,
			false,
			true,
		]);
		expect(events).toEqual([
			{ event: "code-host", step: "stopped", project: busy },
			{ event: "code-host", step: "removed", project: busy },
			{ event: "code-host-error", step: "refused", project: refused },
			{ event: "code-host-error", step: "remove", project: refused, error: new Error("CODE_HOST_PROJECT_DIFFERS") },
			{ event: "code-host", step: "stopped", project: deleted },
			{ event: "code-host", step: "removed", project: deleted },
		]);
		await codeHosts.close();
	});
	it("asks nothing on a node without code hosts, and touches nothing when the answer fails", async () => {
		const { lxd, codeHosts } = hosts();
		const deleting = vi.fn(async () => [company(1)]);
		await expect(codeHosts.removeDeleting(deleting, signal())).resolves.toBe(0);
		expect(deleting).not.toHaveBeenCalled();
		await codeHosts.use(company(1), signal(), async () => undefined);
		lxd.calls.length = 0;
		await expect(
			codeHosts.removeDeleting(async () => {
				throw new Error("CODING_CONTROL_UNCONFIRMED");
			}, signal()),
		).rejects.toThrow("CODING_CONTROL_UNCONFIRMED");
		expect(lxd.calls).toEqual([]);
		expect(lxd.running(company(1))).toBe(true);
		await codeHosts.close();
	});
	it("gives each removal its agent wait, so one that hangs holds up no other; the executor's stop ends the pass", async () => {
		const { lxd, events, codeHosts } = hosts({ agentWaitMs: 500 });
		const [stuck, next] = [1, 2].map((n) => codeHostProject(company(n)));
		await codeHosts.use(company(1), signal(), async () => undefined);
		await codeHosts.use(company(2), signal(), async () => undefined);
		events.length = 0;
		lxd.hangStop = stuck;
		const deleting = async () => [1, 2].map(company);
		await expect(codeHosts.removeDeleting(deleting, signal())).resolves.toBe(1);
		expect([stuck, next].map((project) => lxd.projects.has(project))).toEqual([true, false]);
		expect(events).toEqual([
			{
				event: "code-host-error",
				step: "remove",
				project: stuck,
				error: expect.objectContaining({ name: "TimeoutError" }),
			},
			{ event: "code-host", step: "stopped", project: next },
			{ event: "code-host", step: "removed", project: next },
		]);
		// The executor stops while a removal hangs: the pass ends with its reason.
		const stop = new AbortController();
		const pass = codeHosts.removeDeleting(deleting, stop.signal);
		await vi.waitFor(() => expect(lxd.calls.filter((call) => call === `stop ${stuck}`)).toHaveLength(2), {
			interval: 5,
		});
		stop.abort(new Error("CODING_EXECUTOR_SHUTDOWN"));
		await expect(pass).rejects.toThrow("CODING_EXECUTOR_SHUTDOWN");
		lxd.hangStop = undefined;
		await expect(codeHosts.removeDeleting(deleting, signal())).resolves.toBe(1);
		expect(lxd.projects.has(stuck)).toBe(false);
		await codeHosts.close();
	});
	it("refuses at once the removal of a code host whose job waits for a start, and the next company's still goes", async () => {
		const { lxd, events, codeHosts } = hosts({ running: 1 });
		const [waits, next] = [2, 3].map((n) => codeHostProject(company(n)));
		await codeHosts.use(company(2), signal(), async () => undefined);
		await codeHosts.use(company(3), signal(), async () => undefined);
		const job = held();
		const busy = codeHosts.use(company(1), signal(), job.job);
		await vi.waitFor(() => expect(lxd.running(company(1))).toBe(true));
		// The node's one start is the job's: the second company's job waits for it, with no bound.
		const waiting = codeHosts.use(company(2), signal(), async () => "ran");
		await new Promise((resolve) => setTimeout(resolve, 20));
		events.length = 0;
		const deleting = async () => [2, 3].map(company);
		await expect(codeHosts.removeDeleting(deleting, signal())).resolves.toBe(1);
		expect([waits, next].map((project) => lxd.projects.has(project))).toEqual([true, false]);
		expect(events).toEqual([
			{ event: "code-host-error", step: "remove", project: waits, error: new Error("CODE_HOST_BUSY") },
			{ event: "code-host", step: "removed", project: next },
		]);
		// The job ends, the waiting one runs, and the next pass removes its code host.
		job.release();
		await busy;
		await expect(waiting).resolves.toBe("ran");
		events.length = 0;
		await expect(codeHosts.removeDeleting(deleting, signal())).resolves.toBe(1);
		expect(lxd.projects.has(waits)).toBe(false);
		expect(events).toEqual([
			{ event: "code-host", step: "stopped", project: waits },
			{ event: "code-host", step: "removed", project: waits },
		]);
		await codeHosts.close();
	});
	it("ends a removal's wait for the host's other steps at its agent wait and never runs it later; one a job came to while it waited is CODE_HOST_BUSY", async () => {
		const { lxd, events, codeHosts } = hosts({ agentWaitMs: 500 });
		const [stuck, next] = [1, 2].map((n) => codeHostProject(company(n)));
		await codeHosts.use(company(1), signal(), async () => undefined);
		await codeHosts.use(company(2), signal(), async () => undefined);
		events.length = 0;
		// The executor's start housekeeps, and its stop of the first code host hangs.
		lxd.hangStop = stuck;
		const start = new AbortController();
		const housekeeping = codeHosts.housekeep(start.signal);
		await vi.waitFor(() => expect(lxd.calls).toContain(`stop ${stuck}`));
		const deleting = async () => [1, 2].map(company);
		await expect(codeHosts.removeDeleting(deleting, signal())).resolves.toBe(1);
		expect(events).toEqual([
			{
				event: "code-host-error",
				step: "remove",
				project: stuck,
				error: expect.objectContaining({ name: "TimeoutError" }),
			},
			{ event: "code-host", step: "stopped", project: next },
			{ event: "code-host", step: "removed", project: next },
		]);
		// Another removal waits for the housekeeping, and a job comes meanwhile; then the housekeeping ends.
		const removal = codeHosts.remove(company(1), signal());
		const job = codeHosts.use(company(1), signal(), async () => "ran");
		lxd.hangStop = undefined;
		start.abort(new Error("CODING_EXECUTOR_SHUTDOWN"));
		await expect(housekeeping).rejects.toThrow("CODING_EXECUTOR_SHUTDOWN");
		await expect(removal).rejects.toThrow("CODE_HOST_BUSY");
		await expect(job).resolves.toBe("ran");
		// The removal out of time never ran.
		expect(lxd.projects.has(stuck)).toBe(true);
		expect(lxd.calls).not.toContain(`delete-project ${stuck}`);
		events.length = 0;
		await expect(codeHosts.removeDeleting(deleting, signal())).resolves.toBe(1);
		expect(lxd.projects.has(stuck)).toBe(false);
		expect(events).toEqual([
			{ event: "code-host", step: "stopped", project: stuck },
			{ event: "code-host", step: "removed", project: stuck },
		]);
		await codeHosts.close();
	});
	it("gives the listing of the node's projects its agent wait, so a later pass goes on after one stalled", async () => {
		const { lxd, codeHosts } = hosts({ agentWaitMs: 200 });
		await codeHosts.use(company(1), signal(), async () => undefined);
		const deleting = vi.fn(async () => [company(1)]);
		lxd.hangList = true;
		await expect(codeHosts.removeDeleting(deleting, signal())).rejects.toEqual(
			expect.objectContaining({ name: "TimeoutError" }),
		);
		// The executor's stop ends a stalled listing too.
		const stop = new AbortController();
		const pass = codeHosts.removeDeleting(deleting, stop.signal);
		stop.abort(new Error("CODING_EXECUTOR_SHUTDOWN"));
		await expect(pass).rejects.toThrow("CODING_EXECUTOR_SHUTDOWN");
		expect(deleting).not.toHaveBeenCalled();
		lxd.hangList = false;
		await expect(codeHosts.removeDeleting(deleting, signal())).resolves.toBe(1);
		expect(lxd.projects.has(codeHostProject(company(1)))).toBe(false);
		await codeHosts.close();
	});
	it("closes: no new job, and each code host stops once its jobs end", async () => {
		const { lxd, codeHosts } = hosts();
		await codeHosts.use(company(1), signal(), async () => undefined);
		const job = held();
		const busy = codeHosts.use(company(2), signal(), job.job);
		await vi.waitFor(() => expect(lxd.running(company(2))).toBe(true));
		await codeHosts.close();
		expect([lxd.running(company(1)), lxd.running(company(2))]).toEqual([false, true]);
		await expect(codeHosts.use(company(3), signal(), async () => "ran")).rejects.toThrow("CODE_HOSTS_CLOSED");
		job.release();
		await busy;
		await vi.waitFor(() => expect(lxd.running(company(2))).toBe(false));
	});
	it("refuses waits outside 1 ms to a day, and a bad policy", () => {
		for (const options of [{ idleStopMs: 0 }, { agentWaitMs: 86_400_001 }, { idleStopMs: 1.5 }])
			expect(() => new LxdCodeHosts({ client: new FakeLxd(), policy, ...options })).toThrow(
				"INVALID_CODE_HOST_POLICY",
			);
		expect(() => new LxdCodeHosts({ client: new FakeLxd(), policy: { ...policy, running: 0 } })).toThrow(
			"INVALID_CODE_HOST_POLICY",
		);
	});
});

describe("code host deletions from the control plane", () => {
	const ids = Array.from({ length: 501 }, (_, n) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`);
	it("asks as the node's executor, 500 companies at a time", async () => {
		const calls: [string, Record<string, unknown>][] = [];
		const deleting = controlCodeHostDeletions({
			control: {
				async call(method, args) {
					calls.push([method, args]);
					return (args.p_company_ids as string[]).filter((_, n) => n % 2 === 0);
				},
			},
			owner: "exec-a",
			machineIdSha256: "a".repeat(64),
		});
		expect(CODE_HOST_DELETION_RPCS).toEqual(["qorpera_code_hosts_deleting"]);
		await expect(deleting(ids, signal())).resolves.toEqual(ids.filter((_, n) => n % 2 === 0));
		const args = { p_owner: "exec-a", p_machine_id_sha256: "a".repeat(64) };
		expect(calls).toEqual([
			["qorpera_code_hosts_deleting", { ...args, p_company_ids: ids.slice(0, 500) }],
			["qorpera_code_hosts_deleting", { ...args, p_company_ids: ids.slice(500) }],
		]);
	});
	it.each<unknown>([null, {}, ids[0], [7], [ids[1], "00000000-0000-4000-8000-00000000000f"]])(
		"refuses an answer of %j",
		async (answer) => {
			const deleting = controlCodeHostDeletions({
				control: { call: async () => answer },
				owner: "exec-a",
				machineIdSha256: "a".repeat(64),
			});
			await expect(deleting(ids.slice(0, 2), signal())).rejects.toThrow("CODE_HOST_DELETIONS_UNCONFIRMED");
		},
	);
});
