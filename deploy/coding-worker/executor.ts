import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { type CloudCodingRepository, parseCloudCodingRepository } from "../../packages/contracts/src/cloud-coding.ts";
import { cloudCodingSessionLayout } from "../../packages/contracts/src/cloud-coding-session.ts";
import { parseCloudCodingNasPolicy } from "../../packages/contracts/src/cloud-coding-storage.ts";
import { CloudCodingExecutor } from "../../packages/runner-orchestrator/src/coding-executor.ts";
import { type CodeHostEvent, type CodeHostPolicy, controlCodeHostDeletions, LxdCodeHosts, parseCodeHostPolicy } from "../../packages/runner-orchestrator/src/code-host.ts";
import { CodeHostRepositories } from "../../packages/runner-orchestrator/src/code-host-repositories.ts";
import { CodeHostJobs, type CodeHostViewEvent } from "../../packages/runner-orchestrator/src/code-host-views.ts";
import { LxdCodingExecutorHost, type LxdCodingExecutorHostOptions } from "../../packages/runner-orchestrator/src/coding-executor-host.ts";
import { CodingFolderControl } from "../../packages/runner-orchestrator/src/coding-folder-control.ts";
import { CodingFolderViews } from "../../packages/runner-orchestrator/src/coding-folder-views.ts";
import { createCodingNasStorage } from "../../packages/runner-orchestrator/src/coding-storage.ts";
import { lxdCodingMachinePlan } from "../../packages/runner-orchestrator/src/coding-machine.ts";
import { UnixFolderControl } from "../../packages/runner-orchestrator/src/folder-control.ts";
import { LxdUnixClient } from "../../packages/runner-orchestrator/src/lxd-client.ts";
import { HttpCloudCodingCommandService } from "../../packages/runtime/src/cloud-coding-command-http.ts";
import { codingErrorCode } from "../../packages/runtime/src/cloud-coding-error-code.ts";
import { parseCodingGuestConfiguration } from "../../packages/runtime/src/cloud-coding-guest-configuration.ts";
import { LxdCompanyMachineHost } from "../../packages/runner-orchestrator/src/company-machine-host.ts";
import { type CompanyMachinePolicy, parseCompanyMachinePolicy } from "../../packages/runner-orchestrator/src/company-machine.ts";
import { authorizeCodingCommand, proveNativeBinding } from "./command-authority.ts";
import { authorizeMachineCommand } from "./machine-command-authority.ts";
import { MachineCommandRouter } from "./machine-command-routing.ts";
import { CodingCommandRouter, type CodingCommandPeer } from "./command-routing.ts";
import { CodingExecutorHttpControl } from "./control.ts";
import { readCodingServiceCredential } from "./credentials.ts";
import { BrokerRepositoryCredentials, REPOSITORY_TOKEN } from "./repository-credentials.ts";

