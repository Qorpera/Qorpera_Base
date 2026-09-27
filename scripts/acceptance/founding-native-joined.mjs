import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { LxdUnixClient } from "../../packages/runner-orchestrator/src/lxd-client.ts";
import {
	HttpLxdGuestTransport,
	LxdCloudRunnerProviderBackend,
} from "../../packages/runner-orchestrator/src/lxd-provider.ts";
import { lxdNativeNodePolicy } from "../../packages/runner-orchestrator/src/lxd-native-node-policy.ts";
import { SupabaseCloudRunnerOrchestratorControlPlane } from "../../packages/runner-orchestrator/src/orchestrator.ts";
import { PaidComputerGuardClient } from "../../packages/runner-orchestrator/src/computer-paid-guard-ipc.ts";
import { readPaidComputerHostClock } from "../../packages/runner-orchestrator/src/computer-paid-guard-lxd.ts";
import { RuntimeComputerController } from "../../packages/runner-orchestrator/src/runtime-computer-controller.ts";
import { RuntimeComputerHttpControl } from "../../packages/runner-orchestrator/src/runtime-computer-http-control.ts";
import { RuntimeNodeInventoryObserver } from "../../packages/runner-orchestrator/src/runtime-node-observer.ts";
import { runFoundingNative } from "./founding-native.mjs";
import {
	foundingNativeJoinedOptions,
	readFoundingNativePayment,
	prepareFoundingNativeBrowser,
} from "./founding-native-hosted.mjs";
import { prepareFoundingBootstrap } from "./founding-bootstrap.mjs";
import { foundingNativeAccounts } from "./founding-native-accounts.mjs";
import { foundingNativeEdge } from "./founding-native-edge.mjs";
import { startFoundingNativePlatform } from "./founding-native-platform.mjs";
import { startFoundingNativeModel } from "./founding-native-model.mjs";
import { closeFoundingNativeCustody } from "./founding-native-custody.mjs";
import { dispatchFoundingRuntime } from "./founding-runtime.mjs";
import { readWorkloadUsage, verifyWorkloadUsage } from "./workload-usage-evidence.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const token = () => randomBytes(32).toString("base64url");

export async function readFoundingNativeHost(path) {
	assert(isAbsolute(path) && (await realpath(path)) === path);
	const info = await lstat(path);
	assert(
		info.isFile() &&
			info.size < 1024 * 1024 &&
			(info.mode & 0o077) === 0 &&
			[0, process.getuid?.()].includes(info.uid),
	);
	const host = JSON.parse(await readFile(path, "utf8"));
	assert.equal(host.schema, "qorpera.founding-native-host/v1");
	assert.equal(host.complete, true);
	assert.equal(host.disposableHost, true);
	assert.equal(process.platform, "linux");
	assert.equal(process.getuid?.(), host.uid);
	assert.equal(process.getgid?.(), host.gid);
	assert(host.uid > 0 && cpus().length >= 6 && totalmem() >= 12 * 1024 ** 3);
	assert.equal(
		process.env.NODE_EXTRA_CA_CERTS,
		host.caPath,
		"Start Node with the isolated host CA; TLS validation stays enabled",
	);
	assert(/^[0-9a-f]{64}$/.test(host.imageFingerprint) && /^[0-9a-f]{64}$/.test(host.guestPackageSha256));
	assert.equal(host.installation.guest_package_manifest_sha256, host.guestPackageSha256);
	assert.equal(host.lxdSocketPath, "/var/snap/lxd/common/lxd/unix.socket");
	return host;
}

/** Full joined composition. Auth/member/browser and object publication are
 * real. Model OAuth completion is a disclosed synthetic fixture whose sealed
 * bytes are installed in the exact fresh identity volume. The production
 * orchestrator, provider, bootstrap, native binary and paid guard are used.
 */
