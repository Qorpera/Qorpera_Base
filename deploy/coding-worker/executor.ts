import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { type CloudCodingRepository, parseCloudCodingRepository } from "../../packages/contracts/src/cloud-coding.ts";
import { cloudCodingSessionLayout } from "../../packages/contracts/src/cloud-coding-session.ts";
import { parseCloudCodingNasPolicy } from "../../packages/contracts/src/cloud-coding-storage.ts";
import { CloudCodingExecutor } from "../../packages/runner-orchestrator/src/coding-executor.ts";
import { LxdCodingExecutorHost, type LxdCodingExecutorHostOptions } from "../../packages/runner-orchestrator/src/coding-executor-host.ts";
import { createCodingNasStorage } from "../../packages/runner-orchestrator/src/coding-storage.ts";
import { lxdCodingMachinePlan } from "../../packages/runner-orchestrator/src/coding-machine.ts";
import { LxdUnixClient } from "../../packages/runner-orchestrator/src/lxd-client.ts";
import { HttpCloudCodingCommandService } from "../../packages/runtime/src/cloud-coding-command-http.ts";
import { codingErrorCode } from "../../packages/runtime/src/cloud-coding-error-code.ts";
import { parseCodingGuestConfiguration } from "../../packages/runtime/src/cloud-coding-guest-configuration.ts";
import { authorizeCodingCommand } from "./command-authority.ts";
import { CodingCommandRouter, type CodingCommandPeer } from "./command-routing.ts";
import { CodingExecutorHttpControl } from "./control.ts";
import { readCodingServiceCredential } from "./credentials.ts";
import { BrokerRepositoryCredentials, REPOSITORY_TOKEN } from "./repository-credentials.ts";

interface Config {
	schema: "qorpera.coding-executor-service/v6";
	owner: string;
	supabaseUrl: string;
	commandPort: number;
	peerCommandPort: number;
	commandPeers: CodingCommandPeer[];
	vmPolicy: LxdCodingExecutorHostOptions["vmPolicy"];
	storagePolicy: LxdCodingExecutorHostOptions["storagePolicy"];
	guest: LxdCodingExecutorHostOptions["guest"];
	/** The company secret brokers' shared origin and the systemd credential
	 * holding the executor's own broker token (never the runtime token guests
	 * hold). Required unless every repository names a static credential. */
	broker: { origin: string; executorTokenCredential: string } | null;
	/** `credential` null: the company's GitHub connection through its broker
	 * (the product path). A named credential: a static token file for that
	 * repository, proof-only plumbing that bypasses the company connection. */
	repositories: { repository: CloudCodingRepository; credential: string | null }[];
}
const RESERVED_CREDENTIALS = new Set(["qorpera-coding-executor-config", "qorpera-coding-registry", "qorpera-coding-command", "qorpera-coding-peer-command"]);
const CONFIG_KEYS = "commandPeers,commandPort,guest,owner,peerCommandPort,repositories,schema,storagePolicy,supabaseUrl,vmPolicy";
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CODING_EXECUTOR_CONFIG_INVALID");
	return value as Record<string, unknown>;
}
function origin(value: unknown): string {
	if (typeof value !== "string") throw new Error("CODING_EXECUTOR_CONFIG_INVALID");
	const url = new URL(value);
	if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("CODING_EXECUTOR_CONFIG_INVALID");
	return url.origin;
}
function broker(value: unknown): Config["broker"] {
	if (value === undefined) return null;
	const input = object(value);
	if (Object.keys(input).sort().join() !== "executorTokenCredential,origin" || typeof input.executorTokenCredential !== "string" ||
		!/^qorpera-coding-[a-z0-9-]{1,80}$/.test(input.executorTokenCredential) || RESERVED_CREDENTIALS.has(input.executorTokenCredential) ||
		input.executorTokenCredential.startsWith("qorpera-coding-repository-")) throw new Error("CODING_EXECUTOR_CONFIG_INVALID");
	return { origin: origin(input.origin), executorTokenCredential: input.executorTokenCredential };
}
/** The reviewed JSON configuration (v6: SQL placement routes commands across
 * per-node executors using a separate, local-only peer listener and credential;
 * one coding machine per member, many
 * sessions per machine; every guest path derives from the session, so the
 * guest section names only the image's own coding user, the per-command
 * resource profile and the helper pins). The executor claims coding sessions
 * for `owner` (qorpera_coding_executors.owner) and serves the command gateway
 * on `commandPort` behind the node's HTTPS reverse proxy. `repositories` is the
 * executor's own allowlist; SQL repository grants stay the authority. */
