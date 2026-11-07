import { randomUUID } from "node:crypto";
import { CLOUD_MACHINE_FOLDER_LIMITS, cloudMachineFolderBytes } from "@qorpera/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CloudActionReviewControl, CloudActionReviewGate } from "../src/cloud-action-review.ts";
import type { CloudCompanyPathControl } from "../src/cloud-company-path-gateway.ts";
import { type CloudMachineCommandGateway, CloudMachineCommandRefusal } from "../src/cloud-machine-command-http.ts";
import { cloudMachineTools } from "../src/cloud-machine-tools.ts";
import { CloudNativeToolBoundary } from "../src/cloud-native-tool-boundary.ts";
import {
	type CloudNativeToolOperations,
	cloudNativeToolOperationEnvelope,
} from "../src/cloud-native-tool-operations.ts";
import { CLOUD_RUNTIME_TOOL_OPERATIONS } from "../src/cloud-runtime-observability.ts";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

function fixture(
	machines: { name: string; state: string }[] = [{ name: "build-a", state: "running" }],
	worker = false,
) {
	const { authority, binding } = nativeToolAuthorityFixture();
	const identity = authority.identity;
	const listed = machines.map((machine) => ({
		machineId: randomUUID(),
		cpus: 2,
		memoryGiB: 4,
		diskGiB: 40,
		...machine,
	}));
	const receiptId = randomUUID();
	const receipt = (machineId: string, commandId: string, state = "running") => ({
		schema: "qorpera.machine-command-result/v1",
		machineId,
		commandId,
		inputSha256: "a".repeat(64),
		state,
		exitCode: state === "succeeded" ? 0 : null,
		output: "",
		truncated: false,
		log: { offset: 0, nextOffset: 0, totalBytes: 0, limitBytes: 67108864, limitReached: false },
	});
	/** What the kernel answers to a waiting worker's next status looks (then: the first machine, command running). */
	const statuses: (Record<string, unknown> | Error)[] = [];
	/** The state a start answers with. */
	const started = { state: "waiting", queuePosition: 2 as number | null };
	const control = {
		call: vi.fn(async (method: string, args: Record<string, unknown>) => {
			if (method === "qorpera_native_machine_manage") {
				const request = args.p_request as { action: string; machine?: string };
				if (request.action === "list") return { schema: "qorpera.machine-list/v1", machines: listed };
				if (request.action === "status") {
					const next = statuses.shift();
					if (next instanceof Error) throw next;
					return (
						next ?? {
							schema: "qorpera.machine-status/v1",
							machine: listed[0],
							command: { commandId: randomUUID(), state: "running", endedAt: null },
						}
					);
				}
				const machine = listed.find((entry) => entry.name === request.machine);
				return machine
					? {
							schema: "qorpera.machine-change/v1",
							machine: { ...machine, state: request.action === "stop" ? "stopping" : "deleting" },
						}
					: {
							schema: "qorpera.machine-change/v1",
							refused: { reason: "MACHINE_NOT_FOUND", message: "no machine" },
						};
			}
			if (method === "qorpera_native_machine_start")
				return args.p_action === "authorize"
					? { state: "authorized" }
					: { schema: "qorpera.machine-start/v1", machine: { ...listed[0], ...started } };
			throw new Error(`unexpected ${method}`);
		}),
	};
	const gateway = {
		start: vi.fn<CloudMachineCommandGateway["start"]>(
			async (scope, input) => receipt(scope.machineId, input.commandId) as never,
		),
		read: vi.fn<CloudMachineCommandGateway["read"]>(
			async (scope, input) => receipt(scope.machineId, input.commandId, "succeeded") as never,
		),
		cancel: vi.fn<CloudMachineCommandGateway["cancel"]>(
			async (scope, commandId) => receipt(scope.machineId, commandId, "cancelled") as never,
		),
	};
	const execute = vi.fn<CloudNativeToolOperations["execute"]>(async (options) => {
		await options.authorize(options.operation, identity, options.signal);
		return (
			await options.perform(options.operation, {
				identity,
				receiptId,
				inputSha256: "a".repeat(64),
				idempotencyKey: "b".repeat(64),
				signal: options.signal,
			})
		).content;
	});
	const tools = cloudMachineTools({
		binding,
		identity,
		control: control as unknown as CloudCompanyPathControl,
		operations: { execute },
		gateway,
		worker,
	});
	const run = new AbortController();
	const boundary = new CloudNativeToolBoundary({
		companyId: identity.companyId,
		runId: identity.runId,
		identity,
		tools,
		assertActive: async () => undefined,
		signal: run.signal,
	});
	const content = (result: { contentItems: { text: string }[] }) =>
		JSON.parse(
			JSON.parse(result.contentItems[0].text).content.text ??
				JSON.stringify(JSON.parse(result.contentItems[0].text).content.value),
		);
	const status = (machine: Record<string, unknown> | null, command?: string) => ({
		schema: "qorpera.machine-status/v1",
		machine,
		...(command === undefined ? {} : { command: { commandId: randomUUID(), state: command, endedAt: null } }),
	});
	const looks = () =>
		control.call.mock.calls.filter(
			([method, args]) =>
				method === "qorpera_native_machine_manage" && (args.p_request as { action: string }).action === "status",
		);
	return {
		identity,
		binding,
		listed,
		receipt,
		receiptId,
		control,
		gateway,
		execute,
		tools,
		boundary,
		content,
		run,
		statuses,
		started,
		status,
		looks,
	};
}

