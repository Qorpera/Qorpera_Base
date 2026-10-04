import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LxdCloudRunnerProviderConfig } from "../../src/lxd-provider.ts";
import type {
	CloudRunnerAssignment,
	CloudRunnerInstance,
	CloudRunnerOrchestrationClaim,
	CloudRunnerOrchestratorControlPlane,
	CloudRunnerWork,
} from "../../src/orchestrator.ts";
import { nodeAdmissionFixture } from "../fixtures/node-admission.ts";

/** How long each physical step of a one-run VM takes in the fake, in milliseconds. */
export interface FakeLxdTimings {
	create: number;
	start: number;
	/** From a finished start until the VM agent answers file pushes and commands. */
	agent: number;
	/** The bootstrap unit's `systemctl enable --now`. */
	bootstrap: number;
	/** From the bootstrap until the guest's assignment inbox answers /healthz. */
	ready: number;
	stop: number;
	delete: number;
	/** Every control-plane RPC. */
	rpc: number;
	/** A custom storage volume's creation. */
	volumeCreate: number;
}

interface FakeInstance {
	name: string;
	status: "Stopped" | "Running";
	config: Record<string, string>;
	profiles: string[];
	devices: Record<string, Record<string, string>>;
	address: string;
	mac: string;
	agentAt?: number;
	readyAt?: number;
	/** Set while the VM boots: from its start request until its inbox first answers. */
	bootingSince?: number;
	/** A guest that never activates its inbox. */
	neverReady?: boolean;
}

interface FakeOperation {
	done: Promise<void>;
	metadata: Record<string, unknown>;
	failure?: string;
}

/** One-run LXD provider physical layer over a real Unix socket: the provider talks to it
 * through the production LxdUnixClient, and its guests answer HttpLxdGuestTransport. */
export class FakeLxdSocket {
	readonly timings: FakeLxdTimings;
	readonly profileDevices: Record<string, Record<string, string>> = {
		enp5s0: { type: "nic", name: "enp5s0", network: "lxdbr0" },
	};
	readonly instances = new Map<string, FakeInstance>();
	readonly volumes = new Map<string, Record<string, unknown>>();
	readonly #creatingVolumes = new Set<string>();
	/** Custom volume creations LXD accepted. */
	volumeCreates = 0;
	readonly operations = new Map<string, FakeOperation>();
	readonly unexpected: string[] = [];
	readonly events: Array<{ at: number; instance: string; event: "create" | "start" | "ready" | "delete" }> = [];
	/** Instances whose inbox never answers. */
	readonly neverReady = new Set<string>();
	/** Instances whose create LXD reports as failed. */
	readonly failCreate = new Set<string>();
	/** Allocation ids the fake control plane holds, and the node ceiling it enforces. */
	readonly allocations = new Set<string>();
	nodeCeiling = Number.POSITIVE_INFINITY;
	readonly rpcCalls: Array<{ name: string; body: Record<string, unknown> }> = [];
	/** Runner ids whose job the fake control plane reports as ended. */
	readonly endedRunners = new Set<string>();
	/** Instances an assignment delivery started for; each answer takes deliveryMs. */
	readonly deliveries: string[] = [];
	deliveryMs = 0;
	#booting = 0;
	/** Most VMs booting at one time. */
	peakBooting = 0;
	/** Most VMs existing at one time. */
	peakInstances = 0;
	/** `systemctl enable --now` of the bootstrap unit, per instance. */
	readonly bootstrapRuns = new Map<string, number>();
	#nextAddress = 2;
	readonly #runners = new Map<string, string>();
	#server?: Server;
	#root?: string;
	socket = "";

	constructor(timings: Partial<FakeLxdTimings> = {}) {
		this.timings = {
			create: 20,
			start: 20,
			agent: 40,
			bootstrap: 20,
			ready: 40,
			stop: 10,
			delete: 10,
			rpc: 2,
			volumeCreate: 1,
			...timings,
		};
	}