interface Config {
	schema: "qorpera.coding-executor-service/v7";
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
	/** Company machines on this node (2026-09-28): the node policy SQL copies
	 * into every machine placed here, and the pin of the machine guest helper
	 * the reviewed machine image carries (plus the helpers of earlier images
	 * whose machines still run here). Absent: this executor makes no machines,
	 * but still forwards machine commands to its peers. `folder` (F3 6d), only
	 * ever true: each boot gets a company folder view through the node's folder
	 * service, whose control socket fences its commands' windows and output. */
	machines: { policy: CompanyMachinePolicy; helperSha256: string; previousHelperSha256s: string[]; folder: boolean } | null;
	/** The companies' code hosts on this node (F3 step 5e): the same block as
	 * the node inventory policy's `codeHosts`, so the node's observer accepts
	 * exactly the VMs this executor makes. Absent: this executor never makes a
	 * code host project or VM. */
	codeHost: Readonly<CodeHostPolicy> | null;
	/** The folder model for coding sessions (F3 5g-6a): the guest agent and the folder program this executor pushes into
	 * each member machine, as files on this node with their pins, and the folder service's control socket (default
	 * /run/qorpera-folder-control/control.sock). Absent: the NAS model. With `codeHost` as well, each session works in
	 * its own worktree of its company's code area on the code host (5g-6b); without, its commands start at the company
	 * folder and a turn pushes nothing. */
	folder: { agent: PinnedFile; program: PinnedFile; controlSocket: string | null } | null;
}
interface PinnedFile { path: string; sha256: string }
const RESERVED_CREDENTIALS = new Set(["qorpera-coding-executor-config", "qorpera-coding-registry", "qorpera-coding-command", "qorpera-coding-peer-command"]);
const CONFIG_KEYS = "commandPeers,commandPort,guest,owner,peerCommandPort,repositories,schema,storagePolicy,supabaseUrl,vmPolicy";
const OPTIONAL_CONFIG_KEYS = new Set(["broker", "codeHost", "folder", "machines"]);
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
function absolutePath(value: unknown, maxBytes: number): string {
	if (typeof value !== "string" || !value.startsWith("/") || value === "/" || posix.normalize(value) !== value || value.endsWith("/") ||
		Buffer.byteLength(value) > maxBytes || /[\0-\x1f\x7f]/.test(value)) throw new Error("CODING_EXECUTOR_CONFIG_INVALID");
	return value;
}
function pinnedFile(value: unknown): PinnedFile {
	const input = object(value);
	if (Object.keys(input).sort().join() !== "path,sha256" || typeof input.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(input.sha256))
		throw new Error("CODING_EXECUTOR_CONFIG_INVALID");
	return { path: absolutePath(input.path, 4096), sha256: input.sha256 };
}
function folderConfig(value: unknown): Config["folder"] {
	if (value === undefined) return null;
	const input = object(value);
	const keys = Object.keys(input).sort().join();
	if (keys !== "agent,program" && keys !== "agent,controlSocket,program") throw new Error("CODING_EXECUTOR_CONFIG_INVALID");
	const agent = pinnedFile(input.agent), program = pinnedFile(input.program);
	if (agent.path === program.path) throw new Error("CODING_EXECUTOR_CONFIG_INVALID");
	// A Unix socket's path fits in 107 bytes.
	return { agent, program, controlSocket: input.controlSocket === undefined ? null : absolutePath(input.controlSocket, 107) };
}
/** The file's bytes, refused unless they are the pinned ones. */
async function readPinned(file: PinnedFile): Promise<Buffer> {
	const bytes = await readFile(file.path);
	if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error("CODING_EXECUTOR_FOLDER_PROGRAM_CHANGED");
	return bytes;
}
/** The reviewed JSON configuration (v7: SQL placement routes commands across
 * per-node executors using a separate, local-only peer listener and credential;
 * one coding machine per member, many sessions per machine, each attached
 * until it is archived; every guest path derives from the session, so the
 * guest section names only the image's own coding user, the log bound and the
 * helper pins. A command has no time, memory, CPU or task limit of its own). The executor claims coding sessions
 * for `owner` (qorpera_coding_executors.owner) and serves the command gateway
 * on `commandPort` behind the node's HTTPS reverse proxy. `repositories` is the
 * executor's own allowlist; SQL repository grants stay the authority. */
