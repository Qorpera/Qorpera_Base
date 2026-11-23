import { describe, expect, it, vi } from "vitest";
import { EMPTY_CODING_SETUP, parseCodingSetup } from "../src/coding-setup.ts";
import {
	CODING_SETUP_MAX_TERMINALS,
	type CodingSetupCommandInput,
	type CodingSetupCommandRunner,
	CodingSetupLifecycle,
	CodingSetupLifecycleError,
	resolveCodingSetupEnvironment,
} from "../src/coding-setup-lifecycle.ts";

describe("coding setup lifecycle hooks", () => {
	it("resolves validated non-secret env vars, expands containerEnv references, respects null unsets, and strips protected keys", () => {
		const resolved = resolveCodingSetupEnvironment({
			...EMPTY_CODING_SETUP,
			containerEnv: {
				NODE_ENV: "development",
				APP_PORT: "3000",
				PATH: "/tmp/evil",
				QORPERA_INTERNAL: "no",
				GITHUB_TOKEN: "ghp_123",
				LD_PRELOAD: "/tmp/lib.so",
				GIT_SSH: "/tmp/evil-ssh",
				GIT_PROXY_COMMAND: "/tmp/proxy",
				GIT_CONFIG_COUNT: "1",
				GIT_CONFIG_KEY_0: "core.fsmonitor",
				GIT_CONFIG_VALUE_0: "/tmp/pwn",
				GIT_CONFIG_GLOBAL: "/tmp/gitconfig",
				GIT_EXEC_PATH: "/tmp/git-exec",
				PYTHONSTARTUP: "/tmp/pwn.py",
				PERL5OPT: "-Mevil",
				RUBYOPT: "-revil",
				CUSTOM_TOKEN: "secret",
			},
			remoteEnv: {
				BASE_URL: ["http://localhost:$", "{containerEnv:APP_PORT}"].join(""),
				NODE_ENV: null,
				OPENAI_API_KEY: "sk-secret",
			},
		});

		expect(resolved.env).toEqual({
			APP_PORT: "3000",
			BASE_URL: "http://localhost:3000",
		});
		expect(resolved.skipped).toEqual(
			expect.arrayContaining([
				"PATH",
				"QORPERA_INTERNAL",
				"GITHUB_TOKEN",
				"LD_PRELOAD",
				"GIT_SSH",
				"GIT_PROXY_COMMAND",
				"GIT_CONFIG_COUNT",
				"GIT_CONFIG_KEY_0",
				"GIT_CONFIG_VALUE_0",
				"GIT_CONFIG_GLOBAL",
				"GIT_EXEC_PATH",
				"PYTHONSTARTUP",
				"PERL5OPT",
				"RUBYOPT",
				"CUSTOM_TOKEN",
				"OPENAI_API_KEY",
			]),
		);
	});

	it("runs install once per disk, start once per boot/wake, and re-runs install on a new disk", async () => {
		const parsed = await parseCodingSetup({
			async read(path) {
				if (path === ".qorpera/environment.json") {
					return {
						kind: "file",
						bytes: Buffer.from(
							JSON.stringify({
								install: "npm ci",
								start: "npm run codegen",
								env: { APP_MODE: "dev" },
								terminals: [{ name: "web", command: "npm run dev" }],
							}),
						),
					};
				}
				return { kind: "missing" };
			},
		});
		expect(parsed.refused).toBe(false);

		const ran: CodingSetupCommandInput[] = [];
		const runner: CodingSetupCommandRunner = {
			async exec(input) {
				ran.push(input);
				if (input.argv[2]?.includes("nohup")) {
					return { exitCode: 0, stdout: "4242\n", stderr: "" };
				}
				return { exitCode: 0, stdout: "ok\n", stderr: "" };
			},
		};

		const lifecycle = new CodingSetupLifecycle();
		const baseContext = {
			machineId: "m-1",
			workerId: "w-1",
			diskId: "initial",
			bootId: "boot-1",
			cwd: "/company/code/acme/app/worktrees/w-1",
			setupDigest: parsed.setupDigest,
			setupSpec: parsed.setupSpec,
			runner,
		};

		const first = await lifecycle.onAttach(baseContext, AbortSignal.timeout(5_000));
		expect(first.ranInstall).toBe(true);
		expect(first.ranStart).toBe(true);
		expect(first.env).toEqual({ APP_MODE: "dev" });
		expect(first.startedTerminals).toHaveLength(1);
		expect(first.startedTerminals[0]).toMatchObject({ name: "web", pid: 4242 });

		const second = await lifecycle.onAttach(baseContext, AbortSignal.timeout(5_000));
		expect(second.ranInstall).toBe(false);
		expect(second.ranStart).toBe(false);
		expect(second.startedTerminals).toHaveLength(0);

		lifecycle.onMachineStopped("m-1");
		const afterWake = await lifecycle.onAttach({ ...baseContext, bootId: "boot-2" }, AbortSignal.timeout(5_000));
		expect(afterWake.ranInstall).toBe(false);
		expect(afterWake.ranStart).toBe(true);
		expect(afterWake.startedTerminals).toHaveLength(1);

		lifecycle.onMachineNewDisk("m-1");
		const afterNewDisk = await lifecycle.onAttach(
			{ ...baseContext, diskId: "rebuild-1", bootId: "boot-3" },
			AbortSignal.timeout(5_000),
		);
		expect(afterNewDisk.ranInstall).toBe(true);
		expect(afterNewDisk.ranStart).toBe(true);

		const freshSessionLifecycle = new CodingSetupLifecycle();
		const onFreshWorktree = await freshSessionLifecycle.onAttach(baseContext, AbortSignal.timeout(5_000));
		expect(onFreshWorktree.ranInstall).toBe(true);
		expect(onFreshWorktree.ranStart).toBe(true);
	});

	it("bounds terminals to max limit, tracks PIDs, and stops them cleanly on detach", async () => {
		const commands: string[] = [];
		let pidCounter = 5000;
		const runner: CodingSetupCommandRunner = {
			async exec(input) {
				commands.push(input.argv[2] ?? "");
				if (input.argv[2]?.includes("nohup")) {
					return { exitCode: 0, stdout: `${++pidCounter}\n`, stderr: "" };
				}
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		};
		const terminals = [
			Array.from({ length: 12 }, (_, idx) => ({
				name: `srv-${idx}`,
				command: `node server-${idx}.js`,
				description: null,
			})),
		];
		const lifecycle = new CodingSetupLifecycle();
		const res = await lifecycle.onAttach(
			{
				machineId: "m-2",
				workerId: "w-2",
				diskId: "initial",
				bootId: "boot-1",
				cwd: "/work",
				setupDigest: "1".repeat(64),
				setupSpec: { ...EMPTY_CODING_SETUP, terminals },
				runner,
			},
			AbortSignal.timeout(5_000),
		);
		expect(res.startedTerminals).toHaveLength(CODING_SETUP_MAX_TERMINALS);
		expect(lifecycle.trackedTerminals("m-2", "w-2")).toHaveLength(CODING_SETUP_MAX_TERMINALS);

		await lifecycle.onDetach("m-2", "w-2");
		expect(lifecycle.trackedTerminals("m-2", "w-2")).toHaveLength(0);
		expect(commands.at(-1)).toContain(
			"kill -TERM -5001 5001 -5002 5002 -5003 5003 -5004 5004 -5005 5005 -5006 5006 -5007 5007 -5008 5008",
		);
	});

	it("prepares repositoryDependencies and reports structured CodingSetupLifecycleError on hook failure", async () => {
		const prepared: string[] = [];
		const runner: CodingSetupCommandRunner = {
			async exec() {
				return { exitCode: 2, stdout: "out", stderr: "missing tool" };
			},
		};
		const lifecycle = new CodingSetupLifecycle();
		await expect(
			lifecycle.onAttach(
				{
					machineId: "m-3",
					workerId: "w-3",
					diskId: "initial",
					bootId: "boot-1",
					cwd: "/work",
					setupDigest: "2".repeat(64),
					setupSpec: {
						...EMPTY_CODING_SETUP,
						repositoryDependencies: ["acme/shared"],
						install: [{ from: "install", commands: [{ name: "deps", run: { shell: "pnpm i" } }] }],
					},
					runner,
					prepareDependency: async (dep) => {
						prepared.push(`${dep.repository}:${dep.cwd}`);
					},
				},
				AbortSignal.timeout(5_000),
			),
		).rejects.toMatchObject({
			name: "CodingSetupLifecycleError",
			code: "CODING_SETUP_INSTALL_FAILED",
			phase: "install",
			stepName: "install:deps",
			exitCode: 2,
		});
		expect(prepared).toEqual(["acme/shared:/work"]);
	});

	it("propagates session abort and wraps dependency failures cleanly", async () => {
		const abortController = new AbortController();
		const runner: CodingSetupCommandRunner = {
			exec: vi.fn(async (_input, signal) => {
				abortController.abort(new Error("session aborted"));
				signal.throwIfAborted();
				return { exitCode: 0, stdout: "", stderr: "" };
			}),
		};
		const lifecycle = new CodingSetupLifecycle();
		await expect(
			lifecycle.onAttach(
				{
					machineId: "m-4",
					workerId: "w-4",
					diskId: "initial",
					bootId: "boot-1",
					cwd: "/work",
					setupDigest: "3".repeat(64),
					setupSpec: {
						...EMPTY_CODING_SETUP,
						install: [{ from: "install", commands: [{ name: null, run: { shell: "sleep 10" } }] }],
					},
					runner,
				},
				abortController.signal,
			),
		).rejects.toThrow("session aborted");

		await expect(
			lifecycle.onAttach(
				{
					machineId: "m-5",
					workerId: "w-5",
					diskId: "initial",
					bootId: "boot-1",
					cwd: "/work",
					setupDigest: "4".repeat(64),
					setupSpec: {
						...EMPTY_CODING_SETUP,
						repositoryDependencies: ["acme/lib"],
					},
					runner,
					prepareDependency: async () => {
						throw new Error("clone denied");
					},
				},
				AbortSignal.timeout(5_000),
			),
		).rejects.toBeInstanceOf(CodingSetupLifecycleError);
	});
});
