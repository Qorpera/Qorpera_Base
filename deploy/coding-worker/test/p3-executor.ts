// P3's coding executor, inside the proof's throwaway node (test/prove-coding-session-vm.sh). It is
// runCodingExecutorMain (../executor.ts) with the same configuration, credentials, host (on the folder model when the
// configuration has `folder`, with its start and mount lines, and the company's code host for its repositories when it
// has `codeHost` as well), router, command service and loops, and two stand-ins, because the node has no network card:
//   - control: the executor's RPCs go to the proof's driver over stdio, which runs each one as service_role on the
//     test database (a PostgREST call: one transaction, 55P03 is busy);
//   - the agent plug: no agent exit here (it would have no network to give); the machine's card goes on a bare
//     qagent0 bridge with the MAC the plug tool gives the first machine address;
//   - longer waits for a machine's guest to come up and for a session's mount (see the host's options below).
// The driver also reaches the command service through stdio ("http" lines), as the runtime's gateway would through
// the node's proxy, and asks what a company's code area holds ("inspect" lines: a code host job of its own, as a
// session's attach runs one). Protocol lines on stdout start with "P3 "; every log line goes to stderr.
// Start it with `node -e 'import("/opt/p3/p3-executor.mjs")'`: the bundle holds executor.ts, whose own main runs
// when argv[1] is the bundle.
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { posix } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout } from "node:timers/promises";
import { LxdCodeHosts } from "../../../packages/runner-orchestrator/src/code-host.ts";
import { inspectCodeArea } from "../../../packages/runner-orchestrator/src/code-host-jobs.ts";
import { CodeHostRepositories } from "../../../packages/runner-orchestrator/src/code-host-repositories.ts";
import { CODE_HOST_RPCS, CodeHostJobs } from "../../../packages/runner-orchestrator/src/code-host-views.ts";
import { CODING_EXECUTOR_RPCS, CloudCodingExecutor, CodingControlBusy, CodingControlRefused } from "../../../packages/runner-orchestrator/src/coding-executor.ts";
import { CODING_HOST_RPCS, LxdCodingExecutorHost, type LxdCodingExecutorHostOptions } from "../../../packages/runner-orchestrator/src/coding-executor-host.ts";
import { CODING_FOLDER_CONTROL_SOCKET, CodingFolderControl } from "../../../packages/runner-orchestrator/src/coding-folder-control.ts";
import { CodingFolderViews } from "../../../packages/runner-orchestrator/src/coding-folder-views.ts";
import { createCodingNasStorage } from "../../../packages/runner-orchestrator/src/coding-storage.ts";
import { LxdUnixClient } from "../../../packages/runner-orchestrator/src/lxd-client.ts";
import { HttpCloudCodingCommandService } from "../../../packages/runtime/src/cloud-coding-command-http.ts";
import { authorizeCodingCommand, proveNativeBinding } from "../command-authority.ts";
import { CodingCommandRouter } from "../command-routing.ts";
import { readCodingServiceCredential } from "../credentials.ts";
import { errorCode, logCodeHost, parseCodingExecutorConfiguration } from "../executor.ts";
import { REPOSITORY_TOKEN } from "../repository-credentials.ts";

const METHODS = new Set<string>([...CODING_EXECUTOR_RPCS, ...CODING_HOST_RPCS, ...CODE_HOST_RPCS, "qorpera_authorize_coding_command",
	"qorpera_route_coding_command", "qorpera_native_binding_proven"]);
/** The core's refusals of a coding session's folder view that the control keeps (deploy/coding-worker/control.ts). */
const VIEW_REFUSALS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["qorpera_folder_view_open", new Set(["Folder core authority is required", "Company folder is unavailable",
		"Folder view is invalid", "Folder view opener is invalid", "Folder view anchor is invalid",
		"Folder view attachment is not current", "Folder view principals are unavailable"])],
	["qorpera_folder_view_close", new Set(["Folder core authority is required", "Folder view is unavailable"])],
]);
const log = (value: Record<string, unknown>) => process.stderr.write(`${JSON.stringify(value)}\n`);
console.log = console.error;
const send = (value: Record<string, unknown>) => process.stdout.write(`P3 ${JSON.stringify(value)}\n`);
/** The codes along an error's causes: what failed under a fixed outer code. */
function causes(error: unknown): string[] {
	const codes: string[] = [];
	// A git failure's message is git's stderr, whose own error comes last (after any hints).
	for (let at = error; at instanceof Error && codes.length < 6; at = at.cause)
		codes.push(at.message.length > 1600 ? `${at.message.slice(0, 200)} … ${at.message.slice(-1400)}` : at.message);
	return codes;
}