export function parseCodingExecutorConfiguration(value: unknown): Config {
	const config = object(value);
	const keys = Object.keys(config).sort().join();
	if ((keys !== CONFIG_KEYS && keys !== `broker,${CONFIG_KEYS}`) ||
		config.schema !== "qorpera.coding-executor-service/v6" || typeof config.owner !== "string" || !/^[A-Za-z0-9_.:-]{1,120}$/.test(config.owner) ||
		!Number.isSafeInteger(config.commandPort) || Number(config.commandPort) < 1024 || Number(config.commandPort) > 65535 ||
		!Number.isSafeInteger(config.peerCommandPort) || Number(config.peerCommandPort) < 1024 || Number(config.peerCommandPort) > 65535 || config.peerCommandPort === config.commandPort ||
		!Array.isArray(config.commandPeers) || config.commandPeers.length > 100 ||
		!Array.isArray(config.repositories) || config.repositories.length < 1 || config.repositories.length > 100) throw new Error("CODING_EXECUTOR_CONFIG_INVALID");
	const brokerConfig = broker(config.broker);
	const commandPeers = config.commandPeers.map((value): CodingCommandPeer => {
		const entry = object(value);
		if (Object.keys(entry).sort().join() !== "origin,owner,providerId,tokenCredential" ||
			typeof entry.owner !== "string" || !/^[A-Za-z0-9_.:-]{1,120}$/.test(entry.owner) || entry.owner === config.owner ||
			typeof entry.providerId !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(entry.providerId) ||
			typeof entry.tokenCredential !== "string" || !/^qorpera-coding-peer-[a-z0-9-]{1,60}$/.test(entry.tokenCredential) ||
			RESERVED_CREDENTIALS.has(entry.tokenCredential) || entry.tokenCredential === brokerConfig?.executorTokenCredential)
			throw new Error("CODING_EXECUTOR_CONFIG_INVALID");
		return { owner: entry.owner, providerId: entry.providerId, origin: origin(entry.origin), tokenCredential: entry.tokenCredential };
	});
	if (new Set(commandPeers.map((entry) => entry.owner)).size !== commandPeers.length ||
		new Set(commandPeers.map((entry) => entry.origin)).size !== commandPeers.length ||
		new Set(commandPeers.map((entry) => entry.tokenCredential)).size !== commandPeers.length)
		throw new Error("CODING_EXECUTOR_CONFIG_INVALID");
	const repositories = config.repositories.map((value) => {
		const entry = object(value);
		const entryKeys = Object.keys(entry).sort().join();
		if (entryKeys === "repository") return { repository: parseCloudCodingRepository(entry.repository), credential: null };
		if (entryKeys !== "credential,repository" || typeof entry.credential !== "string" ||
			!/^qorpera-coding-repository-[a-z0-9-]{1,60}$/.test(entry.credential)) throw new Error("CODING_EXECUTOR_CONFIG_INVALID");
		return { repository: parseCloudCodingRepository(entry.repository), credential: entry.credential };
	});
	if (new Set(repositories.map((r) => JSON.stringify(r.repository))).size !== repositories.length ||
		(!brokerConfig && repositories.some((r) => r.credential === null))) throw new Error("CODING_EXECUTOR_CONFIG_INVALID");
	const storagePolicy = parseCloudCodingNasPolicy(config.storagePolicy);
	const vmPolicy = object(config.vmPolicy);
	if (Object.keys(vmPolicy).sort().join() !== "bootstrapSha256,cpus,imageFingerprint,memoryBytes,network,project,providerId,providerPolicySha256,rootDiskBytes,storagePool") throw new Error("CODING_EXECUTOR_CONFIG_INVALID");
	const id = "11111111-1111-4111-8111-111111111111";
	lxdCodingMachinePlan({ ...vmPolicy, schema: "qorpera.lxd-coding-machine/v1", machineId: id, companyId: id, environmentId: id, memberUserId: id } as Parameters<typeof lxdCodingMachinePlan>[0]);
	const guest = object(config.guest);
	if (Object.keys(guest).sort().join() !== "commandHelperSha256,gid,gitHelperSha256,resourceProfile,storageHelperSha256,uid,watchdogHelperSha256" ||
		![guest.commandHelperSha256, guest.gitHelperSha256, guest.watchdogHelperSha256, guest.storageHelperSha256].every((v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v))) throw new Error("CODING_EXECUTOR_CONFIG_INVALID");
	const layout = cloudCodingSessionLayout(id);
	const parsedGuest = parseCodingGuestConfiguration({ schema: "qorpera.coding-command-guest/v3", workerId: id, vmId: id, bootId: id,
		uid: guest.uid, gid: guest.gid, workspacePath: layout.workspacePath, homePath: layout.homePath, cachePath: layout.cachePath,
		outputRoot: layout.outputRoot, resourceProfile: guest.resourceProfile });
	if (parsedGuest.uid >= 200000 || parsedGuest.gid >= 200000 || parsedGuest.resourceProfile.memoryBytes > Number(vmPolicy.memoryBytes) ||
		parsedGuest.resourceProfile.cpuQuotaPercent > Number(vmPolicy.cpus) * 100)
		throw new Error("CODING_EXECUTOR_RESOURCE_POLICY_INVALID");
	return {
		schema: "qorpera.coding-executor-service/v6", owner: config.owner, supabaseUrl: origin(config.supabaseUrl),
		commandPort: Number(config.commandPort), peerCommandPort: Number(config.peerCommandPort), commandPeers, storagePolicy, vmPolicy: vmPolicy as unknown as Config["vmPolicy"],
		guest: guest as unknown as Config["guest"], broker: brokerConfig, repositories,
	};
}