export async function prepareFoundingNativeScenario(platform, host, payment) {
	const bootstrap = await prepareFoundingBootstrap(platform),
		owned = [];
	let backend, runner, maintenance, maintenanceStop, closePromise;
	const parts = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const head = `${parts({ alg: "HS256", typ: "JWT" })}.${parts({ role: "service_role", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 })}`;
	const serviceJwt = `${head}.${createHmac("sha256", platform.jwtSecret).update(head).digest("base64url")}`;
	const rpc = async (name, args, signal = AbortSignal.timeout(15000)) => {
		assert(/^qorpera_[a-z0-9_]+$/.test(name));
		const response = await fetch(`http://127.0.0.1:${platform.restPort}/rpc/${name}`, {
			method: "POST",
			redirect: "error",
			signal,
			headers: { authorization: `Bearer ${serviceJwt}`, "content-type": "application/json" },
			body: JSON.stringify(args),
		});
		assert.equal(response.status, 200, `Isolated actual RPC refused: ${name}`);
		return response.json();
	};
	const accounts = foundingNativeAccounts({ privateRoot: platform.privateRoot, serviceRpc: rpc });
	const close = () => {
		if (closePromise) return closePromise;
		// Preserve the real accounting database until physical stop and settlement
		// have been attempted. A failed closure is retained by the owning harness.
		closePromise = closeFoundingNativeCustody({
			stages: [
				async () => {
					if (runner) await backend.stop(runner, "idle", AbortSignal.timeout(90000));
					if (backend) {
						const root = join(platform.privateRoot, "native-provider");
						for (const entry of await readdir(root, { withFileTypes: true })) {
							if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue;
							const journal = JSON.parse(await readFile(join(root, entry.name, "journal.json"), "utf8"));
							await backend.stop(journal.runner, "revoked", AbortSignal.timeout(90000));
						}
						await backend.reconcile(AbortSignal.timeout(90000));
						assert.equal(
							(await new LxdUnixClient(host.lxdSocketPath).inspectHostInventory(AbortSignal.timeout(15000)))
								.instances.length,
							0,
						);
						assert.equal(
							await platform.cluster.query(
								"select count(*) from public.qorpera_computer_allowance_reservations where settled_at is null;",
							),
							"0",
							"Unsettled physical holds must retain their database",
						);
					}
				},
				async () => {
					maintenanceStop?.abort();
					await maintenance;
				},
				...owned.toReversed().map((item) => () => item.close()),
				() => bootstrap.close(),
			],
			preserve: () => platform.cluster.close({ keepFiles: true }),
			diagnostics: [
				() =>
					writeFile(
						join(platform.privateRoot, "unconfirmed-native-closure.json"),
						JSON.stringify({
							schema: "qorpera.founding-native-unconfirmed/v1",
							databaseRoot: platform.cluster.root,
							database: platform.cluster.database,
							socketDirectory: platform.cluster.socketDirectory,
							port: platform.cluster.port,
							username: platform.cluster.username,
							hostContext: join(host.workRoot, "host.json"),
						}),
						{ mode: 0o600 },
					),
				() =>
					writeFile(
						join(host.workRoot, "unconfirmed-custody.json"),
						JSON.stringify({ privateRoot: platform.privateRoot, databaseRoot: platform.cluster.root }),
						{ mode: 0o600 },
					),
			],
		});
		return closePromise;
	};
	const afterMaterialized = async (pins) => {
		const signal = AbortSignal.timeout(15 * 60000),
			observations = [],
			calls = [];
		const ca = await readFile(host.caPath),
			key = await readFile(host.keyPath),
			cert = await readFile(host.certificatePath);
		const capsuleRoot = join(platform.privateRoot, "native-capsule");
		await mkdir(capsuleRoot, { mode: 0o700 });
		let allowedReference;
		const capsules = {
			async put(reference, bytes) {
				assert(allowedReference === undefined || reference === allowedReference);
				assert(/^native-capsule\/[0-9a-f-]{36}$/.test(reference) && bytes.length <= 2 * 1024 * 1024);
				allowedReference = reference;
				const temporary = join(capsuleRoot, `${randomUUID()}.tmp`);
				await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
				await rename(temporary, join(capsuleRoot, "sealed"));
			},
			async get(reference) {
				assert.equal(reference, allowedReference);
				return readFile(join(capsuleRoot, "sealed"));
			},
		};
		const masterKey = token();
		const sealed = await accounts.sealForGuest({
			profileId: pins.profileId,
			computeIdentityId: pins.computeIdentityId,
			userId: pins.sponsoredByUserId,
			masterKey,
			store: capsules,
		});
		const edges = {};
		for (const name of ["runner-orchestrator", "runner-control"])
			edges[name] = await foundingNativeEdge({ name, restPort: platform.restPort, serviceJwt });
		const guestKey = token(),
			objectToken = token(),
			executorSecret = randomBytes(48).toString("base64url");
		const gateway = await startFoundingNativePlatform({
			host: host.hostAddress,
			port: host.platformPort,
			key,
			cert,
			guestKey,
			publicKey: platform.publicKey,
			serviceJwt,
			restPort: platform.restPort,
			edges,
			capsules,
			capsuleId: sealed.capsuleId,
			nativeObjects: bootstrap.nativeHandler(objectToken),
		});
		owned.push(gateway);
		owned.push(
			await startFoundingNativeModel({
				host: host.hostAddress,
				key,
				cert,
				receiptId: pins.receiptId,
				token: sealed.token,
				dnsPort: host.dnsPort,
				tlsPort: host.tlsPort,
				onObservation: (value) => observations.push(value),
			}),
		);
		const client = new LxdUnixClient(host.lxdSocketPath);
		assert.equal(
			(await client.inspectHostInventory(signal)).instances.length,
			0,
			"Only the member-created run may create a VM",
		);
		const config = {
			adapterId: "founding-native",
			supabaseUrl: gateway.origin,
			supabaseServiceKey: guestKey,
			supabasePublishableKey: platform.publicKey,
			stateRoot: join(platform.privateRoot, "native-provider"),
			project: "default",
			jobProfile: host.jobProfile,
			networkInterface: "eth0",
			imageServer: "local",
			imageFingerprint: host.imageFingerprint,
			storagePool: host.storagePool,
			identityVolumePrefix: "qf-id-",
			identityVolumeSize: "1GiB",
			rootDiskSize: "30GiB",
			cpuLimit: 4,
			memoryLimit: "8GiB",
			guestAssignmentPort: 4319,
			guestAssignmentSource: host.hostAddress,
			nativeBridgePort: 4320,
			nativeExecutionGid: 42041,
			guestReadyTimeoutMs: 180000,
			runnerImage: host.manifest.runnerImage.image,
			runnerPodmanPath: "/usr/bin/podman",
			runnerEntrypoint: "/qorpera/bin/run-job",
			runnerVersion: "founding-native-acceptance",
			codexPath: "/usr/local/bin/codex",
			claudePath: "/usr/local/bin/claude",
			nativeCompanyRuntime: {
				mode: "company-path-v1",
				codexPath: host.manifest.nativeCompany.binaryPath,
				binarySha256: host.manifest.nativeCompany.binarySha256,
				objectGatewayUrl: gateway.origin,
				objectGatewayToken: objectToken,
				secretBroker: {
					origin: gateway.origin,
					runtimeToken: token(),
					caCertificate: ca.toString("utf8"),
					caSha256: hash(ca),
				},
				network: host.bridge,
				recoveryVolumePrefix: "qf-recovery-",
				recoveryVolumeSize: "1GiB",
			},
		};
		const clock = await readPaidComputerHostClock(),
			server = await client.inspectOfficeServer("default", signal),
			nodeId = randomUUID();
		const { policy, policySha256 } = lxdNativeNodePolicy(config, clock.hostMachineIdSha256);
		const inventoryPolicy = {
			schema: "qorpera.runtime-node-inventory-policy/v1",
			nodeId,
			host: {
				machineIdSha256: clock.hostMachineIdSha256,
				socketPath: host.lxdSocketPath,
				socketGid: (await stat(host.lxdSocketPath)).gid,
				certificateSha256: server.certificateSha256,
				serverName: server.serverName,
				serverVersion: server.serverVersion,
				architecture: server.architecture,
			},
			operatingCpuMillis: 500,
			operatingMemoryBytes: 1024 ** 3,
			infrastructure: [],
		};
		await rpc("qorpera_configure_runtime_node", {
			p_policy: {
				schema: "qorpera.runtime-node-policy/v1",
				nodeId,
				machineIdSha256: clock.hostMachineIdSha256,
				label: "isolated-real-founding",
				cpuMillis: cpus().length * 1000,
				memoryBytes: totalmem(),
				headroomCpuMillis: 2000,
				headroomMemoryBytes: 4 * 1024 ** 3,
				standardCpuMillis: 4000,
				standardMemoryBytes: 8 * 1024 ** 3,
				enabled: true,
			},
			p_expected_version: 0,
		});
		await rpc("qorpera_enroll_runtime_node_inventory", { p_policy: inventoryPolicy });
		await rpc("qorpera_enroll_runtime_node_provider", {
			p_node_id: nodeId,
			p_machine_id_sha256: clock.hostMachineIdSha256,
			p_provider_kind: "native",
			p_provider_id: config.adapterId,
			p_policy_sha256: policySha256,
			p_cpu_millis: 4000,
			p_memory_bytes: 8 * 1024 ** 3,
		});
		await platform.cluster.query(`insert into public.qorpera_runtime_computer_host_keys(node_id,provider_kind,provider_id,policy_sha256,machine_id_sha256,bootstrap_sha256,cpu_millis,memory_bytes,backend,key_sha256)
			 values('${nodeId}','native','founding-native','${policySha256}','${clock.hostMachineIdSha256}',null,4000,8589934592,'lxd','${hash(executorSecret)}');`);
		await writeFile(
			join(platform.privateRoot, "native-host-recovery.json"),
			JSON.stringify({
				schema: "qorpera.founding-native-private-recovery/v1",
				config,
				nodeId,
				inventoryPolicy,
				executorSecret,
				jwtSecret: platform.jwtSecret,
				pins,
			}),
			{ flag: "wx", mode: 0o600 },
		);
		const observer = new RuntimeNodeInventoryObserver(inventoryPolicy, { call: rpc }, { lxd: client });
		assert.equal((await observer.observe(signal)).state, "ready");
		const hostFetch = async (input, init) => {
			const url = new URL(String(input));
			assert.equal(url.origin, gateway.origin);
			assert(!url.search && !url.hash);
			assert(/^\/rest\/v1\/rpc\/qorpera_[a-z0-9_]+$/.test(url.pathname));
			return fetch(`http://127.0.0.1:${platform.restPort}${url.pathname.slice("/rest/v1".length)}`, {
				...init,
				redirect: "error",
				headers: { "content-type": "application/json", authorization: `Bearer ${serviceJwt}` },
			});
		};
		const paid = new RuntimeComputerHttpControl(
			{ supabaseUrl: gateway.origin, supabaseServiceKey: serviceJwt, executorSecret },
			hostFetch,
		);
		const guard = new PaidComputerGuardClient("/run/qorpera-native-computer-guard/control.sock");
		const controller = new RuntimeComputerController({
			guard,
			client,
			clock: readPaidComputerHostClock,
			control: {
				async call(method, args, abort) {
					const result = await paid.call(method, args, abort);
					if (args.p_request?.sample || Array.isArray(args.p_request?.entries))
						calls.push({ method, args: structuredClone(args) });
					return result;
				},
			},
		});
		const execPhysical = client.execInstance.bind(client);
		let initialized = false,
			networkProof;
		client.execInstance = async (project, name, command, abort) => {
			if (command.join(" ") === "/usr/bin/systemctl enable --now qorpera-lxd-runner-bootstrap.service") {
				assert(!initialized, "Synthetic identity initialization must be a single exact fresh bootstrap");
				const actual = JSON.parse(
					(await client.readInstanceFile(project, name, "/var/lib/qorpera-bootstrap/bootstrap.json", 65536, abort))
						.content,
				);
				assert.equal(actual.compute_identity_id, pins.computeIdentityId);
				assert.equal(actual.company_runtime?.run_id, pins.runId);
				assert.equal(actual.company_runtime?.profile_id, pins.profileId);
				await client.pushInstanceFile(
					project,
					name,
					"/var/tmp/qorpera-founding-network-probe.py",
					await readFile(new URL("./founding-native-network-probe.py", import.meta.url), "utf8"),
					0o400,
					abort,
				);
				await execPhysical(
					project,
					name,
					[
						"/usr/bin/python3",
						"/var/tmp/qorpera-founding-network-probe.py",
						host.hostAddress,
						String(host.platformPort),
						"/var/tmp/qorpera-founding-network-proof.json",
					],
					abort,
				);
				networkProof = JSON.parse(
					(
						await client.readInstanceFile(
							project,
							name,
							"/var/tmp/qorpera-founding-network-proof.json",
							4096,
							abort,
						)
					).content,
				);
				assert.equal(networkProof.schema, "qorpera.founding-guest-network/v1");
				assert.equal(networkProof.externalIpv4Denied, true);
				assert.equal(networkProof.externalIpv6Denied, true);
				assert.equal(networkProof.syntheticDnsAndTls, true);
				assert.equal(networkProof.uncredentialedBillingDenied, true);
				for (const path of ["qorpera-compute-identity.json", "qorpera-native-provider-master-key"])
					await execPhysical(
						project,
						name,
						["/usr/bin/test", "!", "-e", `/var/lib/qorpera/identity/${path}`],
						abort,
					);
				await client.pushInstanceFile(
					project,
					name,
					"/var/lib/qorpera/identity/qorpera-compute-identity.json",
					JSON.stringify({
						schema: "qorpera.compute-identity-volume/v1",
						compute_identity_id: pins.computeIdentityId,
					}),
					0o600,
					abort,
				);
				await client.pushInstanceFile(
					project,
					name,
					"/var/lib/qorpera/identity/qorpera-native-provider-master-key",
					`${masterKey}\n`,
					0o600,
					abort,
				);
				initialized = true;
			}
			return execPhysical(project, name, command, abort);
		};
		backend = new LxdCloudRunnerProviderBackend(
			config,
			client,
			new HttpLxdGuestTransport(client),
			hostFetch,
			controller,
		);
		const orchestratorId = randomUUID(),
			orchestratorToken = token();
		await platform.cluster.query(`begin; set local role service_role; set local request.jwt.claims='{"role":"service_role"}';
			 select public.qorpera_register_runner_orchestrator('${orchestratorId}','Real founding acceptance','founding-native','${hash(orchestratorToken)}',3600); commit;`);
		const control = new SupabaseCloudRunnerOrchestratorControlPlane(
			gateway.origin,
			platform.publicKey,
			orchestratorId,
			orchestratorToken,
			(input, init) => edges["runner-orchestrator"].handler(new Request(input, init)),
		);
		await control.renewControl();
		maintenanceStop = new AbortController();
		let maintenanceFailure;
		maintenance = (async () => {
			while (!maintenanceStop.signal.aborted) {
				try {
					await observer.observe(signal);
					await backend.maintainComputerUsage(signal);
				} catch (error) {
					maintenanceFailure = error;
				}
				await delay(1000, undefined, { signal: maintenanceStop.signal }).catch(() => {});
			}
		})();
		const dispatch = await dispatchFoundingRuntime({
			pins,
			orchestratorId,
			controlPlane: control,
			signal,
			backend: {
				adapterId: backend.adapterId,
				reconcile: (abort) => backend.reconcile(abort),
				acquire: async (...args) => {
					runner = await backend.acquire(...args);
					return runner;
				},
				deliver: (...args) => backend.deliver(...args),
				stop: (...args) => backend.stop(...args),
			},
		});
		let terminal;
		while (!signal.aborted) {
			terminal = JSON.parse(
				await platform.cluster.query(`select jsonb_build_object('run',run.status,'job',job.status)
				 from public.qorpera_execution_runs run join public.qorpera_runner_jobs job on job.run_id=run.id where run.id='${pins.runId}';`),
			);
			if (["completed", "failed", "cancelled"].includes(terminal.job)) break;
			await delay(1000, undefined, { signal });
		}
		assert.equal(terminal?.job, "completed", "Actual guest run did not complete");
		const publicDelivery = JSON.parse(
			await platform.cluster.query(`select jsonb_agg(jsonb_build_object(
					 'eventId',delivery.event_id,'sessionId',delivery.session_id,'phase',delivery.phase,'textSha256',delivery.text_sha256,
					 'eventRunId',event.execution_id)) from public.qorpera_agent_sends delivery
					 join public.qorpera_session_events event on event.event_id=delivery.event_id
					 where delivery.run_id='${pins.runId}' and delivery.phase='final';`),
		);
		assert.equal(publicDelivery?.length, 1, "Exactly one authoritative public final delivery required");
		assert.equal(publicDelivery[0].sessionId, pins.sessionId);
		assert.equal(publicDelivery[0].eventRunId, pins.runId);
		assert.equal(
			publicDelivery[0].textSha256,
			hash("Isolated founding runtime boundary completed with this company's shared vision."),
		);
		assert.equal(observations.filter((value) => value.kind === "scripted_model_completion").length, 1);
		await backend.stop(runner, "idle", signal);
		runner = undefined;
		maintenanceStop.abort();
		await maintenance;
		if (maintenanceFailure) throw maintenanceFailure;
		assert.equal(
			(await client.inspectHostInventory(signal)).instances.length,
			0,
			"Exact paid guest must be physically deleted",
		);
		const permitId = await platform.cluster.query(
			`select ctx.permit_id from public.qorpera_runtime_computer_contexts ctx where ctx.context->>'runId'='${pins.runId}';`,
		);
		const accounting = await readWorkloadUsage(platform.cluster.query, permitId);
		const physicalSamples = calls.flatMap(({ args }) =>
			args.p_request.sample
				? [args.p_request.sample]
				: args.p_request.entries.map((frame) => JSON.parse(frame.entryText).sample),
		);
		const first = physicalSamples.find((value) => value.state === "running");
		assert(first);
		const reconciliation = verifyWorkloadUsage(accounting, {
			kind: "agent_sandbox",
			shape: { cpuMillis: policy.cpuMillis, memoryBytes: policy.memoryBytes },
			shapeProvenance: { nodeId, policySha256, providerKind: "native", providerId: config.adapterId },
			physicalId: first.physicalId,
			hostBootId: first.hostBootId,
			guestBootId: first.guestBootId,
			physicalSamples,
			firstPayerByReservation: Object.fromEntries(
				accounting.reservations.map((row) => [row.id, pins.sponsoredByUserId]),
			),
		});
		return {
			schema: "qorpera.founding-native-joined/v1",
			pins,
			dispatch,
			terminal,
			publicDelivery,
			reconciliation,
			observations,
			networkProof,
			boundary:
				"Actual member-created run, real published company bytes, native KVM provider/guard/paid ledger. Synthetic external model OAuth and scripted offline model response; no paid model request or production rollout.",
			imageFingerprint: host.imageFingerprint,
			guestPackageSha256: host.guestPackageSha256,
			capsule: { id: sealed.capsuleId, bytes: sealed.bytes, sha256: sealed.sha256 },
			accounting,
		};
	};
	try {
		const browser = await prepareFoundingNativeBrowser({
			platform,
			bootstrap,
			modelAccountSetup: accounts.setup,
			afterMaterialized,
			payment,
		});
		owned.push(browser);
		return { ...browser, close };
	} catch (error) {
		try {
			await close();
		} catch (cleanupError) {
			cleanupError.retainPrivateState = true;
			throw cleanupError;
		}
		if (error.retainPrivateState === true) await platform.cluster.close({ keepFiles: true });
		throw error;
	}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	const options = foundingNativeJoinedOptions(process.argv.slice(2));
	const host = await readFoundingNativeHost(options.host);
	const payment = await readFoundingNativePayment(options);
	await runFoundingNative({ binDirectory: host.binDirectory, tools: host.tools, out: host.out }, (platform) =>
		prepareFoundingNativeScenario(platform, host, payment),
	);
}