	async start(): Promise<string> {
		this.#root = await mkdtemp(join(tmpdir(), "qorpera-lxd-fake-"));
		this.socket = join(this.#root, "lxd.socket");
		const server = createServer((request, response) => void this.#handle(request, response));
		this.#server = server;
		await new Promise<void>((resolveListen, reject) => {
			server.once("error", reject);
			server.listen(this.socket, () => {
				server.off("error", reject);
				resolveListen();
			});
		});
		return this.socket;
	}

	async close(): Promise<void> {
		const server = this.#server;
		this.#server = undefined;
		if (server) {
			server.closeAllConnections();
			await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		}
		if (this.#root) await rm(this.#root, { recursive: true, force: true });
	}

	/** The guest and control-plane side: guest /healthz and /v1/assignment, and the provider's RPCs. */
	readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(String(input));
		if (url.hostname.startsWith("10.41.")) return this.#guest(url, init);
		const name = url.pathname.replace("/rest/v1/rpc/", "");
		const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
		this.rpcCalls.push({ name, body });
		await delay(this.timings.rpc, init?.signal ?? undefined);
		switch (name) {
			case "qorpera_provision_execution_runner": {
				const acquisitionId = String(body.p_client_runner_id);
				const runnerId = this.#runners.get(acquisitionId) ?? randomUUID();
				this.#runners.set(acquisitionId, runnerId);
				return Response.json({
					runner_id: runnerId,
					runner_kind: "qorpera_computer",
					status: "pending",
					provider_adapter: "lxd",
					compute_identity_id: "20000000-0000-4000-8000-000000000011",
					logical_computer_id: null,
					worker_class: "managed_sandbox",
					template_key: "qorpera-member-linux",
					template_version: "v1",
					compute_policy_sha256: "f".repeat(64),
					capabilities: ["agent_turn"],
				});
			}
			case "qorpera_reserve_runtime_machine":
			case "qorpera_release_runtime_machine":
				if (name === "qorpera_release_runtime_machine") this.allocations.delete(String(body.p_allocation_id));
				return Response.json({
					state: name === "qorpera_reserve_runtime_machine" ? "reserved" : "released",
					allocationId: body.p_allocation_id,
					instanceSha256: body.p_instance_sha256,
				});
			case "qorpera_reserve_runtime_node_machine": {
				const allocation = String(body.p_allocation_id);
				if (!this.allocations.has(allocation) && this.allocations.size >= this.nodeCeiling)
					return Response.json({ state: "refused", reason: "NODE_CAPACITY_EXHAUSTED" });
				this.allocations.add(allocation);
				return Response.json(nodeAdmissionFixture(body));
			}
			case "qorpera_bind_native_identity_credential":
				return Response.json({ allocationId: body.p_allocation_id, holderKind: body.p_holder_kind });
			case "qorpera_runtime_ended_runners":
				return Response.json((body.p_runner_ids as string[]).filter((id) => this.endedRunners.has(id)));
			default:
				this.unexpected.push(`rpc ${name}`);
				return new Response("{}", { status: 404 });
		}
	};

	runnerFor(acquisitionId: string): string | undefined {
		return this.#runners.get(acquisitionId);
	}

	/** The instance an acquisition's guest is created as. */
	static instanceName(acquisitionId: string): string {
		return `qorpera-${acquisitionId.replaceAll("-", "")}`;
	}

	async #guest(url: URL, init?: RequestInit): Promise<Response> {
		const guest = [...this.instances.values()].find((instance) => instance.address === url.hostname);
		if (!guest || guest.status !== "Running" || guest.readyAt === undefined || Date.now() < guest.readyAt)
			throw new TypeError("fetch failed: connection refused");
		if (url.pathname === "/healthz") {
			if (guest.bootingSince !== undefined) {
				guest.bootingSince = undefined;
				this.#booting--;
				this.events.push({ at: Date.now(), instance: guest.name, event: "ready" });
			}
			return new Response("{}", { status: 200 });
		}
		if (url.pathname === "/v1/assignment" && init?.method === "POST") {
			this.deliveries.push(guest.name);
			await delay(this.deliveryMs, init.signal);
			return new Response("{}", { status: 202 });
		}
		this.unexpected.push(`guest ${url.pathname}`);
		return new Response("{}", { status: 404 });
	}

	async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(chunk as Buffer);
		const url = new URL(request.url ?? "/", "http://lxd");
		const method = request.method ?? "GET";
		const json =
			request.headers["content-type"] === "application/json" && chunks.length > 0
				? (JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>)
				: undefined;
		const answer = (status: number, body: unknown): void => {
			response.writeHead(status, { "content-type": "application/json" });
			response.end(JSON.stringify(body));
		};
		const error = (status: number, message: string): void =>
			answer(status, { type: "error", error: message, error_code: status });
		const path = url.pathname;
		const operation = /^\/1\.0\/operations\/([0-9a-f-]+)\/wait$/.exec(path);
		if (operation && method === "GET") {
			const current = this.operations.get(operation[1] ?? "");
			if (!current) return error(404, "not found");
			await current.done;
			return answer(200, {
				type: "sync",
				metadata: current.failure
					? { id: operation[1], status: "Failure", status_code: 400, err: current.failure }
					: { id: operation[1], status: "Success", status_code: 200, err: "", metadata: current.metadata },
			});
		}
		const volume = /^\/1\.0\/storage-pools\/[^/]+\/volumes\/custom(?:\/([^/]+))?$/.exec(path);
		if (volume) {
			const name = volume[1] ? decodeURIComponent(volume[1]) : undefined;
			if (method === "GET" && name) {
				const found = this.volumes.get(name);
				return found ? answer(200, { type: "sync", metadata: found }) : error(404, "Storage volume not found");
			}
			if (method === "POST" && !name && json) {
				const created = String(json.name);
				// A volume being created is not listed yet, but its name is taken.
				if (this.volumes.has(created) || this.#creatingVolumes.has(created))
					return error(409, "Volume by that name already exists");
				this.#creatingVolumes.add(created);
				this.volumeCreates++;
				return this.#async(answer, this.timings.volumeCreate, {}, () => {
					this.#creatingVolumes.delete(created);
					this.volumes.set(created, {
						name: created,
						type: "custom",
						content_type: json.content_type,
						description: json.description,
						config: json.config,
					});
					return undefined;
				});
			}
		}
		if (path === "/1.0/instances" && method === "POST" && json) {
			const name = String(json.name);
			if (this.instances.has(name)) return error(409, "Instance already exists");
			const failure = this.failCreate.has(name) ? "Failed creating instance" : undefined;
			const mac = `00:16:3e:00:00:${this.#nextAddress.toString(16).padStart(2, "0")}`;
			const created: FakeInstance = {
				name,
				status: "Stopped",
				config: { ...(json.config as Record<string, string>), "volatile.enp5s0.hwaddr": mac },
				profiles: [...(json.profiles as string[])],
				devices: structuredClone(json.devices as Record<string, Record<string, string>>),
				address: `10.41.0.${this.#nextAddress++}`,
				mac,
				...(this.neverReady.has(name) ? { neverReady: true } : {}),
			};
			this.events.push({ at: Date.now(), instance: name, event: "create" });
			return this.#async(answer, this.timings.create, {}, () => {
				if (!failure) this.instances.set(name, created);
				this.peakInstances = Math.max(this.peakInstances, this.instances.size);
				return failure;
			});
		}
		const instance = /^\/1\.0\/instances\/([^/]+)(\/state|\/exec|\/files)?$/.exec(path);
		if (instance) {
			const name = decodeURIComponent(instance[1] ?? "");
			const current = this.instances.get(name);
			const suffix = instance[2];
			if (!current) return error(404, "Instance not found");
			if (method === "GET" && !suffix) return answer(200, { type: "sync", metadata: this.#record(current) });
			if (method === "GET" && suffix === "/state")
				return answer(200, {
					type: "sync",
					metadata: {
						status: current.status,
						status_code: current.status === "Running" ? 103 : 102,
						network:
							current.status === "Running"
								? {
										enp5s0: {
											hwaddr: current.mac,
											addresses: [{ family: "inet", address: current.address, scope: "global" }],
										},
									}
								: null,
					},
				});
			if (method === "PUT" && suffix === "/state" && json) {
				if (json.action === "start") {
					if (current.status === "Running") return error(400, "The instance is already running");
					if (current.bootingSince === undefined) {
						current.bootingSince = Date.now();
						this.#booting++;
						this.peakBooting = Math.max(this.peakBooting, this.#booting);
					}
					this.events.push({ at: Date.now(), instance: name, event: "start" });
					return this.#async(answer, this.timings.start, {}, () => {
						current.status = "Running";
						current.agentAt = Date.now() + this.timings.agent;
						return undefined;
					});
				}
				if (json.action === "stop")
					return this.#async(answer, this.timings.stop, {}, () => {
						current.status = "Stopped";
						current.agentAt = undefined;
						current.readyAt = undefined;
						if (current.bootingSince !== undefined) {
							current.bootingSince = undefined;
							this.#booting--;
						}
						return undefined;
					});
			}
			const agentUp = current.status === "Running" && current.agentAt !== undefined && Date.now() >= current.agentAt;
			if (method === "POST" && suffix === "/files") {
				if (!agentUp) return error(400, "LXD VM agent isn't currently running");
				return answer(200, { type: "sync", metadata: {} });
			}
			if (method === "POST" && suffix === "/exec" && json) {
				if (!agentUp) return error(400, "LXD VM agent isn't currently running");
				const command = json.command as string[];
				const bootstrap = command[0] === "/usr/bin/systemctl" && command[2] === "--now";
				if (bootstrap) this.bootstrapRuns.set(name, (this.bootstrapRuns.get(name) ?? 0) + 1);
				return this.#async(answer, bootstrap ? this.timings.bootstrap : 1, { return: 0 }, () => {
					if (bootstrap && !current.neverReady) current.readyAt = Date.now() + this.timings.ready;
					return undefined;
				});
			}
			if (method === "DELETE" && !suffix) {
				if (current.status !== "Stopped") return error(400, "Instance is running");
				return this.#async(answer, this.timings.delete, {}, () => {
					this.instances.delete(name);
					this.events.push({ at: Date.now(), instance: name, event: "delete" });
					return undefined;
				});
			}
		}
		this.unexpected.push(`${method} ${path}`);
		error(404, "not found");
	}

	#async(
		answer: (status: number, body: unknown) => void,
		durationMs: number,
		metadata: Record<string, unknown>,
		complete: () => string | undefined,
	): void {
		const id = randomUUID();
		const current: FakeOperation = {
			metadata,
			done: delay(durationMs).then(() => {
				current.failure = complete();
			}),
		};
		this.operations.set(id, current);
		answer(202, { type: "async", status_code: 100, operation: `/1.0/operations/${id}`, metadata: { id } });
	}

	#record(instance: FakeInstance): Record<string, unknown> {
		return {
			name: instance.name,
			type: "virtual-machine",
			status: instance.status,
			status_code: instance.status === "Running" ? 103 : 102,
			config: instance.config,
			profiles: instance.profiles,
			devices: instance.devices,
			expanded_devices: { ...this.profileDevices, ...instance.devices },
			expanded_config: instance.config,
		};
	}
}

