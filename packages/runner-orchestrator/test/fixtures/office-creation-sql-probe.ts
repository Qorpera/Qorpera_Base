import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { type CompanyComputerStartupIdentity, parseCompanyComputerLifecycleRequest } from "@qorpera/contracts";
import type { LxdOfficeActivationRegistry } from "../../src/lxd-office-activation-control.ts";
import { LxdOfficeActivationWorker } from "../../src/lxd-office-activation-worker.ts";
import { planLxdOfficeAdoption } from "../../src/lxd-office-adoption-plan.ts";
import { LxdOfficeAdoptionWorker } from "../../src/lxd-office-adoption-worker.ts";
import { LxdOfficeBootActivationWorker } from "../../src/lxd-office-boot-activation-worker.ts";
import { LxdOfficeBootConfigurationWorker } from "../../src/lxd-office-boot-configuration-worker.ts";
import type { LxdOfficeBootIntentRegistry } from "../../src/lxd-office-boot-intent-control.ts";
import type { LxdOfficeBootSuccessorRegistry } from "../../src/lxd-office-boot-successor-control.ts";
import { LxdOfficeBootWorker } from "../../src/lxd-office-boot-worker.ts";
import { LxdOfficeConfigurationWorker } from "../../src/lxd-office-configuration-worker.ts";
import type { LxdOfficeCreationIdentity } from "../../src/lxd-office-creation-journal.ts";
import { type LxdOfficeCreationRegistry, LxdOfficeCreationWorker } from "../../src/lxd-office-creation-worker.ts";
import { type LxdOfficeGuestBinding, lxdOfficeGuestPlan } from "../../src/lxd-office-guest.ts";
import { officeCanonical, officeDigest } from "../../src/lxd-office-image-provenance.ts";
import type { LxdOfficeStorageObservation } from "../../src/lxd-office-inventory-worker.ts";
import { LxdOfficeInventoryWorker } from "../../src/lxd-office-inventory-worker.ts";
import { publish } from "../../src/lxd-office-journal-files.ts";
import { LxdOfficeLifecycle, type LxdOfficeLifecycleResult } from "../../src/lxd-office-lifecycle.ts";
import type { LxdOfficeLifecyclePhase } from "../../src/lxd-office-lifecycle-journal.ts";
import { type LxdOfficePhysicalPolicy, lxdOfficePhysicalPolicySha256 } from "../../src/lxd-office-physical-policy.ts";
import { LxdOfficePowerOffWorker } from "../../src/lxd-office-power-off-worker.ts";
import { LxdOfficePreparationWorker } from "../../src/lxd-office-preparation-worker.ts";
import type { LxdOfficeLifecycleRegistry } from "../../src/lxd-office-provider-registry.ts";
import { LxdOfficeResumeWorker } from "../../src/lxd-office-resume-worker.ts";
import {
	type LxdOfficeServiceStopRegistry,
	LxdOfficeServiceStopWorker,
} from "../../src/lxd-office-service-stop-worker.ts";
import { lxdOfficeProviderBindingSha256 } from "../../src/lxd-office-start-control.ts";
import { parseLxdOfficeStorageReview } from "../../src/lxd-office-storage-review.ts";
import type { LxdOfficeSuccessorRegistry } from "../../src/lxd-office-successor-control.ts";
import { LxdOfficeSuccessorWorker } from "../../src/lxd-office-successor-worker.ts";
import { officeBootConfigurationHttpFixture } from "./office-boot-configuration-http.ts";
import { runOfficeBootRestartCycles } from "./office-boot-restart-cycles.ts";
import { officeBootServiceRestartHttpFixture } from "./office-boot-service-restart-http.ts";
import { officeBootServiceStartHttpFixture } from "./office-boot-service-start-http.ts";
import { officeConfigurationHttpFixture } from "./office-configuration-http.ts";
import type { OfficeHttpGuest } from "./office-http-guest.ts";
import { officePhysicalFixture } from "./office-physical-policy.ts";
import { officePowerOffHttpFixture } from "./office-power-off-http.ts";
import { officePreparationHttpFixture } from "./office-preparation-http.ts";
import { officeResumeHttpFixture } from "./office-resume-http.ts";
import { officeServiceRestartHttpFixture } from "./office-service-restart-http.ts";
import { officeServiceStartHttpFixture } from "./office-service-start-http.ts";
import { officeServiceStopHttpFixture } from "./office-service-stop-http.ts";
import { runOfficeVmSqlCycles } from "./office-vm-sql-cycles.ts";

export function officeCreationSqlPolicy(scope: Record<string, string>, providerId: string, root: string) {
	const { policy } = officePhysicalFixture();
	Object.assign(policy.guest, scope, {
		providerId,
		imageFingerprint: "a".repeat(64),
		bootstrapSha256: "b".repeat(64),
	});
	policy.journal.path = join(root, "creation-journal");
	policy.journal.mountPoint = policy.journal.path;
	policy.host.socketPath = join(root, "creation.socket");
	return { policy, digest: lxdOfficePhysicalPolicySha256(policy) };
}

/** Real SQL is supplied by the disposable driver. Unix HTTP optionally delegates
 * controls to a disposable systemd guest. Host/image/NAS and VM boot are synthetic. */