export function parseCodingExecutorConfiguration(value: unknown): Config {
	const config = object(value);
	const keys = Object.keys(config).sort().join();
	const optional = keys.split(",").filter((key) => OPTIONAL_CONFIG_KEYS.has(key));
	if (keys.split(",").filter((key) => !OPTIONAL_CONFIG_KEYS.has(key)).join() !== CONFIG_KEYS ||
		new Set(optional).size !== optional.length ||
		config.schema !== "qorpera.coding-executor-service/v7" || typeof config.owner !== "string" || !/^[A-Za-z0-9_.:-]{1,120}$/.test(config.owner) ||
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
	const parsedGuest = parseCodingGuestConfiguration({ schema: "qorpera.coding-command-guest/v4", workerId: id, vmId: id, bootId: id,
		uid: guest.uid, gid: guest.gid, workspacePath: layout.workspacePath, homePath: layout.homePath, cachePath: layout.cachePath,
		outputRoot: layout.outputRoot, resourceProfile: guest.resourceProfile });
	if (parsedGuest.uid >= 200000 || parsedGuest.gid >= 200000) throw new Error("CODING_EXECUTOR_RESOURCE_POLICY_INVALID");
	let machines: Config["machines"] = null;
	if (config.machines !== undefined) {
		const entry = object(config.machines);
		const keys = Object.keys(entry).filter((key) => key !== "folder").sort().join();
		const previous = entry.previousHelperSha256s ?? [];
		if ((keys !== "helperSha256,policy" && keys !== "helperSha256,policy,previousHelperSha256s") ||
			(entry.folder !== undefined && entry.folder !== true) ||
			typeof entry.helperSha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.helperSha256) || !Array.isArray(previous) ||
			previous.length > 16 || previous.some((sha) => typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)) ||
			new Set([entry.helperSha256, ...previous]).size !== previous.length + 1) throw new Error("CODING_EXECUTOR_CONFIG_INVALID");
		const policy = parseCompanyMachinePolicy(entry.policy);
		// Commands route to this executor by the coding provider's peer identity.
		if (policy.providerId !== vmPolicy.providerId) throw new Error("CODING_EXECUTOR_CONFIG_INVALID");
		machines = { policy, helperSha256: entry.helperSha256, previousHelperSha256s: previous as string[], folder: entry.folder === true };
	}
	let codeHost: Config["codeHost"] = null;
	if (config.codeHost !== undefined) {
		try {
			codeHost = parseCodeHostPolicy(config.codeHost);
		} catch {
			throw new Error("CODING_EXECUTOR_CONFIG_INVALID");
		}
	}
	return {
		schema: "qorpera.coding-executor-service/v7", owner: config.owner, supabaseUrl: origin(config.supabaseUrl),
		commandPort: Number(config.commandPort), peerCommandPort: Number(config.peerCommandPort), commandPeers, storagePolicy, vmPolicy: vmPolicy as unknown as Config["vmPolicy"],
		guest: guest as unknown as Config["guest"], broker: brokerConfig, repositories, machines, codeHost, folder: folderConfig(config.folder),
	};
}

/** A loggable code for an executor error: fixed identifiers only (they carry
 * no credential or repository content), else UNCLASSIFIED. The guest's
 * refusal line uses the same rule. */
export function errorCode(error: unknown): string {
	return codingErrorCode(error);
}

