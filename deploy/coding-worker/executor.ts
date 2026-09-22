import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { type CloudCodingRepository, parseCloudCodingRepository } from "../../packages/contracts/src/cloud-coding.ts";
import { createCloudCodingStorageBinding, parseCloudCodingNasPolicy } from "../../packages/contracts/src/cloud-coding-storage.ts";
import { CloudCodingExecutor } from "../../packages/runner-orchestrator/src/coding-executor.ts";
import { LxdCodingExecutorHost, type LxdCodingExecutorHostOptions } from "../../packages/runner-orchestrator/src/coding-executor-host.ts";
import { createCodingNasStorage } from "../../packages/runner-orchestrator/src/coding-storage.ts";
import { lxdCodingVmPlan } from "../../packages/runner-orchestrator/src/coding-vm.ts";
import { LxdUnixClient } from "../../packages/runner-orchestrator/src/lxd-client.ts";
import { HttpCloudCodingCommandService } from "../../packages/runtime/src/cloud-coding-command-http.ts";
import { parseCodingGuestConfiguration } from "../../packages/runtime/src/cloud-coding-guest-configuration.ts";
import { authorizeCodingCommand } from "./command-authority.ts";
import { CodingExecutorHttpControl } from "./control.ts";
import { readCodingServiceCredential } from "./credentials.ts";

interface Config {
	schema: "qorpera.coding-executor-service/v3";
	owner: string;
	supabaseUrl: string;
	commandPort: number;
	vmPolicy: LxdCodingExecutorHostOptions["vmPolicy"];
	storagePolicy: LxdCodingExecutorHostOptions["storagePolicy"];
	guest: LxdCodingExecutorHostOptions["guest"];
	repositories: { repository: CloudCodingRepository; credential: string }[];
}
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
/** The reviewed JSON configuration (v3: sessions executor). The executor claims
 * coding sessions for `owner` (qorpera_coding_executors.owner) and serves the
 * command gateway on `commandPort` behind the node's HTTPS reverse proxy. */