export function fakeProviderConfig(stateRoot: string): LxdCloudRunnerProviderConfig {
	return {
		adapterId: "lxd",
		supabaseUrl: "https://example.supabase.co",
		supabaseServiceKey: "sb_secret_private",
		supabasePublishableKey: "publishable-key",
		stateRoot,
		project: "qorpera-runners",
		jobProfile: "qorpera-job-v1",
		networkInterface: "enp5s0",
		imageServer: "https://images.example.com/",
		imageFingerprint: "a".repeat(64),
		storagePool: "qorpera-vm",
		identityVolumePrefix: "identity-",
		identityVolumeSize: "32GiB",
		rootDiskSize: "64GiB",
		cpuLimit: 4,
		memoryLimit: "8GiB",
		guestAssignmentPort: 8082,
		guestAssignmentSource: "10.41.0.1",
		nativeBridgePort: 8083,
		nativeExecutionGid: 42041,
		guestReadyTimeoutMs: 10_000,
		runnerImage: `registry.example/qorpera@sha256:${"b".repeat(64)}`,
		runnerPodmanPath: "/usr/bin/podman",
		runnerEntrypoint: "/opt/qorpera/run-job",
		runnerVersion: "test",
		codexPath: "/usr/local/bin/codex",
		claudePath: "/usr/local/bin/claude",
	};
}