/** A code host's line in the executor's log, for its VM and for its jobs: an error by its code only, never as itself. */
export function logCodeHost(event: CodeHostEvent | CodeHostViewEvent): void {
	if (event.event === "code-host") console.log(JSON.stringify(event));
	else console.error(JSON.stringify({ event: event.event, step: event.step, project: event.project,
		...(event.error === undefined ? {} : { code: errorCode(event.error) }) }));
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
	const storage = createCodingNasStorage(config.storagePolicy);
	const journalRoot = await storage.prepareControl();
	const lxd = new LxdUnixClient();
	const codeHosts = config.codeHost ? new LxdCodeHosts({ client: new LxdUnixClient(), policy: config.codeHost, log: logCodeHost }) : undefined;
	// Each company's code host jobs, one at a time: its sessions' worktrees on the folder model.
	const codeHostJobs = codeHosts ? new CodeHostJobs({ hosts: codeHosts, client: lxd, control, log: logCodeHost }) : undefined;
	let folder: LxdCodingExecutorHostOptions["folder"];
	if (config.folder) {
		const agent = await readPinned(config.folder.agent), program = await readPinned(config.folder.program);
		const folderControl = new CodingFolderControl(config.folder.controlSocket ? { path: config.folder.controlSocket } : {});
		// The views it holds are recorded beside its journals, on the NAS: a restarted executor still ends them.
		const records = { root: posix.join(journalRoot, "folder-views"), assert: (signal: AbortSignal) => storage.assertControl(signal) };
		folder = {
			views: new CodingFolderViews({ control, folder: folderControl, client: lxd, agent, program, records }), control: folderControl, client: lxd,
			...(codeHostJobs ? { repositories: new CodeHostRepositories(codeHostJobs) } : {}),
			onMount: (mount) => console.log(JSON.stringify({ event: "coding-folder-mount", ...mount })),
		};
		// Which model this executor runs, and with what: a proof reads it from the log.
		console.log(JSON.stringify({ event: "coding-executor-folder", agentSha256: config.folder.agent.sha256, programSha256: config.folder.program.sha256,
			repositories: codeHostJobs ? "code-host" : "none" }));
	}
	const host = new LxdCodingExecutorHost({
		control, owner: config.owner, machineIdSha256: createHash("sha256").update(machine).digest("hex"),
		vmPolicy: config.vmPolicy, storagePolicy: config.storagePolicy, client: lxd, guest: config.guest, journalRoot, ...(folder ? { folder } : {}),
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
	const machineHost = config.machines ? new LxdCompanyMachineHost({
		control, owner: config.owner, machineIdSha256: createHash("sha256").update(machine).digest("hex"),
		policy: config.machines.policy, client: new LxdUnixClient(), journalRoot, storagePolicy: config.storagePolicy,
		helperSha256: config.machines.helperSha256, previousHelperSha256s: config.machines.previousHelperSha256s,
		...(config.machines.folder ? { folder: new UnixFolderControl() } : {}),
	}) : undefined;
	const machineRouter = new MachineCommandRouter({
		owner: config.owner, providerId: config.vmPolicy.providerId, peers: config.commandPeers, control, credential,
		...(machineHost ? {
			executeLocal: (request, authority, signal) => machineHost.command(
				{ machineId: authority.machineId, placementId: authority.placementId, commandId: request.input.commandId,
					inputSha256: authority.inputSha256, bootId: authority.bootId, runId: authority.runId,
					staffAgentId: authority.staffAgentId, requestedByUserId: authority.requestedByUserId },
				request.action === "start" ? { action: "start", commandId: request.input.commandId, inputSha256: request.input.inputSha256,
					command: request.input.command, timeoutMs: request.input.timeoutMs }
					: request.action === "read" ? { action: "read", read: request.input } : { action: "cancel", commandId: request.input.commandId },
				signal),
		} : {}),
	});
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
		// G2-6b: a guest's request proves its run's lease before anything else is asked about its binding.
		proveBinding: (binding, holder, signal) => proveNativeBinding(control, binding, holder, signal),
		authorize: (request, signal) => authorizeCodingCommand(control, request, signal),
		execute: (request, signal) => router.execute(request, signal),
		machines: {
			authorize: (request, signal) => authorizeMachineCommand(control, request, signal),
			execute: (request, signal) => machineRouter.execute(request, signal),
		},
	});
	const peerCommands = new HttpCloudCodingCommandService({
		token: peerToken, port: config.peerCommandPort,
		// Only executors hold the peer token, and the forwarding one proved the guest's holder at its own ingress.
		proveBinding: null,
		authorize: (request, signal) => authorizeCodingCommand(control, request, signal),
		execute: (request, signal) => router.execute(request, signal, true),
		machines: {
			authorize: (request, signal) => authorizeMachineCommand(control, request, signal),
			execute: (request, signal) => machineRouter.execute(request, signal, true),
		},
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
		// The keeper renews every attached session (standing by or in a turn) in a
		// pass every 10 s from the start of the last one, each machine within 15 s,
		// so well inside the guest lease's 45 s: a session's commands run as long as
		// this process keeps its attachment, and stop within a minute after it
		// cannot. Released sessions (archived, revoked, lost) are taken off beside
		// the passes.
		const keeping = (async () => {
			while (!stop.signal.aborted) {
				const started = performance.now();
				try {
					for (const outcome of await running.keep(stop.signal))
						if (outcome.state === "failed") console.error(JSON.stringify({ event: "coding-session-error", ...outcome }));
						else if (outcome.step === "detach" || outcome.state === "not-now")
							console.log(JSON.stringify({ event: "coding-session", ...outcome }));
				} catch (error) {
					if (!stop.signal.aborted) console.error(JSON.stringify({ event: "coding-session-error", code: errorCode(error) }));
				}
				await setTimeout(Math.max(0, 10_000 - (performance.now() - started)), undefined, {
					signal: stop.signal,
				}).catch(() => undefined);
			}
		})();
		// Housekeeping (quiet sessions archived, sleep, removal, release) runs beside
		// claiming, at start and every 30 s after a pass: a long pass never holds up
		// a turn. Every step is logged; a failed one as coding-machine-error, and
		// recorded on the machine.
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
		// Company machines: admission, lifecycle, guest leases and command ends,
		// every 10 s after a pass. A failed step is logged and recorded on its machine.
		const machines = (async () => {
			while (machineHost && !stop.signal.aborted) {
				try {
					for (const outcome of await machineHost.pass(stop.signal))
						if (outcome.state === "failed") console.error(JSON.stringify({ event: "company-machine-error", ...outcome }));
						else if ((outcome.state === "done" && outcome.step !== "commands") || (outcome.state === "not-now" && outcome.code) || outcome.folder)
							console.log(JSON.stringify({ event: "company-machine", ...outcome }));
				} catch (error) {
					if (!stop.signal.aborted) console.error(JSON.stringify({ event: "company-machine-error", code: errorCode(error) }));
				}
				await setTimeout(10_000, undefined, { signal: stop.signal }).catch(() => undefined);
			}
		})();
		// Code hosts: once at start, every one an earlier executor left started
		// stops, and one made under another policy goes; each starts again on its
		// company's next job.
		const hosting = (async () => {
			if (!codeHosts) return;
			try {
				console.log(JSON.stringify({ event: "code-host", step: "housekept", stopped: await codeHosts.housekeep(stop.signal) }));
			} catch (error) {
				if (!stop.signal.aborted) console.error(JSON.stringify({ event: "code-host-error", step: "housekeep", code: errorCode(error) }));
			}
		})();
		// Beside it, at start and every minute after a pass, the code hosts of
		// companies being deleted go with their projects; one still in a job, or
		// whose removal failed or ran out of time, goes on a later pass.
		const deletions = (async () => {
			if (!codeHosts) return;
			const deleting = controlCodeHostDeletions({
				control, owner: config.owner, machineIdSha256: createHash("sha256").update(machine).digest("hex"),
			});
			while (!stop.signal.aborted) {
				try {
					await codeHosts.removeDeleting(deleting, stop.signal);
				} catch (error) {
					if (!stop.signal.aborted) console.error(JSON.stringify({ event: "code-host-error", step: "deletions", code: errorCode(error) }));
				}
				await setTimeout(60_000, undefined, { signal: stop.signal }).catch(() => undefined);
			}
		})();
		await Promise.all([claiming, keeping, housekeeping, machines, hosting, deletions]);
	} finally {
		stop.abort();
		await executor?.drain();
		// A take-off the keeper started settles before the process ends.
		for (const outcome of await host.settled())
			console.log(JSON.stringify({ event: outcome.state === "failed" ? "coding-session-error" : "coding-session", ...outcome }));
		// Each code host stops once its jobs end.
		await codeHosts?.close();
		await commands.close();
		await peerCommands.close();
		process.off("SIGTERM", shutdown);
		process.off("SIGINT", shutdown);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	runCodingExecutorMain().catch(() => { console.error("CODING_EXECUTOR_START_FAILED"); process.exitCode = 1; });
}
