import { randomUUID } from "node:crypto";
import type { CloudCodingNasPolicy } from "../../packages/contracts/src/cloud-coding-storage.ts";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { lxdCompanyMachinePlan, parseCompanyMachinePolicy } from "../../packages/runner-orchestrator/src/company-machine.ts";
import { type CompanyMachineEntry, LxdCompanyMachineHost } from "../../packages/runner-orchestrator/src/company-machine-host.ts";
import { LxdUnixClient } from "../../packages/runner-orchestrator/src/lxd-client.ts";

// The physical proof of company machines on one node, before any SQL is live:
// the real executor workload (journaled LXD lifecycle, guest helper, lease,
// commands, stop and delete) against the node's LXD, with a small in-memory
// stand-in for the kernel's custody RPCs. It never calls the database.
//
// Run as the coding executor's account (LXD socket, NAS control directory):
//   node prove-machine-node.mjs <proof.json>
// proof.json: { policy, helperSha256, storagePolicy, journalRoot, cpus, memoryGiB, diskGiB,
//               repositoryBundle?: "/path/qorpera.tar.gz", blockedTargets?: ["host:port", ...] }
// blockedTargets must stay out of reach: a TCP connect to each must time out (the ACL drops
// it), where an open port would connect and a closed one refuse. A timeout proves a drop only
// where something would otherwise answer: pick targets that answer or refuse from the node
// (cloud metadata on bare metal times out with or without the ACL). The default is node 2's
// NAS, router, Tailscale, cloud metadata and the bridge gateway's SSH.
// The machine is an unregistered instance while it exists: the node's
// observer reports the node unavailable for the few minutes the proof runs.
// Run it in an agreed quiet window.

const run = promisify(execFile);
interface Proof {
	policy: unknown;
	helperSha256: string;
	storagePolicy: CloudCodingNasPolicy;
	journalRoot: string;
	cpus: number;
	memoryGiB: number;
	diskGiB: number;
	repositoryBundle?: string;
	blockedTargets?: string[];
}

