// P3's coding executor, inside the proof's throwaway node (test/prove-coding-session-vm.sh). It is
// runCodingExecutorMain (../executor.ts) with the same configuration, credentials, host, router, command service and
// loops, and two stand-ins, because the node has no network card:
//   - control: the executor's RPCs go to the proof's driver over stdio, which runs each one as service_role on the
//     test database (a PostgREST call: one transaction, 55P03 is busy);
//   - the agent plug: no agent exit here (it would have no network to give); the machine's card goes on a bare
//     qagent0 bridge with the MAC the plug tool gives the first machine address;
//   - longer waits for a machine's guest to come up and for a session's mount (see the host's options below).
// The driver also reaches the command service through stdio ("http" lines), as the runtime's gateway would through
// the node's proxy. Protocol lines on stdout start with "P3 "; every log line goes to stderr.
// Start it with `node -e 'import("/opt/p3/p3-executor.mjs")'`: the bundle holds executor.ts, whose own main runs
// when argv[1] is the bundle.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { setTimeout } from "node:timers/promises";
import { CODING_EXECUTOR_RPCS, CloudCodingExecutor, CodingControlBusy } from "../../../packages/runner-orchestrator/src/coding-executor.ts";
import { CODING_HOST_RPCS, LxdCodingExecutorHost } from "../../../packages/runner-orchestrator/src/coding-executor-host.ts";
import { createCodingNasStorage } from "../../../packages/runner-orchestrator/src/coding-storage.ts";
import { LxdUnixClient } from "../../../packages/runner-orchestrator/src/lxd-client.ts";
import { HttpCloudCodingCommandService } from "../../../packages/runtime/src/cloud-coding-command-http.ts";
import { authorizeCodingCommand, proveNativeBinding } from "../command-authority.ts";
import { CodingCommandRouter } from "../command-routing.ts";
import { readCodingServiceCredential } from "../credentials.ts";
import { errorCode, parseCodingExecutorConfiguration } from "../executor.ts";
import { REPOSITORY_TOKEN } from "../repository-credentials.ts";

const METHODS = new Set<string>([...CODING_EXECUTOR_RPCS, ...CODING_HOST_RPCS, "qorpera_authorize_coding_command",
	"qorpera_route_coding_command", "qorpera_native_binding_proven"]);
const log = (value: Record<string, unknown>) => process.stderr.write(`${JSON.stringify(value)}\n`);
console.log = console.error;
const send = (value: Record<string, unknown>) => process.stdout.write(`P3 ${JSON.stringify(value)}\n`);
/** The codes along an error's causes: what failed under a fixed outer code. */
function causes(error: unknown): string[] {
	const codes: string[] = [];
	for (let at = error; at instanceof Error && codes.length < 6; at = at.cause) codes.push(at.message.slice(0, 200));
	return codes;
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void };
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
			this.#pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
			send({ t: "rpc", id, method, args });
		});
	}
	answer(message: Record<string, unknown>): void {
		const pending = this.#pending.get(Number(message.id));
		if (!pending) return;
		if (message.ok === true) pending.resolve(message.result ?? null);
		else pending.reject(message.sqlState === "55P03" ? new CodingControlBusy() : new Error("CODING_CONTROL_UNCONFIRMED"));
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
	const journalRoot = await createCodingNasStorage(config.storagePolicy).prepareControl();
	const host = new LxdCodingExecutorHost({
		control, owner: config.owner, machineIdSha256: createHash("sha256").update(machine).digest("hex"),
		vmPolicy: config.vmPolicy, storagePolicy: config.storagePolicy, client: new LxdUnixClient(), guest: config.guest, journalRoot,
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
		await Promise.all([claiming, keeping, housekeeping]);
	} finally {
		stop.abort();
		await executor?.drain();
		for (const outcome of await host.settled())
			log({ event: outcome.state === "failed" ? "coding-session-error" : "coding-session", ...outcome });
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