/** The file's bytes, refused unless they are the pinned ones (as executor.ts reads them). */
async function readPinned(file: { path: string; sha256: string }): Promise<Buffer> {
	const bytes = await readFile(file.path);
	if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error("CODING_EXECUTOR_FOLDER_PROGRAM_CHANGED");
	return bytes;
}

/** A socket in front of the folder service's control socket that logs each boundary's answer whole: CodingFolderControl
 * keeps of a view's report only how many paths are unsaved, and a held boundary needs each path's outcome and reason. */
async function boundaryWitness(target: string): Promise<string> {
	const path = posix.join(await mkdtemp(posix.join(tmpdir(), "p3-folder-control-")), "control.sock");
	const server = createServer({ allowHalfOpen: true }, (client) => {
		const upstream = connect({ path: target, allowHalfOpen: true });
		const asked: Buffer[] = [];
		const answered: Buffer[] = [];
		client.on("data", (chunk: Buffer) => asked.push(chunk));
		upstream.on("data", (chunk: Buffer) => answered.push(chunk));
		client.on("error", () => upstream.destroy());
		upstream.on("error", () => client.destroy());
		upstream.on("end", () => {
			const request = Buffer.concat(asked).toString("utf8");
			if (!/"op":"boundary"/.test(request)) return;
			const answer = Buffer.concat(answered).toString("utf8").trim();
			console.log(JSON.stringify({ event: "coding-folder-boundary-answer", request: request.trim(), answer: answer.slice(0, 30_000),
				...(answer.length > 30_000 ? { cut: answer.length } : {}) }));
		});
		client.pipe(upstream);
		upstream.pipe(client);
	});
	await new Promise<void>((resolve, reject) => server.once("error", reject).listen(path, () => resolve()));
	// The executor ends when its work does (nothing closes this socket): run 9 hung 15 min on it after its FAIL.
	server.unref();
	return path;
}

type Pending = { method: string; resolve(value: unknown): void; reject(error: Error): void };
class DriverControl {
	#next = 0;
	readonly #pending = new Map<number, Pending>();
	call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
		if (!METHODS.has(method)) return Promise.reject(new Error("CODING_CONTROL_METHOD_INVALID"));
		if (Buffer.byteLength(JSON.stringify(args)) > 128 * 1024) return Promise.reject(new Error("CODING_CONTROL_REQUEST_TOO_LARGE"));
		const id = ++this.#next;
		const checked = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
		return new Promise((resolve, reject) => {
			const abort = () => {
				this.#pending.delete(id);
				reject(new Error("CODING_CONTROL_UNCONFIRMED"));
			};
			if (checked.aborted) return abort();
			checked.addEventListener("abort", abort, { once: true });
			const settle = <T>(use: (value: T) => void) => (value: T) => {
				checked.removeEventListener("abort", abort);
				this.#pending.delete(id);
				use(value);
			};
			this.#pending.set(id, { method, resolve: settle(resolve), reject: settle(reject) });
			send({ t: "rpc", id, method, args });
		});
	}
	answer(message: Record<string, unknown>): void {
		const pending = this.#pending.get(Number(message.id));
		if (!pending) return;
		if (message.ok === true) return pending.resolve(message.result ?? null);
		// As deploy/coding-worker/control.ts: a busy row, or a folder view's refusal in the core's own words.
		const refused = VIEW_REFUSALS.get(pending.method);
		pending.reject(message.sqlState === "55P03" ? new CodingControlBusy() :
			refused && ["42501", "22023"].includes(String(message.sqlState)) && refused.has(String(message.message))
				? new CodingControlRefused(String(message.message)) : new Error("CODING_CONTROL_UNCONFIRMED"));
	}
}