async function main(path: string): Promise<void> {
	const proof = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown> & Proof;
	const policy = parseCompanyMachinePolicy(proof.policy);
	const machineId = randomUUID(),
		placementId = randomUUID(),
		companyId = "00000000-0000-4000-8000-00000000c0de";
	const binding = {
		schema: "qorpera.lxd-company-machine/v1" as const,
		machineId,
		placementId,
		companyId,
		environmentId: companyId,
		...policy,
		cpus: proof.cpus,
		memoryBytes: proof.memoryGiB * 1024 ** 3,
		rootDiskBytes: proof.diskGiB * 1024 ** 3,
		repositoryWorkerId: null,
	};
	const plan = lxdCompanyMachinePlan(binding);
	const entry: CompanyMachineEntry = {
		machineId,
		placementId,
		retired: false,
		binding,
		bindingText: plan.text,
		instanceSha256: plan.instanceSha256,
		desiredState: "running",
		lifetime: "task",
		reserved: true,
		asleepSince: null,
		removing: false,
		released: false,
		runningAt: null,
		bootId: null,
		commands: [],
		sleepDue: false,
		stopDue: false,
		removeDue: false,
	};
	const log: unknown[] = [];
	const note = (event: string, detail: Record<string, unknown> = {}) => {
		const line = { at: new Date().toISOString(), event, ...detail };
		log.push(line);
		console.log(JSON.stringify(line));
	};
	// The kernel's side, in memory: custody always granted for this one machine.
	const control = {
		async call(method: string, args: Record<string, unknown>) {
			if (method === "qorpera_admit_executor_machines") return [];
			if (method === "qorpera_list_executor_machines") return [{ schema: "qorpera.company-machine-state/v2", ...entry }];
			if (method === "qorpera_authorize_executor_machine")
				return {
					schema: "qorpera.coding-machine-admission/v1",
					machineId: placementId,
					workerId: null,
					instanceSha256: plan.instanceSha256,
					intent: args.p_intent,
					guestUid: null,
					validForMs: 5000,
					nodeId: randomUUID(),
					nodeVersion: 1,
				};
			if (method === "qorpera_mark_company_machine_running") {
				entry.bootId = String(args.p_boot_id);
				entry.runningAt = new Date().toISOString();
				note("running", { bootId: entry.bootId });
				return { state: "running" };
			}
			if (method === "qorpera_suspend_company_machine") return { state: "suspended" };
			if (method === "qorpera_release_company_machine") return { state: "released" };
			if (method === "qorpera_record_company_machine_commands") {
				for (const ended of args.p_ended as { commandId: string }[])
					entry.commands = entry.commands.filter((id) => id !== ended.commandId);
				note("commands", { ended: args.p_ended, busyCommands: args.p_busy_commands, outsideBusy: args.p_outside_busy });
				return { state: "recorded" };
			}
			if (method === "qorpera_record_company_machine_error") {
				note("error", { stage: args.p_stage, code: args.p_code });
				return null;
			}
			throw new Error(`unexpected ${method}`);
		},
	};
	const host = new LxdCompanyMachineHost({
		control,
		owner: "machine-proof",
		machineIdSha256: "0".repeat(64),
		policy,
		client: new LxdUnixClient(),
		journalRoot: proof.journalRoot,
		storagePolicy: proof.storagePolicy,
		helperSha256: proof.helperSha256,
	});
	const signal = AbortSignal.timeout(3_600_000);
	const started = Date.now();
	for (let pass = 0; entry.runningAt === null; pass++) {
		if (pass > 60) throw new Error("machine did not come up");
		note("pass", { outcomes: await host.pass(signal) });
		if (entry.runningAt === null) await new Promise((done) => setTimeout(done, 2000));
	}
	note("usable", { seconds: (Date.now() - started) / 1000 });
	const command = async (text: string, timeoutMs: number | null = 1_800_000) => {
		const commandId = randomUUID(),
			inputSha256 = randomUUID().replaceAll("-", "").padEnd(64, "0");
		entry.commands.push(commandId);
		await host.command({ machineId, placementId, commandId, inputSha256 }, { action: "start", commandId, inputSha256, command: text, timeoutMs }, signal);
		for (;;) {
			const page = await host.command(
				{ machineId, placementId, commandId, inputSha256 },
				{ action: "read", read: { commandId, tail: true, limit: 16384 } },
				signal,
			);
			if (page.state !== "running" && page.state !== "unconfirmed") {
				note("command", { command: text.slice(0, 120), state: page.state, exitCode: page.exitCode, tail: page.output.slice(-1500) });
				return page;
			}
			await new Promise((done) => setTimeout(done, 3000));
		}
	};
	const expect = (ok: boolean, what: string) => {
		note(ok ? "pass-check" : "FAIL-check", { what });
		if (!ok) process.exitCode = 1;
	};
	expect((await command("nproc && free -g && df -h / && uname -r")).state === "succeeded", "sizes and kernel");
	expect((await command("docker run --rm hello-world && docker compose version")).state === "succeeded", "rootful Docker");
	expect(
		(
			await command(
				"mkdir -p /root/stack && cd /root/stack && printf 'services:\\n  db:\\n    image: postgres:17-alpine\\n    environment:\\n      POSTGRES_PASSWORD: proof\\n    healthcheck:\\n      test: pg_isready -U postgres\\n      interval: 2s\\n      retries: 30\\n' > compose.yaml && docker compose up -d --wait && docker compose exec -T db psql -U postgres -c 'select 1' && docker compose down",
			)
		).state === "succeeded",
		"docker compose stack",
	);
	expect((await command("curl -fsS -o /dev/null -w '%{http_code}' https://github.com")).state === "succeeded", "internet out");
	const blocked = proof.blockedTargets ?? [
		"192.168.1.40:22",
		"192.168.1.40:2049",
		"192.168.1.1:80",
		"100.100.100.100:53",
		"169.254.169.254:80",
		"10.88.0.1:22",
	];
	if (!blocked.every((target) => /^[0-9.]+:[0-9]{1,5}$/.test(target))) throw new Error("invalid blocked target");
	const connect = (target: string) => `timeout 5 bash -c '</dev/tcp/${target.replace(":", "/")}' 2>/dev/null`;
	// The method sees an open port: without this, a broken probe would pass every drop below.
	expect((await command(connect("1.1.1.1:443"))).state === "succeeded", "open port connects: 1.1.1.1:443");
	for (const target of blocked)
		expect((await command(`${connect(target)}; test $? -eq 124`)).state === "succeeded", `dropped: ${target}`);
	note("nested-kvm", {
		result: (await command("ls -l /dev/kvm && grep -cE 'vmx|svm' /proc/cpuinfo", 60000)).state,
	});
	if (proof.repositoryBundle) {
		await run("lxc", ["--project", policy.project, "file", "push", proof.repositoryBundle, `${plan.request.name}/root/qorpera.tar.gz`]);
		expect(
			(
				await command(
					"mkdir -p /root/repo && tar -xzf /root/qorpera.tar.gz -C /root/repo && cd /root/repo && npm ci --ignore-scripts && npm run test:hosted-db",
					null,
				)
			).state === "succeeded",
			"Qorpera SQL suite (npm run test:hosted-db)",
		);
	}
	// A command still running when the machine is deleted stops with it.
	const sleeper = randomUUID();
	await host.command(
		{ machineId, placementId, commandId: sleeper, inputSha256: "f".repeat(64) },
		{ action: "start", commandId: sleeper, inputSha256: "f".repeat(64), command: "sleep 3600", timeoutMs: null },
		signal,
	);
	entry.desiredState = "deleted";
	entry.stopDue = true;
	entry.removeDue = true;
	note("pass", { outcomes: await host.pass(signal) });
	entry.reserved = false;
	entry.stopDue = false;
	note("pass", { outcomes: await host.pass(signal) });
	const left = await run("lxc", ["--project", policy.project, "list", plan.request.name, "--format", "csv", "-c", "n"]);
	expect(left.stdout.trim() === "", "machine deleted");
	note("done", { seconds: (Date.now() - started) / 1000 });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv[2] ?? "").catch((error) => {
		console.error(JSON.stringify({ event: "proof-failed", message: error instanceof Error ? error.message : String(error) }));
		process.exitCode = 1;
	});
}