/** A loggable code for an executor error: fixed identifiers only (they carry
 * no credential or repository content), else UNCLASSIFIED. The guest's
 * refusal line uses the same rule. */
export function errorCode(error: unknown): string {
	return codingErrorCode(error);
}

/** Independent Linux service: the identity host runs the model turn, this
 * service runs the repository VM, the command gateway and the Git broker. No
 * member client participates in this loop. */
export async function runCodingExecutorMain(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
	if (process.platform !== "linux" || !process.getuid?.() || !process.geteuid?.()) throw new Error("UNPRIVILEGED_LINUX_REQUIRED");
	if (!environment.CREDENTIALS_DIRECTORY) throw new Error("CODING_CREDENTIALS_REQUIRED");
	const directory = environment.CREDENTIALS_DIRECTORY;
	const credential = (name: string) => readCodingServiceCredential(directory, name);
	const config = parseCodingExecutorConfiguration(JSON.parse(await credential("qorpera-coding-executor-config")));
	const machine = (await readFile("/etc/machine-id", "utf8")).trim();
	if (!/^[0-9a-f]{32}$/.test(machine)) throw new Error("CODING_NODE_IDENTITY_INVALID");
	const control = new CodingExecutorHttpControl({ supabaseUrl: config.supabaseUrl, serviceRoleKey: await credential("qorpera-coding-registry") });
	const brokered = config.broker ? new BrokerRepositoryCredentials({ origin: config.broker.origin,
		executorToken: await credential(config.broker.executorTokenCredential), executorOwner: config.owner }) : null;
	const journalRoot = await createCodingNasStorage(config.storagePolicy).prepareControl();
	const host = new LxdCodingExecutorHost({
		control, owner: config.owner, machineIdSha256: createHash("sha256").update(machine).digest("hex"),
		vmPolicy: config.vmPolicy, storagePolicy: config.storagePolicy, client: new LxdUnixClient(), guest: config.guest, journalRoot,
		repositoryCredentials: {
			async withRepositoryToken(scope, repository, use, signal) {
				signal.throwIfAborted();
				const entry = config.repositories.find((r) => JSON.stringify(r.repository) === JSON.stringify(repository));
				if (!entry) throw new Error("CODING_REPOSITORY_CREDENTIAL_UNAVAILABLE");
				// The product path: the company's GitHub connection, released by the
				// company's broker for this leased session only. A broker refusal is
				// final; it never falls back to a static file.
				if (entry.credential === null) {
					if (!brokered) throw new Error("CODING_REPOSITORY_CREDENTIAL_UNAVAILABLE");
					return brokered.withRepositoryToken(scope, repository, use, signal);
				}
				// Proof-only: a static token file explicitly configured for this repository.
				const token = await credential(entry.credential);
				if (!REPOSITORY_TOKEN.test(token)) throw new Error("CODING_REPOSITORY_CREDENTIAL_INVALID");
				signal.throwIfAborted();
				return use(token);
			},
		},
	});
	const stop = new AbortController();
	const shutdown = () => stop.abort(new Error("CODING_EXECUTOR_SHUTDOWN"));
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
	const router = new CodingCommandRouter({
		owner: config.owner, providerId: config.vmPolicy.providerId, peers: config.commandPeers, control, credential,
		async executeLocal(request, signal) {
			const transport = await host.commandTransport(request.scope, async (action, scope, commandId, inputSha256, checked) => {
				if (action !== request.action || JSON.stringify(scope) !== JSON.stringify(request.scope) || commandId !== request.input.commandId ||
					(request.action === "start" && inputSha256 !== request.input.inputSha256)) throw new Error("CODING_COMMAND_REQUEST_CHANGED");
				await authorizeCodingCommand(control, request, checked);
			}, signal);
			return request.action === "start" ? transport.start(request.scope, request.input, signal) :
				request.action === "read" ? transport.read(request.scope, request.input, signal) : transport.cancel(request.scope, request.input.commandId, signal);
		},
	});
	const commandToken = await credential("qorpera-coding-command");
	const peerToken = await credential("qorpera-coding-peer-command");
	if (commandToken === peerToken) throw new Error("CODING_COMMAND_CREDENTIALS_NOT_SEPARATE");
	for (const peer of config.commandPeers) {
		const remoteToken = await credential(peer.tokenCredential);
		if (remoteToken === commandToken || remoteToken === peerToken) throw new Error("CODING_COMMAND_CREDENTIALS_NOT_SEPARATE");
	}
	const commands = new HttpCloudCodingCommandService({
		token: commandToken, port: config.commandPort,
		authorize: (request, signal) => authorizeCodingCommand(control, request, signal),
		execute: (request, signal) => router.execute(request, signal),
	});
	const peerCommands = new HttpCloudCodingCommandService({
		token: peerToken, port: config.peerCommandPort,
		authorize: (request, signal) => authorizeCodingCommand(control, request, signal),
		execute: (request, signal) => router.execute(request, signal, true),
	});
	let executor: CloudCodingExecutor | undefined;
	try {
		await commands.start(stop.signal);
		await peerCommands.start(stop.signal);
		const running = new CloudCodingExecutor({
			control,
			host,
			owner: config.owner,
			report: (stage, error) => console.error(JSON.stringify({ event: "coding-turn-error", stage, code: errorCode(error) })),
		});
		executor = running;
		// Every claimable turn runs at once; the member machines and the node's
		// capacity are the only bound.
		const claiming = (async () => {
			while (!stop.signal.aborted) {
				let claimed = false;
				try {
					const result = await running.claim(stop.signal);
					claimed = result.state === "claimed";
					if (result.state === "claimed")
						void result.turn.then((status) => console.log(JSON.stringify({ event: "coding-turn", status })));
				} catch {
					if (!stop.signal.aborted) console.error("CODING_EXECUTOR_TICK_UNCONFIRMED");
				}
				if (!claimed) await setTimeout(2000, undefined, { signal: stop.signal }).catch(() => undefined);
			}
		})();
		// Housekeeping (sleep, removal, release) runs beside claiming, at start and
		// every 30 s after a pass: a long pass never holds up a turn. Every step is
		// logged; a failed one as coding-machine-error, and recorded on the machine.
		const housekeeping = (async () => {
			while (!stop.signal.aborted) {
				try {
					for (const outcome of await running.housekeep(stop.signal))
						if (outcome.state === "failed") console.error(JSON.stringify({ event: "coding-machine-error", ...outcome }));
						else console.log(JSON.stringify({ event: "coding-machine", ...outcome }));
				} catch (error) {
					if (!stop.signal.aborted) console.error(JSON.stringify({ event: "coding-machine-error", code: errorCode(error) }));
				}
				await setTimeout(30_000, undefined, { signal: stop.signal }).catch(() => undefined);
			}
		})();
		await Promise.all([claiming, housekeeping]);
	} finally {
		stop.abort();
		await executor?.drain();
		await commands.close();
		await peerCommands.close();
		process.off("SIGTERM", shutdown);
		process.off("SIGINT", shutdown);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	runCodingExecutorMain().catch(() => { console.error("CODING_EXECUTOR_START_FAILED"); process.exitCode = 1; });
}
