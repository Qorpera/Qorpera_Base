import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
	CODE_HOST_INSTANCE,
	CODE_HOST_PROJECT_CONFIG,
	type CodeHostEvent,
	type CodeHostPolicy,
	codeHostInstanceMatches,
	codeHostProject,
	LxdCodeHosts,
} from "../../../packages/runner-orchestrator/src/code-host.ts";
import { type LxdHostInventory, LxdUnixClient } from "../../../packages/runner-orchestrator/src/lxd-client.ts";
import {
	type RuntimeNodeInventoryEntry,
	reconcileRuntimeNodeInventory,
} from "../../../packages/runner-orchestrator/src/runtime-node-inventory.ts";

// The code host image's proof on a test machine (5e): the coding executor's code hosts (code-host.ts), made from the
// image just built, on the test machine's own LXD, and the node observer's view of them (runtime-node-inventory.ts).
// test/prove-code-host-image.sh runs it as root, with the three companies' projects absent, and deletes whatever is
// left of them after it; it never calls the database. Only there:
//   node prove-code-host.ts <image-fingerprint> <storage-pool> <company A> <company B> <company C>
// with QORPERA_PROOF_GIT and QORPERA_PROOF_FOLDER_SHA256 for the checks inside a code host (prove-in-code-host.sh).
// Prints PASS lines and the executor's events, then CODE HOSTS PASSED.

const GiB = 1024 ** 3;
const SOCKET = "/var/snap/lxd/common/lxd/unix.socket";
const STOPPED = 102,
	RUNNING = 103;
const HERE = dirname(fileURLToPath(import.meta.url));

function check(ok: unknown, what: string, seen?: unknown): void {
	if (!ok) throw new Error(`FAIL: ${what}${seen === undefined ? "" : `: ${JSON.stringify(seen)}`}`);
	console.log(`PASS: ${what}`);
}

async function refused(promise: Promise<unknown>, code: string, what: string): Promise<void> {
	const error = await promise.then(
		() => undefined,
		(error: unknown) => error,
	);
	check(error instanceof Error && error.message === code, what, error instanceof Error ? error.message : error);
}