async function main(): Promise<void> {
	if (process.platform !== "linux" || !process.getuid?.() || !process.geteuid?.()) throw new Error("UNPRIVILEGED_LINUX_REQUIRED");
	const directory = process.env.CREDENTIALS_DIRECTORY;
	if (!directory) throw new Error("CODING_CREDENTIALS_REQUIRED");
	const credential = (name: string) => readCodingServiceCredential(directory, name);
	const config = parseCodingExecutorConfiguration(JSON.parse(await credential("qorpera-coding-executor-config")));
	const machine = (await readFile("/etc/machine-id", "utf8")).trim();
	if (!/^[0-9a-f]{32}$/.test(machine)) throw new Error("CODING_NODE_IDENTITY_INVALID");
	const control = new DriverControl();
	const stop = new AbortController();
	const lines = createInterface({ input: process.stdin });
	const storage = createCodingNasStorage(config.storagePolicy);
	const journalRoot = await storage.prepareControl();
	const lxd = new LxdUnixClient();
	// The code host is three levels deep too, on one CPU: its agent took about 2 minutes in phase B's run 2 and more
	// than production's 2-minute wait in run 3.
	const codeHosts = config.codeHost
		? new LxdCodeHosts({ client: new LxdUnixClient(), policy: config.codeHost, log: logCodeHost, agentWaitMs: 600_000 })
		: undefined;
	const codeHostJobs = codeHosts ? new CodeHostJobs({ hosts: codeHosts, client: lxd, control, log: logCodeHost }) : undefined;
	let folder: LxdCodingExecutorHostOptions["folder"];
	if (config.folder) {
		const agent = await readPinned(config.folder.agent), program = await readPinned(config.folder.program);
		const folderControl = new CodingFolderControl(config.folder.controlSocket ? { path: config.folder.controlSocket } : {});
		// The views it holds are recorded beside its journals, on the NAS: a restarted executor still ends them.
		const records = { root: posix.join(journalRoot, "folder-views"), assert: (signal: AbortSignal) => storage.assertControl(signal) };
		// Each boundary's answer goes to the log, so a CODING_FOLDER_BOUNDARY_HELD shows which view held and why: whole
		// from the witness socket, and as the host reads it.
		const witnessed = new CodingFolderControl({ path: await boundaryWitness(config.folder.controlSocket ?? CODING_FOLDER_CONTROL_SOCKET) });
		const boundaries: Pick<CodingFolderControl, "boundary" | "restarted"> = {
			restarted: (machine, signal) => witnessed.restarted(machine, signal),
			async boundary(machine, final, signal) {
				try {
					const answer = await witnessed.boundary(machine, final, signal);
					console.log(JSON.stringify({ event: "coding-folder-boundary", final, ...answer }));
					return answer;
				} catch (error) {
					console.log(JSON.stringify({ event: "coding-folder-boundary-failed", machine, final, error: causes(error) }));
					throw error;
				}
			},
		};
		folder = {
			views: new CodingFolderViews({ control, folder: folderControl, client: lxd, agent, program, records }), control: boundaries, client: lxd,
			...(codeHostJobs ? { repositories: new CodeHostRepositories(codeHostJobs) } : {}),
			onMount: (mount) => console.log(JSON.stringify({ event: "coding-folder-mount", ...mount })),
		};
		console.log(JSON.stringify({ event: "coding-executor-folder", agentSha256: config.folder.agent.sha256, programSha256: config.folder.program.sha256,
			repositories: codeHostJobs ? "code-host" : "none" }));
	}
	const host = new LxdCodingExecutorHost({
		control, owner: config.owner, machineIdSha256: createHash("sha256").update(machine).digest("hex"),
		vmPolicy: config.vmPolicy, storagePolicy: config.storagePolicy, client: lxd, guest: config.guest, journalRoot, ...(folder ? { folder } : {}),
		agentPlug: async () => "0e:51:0a:d2:01:0a",
		// A coding machine here is three levels deep (test machine, node, machine): its agent took 4 minutes and
		// its systemd 6 in the first run, against production's one level.
		guestReadyTimeoutMs: 900_000,
		attachTimeoutMs: 180_000,
		repositoryCredentials: {
			async withRepositoryToken(_scope, repository, use, signal) {
				signal.throwIfAborted();
				const entry = config.repositories.find((r) => JSON.stringify(r.repository) === JSON.stringify(repository));
				if (!entry?.credential) throw new Error("CODING_REPOSITORY_CREDENTIAL_UNAVAILABLE");
				const token = await credential(entry.credential);
				if (!REPOSITORY_TOKEN.test(token)) throw new Error("CODING_REPOSITORY_CREDENTIAL_INVALID");
				signal.throwIfAborted();
				return use(token);
			},
		},
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
	const commands = new HttpCloudCodingCommandService({
		token: await credential("qorpera-coding-command"), port: config.commandPort,
		proveBinding: (binding, holder, signal) => proveNativeBinding(control, binding, holder, signal),
		authorize: (request, signal) => authorizeCodingCommand(control, request, signal),
		execute: (request, signal) => router.execute(request, signal),
	});
	lines.on("line", (line) => {
		let message: Record<string, unknown>;
		try {
			message = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return log({ event: "p3-bad-line" });
		}
		if (message.t === "rpc") control.answer(message);
		else if (message.t === "stop") stop.abort(new Error("CODING_EXECUTOR_SHUTDOWN"));
		else if (message.t === "inspect")
			void (async () => {
				try {
					if (!codeHostJobs) throw new Error("P3_NO_CODE_HOST");
					const value = { repository: message.repository, commit: message.commit } as Parameters<typeof inspectCodeArea>[1];
					const state = await codeHostJobs.run(String(message.companyId), String(message.environmentId), stop.signal,
						(job) => inspectCodeArea(job, value));
					send({ t: "inspect", id: message.id, ok: true, state });
				} catch (error) {
					send({ t: "inspect", id: message.id, ok: false, error: causes(error) });
				}
			})();
		else if (message.t === "http")
			void (async () => {
				try {
					const response = await fetch(`http://127.0.0.1:${config.commandPort}${String(message.path)}`, {
						method: "POST", redirect: "error", headers: message.headers as Record<string, string>, body: String(message.body),
						signal: AbortSignal.timeout(60000),
					});
					send({ t: "http", id: message.id, status: response.status, body: await response.text() });
				} catch (error) {
					send({ t: "http", id: message.id, status: 0, body: "", error: causes(error) });
				}
			})();
	});
	lines.on("close", () => stop.abort(new Error("CODING_EXECUTOR_SHUTDOWN")));
	let executor: CloudCodingExecutor | undefined;
	try {
		await commands.start(stop.signal);
		const running = new CloudCodingExecutor({
			control, host, owner: config.owner,
			report: (stage, error) => log({ event: "coding-turn-error", stage, code: errorCode(error), causes: causes(error) }),
		});
		executor = running;
		send({ t: "ready" });
		const claiming = (async () => {
			while (!stop.signal.aborted) {
				let claimed = false;
				try {
					const result = await running.claim(stop.signal);
					claimed = result.state === "claimed";
					if (result.state === "claimed") {
						send({ t: "claimed" });
						void result.turn.then((status) => {
							log({ event: "coding-turn", status });
							send({ t: "turn", status });
						});
					}
				} catch (error) {
					if (!stop.signal.aborted) log({ event: "coding-tick-unconfirmed", causes: causes(error) });
				}
				if (!claimed) await setTimeout(2000, undefined, { signal: stop.signal }).catch(() => undefined);
			}
		})();
		const keeping = (async () => {
			while (!stop.signal.aborted) {
				const started = performance.now();
				try {
					for (const outcome of await running.keep(stop.signal))
						if (outcome.state === "failed") log({ event: "coding-session-error", ...outcome });
						else if (outcome.step === "detach" || outcome.state === "not-now") log({ event: "coding-session", ...outcome });
				} catch (error) {
					if (!stop.signal.aborted) log({ event: "coding-session-error", code: errorCode(error), causes: causes(error) });
				}
				await setTimeout(Math.max(0, 10_000 - (performance.now() - started)), undefined, { signal: stop.signal }).catch(() => undefined);
			}
		})();
		const housekeeping = (async () => {
			while (!stop.signal.aborted) {
				try {
					for (const outcome of await running.housekeep(stop.signal))
						log({ event: outcome.state === "failed" ? "coding-machine-error" : "coding-machine", ...outcome });
				} catch (error) {
					if (!stop.signal.aborted) log({ event: "coding-machine-error", code: errorCode(error), causes: causes(error) });
				}
				await setTimeout(30_000, undefined, { signal: stop.signal }).catch(() => undefined);
			}
		})();
		const hosting = (async () => {
			if (!codeHosts) return;
			try {
				log({ event: "code-host", step: "housekept", stopped: await codeHosts.housekeep(stop.signal) });
			} catch (error) {
				if (!stop.signal.aborted) log({ event: "code-host-error", step: "housekeep", code: errorCode(error), causes: causes(error) });
			}
		})();
		await Promise.all([claiming, keeping, housekeeping, hosting]);
	} finally {
		stop.abort();
		await executor?.drain();
		for (const outcome of await host.settled())
			log({ event: outcome.state === "failed" ? "coding-session-error" : "coding-session", ...outcome });
		await codeHosts?.close();
		await commands.close();
		lines.close();
	}
}

main().then(() => send({ t: "exit", ok: true }), (error) => {
	log({ event: "p3-executor-failed", causes: causes(error) });
	send({ t: "exit", ok: false, causes: causes(error) });
	// stdin's reader keeps the process up when main fails before its own finally.
	process.stdout.write("", () => process.exit(1));
});