export async function runOfficeCreationSqlProbe(
	policy: LxdOfficePhysicalPolicy,
	registry: LxdOfficeCreationRegistry,
	bootOptions?: {
		guest?: OfficeHttpGuest;
		powerOff?: boolean;
		resume?: {
			laterCycles?: boolean;
			registry: LxdOfficeBootIntentRegistry;
			successorRegistry: LxdOfficeBootSuccessorRegistry;
			serviceRegistry: LxdOfficeSuccessorRegistry;
			enable: () => Promise<void>;
		};
		lifecycle?: boolean;
		stop?: { registry: LxdOfficeServiceStopRegistry; restartDatabase: () => Promise<void> };
		successor?: { registry: LxdOfficeSuccessorRegistry; enable: () => Promise<void> };
		revoke: () => Promise<void>;
		prepare?: boolean;
		configure?: boolean;
		activation?: {
			registry: LxdOfficeActivationRegistry;
			ready: (
				identity: CompanyComputerStartupIdentity,
				activationId: string,
				nativePort: number,
				viewerPort: number,
			) => Promise<void>;
		};
	},
) {
	await mkdir(policy.journal.path, { mode: 0o700 });
	const operationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
	const startOperationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
	const guest = bootOptions?.guest;
	const powerOff = bootOptions?.powerOff ? officePowerOffHttpFixture(policy.journal.path) : undefined;
	let guestBootId = guest?.bootId ?? "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
	let startPosts = 0,
		startPolls = 0,
		startPending = true;
	let posts = 0,
		polls = 0,
		pending = true,
		instance: Record<string, unknown> | undefined;
	const failures: unknown[] = [];
	const preparation = officePreparationHttpFixture(policy.journal.path, guest);
	const resumeHttp = bootOptions?.resume
		? officeResumeHttpFixture(policy.journal.path, () => {
				assert(!guest, "synthetic VM resume cannot reboot actual systemd");
				guestBootId =
					guestBootId === "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
						? "efefefef-efef-4fef-8fef-efefefefefef"
						: randomUUID();
				for (const path of preparation.files.keys()) if (path.startsWith("/run/")) preparation.files.delete(path);
			})
		: undefined;
	const configuration = officeConfigurationHttpFixture(policy.journal.path, preparation.files, guest);
	const bootConfiguration = bootOptions?.resume
		? officeBootConfigurationHttpFixture(policy.journal.path, preparation.files)
		: undefined;
	const bootActivation = bootOptions?.resume
		? officeBootServiceStartHttpFixture(policy.journal.path, preparation.files, bootOptions.activation!.ready)
		: undefined;
	const bootRestart = bootOptions?.resume
		? officeBootServiceRestartHttpFixture(policy.journal.path, preparation.files, bootOptions.activation!.ready)
		: undefined;
	const stop = bootOptions?.stop
		? officeServiceStopHttpFixture(policy.journal.path, preparation.files, guest)
		: undefined;
	const successor = bootOptions?.successor
		? officeServiceRestartHttpFixture(policy.journal.path, preparation.files, bootOptions.activation!.ready, guest)
		: undefined;
	const activation = bootOptions?.activation
		? officeServiceStartHttpFixture(policy.journal.path, preparation.files, bootOptions.activation.ready, guest)
		: undefined;
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			void (async () => {
				const send = (status: number, value: unknown) => {
					response.writeHead(status, { "content-type": "application/json" });
					response.end(JSON.stringify(value));
				};
				try {
					const method = request.method,
						url = request.url ?? "";
					if (
						bootRestart &&
						instance &&
						(await bootRestart.handle(
							method,
							url,
							request.headers,
							Buffer.concat(chunks),
							String(instance.name),
							response,
						))
					)
						return;
					if (
						bootActivation &&
						instance &&
						(await bootActivation.handle(
							method,
							url,
							request.headers,
							Buffer.concat(chunks),
							String(instance.name),
							response,
						))
					)
						return;
					if (
						bootConfiguration &&
						instance &&
						(await bootConfiguration.handle(
							method,
							url,
							request.headers,
							Buffer.concat(chunks),
							String(instance.name),
							response,
						))
					)
						return;
					if (
						resumeHttp &&
						instance &&
						(await resumeHttp.handle(method, url, Buffer.concat(chunks), instance, response))
					)
						return;
					if (
						powerOff &&
						instance &&
						(await powerOff.handle(method, url, Buffer.concat(chunks), instance, response))
					)
						return;
					if (
						successor &&
						instance &&
						(await successor.handle(
							method,
							url,
							request.headers,
							Buffer.concat(chunks),
							String(instance.name),
							response,
						))
					)
						return;
					if (
						stop &&
						instance &&
						(await stop.handle(
							method,
							url,
							request.headers,
							Buffer.concat(chunks),
							String(instance.name),
							response,
						))
					)
						return;
					if (
						activation &&
						instance &&
						(await activation.handle(
							method,
							url,
							request.headers,
							Buffer.concat(chunks),
							String(instance.name),
							response,
						))
					)
						return;
					if (
						bootOptions?.configure &&
						instance &&
						(await configuration.handle(
							method,
							url,
							request.headers,
							Buffer.concat(chunks),
							String(instance.name),
							response,
						))
					)
						return;
					if (
						bootOptions?.prepare &&
						instance &&
						(await preparation.handle(
							method,
							url,
							request.headers,
							Buffer.concat(chunks),
							String(instance.name),
							response,
						))
					)
						return;
					if (bootOptions && instance) {
						const startOperation = () => ({
							id: startOperationId,
							class: "task",
							status: startPending ? "Running" : "Success",
							status_code: startPending ? 103 : 200,
							err: "",
							resources: {},
							metadata: { entity_url: `/1.0/instances/${instance!.name}?project=offices` },
						});
						if (method === "PUT" && url === `/1.0/instances/${instance.name}/state?project=offices`) {
							const action = JSON.parse(Buffer.concat(chunks).toString());
							assert.equal(action.action, "start");
							assert.equal(action.force, false);
							assert.equal(action.stateful, false);
							const files = (await readdir(policy.journal.path)).filter((name) =>
								name.startsWith("boot-intent-"),
							);
							assert.equal(files.length, 1);
							const retained = JSON.parse(await readFile(join(policy.journal.path, files[0]), "utf8"));
							const dispatch = JSON.parse(
								await readFile(join(policy.journal.path, retained.allocationId, "000003.json"), "utf8"),
							);
							assert.equal(dispatch.kind, "dispatch");
							assert.equal(dispatch.commandId, retained.startCommandId);
							startPosts++;
							instance.status = "Running";
							instance.status_code = 103;
							send(202, {
								type: "async",
								status_code: 100,
								operation: `/1.0/operations/${startOperationId}`,
								metadata: startOperation(),
							});
							return;
						}
						if (method === "GET" && url === `/1.0/operations/${startOperationId}?project=offices`) {
							startPolls++;
							send(200, { type: "sync", status_code: 200, metadata: startOperation() });
							return;
						}
						if (
							method === "GET" &&
							url ===
								`/1.0/instances/${instance.name}/files?path=${encodeURIComponent("/proc/sys/kernel/random/boot_id")}&project=offices`
						) {
							assert.equal(instance.status, "Running");
							response.writeHead(200, {
								"content-type": "application/octet-stream",
								"x-lxd-type": "file",
								"x-lxd-uid": "0",
								"x-lxd-gid": "0",
								"x-lxd-mode": "0444",
							});
							response.end(`${guestBootId}\n`);
							return;
						}
					}
					if (method === "POST" && url === "/1.0/instances?project=offices") {
						posts++;
						const files = (await readdir(policy.journal.path)).filter((name) => name.startsWith("intent-"));
						assert.equal(files.length, 1);
						const identity = JSON.parse(await readFile(join(policy.journal.path, files[0]), "utf8")) as {
							binding: LxdOfficeGuestBinding;
							createCommandId: string;
						};
						const plan = lxdOfficeGuestPlan(identity.binding);
						assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), plan.request);
						const dispatch = JSON.parse(
							await readFile(join(policy.journal.path, identity.binding.allocationId, "000000.json"), "utf8"),
						);
						assert.equal(dispatch.kind, "dispatch");
						assert.equal(dispatch.commandId, identity.createCommandId);
						const config = { ...plan.request.config, "volatile.base_image": identity.binding.imageFingerprint };
						instance = {
							name: plan.request.name,
							type: "virtual-machine",
							status: "Stopped",
							status_code: 102,
							profiles: [],
							config,
							expanded_config: config,
							devices: plan.request.devices,
							expanded_devices: plan.request.devices,
						};
						send(202, {
							type: "async",
							status_code: 100,
							operation: `/1.0/operations/${operationId}`,
							metadata: {
								id: operationId,
								class: "task",
								status: "Running",
								status_code: 103,
								err: "",
								resources: {},
								metadata: { entity_url: `/1.0/instances/${plan.request.name}?project=offices` },
							},
						});
						return;
					}
					if (method === "GET" && url === `/1.0/operations/${operationId}?project=offices`) {
						polls++;
						send(200, {
							type: "sync",
							status_code: 200,
							metadata: {
								id: operationId,
								class: "task",
								status: pending ? "Running" : "Success",
								status_code: pending ? 103 : 200,
								err: "",
								resources: {},
								metadata: { entity_url: `/1.0/instances/${instance?.name}?project=offices` },
							},
						});
						return;
					}
					if (method === "GET" && url.startsWith("/1.0/instances/qorpera-office-")) {
						send(instance ? 200 : 404, { type: "sync", status_code: 200, metadata: instance ?? {} });
						return;
					}
					throw new Error("Unexpected provider mutation or lookup");
				} catch (error) {
					failures.push(error);
					if (guest)
						console.error(
							"Actual systemd fixture request failed:",
							error instanceof Error ? error.message : "unknown",
						);
					send(500, {});
				}
			})();
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(policy.host.socketPath, resolve);
	});
	try {
		let loseReserveReply = true;
		const transport = {
			call: async (
				method: Parameters<typeof registry.call>[0],
				args: Record<string, unknown>,
				signal: AbortSignal,
			) => {
				const result = await registry.call(method, args, signal);
				if (method === "qorpera_reserve_runtime_office_start" && loseReserveReply) {
					loseReserveReply = false;
					throw new Error("fixture lost committed reservation response");
				}
				return result;
			},
		};
		const gate = {
			policy,
			inspect: async (signal: AbortSignal) => ({
				signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
				validForMs: 5000,
				hostBootId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
			}),
		};
		const worker = () => new LxdOfficeCreationWorker(gate, transport);
		const lifecycleMode = bootOptions?.lifecycle === true;
		const limits = { maxEntries: 100, maxDepth: 4, maxFileBytes: 1024, maxTotalBytes: 4096, maxManifestBytes: 65536 };
		const phaseWorkers: Record<string, unknown> = {};
		let lifecyclePlan: unknown;
		let recoveryPlan: unknown;
		let resumePlan: unknown;
		let bootConfigurationWorker: (() => LxdOfficeBootConfigurationWorker) | undefined;
		let bootActivationWorker: (() => LxdOfficeBootActivationWorker) | undefined;
		const lifecycleRegistry: LxdOfficeLifecycleRegistry = {
			call: (method, args, signal) => {
				if (
					method === "qorpera_prepare_runtime_office_boot_successor" ||
					method === "qorpera_runtime_office_boot_successor_status" ||
					method === "qorpera_check_runtime_office_boot_successor" ||
					method === "qorpera_activate_runtime_office_boot_successor"
				) {
					if (!bootOptions?.resume) throw new Error("Creation/same-boot fixture cannot dispatch a guest reboot");
					return bootOptions.resume.successorRegistry.call(method, args, signal);
				}
				if (
					method === "qorpera_prepare_runtime_office_boot_intent" ||
					method === "qorpera_runtime_office_boot_intent_status" ||
					method === "qorpera_check_runtime_office_boot_intent"
				) {
					if (!bootOptions?.resume) throw new Error("resume not enabled");
					return bootOptions.resume.registry.call(method, args, signal);
				}
				if (
					method === "qorpera_prepare_runtime_office_successor" ||
					method === "qorpera_runtime_office_successor_status" ||
					method === "qorpera_check_runtime_office_successor" ||
					method === "qorpera_activate_runtime_office_successor"
				) {
					const successorRegistry = bootOptions?.successor?.registry ?? bootOptions?.resume?.serviceRegistry;
					if (!successorRegistry) throw new Error("First activation fixture cannot prepare a successor");
					return successorRegistry.call(method, args, signal);
				}
				if (
					method === "qorpera_begin_runtime_office_lifecycle" ||
					method === "qorpera_runtime_office_lifecycle_status" ||
					method === "qorpera_prepare_runtime_office_stop" ||
					method === "qorpera_ack_runtime_office_stop" ||
					method === "qorpera_runtime_office_stop_status"
				) {
					if (!bootOptions?.stop) throw new Error("First activation fixture cannot perform lifecycle recovery");
					return bootOptions.stop.registry.call(method, args, signal);
				}
				if (
					method === "qorpera_prepare_runtime_office_activation" ||
					method === "qorpera_runtime_office_activation_status" ||
					method === "qorpera_activate_runtime_office"
				)
					return bootOptions!.activation!.registry.call(method, args, signal);
				if (
					method === "qorpera_enroll_office_software" ||
					method === "qorpera_begin_office_software" ||
					method === "qorpera_check_office_software_install" ||
					method === "qorpera_ack_office_software_install" ||
					method === "qorpera_office_software_status" ||
					method === "qorpera_check_office_software_invocation" ||
					method === "qorpera_ack_office_software_invocation"
				)
					throw new Error("First activation fixture has no software lane");
				return registry.call(method, args, signal);
			},
		};
		const lifecycle = () =>
			new LxdOfficeLifecycle(
				{ ...gate, check: async (_binding, signal) => gate.inspect(signal) },
				lifecycleRegistry,
				{ planPath: "/synthetic-lifecycle-plan", inventoryLimits: limits },
				{
					workers: phaseWorkers as unknown as NonNullable<
						ConstructorParameters<typeof LxdOfficeLifecycle>[3]
					>["workers"],
					kernelLock: async () => {},
					...(bootConfigurationWorker ? { bootConfigurationWorker: bootConfigurationWorker() } : {}),
					...(bootActivationWorker ? { bootActivationWorker: bootActivationWorker() } : {}),
					...(bootOptions?.resume
						? {
								resumeWorker: new LxdOfficeResumeWorker(
									{ ...gate, check: async (_binding, signal) => gate.inspect(signal) },
									bootOptions.resume.registry,
									{ kernelLock: async () => {} },
								),
							}
						: {}),
					...(bootOptions?.successor || bootOptions?.resume
						? {
								successorWorker: new LxdOfficeSuccessorWorker(
									{ ...gate, check: async (_binding, signal) => gate.inspect(signal) },
									bootOptions.successor?.registry ?? bootOptions.resume!.serviceRegistry,
									{ kernelLock: async () => {} },
								),
							}
						: {}),
					...(bootOptions?.stop
						? {
								stopWorker: new LxdOfficeServiceStopWorker(
									{ ...gate, check: async (_binding, signal) => gate.inspect(signal) },
									bootOptions.stop.registry,
									{ kernelLock: async () => {} },
								),
								powerOffWorker: new LxdOfficePowerOffWorker(
									{ ...gate, check: async (_binding, signal) => gate.inspect(signal) },
									bootOptions.stop.registry,
									{ kernelLock: async () => {} },
								),
							}
						: {}),
					readProtected: async (path) => {
						if (path.endsWith(".resume")) {
							if (!resumePlan) throw Object.assign(new Error("no resume requested"), { code: "ENOENT" });
							return Buffer.from(JSON.stringify(resumePlan));
						}
						if (path.endsWith(".recovery")) {
							if (!recoveryPlan) throw Object.assign(new Error("no recovery requested"), { code: "ENOENT" });
							return Buffer.from(JSON.stringify(recoveryPlan));
						}
						if (!lifecyclePlan) throw Object.assign(new Error("fixture review missing"), { code: "ENOENT" });
						return Buffer.from(JSON.stringify(lifecyclePlan));
					},
				},
			);
		async function composed<T>(
			phase: LxdOfficeLifecyclePhase,
			operation: (signal: AbortSignal) => Promise<T>,
		): Promise<T> {
			if (!lifecycleMode) return operation(signal());
			let value: T | undefined;
			let workerCode = "UNCONFIRMED";
			const began = performance.now();
			const method =
				phase === "inventory" ? "inspectSettled" : phase === "adoption" ? "copySettled" : "reconcileSettled";
			phaseWorkers[phase] = {
				[method]: async (...args: unknown[]) => {
					try {
						value = await operation(args.at(-1) as AbortSignal);
						return value;
					} catch (error) {
						if (error instanceof Error && /^OFFICE_[A-Z0-9_]{1,100}$/.test(error.message))
							workerCode = error.message;
						throw error;
					}
				},
			};
			let result: LxdOfficeLifecycleResult;
			try {
				result = await lifecycle().reconcile(signal());
			} catch (error) {
				// Test-only diagnostics contain fixed phase names, bounded error
				// codes and timing; never transport bodies or protected credentials.
				if (guest)
					console.log(
						`OFFICE_SQL_PHASE=${JSON.stringify({
							phase,
							workerCode,
							elapsedMs: Math.round(performance.now() - began),
							outcome: "unconfirmed",
						})}`,
					);
				throw error;
			}
			if (guest)
				console.log(
					`OFFICE_SQL_PHASE=${JSON.stringify({ phase, elapsedMs: Math.round(performance.now() - began), outcome: "completed" })}`,
				);
			assert.equal(result.phase, phase);
			assert.notEqual(value, undefined);
			return value!;
		}
		const signal = () => new AbortController().signal;
		await assert.rejects(
			composed("creation", (sig) => worker().reconcileSettled(sig)),
			lifecycleMode ? /OFFICE_LIFECYCLE_UNCONFIRMED/ : /fixture lost committed reservation response/,
		);
		assert.equal(posts, 0);
		const first = await composed("creation", (sig) => worker().reconcileSettled(sig));
		assert.equal(first.state, "pending");
		assert.equal(posts, 1);
		pending = false;
		const completed = await composed("creation", (sig) => worker().reconcileSettled(sig));
		assert.equal(completed.state, "awaiting_adoption");
		if (!lifecycleMode) assert.deepEqual(await worker().reconcile(signal()), completed);
		assert.equal(posts, 1);
		assert.equal(polls, 2);
		assert.deepEqual(failures, []);
		let firstBoot: Record<string, unknown> | undefined;
		if (bootOptions) {
			const files = (await readdir(policy.journal.path)).filter((name) => name.startsWith("intent-"));
			const identity = JSON.parse(
				await readFile(join(policy.journal.path, files[0]), "utf8"),
			) as LxdOfficeCreationIdentity;
			const observation: LxdOfficeStorageObservation = {
				schema: "qorpera.lxd-office-storage-observation/v1",
				intentId: identity.intentId,
				allocationId: identity.binding.allocationId,
				providerBindingSha256: lxdOfficeProviderBindingSha256(identity.binding),
				hostBootId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
				inventory: {
					schema: "qorpera.office-storage-inventory/v1",
					root: identity.binding.workbenchSource,
					mountId: "123",
					totalBytes: 0,
					entries: [
						{
							path: ".",
							kind: "directory",
							dev: "1",
							ino: "1",
							uid: 1000,
							gid: 1000,
							mode: 0o700,
							mtimeNs: "1",
							ctimeNs: "1",
							bytes: 0,
							sha256: null,
						},
					],
				},
			};
			const input = {
				schema: "qorpera.lxd-office-adoption-input/v1",
				adoptionId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
				shared: { workbench: null, desktopHome: null },
				legacy: null,
				quarantine: [],
			};
			const plan = planLxdOfficeAdoption(input, identity.binding, observation);
			const handoffBytes = Buffer.from(
				officeCanonical({
					schema: "qorpera.lxd-office-storage-maintenance/v1",
					state: "exclusive_writers_confirmed",
					hostBootId: observation.hostBootId,
					providerBindingSha256: observation.providerBindingSha256,
					observationSha256: officeDigest(observation),
					planSha256: officeDigest(plan),
				}),
			);
			const reviewBytes = Buffer.from(
				officeCanonical({
					schema: "qorpera.lxd-office-storage-review/v1",
					reviewId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
					decision: "initialize_empty",
					observationSha256: officeDigest(observation),
					planSha256: officeDigest(plan),
					writerFence: {
						state: "exclusive_writers_confirmed",
						evidenceSha256: createHash("sha256").update(handoffBytes).digest("hex"),
					},
				}),
			);
			const copyAuthority = {
				schema: "qorpera.lxd-office-adoption-authority/v1",
				observationSha256: officeDigest(observation),
				planSha256: officeDigest(plan),
				reviewSha256: createHash("sha256").update(reviewBytes).digest("hex"),
			};
			const copy = {
				...copyAuthority,
				schema: "qorpera.lxd-office-adoption-copy/v1",
				state: "copied",
				adoptionId: plan.adoptionId,
				outputInventorySha256: "f".repeat(64),
			};
			for (const [name, value] of [
				[`inventory-${officeDigest(observation)}.json`, observation],
				[`adoption-${plan.adoptionId}.json`, copyAuthority],
				[`adoption-result-${plan.adoptionId}.json`, copy],
			] as const)
				await publish(policy.journal.path, name, Buffer.from(officeCanonical(value)));
			const request = {
				intentId: identity.intentId,
				observationSha256: officeDigest(observation),
				input,
				reviewPath: "/synthetic-review",
				writerFencePath: "/synthetic-handoff",
			};
			const ports = {
				kernelLock: async () => {},
				readProtected: async (path: string) => {
					if (path === request.reviewPath) return reviewBytes;
					assert.equal(path, request.writerFencePath);
					return handoffBytes;
				},
			};
			const physical = {
				policy,
				check: async (_binding: LxdOfficeGuestBinding, signal: AbortSignal) => gate.inspect(signal),
			};
			const boot = () => new LxdOfficeBootWorker(physical, registry, ports);
			if (lifecycleMode) {
				await composed("inventory", (sig) =>
					new LxdOfficeInventoryWorker(
						physical,
						registry,
						limits,
						undefined,
						async () => observation.inventory,
					).inspectSettled(identity.intentId, sig),
				);
				assert.equal((await lifecycle().reconcile(signal())).state, "awaiting_review");
				lifecyclePlan = {
					schema: "qorpera.lxd-office-lifecycle-plan/v1",
					request: { ...request, serviceBootstrapPath: "/synthetic-bootstrap" },
				};
				assert.equal((await lifecycle().reconcile(signal())).state, "progressed");
				const review = parseLxdOfficeStorageReview(
					JSON.parse(reviewBytes.toString()),
					observation,
					officeDigest(plan),
				);
				await composed("adoption", (sig) =>
					new LxdOfficeAdoptionWorker(physical, registry, limits, {
						...ports,
						copy: async (_options, guard, checked) => {
							await guard.assertWritable(plan, review, checked);
							return {
								...copy,
								state: "copied" as const,
								schema: "qorpera.lxd-office-adoption-copy/v1" as const,
							};
						},
					}).copySettled(request, sig),
				);
			}
			const started = await composed("boot", (sig) => boot().reconcileSettled(request, sig));
			assert.equal(started.state, "pending");
			startPending = false;
			const observed = await composed("boot", (sig) => boot().reconcileSettled(request, sig));
			assert.equal(observed.state, "awaiting_preparation");
			if (!lifecycleMode) assert.deepEqual(await boot().reconcile(request, signal()), observed);
			assert.equal(startPosts, 1);
			assert.equal(startPolls, 2);
			let prepared: Record<string, unknown> | undefined;
			if (bootOptions.prepare) {
				const prepare = () => new LxdOfficePreparationWorker(physical, registry, ports);
				const pending = await composed("preparation", (sig) => prepare().reconcileSettled(request, sig));
				assert.equal(pending.state, "pending");
				preparation.finish();
				const completed = await composed("preparation", (sig) => prepare().reconcileSettled(request, sig));
				assert.equal(completed.state, "awaiting_activation");
				if (!lifecycleMode) assert.deepEqual(await prepare().reconcile(request, signal()), completed);
				assert.deepEqual(preparation.counts(), { posts: 1, polls: 2, uploads: 1 });
				prepared = {
					...completed,
					...preparation.counts(),
					systemdAndGuestReport: guest ? "actual systemd; synthetic inventory" : "synthetic",
					activated: false,
				};
			}
			let configured: Record<string, unknown> | undefined;
			let activated: Record<string, unknown> | undefined;
			let configurationWorker: (() => LxdOfficeConfigurationWorker) | undefined;
			const configurationRequest = { ...request, serviceBootstrapPath: "/synthetic-bootstrap" };
			if (bootOptions.configure) {
				const cert = join(policy.journal.path, "synthetic-cert.pem"),
					key = join(policy.journal.path, "synthetic-key.pem");
				assert.equal(
					spawnSync(
						"openssl",
						[
							"req",
							"-x509",
							"-newkey",
							"rsa:2048",
							"-nodes",
							"-keyout",
							key,
							"-out",
							cert,
							"-days",
							"1",
							"-subj",
							"/CN=office.invalid",
						],
						{ timeout: 10000, stdio: "pipe" },
					).status,
					0,
				);
				const secrets = {
					registry: "r".repeat(64),
					native: "n".repeat(43),
					objects: "o".repeat(43),
					tlsCert: await readFile(cert, "utf8"),
					tlsKey: await readFile(key, "utf8"),
				};
				const bootstrap = Buffer.from(
					JSON.stringify({
						schema: "qorpera.lxd-office-service-bootstrap/v1",
						providerBindingSha256: lxdOfficeProviderBindingSha256(identity.binding),
						registryUrl: "https://registry.invalid",
						captureObjectGatewayUrl: "https://objects.invalid",
						native: { host: "0.0.0.0", port: 9443 },
						viewer: { host: "0.0.0.0", port: 9444, origins: ["https://client.invalid"] },
						credentials: Object.fromEntries(
							Object.entries(secrets).map(([name, value]) => [
								name,
								{
									path: `/synthetic-credentials/${name}`,
									bytes: Buffer.byteLength(value),
									sha256: createHash("sha256").update(value).digest("hex"),
								},
							]),
						),
					}),
				);
				const configurationPorts = {
					...ports,
					readProtected: async (path: string) =>
						path === configurationRequest.serviceBootstrapPath ? bootstrap : ports.readProtected(path),
					readCredential: async (path: string) => {
						const name = path.slice("/synthetic-credentials/".length) as keyof typeof secrets;
						assert.equal(path, `/synthetic-credentials/${name}`);
						assert(name in secrets);
						return Buffer.from(secrets[name]);
					},
				};
				configurationWorker = () => new LxdOfficeConfigurationWorker(physical, registry, configurationPorts);
				if (bootOptions.resume) {
					bootConfigurationWorker = () =>
						new LxdOfficeBootConfigurationWorker(physical, bootOptions.resume!.registry, configurationPorts);
					bootActivationWorker = () =>
						new LxdOfficeBootActivationWorker(
							physical,
							bootOptions.resume!.successorRegistry,
							configurationPorts,
						);
				}
				const pending = await composed("configuration", (sig) =>
					configurationWorker!().reconcileSettled(configurationRequest, sig),
				);
				assert.equal(pending.state, "pending");
				configuration.finish();
				const completed = await composed("configuration", (sig) =>
					configurationWorker!().reconcileSettled(configurationRequest, sig),
				);
				assert.equal(completed.state, "awaiting_activation");
				if (!lifecycleMode)
					assert.deepEqual(await configurationWorker().reconcile(configurationRequest, signal()), completed);
				assert.deepEqual(configuration.counts(), { posts: 1, polls: 2, uploads: 1 });
				configured = {
					...completed,
					...configuration.counts(),
					guestHelper: guest ? "actual protected root control" : "synthetic",
					activated: false,
				};
				if (bootOptions.activation && activation) {
					const worker = () =>
						new LxdOfficeActivationWorker(
							physical,
							registry,
							bootOptions.activation!.registry,
							configurationPorts,
						);
					// The driver deliberately loses the first committed activation reply.
					await assert.rejects(
						composed("activation", (sig) => worker().reconcileSettled(configurationRequest, sig)),
						lifecycleMode ? /OFFICE_LIFECYCLE_UNCONFIRMED/ : /OFFICE_ACTIVATION_UNCONFIRMED/,
					);
					const active = await composed("activation", (sig) =>
						worker().reconcileSettled(configurationRequest, sig),
					);
					assert.equal(active.state, "active");
					assert.deepEqual(
						await composed("activation", (sig) => worker().reconcileSettled(configurationRequest, sig)),
						active,
					);
					await bootOptions.revoke();
					assert.deepEqual(
						await composed("activation", (sig) => worker().reconcileSettled(configurationRequest, sig)),
						active,
					);
					assert.equal(activation.counts().starts, 1);
					assert.equal(activation.counts().uploads, 1);
					assert.equal(activation.counts().inspections, 4);
					assert.deepEqual(configuration.counts(), { posts: 1, polls: 2, uploads: 1 });
					assert.deepEqual(preparation.counts(), { posts: 1, polls: 2, uploads: 1 });
					activated = {
						...active,
						...activation.counts(),
						lostStartReplyRecovered: true,
						lostCommittedActivationRecovered: true,
						preparationDisablePreservesActiveRecovery: true,
						physicalSystemd: guest ? "actual" : "synthetic",
					};
					if (bootOptions.stop && stop) {
						assert(lifecycleMode);
						const configBytes = preparation.files.get("/etc/qorpera-office/credentials/config.json")!.content;
						const config = JSON.parse(configBytes.toString()),
							attestation = config.linux.attestation;
						const prior = JSON.parse(
							preparation.files
								.get("/run/qorpera-office-preparation/service-start-completion.json")!
								.content.toString(),
						);
						const recovery = parseCompanyComputerLifecycleRequest({
							schema: "qorpera.office-lifecycle-request/v1",
							transitionId: randomUUID(),
							action: bootOptions.successor ? "service_restart" : bootOptions.powerOff ? "power_off" : "replace",
							activationId: prior.activationId,
							providerId: policy.guest.providerId,
							providerPolicySha256: lxdOfficePhysicalPolicySha256(policy),
							startup: {
								scope: config.scope,
								computerGeneration: config.computerGeneration,
								allocationId: attestation.allocationId,
								instanceSha256: attestation.instanceSha256,
								imageSha256: attestation.imageSha256,
								bootstrapSha256: attestation.bootstrapSha256,
								bootId: attestation.bootId,
								configurationSha256: prior.configurationSha256,
								serviceInvocationId: prior.serviceInvocationId,
							},
						});
						recoveryPlan = { schema: "qorpera.lxd-office-recovery-plan/v1", request: recovery };
						// The driver loses the committed revocation, then committed ack.
						await assert.rejects(lifecycle().reconcile(signal()), /OFFICE_LIFECYCLE_UNCONFIRMED/);
						await assert.rejects(lifecycle().reconcile(signal()), /OFFICE_LIFECYCLE_UNCONFIRMED/);
						await bootOptions.stop.restartDatabase();
						const stopped = await lifecycle().reconcile(signal());
						assert.equal(stopped.state, bootOptions.successor || powerOff ? "progressed" : "held");
						assert.equal(stopped.phase, "service_stop");
						assert(stopped.acknowledgedAtMs);
						if (!bootOptions.successor && !powerOff)
							assert.deepEqual(await lifecycle().reconcile(signal()), stopped);
						if (powerOff) {
							const uncertain = await lifecycle().reconcile(signal());
							assert.equal(uncertain.state, "unknown");
							assert.equal(uncertain.phase, "power_off");
							await bootOptions.stop.restartDatabase();
							const off = await lifecycle().reconcile(signal());
							assert.equal(off.state, "powered_off");
							assert.equal(off.phase, "power_off");
							assert.deepEqual(await lifecycle().reconcile(signal()), off);
							assert.deepEqual(powerOff.counts(), { posts: 1, polls: 2 });
							assert.equal(instance?.status, "Stopped");
							if (bootOptions.resume && resumeHttp) {
								const suffix = `${recovery.startup.allocationId}-${recovery.transitionId}`,
									shutdownFile = await readFile(
										join(policy.journal.path, `power-off-completed-${suffix}.json`),
									),
									shutdown = JSON.parse(
										await readFile(join(policy.journal.path, `power-off-request-${suffix}.json`), "utf8"),
									);
								const originalConfig = Buffer.from(
										preparation.files.get("/etc/qorpera-office/credentials/config.json")!.content,
									),
									archives = [...preparation.files]
										.filter(([path]) => path.startsWith("/etc/qorpera-office/history/"))
										.map(([path, file]) => [path, Buffer.from(file.content)] as const);
								assert(archives.length > 3);
								resumePlan = {
									schema: "qorpera.lxd-office-resume-plan/v1",
									request: {
										schema: "qorpera.office-boot-intent-request/v1",
										bootIntentId: randomUUID(),
										activationId: randomUUID(),
										predecessor: recovery,
										stopHistorySha256: shutdown.stopHistorySha256,
										powerOffCompletionSha256: createHash("sha256").update(shutdownFile).digest("hex"),
									},
								};
								assert.deepEqual(await lifecycle().reconcile(signal()), {
									state: "progressed",
									phase: "power_off",
									intentId: off.intentId,
									transitionId: recovery.transitionId,
								});
								await assert.rejects(lifecycle().reconcile(signal()), /OFFICE_LIFECYCLE_UNCONFIRMED/); // disabled provider
								assert.equal(resumeHttp.counts().starts, 0);
								await bootOptions.resume.enable();
								await assert.rejects(lifecycle().reconcile(signal()), /OFFICE_LIFECYCLE_UNCONFIRMED/); // lost committed intent
								await bootOptions.stop.restartDatabase();
								assert.equal((await lifecycle().reconcile(signal())).state, "unknown"); // lost accepted operation poll
								await bootOptions.stop.restartDatabase();
								const resumed = await lifecycle().reconcile(signal());
								assert.equal(resumed.state, "progressed");
								assert.equal(resumed.phase, "resume");
								assert.deepEqual(resumeHttp.counts(), { starts: 1, polls: 2 });
								assert.deepEqual(powerOff.counts(), { posts: 1, polls: 2 });
								assert.equal(instance?.status, "Running");
								assert.equal(
									[...preparation.files.keys()].some((path) => path.startsWith("/run/")),
									false,
								);
								assert(
									originalConfig.equals(
										preparation.files.get("/etc/qorpera-office/credentials/config.json")!.content,
									),
								);
								for (const [path, bytes] of archives)
									assert(bytes.equals(preparation.files.get(path)!.content));
								assert(
									shutdownFile.equals(
										await readFile(join(policy.journal.path, `power-off-completed-${suffix}.json`)),
									),
								);
								// A fresh tmpfiles lock replaces the volatile previous-boot lock.
								preparation.files.set("/run/qorpera-office-preparation/control.lock", {
									content: Buffer.alloc(0),
									mode: "0600",
								});
								assert.equal((await lifecycle().reconcile(signal())).state, "unknown"); // accepted root operation, lost poll
								await bootOptions.stop.restartDatabase();
								const configured = await lifecycle().reconcile(signal());
								assert.equal(configured.state, "progressed");
								assert.equal(configured.phase, "boot_configuration");
								await assert.rejects(lifecycle().reconcile(signal()), /OFFICE_LIFECYCLE_UNCONFIRMED/); // Lost committed successor preparation.
								assert.deepEqual(bootActivation!.counts(), { starts: 0, inspections: 0, uploads: 0 });
								await bootOptions.stop.restartDatabase();
								await assert.rejects(lifecycle().reconcile(signal()), /OFFICE_LIFECYCLE_UNCONFIRMED/); // Lost physical start and committed activation replies.
								assert.deepEqual(bootActivation!.counts(), { starts: 1, inspections: 1, uploads: 1 });
								await bootOptions.stop.restartDatabase();
								const reactivated = await lifecycle().reconcile(signal());
								assert.equal(reactivated.state, "active");
								assert.equal(reactivated.phase, "boot_activation");
								assert.deepEqual(await lifecycle().reconcile(signal()), reactivated);
								assert.deepEqual(bootActivation!.counts(), { starts: 1, inspections: 3, uploads: 1 });
								assert.deepEqual(bootConfiguration!.counts(), { posts: 1, polls: 2, uploads: 1 });
								assert(
									originalConfig.equals(
										preparation.files.get("/etc/qorpera-office/credentials/config.json")!.content,
									),
								);
								for (const [path, bytes] of archives)
									assert(bytes.equals(preparation.files.get(path)!.content));
								assert(!preparation.files.has("/run/qorpera-office-preparation/service-start-completion.json"));
								await bootOptions.revoke();
								assert.deepEqual(await lifecycle().reconcile(signal()), reactivated); // Disabled preparation still permits independently inspected active recovery.
								assert.deepEqual(bootActivation!.counts(), { starts: 1, inspections: 4, uploads: 1 });
								assert.deepEqual(bootConfiguration!.counts(), { posts: 1, polls: 2, uploads: 1 });
								const bootStart = JSON.parse(
									preparation.files
										.get("/run/qorpera-office-preparation/boot-service-start-completion.json")!
										.content.toString(),
								);
								const secondRecovery = parseCompanyComputerLifecycleRequest({
									...recovery,
									action: "service_restart",
									transitionId: randomUUID(),
									activationId: bootStart.activationId,
									startup: {
										...recovery.startup,
										bootId: bootStart.command.bootId,
										configurationSha256: bootStart.configurationSha256,
										serviceInvocationId: bootStart.serviceInvocationId,
									},
								});
								recoveryPlan = { schema: "qorpera.lxd-office-recovery-plan/v1", request: secondRecovery };
								// A new revocation/stop/acknowledgement on this boot must retain
								// its own identities through the same lost replies and restart.
								await assert.rejects(lifecycle().reconcile(signal()), /OFFICE_LIFECYCLE_UNCONFIRMED/);
								await bootOptions.stop.restartDatabase();
								await assert.rejects(lifecycle().reconcile(signal()), /OFFICE_LIFECYCLE_UNCONFIRMED/);
								await bootOptions.stop.restartDatabase();
								const secondStopped = await lifecycle().reconcile(signal());
								assert.equal(secondStopped.state, "progressed");
								assert.equal(secondStopped.phase, "service_stop");
								assert(secondStopped.acknowledgedAtMs);
								const stopRecovered = await new LxdOfficeServiceStopWorker(
									physical,
									bootOptions.stop.registry,
									{ kernelLock: async () => {} },
								).reconcile(identity.intentId, secondRecovery, signal());
								assert.equal(stopRecovered.state, "stopped");
								assert.equal(stopRecovered.transitionId, secondRecovery.transitionId);
								assert.equal(stopRecovered.acknowledgedAtMs, secondStopped.acknowledgedAtMs);
								assert.deepEqual(stop.counts(), { stops: 2, inspections: 2, uploads: 2 });
								assert.deepEqual(bootActivation!.counts(), { starts: 1, inspections: 4, uploads: 1 });
								assert.deepEqual(bootConfiguration!.counts(), { posts: 1, polls: 2, uploads: 1 });
								for (const [path, bytes] of archives)
									assert(bytes.equals(preparation.files.get(path)!.content));
								assert(
									originalConfig.equals(
										preparation.files.get("/etc/qorpera-office/credentials/config.json")!.content,
									),
								);
								const restarts = await runOfficeBootRestartCycles({
									finalReboot: bootOptions.resume.laterCycles,
									files: preparation.files,
									request: secondRecovery,
									reconcile: () => lifecycle().reconcile(signal()),
									setRecovery: (request) => {
										recoveryPlan = { schema: "qorpera.lxd-office-recovery-plan/v1", request };
									},
									enable: bootOptions.resume.enable,
									revoke: bootOptions.revoke,
									restartDatabase: bootOptions.stop.restartDatabase,
									counts: bootRestart!.counts,
								});
								assert.deepEqual(stop.counts(), { stops: 4, uploads: 4, inspections: 4 });
								if (bootOptions.resume.laterCycles) {
									const cycles = await runOfficeVmSqlCycles({
										root: policy.journal.path,
										files: preparation.files,
										request: restarts.request,
										reconcile: () => lifecycle().reconcile(signal()),
										setRecovery: (request) => {
											recoveryPlan = { schema: "qorpera.lxd-office-recovery-plan/v1", request };
										},
										setResume: (plan) => {
											resumePlan = plan;
										},
										enable: bootOptions.resume.enable,
										revoke: bootOptions.revoke,
										restartDatabase: bootOptions.stop.restartDatabase,
										counts: () => ({
											powerOff: powerOff.counts(),
											resume: resumeHttp.counts(),
											configuration: bootConfiguration!.counts(),
											activation: bootActivation!.counts(),
											stops: stop.counts(),
										}),
									});
									console.log(`OFFICE_SQL_VM_CYCLES_PROOF=${JSON.stringify(cycles)}`);
								}
								recoveryPlan = { schema: "qorpera.lxd-office-recovery-plan/v1", request: recovery };
								if (!bootOptions.resume.laterCycles)
									console.log(
										`OFFICE_SQL_RESUME_PROOF=${JSON.stringify({ ...reactivated, ...resumeHttp.counts(), configuration: bootConfiguration!.counts(), bootActivation: bootActivation!.counts(), secondStop: { ...secondStopped, rootServiceStop: "synthetic" }, allStops: stop.counts(), restarts, archiveFiles: archives.length, preservedConfiguration: true, clearedRunHistory: true, ordinaryServiceStarted: true, physicalVM: "synthetic", protectedArchive: "synthetic", rootConfiguration: "synthetic", rootServiceStart: "synthetic", actualSqlAndUnixHttp: true })}`,
									);
							}
							const stage = join(
								policy.journal.path,
								`recovery-stage-${recovery.startup.allocationId}-${recovery.transitionId}.json`,
							);
							await rm(stage);
							await assert.rejects(lifecycle().reconcile(signal()), /OFFICE_LIFECYCLE_UNCONFIRMED/);
							activated = {
								...activated,
								powerOff: {
									...off,
									...powerOff.counts(),
									physicalVM: "synthetic",
									databaseRestartRecovered: true,
								},
							};
						}
						const expectedStops = bootOptions.resume?.laterCycles ? 6 : bootOptions.resume ? 4 : 1;
						assert.deepEqual(stop.counts(), {
							stops: expectedStops,
							uploads: expectedStops,
							inspections: expectedStops,
						});
						assert.equal(activation.counts().starts, 1);
						activated = {
							...activated,
							stop: {
								...stopped,
								...stop.counts(),
								lostRevocationReplyRecovered: true,
								lostPhysicalReplyRecovered: true,
								lostCommittedAckRecovered: true,
								databaseRestartRecovered: true,
								physicalSystemd: guest ? "actual" : "synthetic",
							},
						};
						if (bootOptions.successor && successor) {
							const initialStart = Buffer.from(
								preparation.files.get("/run/qorpera-office-preparation/service-start-completion.json")!.content,
							);
							const initialStop = Buffer.from(
								preparation.files.get("/run/qorpera-office-preparation/service-stop-completion.json")!.content,
							);
							await bootOptions.successor.enable();
							const results = [];
							for (let cycle = 0; cycle < 2; cycle++) {
								if (cycle === 0) {
									await assert.rejects(lifecycle().reconcile(signal()), /OFFICE_LIFECYCLE_UNCONFIRMED/);
									await assert.rejects(lifecycle().reconcile(signal()), /OFFICE_LIFECYCLE_UNCONFIRMED/);
									await bootOptions.stop.restartDatabase();
								}
								const running = lifecycle(),
									result = await running.reconcile(signal());
								assert.equal(result.state, "active");
								assert.equal(result.phase, "service_restart");
								assert(result.activationId);
								const beforePoll: { starts: number; inspections: number; uploads: number } = successor.counts();
								assert.deepEqual(await running.reconcile(signal()), result);
								assert.deepEqual(successor.counts(), beforePoll);
								assert.deepEqual(await lifecycle().reconcile(signal()), result);
								results.push(result);
								if (cycle === 0) {
									const current = JSON.parse(
										preparation.files
											.get(
												`/run/qorpera-office-preparation/service-restart-completion-${result.activationId}.json`,
											)!
											.content.toString(),
									);
									recoveryPlan = {
										schema: "qorpera.lxd-office-recovery-plan/v1",
										request: {
											...recovery,
											activationId: result.activationId,
											transitionId: randomUUID(),
											startup: { ...recovery.startup, serviceInvocationId: current.serviceInvocationId },
										},
									};
									assert.equal((await lifecycle().reconcile(signal())).state, "progressed");
								}
							}
							assert(
								preparation.files
									.get("/run/qorpera-office-preparation/service-start-completion.json")!
									.content.equals(initialStart),
							);
							assert(
								preparation.files
									.get("/run/qorpera-office-preparation/service-stop-completion.json")!
									.content.equals(initialStop),
							);
							assert.equal(successor.counts().starts, 2);
							assert.equal(successor.counts().uploads, 2);
							assert.equal(stop.counts().stops, 2);
							const retainedRecovery = recoveryPlan;
							recoveryPlan = undefined;
							await assert.rejects(lifecycle().reconcile(signal()), /OFFICE_LIFECYCLE_UNCONFIRMED/);
							recoveryPlan = retainedRecovery;
							assert.equal(successor.counts().starts, 2);
							assert.equal(stop.counts().stops, 2);
							activated = {
								...activated,
								successors: results,
								successorOperations: successor.counts(),
								stopOperations: stop.counts(),
							};
						}
					}
				}
			}
			if (!activated) await bootOptions.revoke();
			if (configurationWorker) {
				await assert.rejects(
					configurationWorker().reconcile(configurationRequest, signal()),
					/OFFICE_CONFIGURATION_UNCONFIRMED/,
				);
				assert.deepEqual(configuration.counts(), { posts: 1, polls: 2, uploads: 1 });
			}
			const earlierPhaseRefusal = bootOptions.successor
				? /Office start authority unavailable/
				: /Office provider authority unavailable/;
			await assert.rejects(boot().reconcile(request, signal()), earlierPhaseRefusal);
			if (bootOptions.prepare) {
				await assert.rejects(
					new LxdOfficePreparationWorker(physical, registry, ports).reconcile(request, signal()),
					earlierPhaseRefusal,
				);
				assert.deepEqual(preparation.counts(), { posts: 1, polls: 2, uploads: 1 });
			}
			assert.equal(startPosts, 1);
			assert.deepEqual(failures, []);
			firstBoot = {
				...observed,
				startPosts,
				startPolls,
				providerDisableRefused: true,
				copyAndWriterAuthority: "synthetic",
				activated: false,
				...(prepared ? { preparation: prepared } : {}),
				...(configured ? { configuration: configured } : {}),
				...(activated ? { activation: activated } : {}),
			};
		}
		return {
			state: completed.state,
			...(lifecycleMode
				? {
						serializedLifecycle: true,
						retainedPhases: (await readdir(policy.journal.path)).filter((name) => name.startsWith("lifecycle-"))
							.length,
					}
				: {}),
			posts,
			polls,
			lostCommittedReservationRecovered: true,
			physicalGate: "synthetic",
			physicalVm: false,
			...(firstBoot ? { firstBoot } : {}),
		};
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
}