export function parseCodingExecutorConfiguration(value: unknown): Config {
	const config = object(value);
	if (Object.keys(config).sort().join() !== "commandPort,guest,owner,repositories,schema,storagePolicy,supabaseUrl,vmPolicy" ||
		config.schema !== "qorpera.coding-executor-service/v3" || typeof config.owner !== "string" || !/^[A-Za-z0-9_.:-]{1,120}$/.test(config.owner) ||
		!Number.isSafeInteger(config.commandPort) || Number(config.commandPort) < 1024 || Number(config.commandPort) > 65535 ||
		!Array.isArray(config.repositories) || config.repositories.length < 1 || config.repositories.length > 100) throw new Error("CODING_EXECUTOR_CONFIG_INVALID");
	const repositories = config.repositories.map((value) => {
		const entry = object(value);
		if (Object.keys(entry).sort().join() !== "credential,repository" || typeof entry.credential !== "string" ||
			!/^qorpera-coding-repository-[a-z0-9-]{1,60}$/.test(entry.credential)) throw new Error("CODING_EXECUTOR_CONFIG_INVALID");
		return { repository: parseCloudCodingRepository(entry.repository), credential: entry.credential };
	});
	if (new Set(repositories.map((r) => JSON.stringify(r.repository))).size !== repositories.length) throw new Error("CODING_EXECUTOR_CONFIG_INVALID");
	const storagePolicy = parseCloudCodingNasPolicy(config.storagePolicy);
	const vmPolicy = object(config.vmPolicy);
	if (Object.keys(vmPolicy).sort().join() !== "bootstrapSha256,cpus,imageFingerprint,memoryBytes,network,project,providerId,providerPolicySha256,rootDiskBytes,storagePool") throw new Error("CODING_EXECUTOR_CONFIG_INVALID");
	const id = "11111111-1111-4111-8111-111111111111";
	lxdCodingVmPlan({ ...vmPolicy, schema: "qorpera.lxd-coding-vm/v2", storage: createCloudCodingStorageBinding(storagePolicy, { workerId: id, companyId: id, environmentId: id, machineIdSha256: "0".repeat(64), writerGeneration: 1 }), workerId: id, allocationId: id, companyId: id, environmentId: id, repository: repositories[0].repository } as Parameters<typeof lxdCodingVmPlan>[0]);
	const guest = object(config.guest);
	if (Object.keys(guest).sort().join() !== "cachePath,commandHelperSha256,gid,gitHelperSha256,homePath,outputRoot,resourceProfile,storageHelperSha256,uid,watchdogHelperSha256,workspacePath" ||
		![guest.commandHelperSha256, guest.gitHelperSha256, guest.watchdogHelperSha256, guest.storageHelperSha256].every((v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v))) throw new Error("CODING_EXECUTOR_CONFIG_INVALID");
	const parsedGuest = parseCodingGuestConfiguration({ schema: "qorpera.coding-command-guest/v2", workerId: id, vmId: id, bootId: id,
		uid: guest.uid, gid: guest.gid, workspacePath: guest.workspacePath, homePath: guest.homePath, cachePath: guest.cachePath,
		outputRoot: guest.outputRoot, resourceProfile: guest.resourceProfile });
	if (parsedGuest.workspacePath !== "/workspace/repository" || parsedGuest.homePath !== "/workspace/home" ||
		parsedGuest.cachePath !== "/workspace/cache" || parsedGuest.outputRoot !== "/var/lib/qorpera-coding/logs" ||
		parsedGuest.resourceProfile.memoryBytes > Number(vmPolicy.memoryBytes) || parsedGuest.resourceProfile.cpuQuotaPercent > Number(vmPolicy.cpus) * 100)
		throw new Error("CODING_EXECUTOR_RESOURCE_POLICY_INVALID");
	return {
		schema: "qorpera.coding-executor-service/v3", owner: config.owner, supabaseUrl: origin(config.supabaseUrl),
		commandPort: Number(config.commandPort), storagePolicy, vmPolicy: vmPolicy as unknown as Config["vmPolicy"],
		guest: guest as unknown as Config["guest"], repositories,
	};
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
	const journalRoot = await createCodingNasStorage(config.storagePolicy).prepareControl();
	const host = new LxdCodingExecutorHost({
		control, owner: config.owner, machineIdSha256: createHash("sha256").update(machine).digest("hex"),
		vmPolicy: config.vmPolicy, storagePolicy: config.storagePolicy, client: new LxdUnixClient(), guest: config.guest, journalRoot,
		repositoryCredentials: {
			async withRepositoryToken(repository, use, signal) {
				signal.throwIfAborted();
				const entry = config.repositories.find((r) => JSON.stringify(r.repository) === JSON.stringify(repository));
				if (!entry) throw new Error("CODING_REPOSITORY_CREDENTIAL_UNAVAILABLE");
				const token = await credential(entry.credential);
				if (!/^[A-Za-z0-9_]{20,512}$/.test(token)) throw new Error("CODING_REPOSITORY_CREDENTIAL_INVALID");
				signal.throwIfAborted();
				return use(token);
			},
		},
	});
	const stop = new AbortController();
	const shutdown = () => stop.abort();
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
	const commands = new HttpCloudCodingCommandService({
		token: await credential("qorpera-coding-command"), port: config.commandPort,
		authorize: (request, signal) => authorizeCodingCommand(control, request, signal),
		async execute(request, signal) {
			const transport = await host.commandTransport(request.scope, async (action, scope, commandId, inputSha256, checked) => {
				if (action !== request.action || JSON.stringify(scope) !== JSON.stringify(request.scope) || commandId !== request.input.commandId ||
					(request.action === "start" && inputSha256 !== request.input.inputSha256)) throw new Error("CODING_COMMAND_REQUEST_CHANGED");
				await authorizeCodingCommand(control, request, checked);
			}, signal);
			return request.action === "start" ? transport.start(request.scope, request.input, signal) :
				request.action === "read" ? transport.read(request.scope, request.input, signal) : transport.cancel(request.scope, request.input.commandId, signal);
		},
	});
	try {
		await commands.start(stop.signal);
		const executor = new CloudCodingExecutor({ control, host, owner: config.owner });
		while (!stop.signal.aborted) {
			try {
				const status = await executor.runOnce(stop.signal);
				if (status !== "idle") console.log(JSON.stringify({ event: "coding-turn", status }));
			} catch {
				if (!stop.signal.aborted) console.error("CODING_EXECUTOR_TICK_UNCONFIRMED");
			}
			await setTimeout(2000, undefined, { signal: stop.signal }).catch(() => undefined);
		}
	} finally {
		stop.abort();
		await commands.close();
		process.off("SIGTERM", shutdown);
		process.off("SIGINT", shutdown);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	runCodingExecutorMain().catch(() => { console.error("CODING_EXECUTOR_START_FAILED"); process.exitCode = 1; });
}