function lxc(project: string, ...args: string[]) {
	return spawnSync("lxc", ["--project", project, ...args], { input: "", encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}
function inside(project: string, ...command: string[]): string {
	const result = lxc(project, "exec", CODE_HOST_INSTANCE, "--", ...command);
	if (result.status !== 0) throw new Error(`${command.join(" ")} in ${project}: ${result.stderr || result.error}`);
	return result.stdout.trim();
}

async function main(args: string[]): Promise<void> {
	const [imageFingerprint, storagePool, ...companies] = args;
	const git = process.env.QORPERA_PROOF_GIT,
		folder = process.env.QORPERA_PROOF_FOLDER_SHA256;
	if (args.length !== 5 || !git || !folder)
		throw new Error("usage: prove-code-host.ts <image-fingerprint> <storage-pool> <company A> <company B> <company C>");
	const [A, B, C] = companies;
	const projects = companies.map(codeHostProject);
	const [PA, PB, PC] = projects;
	const signal = AbortSignal.timeout(60 * 60_000);
	const socket = realpathSync(SOCKET);
	const client = new LxdUnixClient(socket, 300);
	const policy: CodeHostPolicy = {
		imageFingerprint,
		storagePool,
		cpus: 1,
		memoryBytes: GiB,
		rootDiskBytes: 12 * GiB,
		running: 1,
	};
	// A cut that changes the limits.
	const wider: CodeHostPolicy = { ...policy, cpus: 2 };

	// The executor's events since `mark`, in a fixed order.
	const events: string[] = [];
	let mark = 0;
	const log = (event: CodeHostEvent) => {
		const error = "error" in event && event.error !== undefined;
		const why = error ? ` ${event.error instanceof Error ? event.error.message : String(event.error)}` : "";
		events.push(`${event.event} ${event.step} ${event.project}${why}`);
		console.log(`event: ${events.at(-1)}`);
	};
	const since = (...expected: string[]) => isDeepStrictEqual(events.slice(mark).sort(), expected.sort());
	const executor = (p: CodeHostPolicy) => new LxdCodeHosts({ client, policy: p, agentWaitMs: 300_000, log });

	// The node observer's entries for the proof's projects, with a node policy that has these code hosts (or none).
	// Other runs come and go on the test machine: a listing that changed while it was read is read again.
	const nodeId = randomUUID();
	const observe = async (...codeHosts: (CodeHostPolicy | undefined)[]) => {
		let found: LxdHostInventory | undefined;
		for (let attempt = 1; !found; attempt += 1) {
			try {
				found = await client.inspectHostInventory(signal);
			} catch (error) {
				if (attempt === 20 || signal.aborted) throw error;
				await delay(2000, undefined, { signal });
			}
		}
		const { server } = found;
		const instances = found.instances.filter((i) => projects.includes(i.project));
		const host = {
			machineIdSha256: createHash("sha256").update(readFileSync("/etc/machine-id")).digest("hex"),
			socketPath: socket,
			socketGid: statSync(socket).gid,
			certificateSha256: server.certificateSha256,
			serverName: server.serverName,
			serverVersion: server.serverVersion,
			architecture: server.architecture as "x86_64",
		};
		const brief = (e: RuntimeNodeInventoryEntry) => `${e.category} ${e.state} ${e.reason ?? "accepted"}`;
		return codeHosts.map((hosts) => {
			const { entries } = reconcileRuntimeNodeInventory(
				{ server, instances },
				{
					policy: {
						schema: "qorpera.runtime-node-inventory-policy/v1",
						nodeId,
						host,
						operatingCpuMillis: 1000,
						operatingMemoryBytes: GiB,
						infrastructure: [],
						...(hosts ? { codeHosts: hosts } : {}),
					},
					nodeVersion: 1,
					contextSha256: "0".repeat(64),
					headroomCpuMillis: 0,
					headroomMemoryBytes: 0,
					allocations: [],
				},
			);
			return Object.fromEntries(entries.map((e) => [e.project, brief(e)]));
		});
	};

	for (const project of projects) check(!(await client.getProject(project, signal)), `no ${project} before the proof`);

	// --- A's first job makes its project and code host, and the code host is what the image promises -----------------
	const first = executor(policy);
	let machineA = "";
	let began = Date.now();
	await first.use(A, signal, async (lease) => {
		console.log(`A's code host answered ${Math.round((Date.now() - began) / 1000)} s after its first job asked`);
		check(isDeepStrictEqual(lease, { companyId: A, project: PA, name: CODE_HOST_INSTANCE }), "the lease is A's");
		check(since(`code-host project-made ${PA}`), "A's first job made its project", events);
		const project = await client.getProject(PA, signal);
		check(isDeepStrictEqual(project?.config, CODE_HOST_PROJECT_CONFIG), "A's project has the code host settings", project);
		const instance = await client.getInstance(PA, CODE_HOST_INSTANCE, signal);
		check(
			instance?.statusCode === RUNNING &&
				codeHostInstanceMatches(policy, PA, instance) &&
				Object.keys(instance.expandedDevices).join() === "root",
			"A's code host runs, exactly as the policy makes it: no NIC, no profile, only its root disk",
			instance,
		);
		const script = join(HERE, "prove-in-code-host.sh");
		const push = lxc(PA, "file", "push", "--uid", "0", "--gid", "0", "--mode", "0500", script, "code-host/root/");
		if (push.status !== 0) throw new Error(`file push: ${push.stderr}`);
		const proof = lxc(PA, "exec", CODE_HOST_INSTANCE, "--", "env", `QORPERA_PROOF_GIT=${git}`,
			`QORPERA_PROOF_FOLDER_SHA256=${folder}`, `QORPERA_PROOF_CPUS=${policy.cpus}`,
			`QORPERA_PROOF_DISK_BYTES=${policy.rootDiskBytes}`, "bash", "/root/prove-in-code-host.sh");
		process.stdout.write(proof.stdout);
		process.stderr.write(proof.stderr);
		check(proof.status === 0 && proof.stdout.endsWith("ALL PASSED\n"), "the checks inside A's code host passed");
		machineA = inside(PA, "cat", "/etc/machine-id");
		const [accepted, otherLimits, none] = await observe(policy, wider, undefined);
		check(isDeepStrictEqual(accepted, { [PA]: "code-host running accepted" }), "the node observer accepts it", accepted);
		const unregistered = { [PA]: "unmanaged running UNREGISTERED_INSTANCE" };
		check(isDeepStrictEqual(otherLimits, unregistered), "under other limits it is unregistered", otherLimits);
		check(isDeepStrictEqual(none, unregistered), "and on a node whose policy has no code hosts", none);
		await refused(first.remove(A, signal), "CODE_HOST_BUSY", "A's code host is not removed while its job runs");
	});

	// --- B's first job: one code host runs at a time, so A's idle one stops first -------------------------------------
	mark = events.length;
	await first.use(B, signal, async () => {
		check(since(`code-host project-made ${PB}`, `code-host stopped ${PA}`), "B's job stopped A's idle code host", events);
		const machineB = inside(PB, "cat", "/etc/machine-id");
		check(
			/^[0-9a-f]{32}$/.test(machineA) && /^[0-9a-f]{32}$/.test(machineB) && machineA !== machineB,
			"each code host has its own machine id",
			[machineA, machineB],
		);
		check(inside(PB, "ls", "/sys/class/net") === "lo", "B's code host has only the loopback link");
		const [seen] = await observe(policy);
		const both = { [PA]: "code-host suspended accepted", [PB]: "code-host running accepted" };
		check(isDeepStrictEqual(seen, both), "the observer accepts both, A stopped and B running", seen);
	});
	mark = events.length;
	await first.close();
	check(since(`code-host stopped ${PB}`), "the executor's end stopped B's code host", events);
	check((await client.getInstance(PB, CODE_HOST_INSTANCE, signal))?.statusCode === STOPPED, "B's code host is stopped");
	await refused(first.use(A, signal, async () => undefined), "CODE_HOSTS_CLOSED", "a closed executor starts no job");

	// --- A cut changes the limits: the next executor makes A's code host again -----------------------------------------
	const second = executor(wider);
	mark = events.length;
	began = Date.now();
	await second.use(A, signal, async () => {
		console.log(`A's new code host answered ${Math.round((Date.now() - began) / 1000)} s after the job asked`);
		check(since(`code-host replaced ${PA}`), "A's code host from the old policy was replaced", events);
		const instance = await client.getInstance(PA, CODE_HOST_INSTANCE, signal);
		check(
			instance?.config["limits.cpu"] === "2" && codeHostInstanceMatches(wider, PA, instance),
			"A's new code host has the new limits",
			instance?.config,
		);
		check(inside(PA, "nproc") === "2", "and two processors inside");
		const machine = inside(PA, "cat", "/etc/machine-id");
		check(/^[0-9a-f]{32}$/.test(machine) && machine !== machineA, "a new code host, with a new machine id");
		const [seen] = await observe(wider);
		const cut = { [PA]: "code-host running accepted", [PB]: "unmanaged suspended UNREGISTERED_INSTANCE" };
		check(isDeepStrictEqual(seen, cut), "under the new policy, B's old code host is unregistered", seen);
	});

	// --- C's project was changed by hand: the executor never touches it ------------------------------------------------
	await client.createProject(PC, { ...CODE_HOST_PROJECT_CONFIG, "limits.instances": "2" }, signal);
	const changed = (await client.getProject(PC, signal))?.config;

	// --- The next executor's start: housekeeping ---------------------------------------------------------------------
	const third = executor(wider);
	mark = events.length;
	const stopped = await third.housekeep(signal);
	check(stopped === 1, "housekeeping stopped the one code host still running (A's)", stopped);
	check(
		since(
			`code-host stopped ${PA}`,
			`code-host outdated ${PB}`,
			`code-host-error refused ${PC}`,
			`code-host-error housekeep ${PC} CODE_HOST_PROJECT_DIFFERS`,
		),
		"it deleted B's outdated code host and refused C's project",
		events,
	);
	check((await client.getInstance(PA, CODE_HOST_INSTANCE, signal))?.statusCode === STOPPED, "A's code host is kept");
	check(
		!(await client.getInstance(PB, CODE_HOST_INSTANCE, signal)) && (await client.getProject(PB, signal)),
		"B's code host is gone, its project kept",
	);
	const [after] = await observe(wider);
	check(isDeepStrictEqual(after, { [PA]: "code-host suspended accepted" }), "the observer accepts what is left", after);
	mark = events.length;
	await second.close();
	check(since(), "the previous executor's end had nothing left to stop", events);

	await refused(
		third.use(C, signal, async () => {
			throw new Error("C's job ran");
		}),
		"CODE_HOST_PROJECT_DIFFERS",
		"a job for C is refused",
	);
	check(
		!(await client.getInstance(PC, CODE_HOST_INSTANCE, signal)) &&
			isDeepStrictEqual((await client.getProject(PC, signal))?.config, changed),
		"C's project is as it was, with no code host",
	);

	// --- The companies' deletion -------------------------------------------------------------------------------------
	mark = events.length;
	check((await third.remove(A, signal)) && !(await client.getProject(PA, signal)), "removing A deleted its code host and project");
	check((await third.remove(B, signal)) && !(await client.getProject(PB, signal)), "removing B deleted its empty project");
	await refused(third.remove(C, signal), "CODE_HOST_PROJECT_DIFFERS", "C's refused project is not removed");
	check((await third.remove(A, signal)) === false, "removing A again finds nothing");
	check(
		since(`code-host removed ${PA}`, `code-host removed ${PB}`, `code-host-error refused ${PC}`),
		"the removals' events",
		events,
	);
	await third.close();
	await client.deleteProject(PC, signal);
	for (const project of projects) check(!(await client.getProject(project, signal)), `no ${project} after the proof`);
	console.log("CODE HOSTS PASSED");
}

main(process.argv.slice(2)).then(
	() => process.exit(0),
	(error: unknown) => {
		console.error(error);
		process.exit(1);
	},
);