/** One member's session turn; every run shares the member's Compute Identity. */
export function fakeWork(runId: string): CloudRunnerWork {
	return {
		runId,
		jobId: runId.replace(/^.{8}/, "40000000"),
		profileId: "20000000-0000-4000-8000-000000000004",
		environmentId: "20000000-0000-4000-8000-000000000005",
		sourceKind: "session_turn",
		sourceId: runId,
		sessionId: "20000000-0000-4000-8000-000000000006",
		substrateVersionId: "20000000-0000-4000-8000-000000000007",
		companySnapshotId: "20000000-0000-4000-8000-000000000008",
		staffAgentId: "20000000-0000-4000-8000-000000000009",
		staffVersion: 1,
		inputIds: ["20000000-0000-4000-8000-000000000010"],
		transcriptStartSequence: 1,
		deadlineAt: "2099-08-21T18:00:00.000Z",
		requiredCapability: "agent_turn",
		jobType: "agent_turn",
		payload: {},
		publicationMode: "automatic",
		reviewerStaffIds: [],
		computeIdentityId: "20000000-0000-4000-8000-000000000011",
		computeIdentityOwnershipKind: "member",
		computeIdentityOwnerUserId: "20000000-0000-4000-8000-000000000012",
		computeTemplateKey: "qorpera-member-linux",
		computeTemplateVersion: "v1",
		computePolicySha256: "f".repeat(64),
		workerClass: "managed_sandbox",
		requestedByUserId: "20000000-0000-4000-8000-000000000012",
		sponsoredByUserId: "20000000-0000-4000-8000-000000000012",
		sponsor: {
			bindingId: "20000000-0000-4000-8000-000000000013",
			version: 1,
			kind: "member_connection",
			providerConnectionId: "20000000-0000-4000-8000-000000000014",
			providerConnectionVersion: 1,
			provider: "openai",
			authenticationMode: "native_subscription",
			nativeHarness: "codex-cli",
			allowAutonomous: false,
		},
		modelPolicy: {
			provider: "openai",
			model: "gpt-test",
			maxCalls: 1,
			maxInputTokens: 1_000_000,
			maxOutputTokens: 100_000,
			maxCostMicrousd: 1,
		},
		attempt: 1,
	};
}