describe("machine tools", () => {
	it("gives a worker the same seven tools, without notify, and tells it that nothing wakes it", async () => {
		const agent = fixture();
		const helper = fixture(undefined, true);
		try {
			expect(helper.tools.map((tool) => tool.name)).toEqual(agent.tools.map((tool) => tool.name));
			const run = helper.tools.find((tool) => tool.name === "machine_run")!;
			const start = helper.tools.find((tool) => tool.name === "machine_start")!;
			expect(run.inputSchema.properties).not.toHaveProperty("notify");
			expect(run.description).toContain("You are a worker: nothing wakes you.");
			expect(run.description).not.toContain("With notify true");
			expect(start.description).toContain("You are a worker: nothing wakes you.");
			expect(start.description).not.toContain("you are woken when it runs");
			// To wait longer it repeats the same start: a new key would be another start.
			expect(start.description).toContain("call machine_start again with the same operationKey and arguments");
			expect(() =>
				run.parseArguments({ operationKey: "k", machine: "build-a", command: "npm test", notify: true }),
			).toThrow();
			expect(run.parseArguments({ operationKey: "k", machine: "build-a", command: "npm test" })).toMatchObject({
				notify: false,
			});
		} finally {
			agent.boundary.close();
			helper.boundary.close();
		}
	});

	it("tells agents the one idle rule: a busy program keeps a task machine awake, a waiting server stops with it", () => {
		const agent = fixture();
		const helper = fixture(undefined, true);
		try {
			for (const tools of [agent.tools, helper.tools]) {
				const start = tools.find((tool) => tool.name === "machine_start")!;
				const run = tools.find((tool) => tool.name === "machine_run")!;
				expect(start.description).toContain(
					"only a busy program (over about 5% of one core, or moving data) keeps it awake, and one busy for hours brings check-ins",
				);
				expect(start.description).toContain(
					"a server that only waits stops when it sleeps, and your next run is told",
				);
				expect(start.description).toContain("use it to keep a server up");
				expect(start.description).toContain(
					"the agent that started it is asked once a week whether the work still needs it",
				);
				expect(run.description).toContain("keep a server up on an always-on machine");
				// F3 6e-1: a session's work is in the company folder; no repository is attached.
				expect(start.description).toContain("/company/code/<owner>/<name>/worktrees/<workerId>");
				expect(start.description).not.toContain("/mnt/repository");
				for (const tool of tools) expect(Buffer.byteLength(tool.description)).toBeLessThanOrEqual(4096);
			}
		} finally {
			agent.boundary.close();
			helper.boundary.close();
		}
	});

	it("points a company agent's run to share_app for a server members open; a worker has no share_app", () => {
		const agent = fixture();
		const helper = fixture(undefined, true);
		try {
			for (const name of ["machine_start", "machine_run"]) {
				expect(agent.tools.find((tool) => tool.name === name)!.description).toContain(
					"share its port with share_app",
				);
				expect(helper.tools.find((tool) => tool.name === name)!.description).not.toContain("share_app");
			}
		} finally {
			agent.boundary.close();
			helper.boundary.close();
		}
	});

	it("offers waiting to workers only: an agent is woken instead", () => {
		const agent = fixture();
		const helper = fixture(undefined, true);
		try {
			for (const tool of ["machine_start", "machine_read"]) {
				const agentTool = agent.tools.find((entry) => entry.name === tool)!;
				expect(agentTool.inputSchema.properties).not.toHaveProperty("waitSeconds");
				expect(agentTool.description).not.toContain("waitSeconds");
				expect(helper.tools.find((entry) => entry.name === tool)!.inputSchema.properties).toHaveProperty(
					"waitSeconds",
				);
			}
			const read = agent.tools.find((tool) => tool.name === "machine_read")!;
			expect(() => read.parseArguments({ machine: "build-a", commandId: randomUUID(), waitSeconds: 5 })).toThrow();
			const start = agent.tools.find((tool) => tool.name === "machine_start")!;
			expect(() => start.parseArguments({ operationKey: "k", machine: "build-a", waitSeconds: 5 })).toThrow();
			const helperRead = helper.tools.find((tool) => tool.name === "machine_read")!;
			for (const waitSeconds of [0, 301, 1.5, "5"])
				expect(() =>
					helperRead.parseArguments({ machine: "build-a", commandId: randomUUID(), waitSeconds }),
				).toThrow();
		} finally {
			agent.boundary.close();
			helper.boundary.close();
		}
	});

	describe("a worker waiting", () => {
		/** The read before the wait finds the command still running. */
		const running = (f: ReturnType<typeof fixture>) =>
			f.gateway.read.mockImplementationOnce(
				async (scope, input) => f.receipt(scope.machineId, input.commandId) as never,
			);
		beforeEach(() => {
			vi.useFakeTimers();
		});
		afterEach(() => {
			vi.useRealTimers();
		});

		it("answers at once, after one look, when the command has already ended", async () => {
			const f = fixture(undefined, true);
			try {
				const read = await f.boundary.invoke("r1", "qorpera", "machine_read", {
					machine: "build-a",
					commandId: randomUUID(),
					tail: true,
					waitSeconds: 60,
				});
				expect(read.contentItems[0].text).toContain("succeeded");
				expect(f.looks()).toHaveLength(1);
				expect(f.gateway.read).toHaveBeenCalledTimes(1);
			} finally {
				f.boundary.close();
			}
		});

		it("tells a stopped worker so, without reading the machine, even when its command has ended", async () => {
			const f = fixture(undefined, true);
			try {
				f.statuses.push({ schema: "qorpera.machine-status/v1", workStopped: true });
				const read = await f.boundary.invoke("r1", "qorpera", "machine_read", {
					machine: "build-a",
					commandId: randomUUID(),
					waitSeconds: 60,
				});
				expect(read.contentItems[0].text).toContain("WORK_STOPPED");
				expect(f.gateway.read).not.toHaveBeenCalled();
			} finally {
				f.boundary.close();
			}
		});

		it.each(["unconfirmed", "running"])("keeps waiting while the machine says the command is %s", async (state) => {
			const f = fixture(undefined, true);
			try {
				f.gateway.read.mockImplementationOnce(
					async (scope, input) => f.receipt(scope.machineId, input.commandId, state) as never,
				);
				f.statuses.push(f.status(f.listed[0], "running"), f.status(f.listed[0], "succeeded"));
				const read = f.boundary.invoke("r1", "qorpera", "machine_read", {
					machine: "build-a",
					commandId: randomUUID(),
					waitSeconds: 60,
				});
				await vi.advanceTimersByTimeAsync(5_000);
				expect((await read).contentItems[0].text).toContain("succeeded");
				expect(f.looks()).toHaveLength(2);
				expect(f.gateway.read).toHaveBeenCalledTimes(2);
			} finally {
				f.boundary.close();
			}
		});

		it("goes on waiting when the read before the wait fails", async () => {
			const f = fixture(undefined, true);
			try {
				f.gateway.read.mockRejectedValueOnce(new Error("transport_unavailable"));
				f.statuses.push(f.status(f.listed[0], "running"), f.status(f.listed[0], "succeeded"));
				const read = f.boundary.invoke("r1", "qorpera", "machine_read", {
					machine: "build-a",
					commandId: randomUUID(),
					waitSeconds: 60,
				});
				await vi.advanceTimersByTimeAsync(5_000);
				const result = await read;
				expect(result.success).toBe(true);
				expect(result.contentItems[0].text).toContain("succeeded");
				expect(f.gateway.read).toHaveBeenCalledTimes(2);
			} finally {
				f.boundary.close();
			}
		});

		describe("keeps what the read before the wait reported once", () => {
			const notSaved = [{ path: "notes/plan.md", outcome: "conflict" }];
			const reported = (f: ReturnType<typeof fixture>) =>
				f.gateway.read.mockImplementationOnce(
					async (scope, input) =>
						({
							...f.receipt(scope.machineId, input.commandId),
							companyFolder: { company: "mounted", notSaved },
						}) as never,
				);
			const answer = (f: ReturnType<typeof fixture>, key: string) =>
				f.boundary.invoke(key, "qorpera", "machine_read", {
					machine: "build-a",
					commandId: randomUUID(),
					waitSeconds: 60,
				});

			it("for the answer after the wait", async () => {
				const f = fixture(undefined, true);
				try {
					reported(f);
					f.gateway.read.mockImplementationOnce(
						async (scope, input) =>
							({
								...f.receipt(scope.machineId, input.commandId, "succeeded"),
								companyFolder: { company: "mounted" },
							}) as never,
					);
					f.statuses.push(f.status(f.listed[0], "running"), f.status(f.listed[0], "succeeded"));
					const read = answer(f, "r1");
					await vi.advanceTimersByTimeAsync(5_000);
					expect(f.content((await read) as never)).toMatchObject({
						state: "succeeded",
						companyFolder: { company: "mounted", notSaved },
					});
					expect(f.gateway.read).toHaveBeenCalledTimes(2);
				} finally {
					f.boundary.close();
				}
			});

			it("when the worker's work is stopped during the wait", async () => {
				const f = fixture(undefined, true);
				try {
					reported(f);
					f.statuses.push(f.status(f.listed[0], "running"), {
						schema: "qorpera.machine-status/v1",
						workStopped: true,
					});
					const read = answer(f, "r1");
					await vi.advanceTimersByTimeAsync(5_000);
					expect(f.content((await read) as never)).toMatchObject({
						refused: { reason: "WORK_STOPPED" },
						companyFolder: { notSaved },
					});
				} finally {
					f.boundary.close();
				}
			});

			it("when the machine stops during the wait and the read is refused", async () => {
				const f = fixture(undefined, true);
				try {
					reported(f);
					f.gateway.read.mockRejectedValueOnce(new CloudMachineCommandRefusal("MACHINE_NOT_RUNNING"));
					f.statuses.push(
						f.status(f.listed[0], "running"),
						f.status({ ...f.listed[0], state: "stopping" }, "running"),
					);
					const read = answer(f, "r1");
					await vi.advanceTimersByTimeAsync(5_000);
					expect(f.content((await read) as never)).toMatchObject({
						refused: { reason: "MACHINE_NOT_RUNNING" },
						companyFolder: { notSaved },
					});
				} finally {
					f.boundary.close();
				}
			});
		});

		it("looks at the kernel's status until its command ends, and reads it before the wait and for the answer", async () => {
			const f = fixture(undefined, true);
			try {
				running(f);
				f.statuses.push(
					f.status(f.listed[0], "running"),
					f.status(f.listed[0], "running"),
					f.status(f.listed[0], "succeeded"),
				);
				const read = f.boundary.invoke("r1", "qorpera", "machine_read", {
					machine: "build-a",
					commandId: randomUUID(),
					tail: true,
					waitSeconds: 60,
				});
				await vi.advanceTimersByTimeAsync(10_000);
				const result = await read;
				expect(result.success).toBe(true);
				expect(result.contentItems[0].text).toContain("succeeded");
				expect(f.looks()).toHaveLength(3);
				// The machine is asked before the wait and for the answer, never while waiting.
				expect(f.gateway.read).toHaveBeenCalledTimes(2);
			} finally {
				f.boundary.close();
			}
		});

		it("stops looking when the time passes, and still answers with a read", async () => {
			const f = fixture(undefined, true);
			try {
				f.gateway.read.mockImplementation(
					async (scope, input) =>
						({
							schema: "qorpera.machine-command-result/v1",
							machineId: scope.machineId,
							commandId: input.commandId,
							inputSha256: "a".repeat(64),
							state: "running",
							exitCode: null,
							output: "",
							truncated: false,
							log: { offset: 0, nextOffset: 0, totalBytes: 0, limitBytes: 67108864, limitReached: false },
						}) as never,
				);
				const read = f.boundary.invoke("r1", "qorpera", "machine_read", {
					machine: "build-a",
					commandId: randomUUID(),
					waitSeconds: 12,
				});
				await vi.advanceTimersByTimeAsync(12_000);
				const result = await read;
				expect(result.contentItems[0].text).toContain("running");
				// Looks at 0, 5, 10 and at the deadline, 12 s.
				expect(f.looks()).toHaveLength(4);
				expect(f.gateway.read).toHaveBeenCalledTimes(2);
			} finally {
				f.boundary.close();
			}
		});

		it("keeps waiting through a failed look", async () => {
			const f = fixture(undefined, true);
			try {
				f.statuses.push(new Error("transport_unavailable"), f.status(f.listed[0], "failed"));
				const read = f.boundary.invoke("r1", "qorpera", "machine_read", {
					machine: "build-a",
					commandId: randomUUID(),
					waitSeconds: 60,
				});
				await vi.advanceTimersByTimeAsync(5_000);
				expect((await read).success).toBe(true);
				expect(f.looks()).toHaveLength(2);
				expect(f.gateway.read).toHaveBeenCalledTimes(1);
			} finally {
				f.boundary.close();
			}
		});

		it("ends when its work is stopped, without reading the machine again", async () => {
			const f = fixture(undefined, true);
			try {
				running(f);
				f.statuses.push(f.status(f.listed[0], "running"), {
					schema: "qorpera.machine-status/v1",
					workStopped: true,
				});
				const read = f.boundary.invoke("r1", "qorpera", "machine_read", {
					machine: "build-a",
					commandId: randomUUID(),
					waitSeconds: 300,
				});
				await vi.advanceTimersByTimeAsync(5_000);
				const result = await read;
				expect(result.success).toBe(true);
				expect(result.contentItems[0].text).toContain("WORK_STOPPED");
				expect(f.gateway.read).toHaveBeenCalledTimes(1);
			} finally {
				f.boundary.close();
			}
		});

		it("ends when the run is stopped", async () => {
			const f = fixture(undefined, true);
			try {
				running(f);
				const read = f.boundary.invoke("r1", "qorpera", "machine_read", {
					machine: "build-a",
					commandId: randomUUID(),
					waitSeconds: 300,
				});
				await vi.advanceTimersByTimeAsync(7_000);
				f.run.abort(new Error("run stopped"));
				expect((await read).success).toBe(false);
				expect(f.looks()).toHaveLength(2);
				expect(f.gateway.read).toHaveBeenCalledTimes(1);
			} finally {
				f.boundary.close();
			}
		});

		it("waits while its machine starts, outside the start's receipt", async () => {
			const f = fixture(undefined, true);
			try {
				f.started.state = "starting";
				f.started.queuePosition = null;
				f.statuses.push(
					f.status({ ...f.listed[0], state: "starting" }),
					f.status({ ...f.listed[0], state: "running" }),
				);
				const start = f.boundary.invoke("s1", "qorpera", "machine_start", {
					operationKey: "shard",
					name: "shard-1",
					purpose: "One test shard",
					waitSeconds: 120,
				});
				await vi.advanceTimersByTimeAsync(5_000);
				const result = await start;
				expect(result.success).toBe(true);
				expect(f.content(result as never).machine.state).toBe("running");
				expect(f.looks()).toHaveLength(2);
				expect(f.execute.mock.calls[0][0].operation.arguments).not.toHaveProperty("waitSeconds");
				expect(f.execute.mock.calls[0][0].operation.arguments).toMatchObject({ name: "shard-1" });
			} finally {
				f.boundary.close();
			}
		});

		it("stops waiting for a start at the deadline, when the machine is gone, or when its work is stopped", async () => {
			const start = async (f: ReturnType<typeof fixture>, key: string, waitSeconds: number, advance: number) => {
				const call = f.boundary.invoke(key, "qorpera", "machine_start", {
					operationKey: key,
					machine: "build-a",
					waitSeconds,
				});
				await vi.advanceTimersByTimeAsync(advance);
				return f.content((await call) as never);
			};
			const slow = fixture(undefined, true);
			const gone = fixture(undefined, true);
			const stopped = fixture(undefined, true);
			try {
				for (const f of [slow, gone, stopped]) {
					f.started.state = "starting";
					f.started.queuePosition = null;
				}
				slow.statuses.push(
					...Array.from({ length: 3 }, () => slow.status({ ...slow.listed[0], state: "starting" })),
				);
				expect((await start(slow, "slow", 7, 7_000)).machine.state).toBe("starting");
				// Looks at 0, 5 and at the deadline, 7 s.
				expect(slow.looks()).toHaveLength(3);
				gone.statuses.push(gone.status(null));
				expect((await start(gone, "gone", 60, 0)).machine.state).toBe("deleted");
				stopped.statuses.push({ schema: "qorpera.machine-status/v1", workStopped: true });
				const answer = await start(stopped, "stopped", 60, 0);
				// It was started all the same: the answer is the start, and the worker is told to end.
				expect(answer.machine.state).toBe("starting");
				expect(answer.workStopped).toContain("end your run");
				expect(answer.refused).toBeUndefined();
			} finally {
				for (const f of [slow, gone, stopped]) f.boundary.close();
			}
		});

		it("stops waiting for a command when its machine stops, and the read says so", async () => {
			const f = fixture(undefined, true);
			try {
				f.statuses.push(f.status({ ...f.listed[0], state: "stopping" }, "running"));
				f.gateway.read.mockRejectedValueOnce(new CloudMachineCommandRefusal("MACHINE_NOT_RUNNING"));
				const read = f.boundary.invoke("r1", "qorpera", "machine_read", {
					machine: "build-a",
					commandId: randomUUID(),
					waitSeconds: 300,
				});
				await vi.advanceTimersByTimeAsync(0);
				const result = await read;
				expect(result.contentItems[0].text).toContain("MACHINE_NOT_RUNNING");
				expect(f.looks()).toHaveLength(1);
				expect(f.gateway.read).toHaveBeenCalledTimes(1);
			} finally {
				f.boundary.close();
			}
		});

		it("answers at once when its machine waits in line for room", async () => {
			const f = fixture(undefined, true);
			try {
				const result = await f.boundary.invoke("s1", "qorpera", "machine_start", {
					operationKey: "wake",
					machine: "build-a",
					waitSeconds: 120,
				});
				expect(f.content(result as never).machine).toMatchObject({ state: "waiting", queuePosition: 2 });
				expect(f.looks()).toHaveLength(0);
				expect(f.execute.mock.calls[0][0].operation.arguments).toEqual({ machine: "build-a" });
			} finally {
				f.boundary.close();
			}
		});
	});

	it("are the seven machine operations the runtime observes by name", () => {
		const f = fixture();
		expect(f.tools.map((tool) => tool.name)).toEqual([
			"machine_start",
			"machine_run",
			"machine_read",
			"machine_cancel",
			"machine_stop",
			"machine_delete",
			"machine_list",
		]);
		for (const tool of f.tools) expect(CLOUD_RUNTIME_TOOL_OPERATIONS).toContain(tool.name);
		f.boundary.close();
	});

	it("starts a machine through a receipt: the exact envelope is authorized, then begun once", async () => {
		const f = fixture();
		try {
			const args = { operationKey: "suite", name: "build-b", purpose: "Run the SQL suite", cpus: 8, memoryGiB: 16 };
			const result = await f.boundary.invoke("s1", "qorpera", "machine_start", args);
			expect(result.success).toBe(true);
			const operation = f.execute.mock.calls[0][0].operation;
			expect(operation).toEqual({
				tool: "machine_start",
				toolVersion: "qorpera.machine-tools/v1",
				logicalOperationKey: "suite",
				arguments: {
					name: "build-b",
					purpose: "Run the SQL suite",
					cpus: 8,
					memoryGiB: 16,
					diskGiB: 40,
					lifetime: "task",
				},
				target: { realm: "company_machine" },
				requiresCompanyRevision: false,
			});
			const [authorize, begin] = f.control.call.mock.calls;
			expect(authorize).toEqual([
				"qorpera_native_machine_start",
				{
					p_binding: f.binding,
					p_envelope: cloudNativeToolOperationEnvelope(f.identity, operation),
					p_action: "authorize",
				},
				expect.any(AbortSignal),
			]);
			expect(begin?.[1]).toMatchObject({
				p_action: "begin",
				p_receipt_id: f.receiptId,
				p_envelope: authorize?.[1].p_envelope,
			});
		} finally {
			f.boundary.close();
		}
	});

	it("wakes a machine by name only, and needs a purpose for a new one", async () => {
		const f = fixture();
		try {
			expect(
				(await f.boundary.invoke("w", "qorpera", "machine_start", { operationKey: "wake", machine: "build-a" }))
					.success,
			).toBe(true);
			expect(f.execute.mock.calls[0][0].operation.arguments).toEqual({ machine: "build-a" });
			for (const [index, bad] of [
				{ operationKey: "x", machine: "build-a", cpus: 2 },
				{ operationKey: "x", name: "no-purpose" },
				{ operationKey: "x", name: "Bad Name", purpose: "x" },
				{ operationKey: "x", name: "big", purpose: "x", cpus: 65 },
				// No coding session's repository is attached any more (F3 6e-1): its work is in the company folder.
				{ operationKey: "x", name: "repo", purpose: "x", repositoryWorker: "worker-1" },
			].entries())
				expect((await f.boundary.invoke(`bad-${index}`, "qorpera", "machine_start", bad)).success).toBe(false);
		} finally {
			f.boundary.close();
		}
	});

	// F3 6d: an agent's command and a worker's go to the review under the run's own binding, from which the review takes
	// the run's agent and member and their rules; starting and listing machines do not.
	it.each([
		["an agent", false],
		["a worker", true],
	] as const)("sends %s's command to the review before it starts (F3 6d)", async (_who, worker) => {
		const f = fixture(undefined, worker);
		const control = vi.fn<CloudActionReviewControl["call"]>(async () => ({
			state: "declined",
			reviewId: "review-0",
		}));
		const reviewer = { review: vi.fn() };
		const boundary = new CloudNativeToolBoundary({
			companyId: f.identity.companyId,
			runId: f.identity.runId,
			identity: f.identity,
			tools: f.tools,
			assertActive: async () => undefined,
			signal: f.run.signal,
			review: new CloudActionReviewGate({
				binding: f.binding,
				control: { call: control },
				reviewer,
				request: "",
				holdMs: 0,
			}),
		});
		try {
			const start = { operationKey: "wake", machine: "build-a" };
			expect((await boundary.invoke("s", "qorpera", "machine_start", start)).success).toBe(true);
			expect((await boundary.invoke("l", "qorpera", "machine_list", {})).success).toBe(true);
			expect(control).not.toHaveBeenCalled();
			const command = { operationKey: "suite:1", machine: "build-a", command: "npm test" };
			const denied = await boundary.invoke("r", "qorpera", "machine_run", command);
			expect(denied.success).toBe(false);
			expect(denied.contentItems[0].text).toContain("REVIEW_DENIED");
			expect(control.mock.calls.map(([method, args]) => [method, args])).toEqual([
				[
					"qorpera_begin_action_review",
					{
						p_binding: f.binding,
						p_call: { tool: "machine_run", argumentSha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
					},
				],
			]);
			expect(f.gateway.start).not.toHaveBeenCalled();
			expect(reviewer.review).not.toHaveBeenCalled();
		} finally {
			boundary.close();
			f.boundary.close();
		}
	});

	it("runs a command on a running machine with its handle bound to the receipt, and no deadline unless asked", async () => {
		const f = fixture();
		try {
			const args = { operationKey: "suite:1", machine: "build-a", command: "npm test", notify: true };
			expect((await f.boundary.invoke("r1", "qorpera", "machine_run", args)).success).toBe(true);
			expect(f.gateway.start).toHaveBeenCalledWith(
				{ machineId: f.listed[0].machineId },
				{ commandId: f.receiptId, inputSha256: "a".repeat(64), command: "npm test", timeoutMs: null, notify: true },
				expect.any(AbortSignal),
			);
			expect(f.execute.mock.calls[0][0].operation).toMatchObject({
				tool: "machine_run",
				arguments: args,
				target: { realm: "company_machine", machineId: f.listed[0].machineId },
			});
		} finally {
			f.boundary.close();
		}
	});

	it("answers an executor's refusal as a refused result: nothing started", async () => {
		const f = fixture();
		try {
			f.gateway.start.mockRejectedValueOnce(new CloudMachineCommandRefusal("MACHINE_COMMAND_ENDED"));
			const given = await f.boundary.invoke("r1", "qorpera", "machine_run", {
				operationKey: "suite:1",
				machine: "build-a",
				command: "npm test",
			});
			expect(given.success).toBe(true);
			expect(given.contentItems[0].text).toContain("MACHINE_COMMAND_ENDED");
			f.gateway.start.mockRejectedValueOnce(new Error("MACHINE_NOT_RUNNING"));
			const stopped = await f.boundary.invoke("r2", "qorpera", "machine_run", {
				operationKey: "suite:2",
				machine: "build-a",
				command: "npm test",
			});
			expect(stopped.contentItems[0].text).toContain("MACHINE_NOT_RUNNING");
			// A command from before the machine moved: its log went with the old disk.
			f.gateway.read.mockRejectedValueOnce(new Error("MACHINE_COMMAND_ENDED"));
			const gone = await f.boundary.invoke("r3", "qorpera", "machine_read", {
				machine: "build-a",
				commandId: randomUUID(),
			});
			expect(gone.success).toBe(true);
			expect(gone.contentItems[0].text).toContain("MACHINE_COMMAND_ENDED");
			f.gateway.cancel.mockRejectedValueOnce(new CloudMachineCommandRefusal("MACHINE_COMMAND_ENDED"));
			const cancelled = await f.boundary.invoke("r4", "qorpera", "machine_cancel", {
				operationKey: "stop:1",
				machine: "build-a",
				commandId: randomUUID(),
			});
			expect(cancelled.contentItems[0].text).toContain("MACHINE_COMMAND_ENDED");
			expect(f.content(cancelled as never).refused).not.toHaveProperty("lost");
			// A command its machine lost when it moved for its folder says why (6e-2a), on a read, a cancel and a start.
			const moved = "the machine moved to a new disk because something it read in /company is no longer readable";
			f.gateway.read.mockRejectedValueOnce(
				new CloudMachineCommandRefusal("MACHINE_COMMAND_ENDED", "moved_unreadable"),
			);
			const lostRead = await f.boundary.invoke("r5", "qorpera", "machine_read", {
				machine: "build-a",
				commandId: randomUUID(),
			});
			expect(f.content(lostRead as never).refused).toEqual({
				reason: "MACHINE_COMMAND_ENDED",
				message: "that command ended when its machine stopped or moved; its log went with the old disk",
				lost: moved,
			});
			f.gateway.cancel.mockRejectedValueOnce(
				new CloudMachineCommandRefusal("MACHINE_COMMAND_ENDED", "moved_unreadable"),
			);
			const lostCancel = await f.boundary.invoke("r6", "qorpera", "machine_cancel", {
				operationKey: "stop:2",
				machine: "build-a",
				commandId: randomUUID(),
			});
			expect(f.content(lostCancel as never).refused).toMatchObject({ lost: moved });
			f.gateway.start.mockRejectedValueOnce(
				new CloudMachineCommandRefusal("MACHINE_COMMAND_ENDED", "moved_unreadable"),
			);
			const lostStart = await f.boundary.invoke("r7", "qorpera", "machine_run", {
				operationKey: "suite:3",
				machine: "build-a",
				command: "npm test",
			});
			expect(f.content(lostStart as never).refused).toEqual({
				reason: "MACHINE_COMMAND_ENDED",
				message: "this command was lost after it started; start it again with a new operationKey",
				lost: moved,
			});
		} finally {
			f.boundary.close();
		}
	});

	it("tells the agent when a machine is missing or not running, without a receipt", async () => {
		const f = fixture([{ name: "waiting-one", state: "waiting" }]);
		try {
			const notRunning = await f.boundary.invoke("r1", "qorpera", "machine_run", {
				operationKey: "k",
				machine: "waiting-one",
				command: "true",
			});
			expect(notRunning.success).toBe(true);
			expect(notRunning.contentItems[0].text).toContain("MACHINE_NOT_RUNNING");
			const missing = await f.boundary.invoke("r2", "qorpera", "machine_read", {
				machine: "nobody",
				commandId: randomUUID(),
			});
			expect(missing.contentItems[0].text).toContain("MACHINE_NOT_FOUND");
			expect(f.execute).not.toHaveBeenCalled();
			expect(f.gateway.start).not.toHaveBeenCalled();
		} finally {
			f.boundary.close();
		}
	});

	it("reads, cancels, stops, deletes and lists", async () => {
		const f = fixture();
		try {
			const commandId = randomUUID();
			expect(
				(await f.boundary.invoke("a", "qorpera", "machine_read", { machine: "build-a", commandId, tail: true }))
					.success,
			).toBe(true);
			expect(f.gateway.read).toHaveBeenCalledWith(
				{ machineId: f.listed[0].machineId },
				{ commandId, tail: true, limit: 4096 },
				expect.any(AbortSignal),
			);
			expect(
				(
					await f.boundary.invoke("b", "qorpera", "machine_cancel", {
						operationKey: "c",
						machine: "build-a",
						commandId,
					})
				).success,
			).toBe(true);
			expect(f.gateway.cancel).toHaveBeenCalledWith(
				{ machineId: f.listed[0].machineId },
				commandId,
				expect.any(AbortSignal),
			);
			const stop = await f.boundary.invoke("c", "qorpera", "machine_stop", { machine: "build-a" });
			expect(stop.contentItems[0].text).toContain("stopping");
			const gone = await f.boundary.invoke("d", "qorpera", "machine_delete", { machine: "nobody" });
			expect(gone.contentItems[0].text).toContain("MACHINE_NOT_FOUND");
			const list = await f.boundary.invoke("e", "qorpera", "machine_list", {});
			expect(list.contentItems[0].text).toContain("build-a");
		} finally {
			f.boundary.close();
		}
	});

	it("shows what the company folder said, and keeps the paths not saved when a read asks again for a smaller page (F3 6e-2a)", async () => {
		const f = fixture();
		try {
			const machineId = f.listed[0].machineId;
			const commandId = randomUUID();
			const page = (state: string, output: string, companyFolder: Record<string, unknown>, id = commandId) => ({
				schema: "qorpera.machine-command-result/v1",
				machineId,
				commandId: id,
				inputSha256: "a".repeat(64),
				state,
				exitCode: state === "succeeded" ? 0 : null,
				output,
				truncated: Buffer.byteLength(output) < 16000,
				log: {
					offset: 0,
					nextOffset: Buffer.byteLength(output),
					totalBytes: 16000,
					limitBytes: 67108864,
					limitReached: false,
				},
				companyFolder,
			});
			const pending = { company: "pending", heldBack: "the machine has not answered the company folder yet" };
			f.gateway.start.mockResolvedValueOnce(page("running", "", pending, f.receiptId) as never);
			const ran = await f.boundary.invoke("r", "qorpera", "machine_run", {
				operationKey: "suite:1",
				machine: "build-a",
				command: "npm test",
			});
			expect(f.content(ran as never).companyFolder).toEqual(pending);
			const none = {
				company: "none",
				why: "the company folder refused this machine's view",
				heldBack: "this boot of the machine has no /company",
			};
			f.gateway.cancel.mockResolvedValueOnce(page("cancelled", "", none) as never);
			const cancelled = await f.boundary.invoke("c", "qorpera", "machine_cancel", {
				operationKey: "stop:1",
				machine: "build-a",
				commandId,
			});
			expect(f.content(cancelled as never).companyFolder).toEqual(none);
			// Each page is as long as the read asks: the first is too large for the result, so the read asks again. The
			// executor said its paths not saved on the first page only.
			const folders: Record<string, unknown>[] = [];
			// What a try after those reports: the paths still not saved, which every try says again.
			let after: Record<string, unknown> = { company: "mounted" };
			f.gateway.read.mockImplementation(
				async (_scope, input) =>
					page("succeeded", "x".repeat(input.limit ?? 4096), folders.shift() ?? after) as never,
			);
			const plan = { path: "notes/plan.md", outcome: "conflict", reason: "changed meanwhile" };
			const pay = { path: "people/pay.md", outcome: "denied" };
			folders.push({ company: "mounted", notSaved: [plan, pay] });
			const read = async (key: string) =>
				f.content(
					(await f.boundary.invoke(key, "qorpera", "machine_read", {
						machine: "build-a",
						commandId,
						limit: 8192,
					})) as never,
				);
			const shown = await read("a");
			expect(f.gateway.read.mock.calls.map(([, input]) => input.limit)).toEqual([8192, 4096]);
			expect(shown.output).toBe("x".repeat(4096));
			expect(shown.companyFolder).toEqual({ company: "mounted", notSaved: [plan, pay] });
			// Paths from every try, within the report's limits; the rest are counted.
			f.gateway.read.mockClear();
			const many = (from: string) =>
				Array.from({ length: 5 }, (_, i) => ({
					path: `reports/${from}${i}.md`,
					outcome: "refused",
					reason: "r".repeat(150),
				}));
			folders.push(
				{ company: "mounted", notSaved: many("a"), moreNotSaved: 1 },
				{ company: "mounted", notSaved: many("b") },
			);
			const merged = (await read("b")).companyFolder;
			expect(f.gateway.read.mock.calls.map(([, input]) => input.limit).slice(0, 2)).toEqual([8192, 4096]);
			const listed = merged.notSaved as { path: string }[];
			expect(listed.length).toBeGreaterThan(5);
			expect(listed.length).toBeLessThan(CLOUD_MACHINE_FOLDER_LIMITS.notSaved);
			expect(listed.length + merged.moreNotSaved).toBe(11);
			expect(listed.map((entry) => entry.path)).toEqual(
				[...many("a"), ...many("b")].slice(0, listed.length).map((entry) => entry.path),
			);
			expect(cloudMachineFolderBytes(merged)).toBeLessThanOrEqual(CLOUD_MACHINE_FOLDER_LIMITS.bytes);
			expect(merged.company).toBe("mounted");
			// The paths still not saved come on every try: the last try's are shown, not added to the first's.
			f.gateway.read.mockClear();
			const still = Array.from({ length: 8 }, (_, i) => ({ path: `people/p${i}.md`, outcome: "denied" }));
			after = { company: "mounted", stillNotSaved: still, moreStillNotSaved: 3 };
			folders.push({ ...after, notSaved: [plan] }, { ...after, notSaved: [pay] });
			const again = (await read("e")).companyFolder;
			expect(f.gateway.read.mock.calls.map(([, input]) => input.limit).slice(0, 2)).toEqual([8192, 4096]);
			expect(again).toEqual({
				company: "mounted",
				notSaved: [plan, pay],
				stillNotSaved: still,
				moreStillNotSaved: 3,
			});
			// Past the report's bytes, they go before the paths said once.
			f.gateway.read.mockClear();
			const long = (from: string, n: number) =>
				Array.from({ length: n }, (_, i) => ({
					path: `reports/${from}${i}.md`,
					outcome: "refused",
					reason: "r".repeat(150),
				}));
			after = { company: "mounted", stillNotSaved: long("s", 2) };
			folders.push({ ...after, notSaved: long("a", 3) }, { ...after, notSaved: long("b", 3) });
			const full = (await read("f")).companyFolder;
			expect(f.gateway.read.mock.calls.map(([, input]) => input.limit).slice(0, 2)).toEqual([8192, 4096]);
			expect(full.notSaved).toEqual([...long("a", 3), ...long("b", 3)]);
			expect(full).not.toHaveProperty("moreNotSaved");
			expect(full).not.toHaveProperty("stillNotSaved");
			expect(full.moreStillNotSaved).toBe(2);
			expect(cloudMachineFolderBytes(full)).toBeLessThanOrEqual(CLOUD_MACHINE_FOLDER_LIMITS.bytes);
		} finally {
			f.boundary.close();
		}
	});
});