/** A control plane whose queue the test fills; it claims, assigns and records like the edge function. */
export class FakeClaimQueue implements CloudRunnerOrchestratorControlPlane {
	readonly orchestratorId: string;
	readonly queued: CloudRunnerWork[] = [];
	readonly claimed = new Map<string, number>();
	reconcilePasses = 0;
	/** Resolves each provider-independent reconcile step after this long. */
	reconcileDelayMs = 0;

	constructor(orchestratorId: string) {
		this.orchestratorId = orchestratorId;
	}

	async listRoutineScheduleHeads() {
		return { items: [], hasMore: false };
	}
	async enqueueRoutineWake(): Promise<never> {
		throw new Error("no routines in this fixture");
	}
	async advanceRoutineNextDue(): Promise<never> {
		throw new Error("no routines in this fixture");
	}
	async reconcileExpired(_orchestratorId: string, signal?: AbortSignal): Promise<void> {
		await delay(this.reconcileDelayMs, signal);
		this.reconcilePasses++;
	}
	async retainedClaims(): Promise<readonly CloudRunnerOrchestrationClaim[]> {
		return [];
	}
	async claimNext(orchestratorId: string, clientClaimId: string): Promise<CloudRunnerOrchestrationClaim | undefined> {
		const work = this.queued.shift();
		if (!work) return undefined;
		this.claimed.set(work.runId, Date.now());
		return {
			claimId: clientClaimId,
			orchestratorId,
			status: "claimed",
			leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
			work,
		};
	}
	async renewClaim(claim: CloudRunnerOrchestrationClaim): Promise<CloudRunnerOrchestrationClaim> {
		return { ...claim, leaseExpiresAt: new Date(Date.now() + 120_000).toISOString() };
	}
	async assign(
		claim: CloudRunnerOrchestrationClaim,
		runner: CloudRunnerInstance,
		clientAssignmentId: string,
		capabilitySha256: string,
	): Promise<CloudRunnerAssignment> {
		return {
			assignmentId: clientAssignmentId,
			claimId: claim.claimId,
			runId: claim.work.runId,
			jobId: claim.work.jobId,
			runnerId: runner.runnerId,
			capabilitySha256,
			expiresAt: new Date(Date.now() + 120_000).toISOString(),
		};
	}
	async releaseClaim(): Promise<void> {}
}

function delay(ms: number, signal?: AbortSignal | null): Promise<void> {
	return new Promise((resolveWait, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolveWait();
		}, ms);
		const abort = (): void => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", abort, { once: true });
	});
}
