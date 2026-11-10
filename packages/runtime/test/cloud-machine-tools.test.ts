import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { CLOUD_MACHINE_FOLDER_LIMITS, cloudMachineFolderBytes } from "@qorpera/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CloudActionReviewControl, CloudActionReviewGate } from "../src/cloud-action-review.ts";
import type { CloudCompanyPathControl } from "../src/cloud-company-path-gateway.ts";
import {
	CloudMachineAccountFillRefusal,
	CloudMachineCodingValueRefusal,
	type CloudMachineCommandGateway,
	CloudMachineCommandRefusal,
	CloudMachineCommandUnanswered,
} from "../src/cloud-machine-command-http.ts";
import {
	CLOUD_MACHINE_DESKTOP_LEAST,
	CLOUD_MACHINE_START_ANSWER_MS,
	CLOUD_MACHINE_START_DESCRIPTION,
	type CloudMachineCodingValues,
	cloudMachineTools,
} from "../src/cloud-machine-tools.ts";
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
	codingValues?: CloudMachineCodingValues,
	accountFills = false,
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
		wake: vi.fn<NonNullable<CloudMachineCommandGateway["wake"]>>(async () => false),
		codingValue: vi.fn<NonNullable<CloudMachineCommandGateway["codingValue"]>>(async (_scope, input) => ({
			schema: "qorpera.machine-coding-value/v1",
			commandId: input.commandId,
			box: {
				schema: "qorpera.coding-value-machine-box/v1",
				ephemeralPublicKey: "e",
				iv: "i",
				tag: "t",
				ciphertext: "c",
			},
		})),
		accountFill: vi.fn<NonNullable<CloudMachineCommandGateway["accountFill"]>>(async (_scope, input) => ({
			schema: "qorpera.machine-account-fill/v1",
			commandId: input.commandId,
			filled: true,
		})),
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
		...(codingValues ? { codingValues } : {}),
		...(accountFills ? { accountFills } : {}),
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

	describe("a start the executor does not answer", () => {
		const run = { operationKey: "suite:1", machine: "build-a", command: "npm test" };
		const unanswered = () => new CloudMachineCommandUnanswered();
		/** How the kernel answers a look: the machine running and no record of the command, unless told otherwise. */
		const noRecord = (f: ReturnType<typeof fixture>) => ({
			schema: "qorpera.machine-status/v1",
			machine: f.listed[0],
			command: null,
		});
		/** The call's result, as the boundary answers an outcome it does not know. */
		const unknown = (result: { success: boolean; contentItems: { text: string }[] }) => {
			expect(result.contentItems[0].text).not.toContain("refused");
			expect(result.contentItems[0].text).not.toContain("start it again");
			expect(result.contentItems[0].text).not.toContain('"commandId"');
		};
		beforeEach(() => {
			vi.useFakeTimers();
		});
		afterEach(() => {
			vi.useRealTimers();
		});

		it("sends it again, the same start, while the kernel has no record of it", async () => {
			const f = fixture();
			try {
				f.statuses.push(noRecord(f), noRecord(f));
				f.gateway.start.mockRejectedValueOnce(unanswered()).mockRejectedValueOnce(unanswered());
				const call = f.boundary.invoke("r1", "qorpera", "machine_run", run);
				await vi.advanceTimersByTimeAsync(3000);
				const result = await call;
				expect(result.success).toBe(true);
				expect(f.content(result as never)).toMatchObject({ commandId: f.receiptId, state: "running" });
				expect(f.gateway.start.mock.calls.map(([scope, input]) => [scope, input])).toEqual(
					Array(3).fill([
						{ machineId: f.listed[0].machineId },
						{
							commandId: f.receiptId,
							inputSha256: "a".repeat(64),
							command: "npm test",
							timeoutMs: null,
							notify: false,
						},
					]),
				);
				// Each send after the first follows a look that asked about this command.
				expect(f.looks().map(([, args]) => args.p_request)).toEqual(
					Array(2).fill({ action: "status", machine: "build-a", commandId: f.receiptId }),
				);
				expect(f.execute.mock.calls[0][0].performMs).toBe(CLOUD_MACHINE_START_ANSWER_MS);
			} finally {
				f.boundary.close();
			}
		});

		it.each([
			[
				"a record of the command, which may have started",
				{ command: { commandId: "c", state: "running", endedAt: null } },
			],
			[
				"a record of a command that already ended",
				{ command: { commandId: "c", state: "succeeded", endedAt: "x" } },
			],
			["a machine no longer running", { machine: { name: "build-a", state: "stopping" }, command: null }],
			["a machine gone", { machine: null }],
			["a run told to stop", { machine: undefined, workStopped: true }],
		])("sends nothing more on %s, and the outcome stays unknown", async (_label, look) => {
			const f = fixture();
			try {
				f.statuses.push({ ...noRecord(f), ...look });
				f.gateway.start.mockRejectedValueOnce(unanswered());
				const call = f.boundary.invoke("r1", "qorpera", "machine_run", run);
				await vi.advanceTimersByTimeAsync(1000);
				unknown((await call) as never);
				expect(f.gateway.start).toHaveBeenCalledTimes(1);
				expect(f.looks()).toHaveLength(1);
			} finally {
				f.boundary.close();
			}
		});

		it.each(["MACHINE_COMMAND_ENDED", "MACHINE_NOT_RUNNING"] as const)(
			"never reads %s after an unanswered send as nothing started: that send proves only itself",
			async (code) => {
				const f = fixture();
				try {
					f.statuses.push(noRecord(f));
					f.gateway.start
						.mockRejectedValueOnce(unanswered())
						.mockRejectedValueOnce(new CloudMachineCommandRefusal(code));
					const call = f.boundary.invoke("r1", "qorpera", "machine_run", run);
					await vi.advanceTimersByTimeAsync(1000);
					const result = await call;
					unknown(result as never);
					expect(result.contentItems[0].text).not.toContain(code);
					expect(f.gateway.start).toHaveBeenCalledTimes(2);
				} finally {
					f.boundary.close();
				}
			},
		);

		it("does not send again what the executor answered, a refusal or its 403, and does not look", async () => {
			const f = fixture();
			try {
				f.gateway.start.mockRejectedValueOnce(new Error("Machine command gateway unavailable"));
				unknown((await f.boundary.invoke("r1", "qorpera", "machine_run", run)) as never);
				expect(f.gateway.start).toHaveBeenCalledTimes(1);
				// The first send's refusal still says nothing started.
				f.gateway.start.mockRejectedValueOnce(new CloudMachineCommandRefusal("MACHINE_COMMAND_ENDED"));
				const refused = await f.boundary.invoke("r2", "qorpera", "machine_run", {
					...run,
					operationKey: "suite:2",
				});
				expect(f.content(refused as never).refused).toMatchObject({ reason: "MACHINE_COMMAND_ENDED" });
				expect(f.gateway.start).toHaveBeenCalledTimes(2);
				expect(f.looks()).toHaveLength(0);
			} finally {
				f.boundary.close();
			}
		});

		it("does not send again while it cannot look, and sends nothing more once the run stops", async () => {
			const f = fixture();
			try {
				f.statuses.push(new Error("database slow"), new Error("database slow"));
				f.gateway.start.mockRejectedValue(unanswered());
				const call = f.boundary.invoke("r1", "qorpera", "machine_run", run);
				await vi.advanceTimersByTimeAsync(3000);
				expect(f.gateway.start).toHaveBeenCalledTimes(1);
				expect(f.looks()).toHaveLength(2);
				f.run.abort();
				await call;
				await vi.advanceTimersByTimeAsync(60_000);
				expect(f.gateway.start).toHaveBeenCalledTimes(1);
			} finally {
				f.boundary.close();
			}
		});

		it("leaves machine_cancel as it was: an unanswered cancel is not sent again", async () => {
			const f = fixture();
			try {
				f.gateway.cancel.mockRejectedValueOnce(unanswered());
				const result = await f.boundary.invoke("r1", "qorpera", "machine_cancel", {
					operationKey: "stop:1",
					machine: "build-a",
					commandId: randomUUID(),
				});
				unknown(result as never);
				expect(f.gateway.cancel).toHaveBeenCalledTimes(1);
				expect(f.execute.mock.calls[0][0].performMs).toBeUndefined();
			} finally {
				f.boundary.close();
			}
		});

		it("waits for a read as long as the gateway does, and reads once", async () => {
			const f = fixture();
			try {
				const commandId = randomUUID();
				const answer = await f.gateway.read(
					{ machineId: f.listed[0].machineId },
					{ commandId },
					new AbortController().signal,
				);
				f.gateway.read.mockClear();
				f.gateway.read.mockImplementationOnce(
					() => new Promise((resolve) => setTimeout(() => resolve(answer), 20_000)),
				);
				const late = f.boundary.invoke("r1", "qorpera", "machine_read", { machine: "build-a", commandId });
				await vi.advanceTimersByTimeAsync(20_000);
				const result = await late;
				expect(result.success).toBe(true);
				expect(f.content(result as never)).toMatchObject({ commandId, state: "succeeded" });
				expect(f.gateway.read).toHaveBeenCalledTimes(1);
				// No answer at all: the agent hears so after that long, and a read is not sent again.
				f.gateway.read.mockClear();
				f.gateway.read.mockImplementationOnce(() => new Promise(() => undefined));
				const never = f.boundary.invoke("r2", "qorpera", "machine_read", { machine: "build-a", commandId });
				let settled = false;
				void never.then(() => {
					settled = true;
				});
				await vi.advanceTimersByTimeAsync(29_000);
				expect(settled).toBe(false);
				await vi.advanceTimersByTimeAsync(1000);
				await never;
				expect(settled).toBe(true);
				expect(f.gateway.read).toHaveBeenCalledTimes(1);
			} finally {
				f.boundary.close();
			}
		});
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

		it("answers a failed read after the wait as unconfirmed when nothing was reported", async () => {
			const f = fixture(undefined, true);
			try {
				running(f);
				f.gateway.read.mockRejectedValueOnce(new Error("transport_unavailable"));
				f.statuses.push(f.status(f.listed[0], "running"), f.status(f.listed[0], "succeeded"));
				const read = f.boundary.invoke("r1", "qorpera", "machine_read", {
					machine: "build-a",
					commandId: randomUUID(),
					waitSeconds: 60,
				});
				await vi.advanceTimersByTimeAsync(5_000);
				expect((await read).contentItems[0].text).toContain("TOOL_OUTCOME_UNCONFIRMED");
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

			it("when the read after the wait fails", async () => {
				const f = fixture(undefined, true);
				try {
					reported(f);
					f.gateway.read.mockRejectedValueOnce(new Error("transport_unavailable"));
					f.statuses.push(f.status(f.listed[0], "running"), f.status(f.listed[0], "succeeded"));
					const read = answer(f, "r1");
					await vi.advanceTimersByTimeAsync(5_000);
					const result = await read;
					expect(result.success).toBe(true);
					expect(f.content(result as never)).toMatchObject({
						refused: { reason: "MACHINE_READ_UNANSWERED" },
						companyFolder: { notSaved },
					});
					expect(f.gateway.read).toHaveBeenCalledTimes(2);
				} finally {
					f.boundary.close();
				}
			});

			it("when a later receipt says nothing of the folder", async () => {
				const f = fixture(undefined, true);
				try {
					reported(f);
					f.statuses.push(f.status(f.listed[0], "running"), f.status(f.listed[0], "succeeded"));
					const read = answer(f, "r1");
					await vi.advanceTimersByTimeAsync(5_000);
					expect(f.content((await read) as never)).toMatchObject({
						state: "succeeded",
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

		it("a starting machine's executor is told at once, and its word ends the worker's wait", async () => {
			const f = fixture(undefined, true);
			try {
				f.started.state = "starting";
				let say = (_told: boolean) => {};
				f.gateway.wake.mockImplementationOnce(
					() =>
						new Promise<boolean>((settle) => {
							say = settle;
						}),
				);
				const looking = { schema: "qorpera.machine-status/v1", machine: { ...f.listed[0], state: "starting" } };
				const up = { schema: "qorpera.machine-status/v1", machine: { ...f.listed[0], state: "running" } };
				f.statuses.push(looking, up);
				const start = f.boundary.invoke("s1", "qorpera", "machine_start", {
					operationKey: "woken",
					machine: f.listed[0].name,
					waitSeconds: 120,
				});
				await vi.advanceTimersByTimeAsync(100);
				expect(f.gateway.wake).toHaveBeenCalledWith({ machineId: f.listed[0].machineId }, true, expect.anything());
				expect(f.looks()).toHaveLength(1);
				// Well before its next look.
				await vi.advanceTimersByTimeAsync(400);
				say(true);
				await vi.advanceTimersByTimeAsync(0);
				const result = await start;
				expect(f.content(result as never).machine.state).toBe("running");
				expect(f.looks()).toHaveLength(2);
			} finally {
				f.boundary.close();
			}
		});

		it("a lost word costs only the looks every few seconds", async () => {
			const f = fixture(undefined, true);
			try {
				f.started.state = "starting";
				f.gateway.wake.mockRejectedValueOnce(new Error("Machine command gateway unavailable"));
				const looking = { schema: "qorpera.machine-status/v1", machine: { ...f.listed[0], state: "starting" } };
				const up = { schema: "qorpera.machine-status/v1", machine: { ...f.listed[0], state: "running" } };
				f.statuses.push(looking, looking, up);
				const start = f.boundary.invoke("s1", "qorpera", "machine_start", {
					operationKey: "lost",
					machine: f.listed[0].name,
					waitSeconds: 120,
				});
				await vi.advanceTimersByTimeAsync(100);
				// The word's failure ends no wait: the next look comes at its time.
				expect(f.looks()).toHaveLength(1);
				await vi.advanceTimersByTimeAsync(10_000);
				const result = await start;
				expect(result.success).toBe(true);
				expect(f.content(result as never).machine.state).toBe("running");
				expect(f.looks()).toHaveLength(3);
			} finally {
				f.boundary.close();
			}
		});

		it("a machine in line, or one already running, is not waited on", async () => {
			const f = fixture(undefined, true);
			try {
				f.started.state = "waiting";
				const lined = await f.boundary.invoke("s1", "qorpera", "machine_start", {
					operationKey: "lined",
					machine: f.listed[0].name,
					waitSeconds: 120,
				});
				expect(f.content(lined as never).machine.state).toBe("waiting");
				expect(f.gateway.wake).toHaveBeenCalledWith({ machineId: f.listed[0].machineId }, false, expect.anything());
				f.gateway.wake.mockClear();
				f.started.state = "running";
				await f.boundary.invoke("s2", "qorpera", "machine_start", {
					operationKey: "up",
					machine: f.listed[0].name,
					waitSeconds: 120,
				});
				expect(f.gateway.wake).not.toHaveBeenCalled();
				expect(f.looks()).toEqual([]);
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

	it("makes a desktop computer large enough for its desktop, and sends only the size to the start", async () => {
		const f = fixture();
		try {
			// Asked small beside desktop true: raised to the least a desktop wants. Asked larger: kept.
			const small = {
				operationKey: "d1",
				name: "shop-test",
				purpose: "Try the shop as a customer",
				cpus: 1,
				memoryGiB: 1,
			};
			expect((await f.boundary.invoke("d1", "qorpera", "machine_start", { ...small, desktop: true })).success).toBe(
				true,
			);
			expect(f.execute.mock.calls[0][0].operation.arguments).toEqual({
				name: "shop-test",
				purpose: "Try the shop as a customer",
				...CLOUD_MACHINE_DESKTOP_LEAST,
				diskGiB: 40,
				lifetime: "task",
			});
			const large = { operationKey: "d2", name: "editor-test", purpose: "Try the 3D editor", cpus: 4, memoryGiB: 8 };
			expect((await f.boundary.invoke("d2", "qorpera", "machine_start", { ...large, desktop: true })).success).toBe(
				true,
			);
			expect(f.execute.mock.calls[1][0].operation.arguments).toMatchObject({ cpus: 4, memoryGiB: 8 });
			// Without it, or with desktop false, a small machine stays small: machines have no screen unless asked.
			expect(
				(
					await f.boundary.invoke("d3", "qorpera", "machine_start", {
						...small,
						operationKey: "d3",
						desktop: false,
					})
				).success,
			).toBe(true);
			expect(f.execute.mock.calls[2][0].operation.arguments).toMatchObject({ cpus: 1, memoryGiB: 1 });
			expect(f.execute.mock.calls[2][0].operation.arguments).not.toHaveProperty("desktop");
			// A wake names only the machine, and desktop is yes or no.
			for (const [index, bad] of [
				{ operationKey: "x", machine: "shop-test", desktop: true },
				{ operationKey: "x", name: "shop-test", purpose: "x", desktop: "yes" },
			].entries())
				expect((await f.boundary.invoke(`bad-desktop-${index}`, "qorpera", "machine_start", bad)).success).toBe(
					false,
				);
			// The agent is told how to ask, and that a smaller machine refuses its desktop.
			expect(CLOUD_MACHINE_START_DESCRIPTION).toContain(
				"desktop true makes it a desktop computer, with at least 2 cpus and 4 GiB",
			);
			expect(CLOUD_MACHINE_START_DESCRIPTION).toContain("desktop start <company files, folders or URLs>");
			// Every command the text says takes --shot is one the machine's desktop command takes it for; run is not.
			const desktop = readFileSync(new URL("../../../deploy/machine/desktop", import.meta.url), "utf8");
			const takesShot =
				desktop
					.match(/\n(open(?: \| [a-z]+)+)\)\n\tif \(\( \$# >= 3 \)\) && \[\[ \$\{\*: -2:1\} == --shot \]\]/)?.[1]
					.split(" | ") ?? [];
			const advertised =
				CLOUD_MACHINE_START_DESCRIPTION.match(/end a ([a-z, ]+) with --shot /)?.[1].split(/, | or /) ?? [];
			expect(advertised).toEqual(["click", "type", "key", "scroll", "open"]);
			for (const command of advertised) expect(takesShot).toContain(command);
			expect(takesShot).not.toContain("run");
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

	// 20260930705000: save_coding_value, a key the agent copied on its machine's desktop, into the vault.
	describe("save_coding_value", () => {
		const vault = () => {
			const values = {
				codingValuePrepare: vi.fn<CloudMachineCodingValues["codingValuePrepare"]>(async () => ({
					schema: "qorpera.coding-value-prepare-answer/v1" as const,
					variable: "npm_token",
					replaced: false,
				})),
				codingValueCapture: vi.fn<CloudMachineCodingValues["codingValueCapture"]>(async () => ({
					schema: "qorpera.coding-value-capture-answer/v1" as const,
					variable: "npm_token",
					repository: "acme/web",
					version: 2,
					unchanged: false,
				})),
			};
			return values;
		};
		const args = {
			operationKey: "npm-key",
			machine: "build-a",
			service: "npm",
			variable: "npm_token",
			repository: "acme/web",
			purpose: "Installs the private packages.",
		};

		it("is offered to a company agent's run with the vault, never to a worker or without the vault", () => {
			const agent = fixture(undefined, false, vault());
			const helper = fixture(undefined, true, vault());
			const without = fixture();
			try {
				expect(agent.tools.map((tool) => tool.name).at(-1)).toBe("save_coding_value");
				expect(helper.tools.map((tool) => tool.name)).not.toContain("save_coding_value");
				expect(without.tools.map((tool) => tool.name)).not.toContain("save_coding_value");
				expect(CLOUD_RUNTIME_TOOL_OPERATIONS).toContain("save_coding_value");
				const save = agent.tools.find((tool) => tool.name === "save_coding_value")!;
				expect(Buffer.byteLength(save.description)).toBeLessThanOrEqual(4096);
				for (const words of [
					"press the site's own Copy button",
					"You never pass the key",
					"clears the clipboard",
					"Never type, paste, print, echo or write a key anywhere",
					"take no desktop shot while a key is on the screen: shots are kept in the company folder",
					"ask_member with surface secret and connectorId environment",
					"owner or an admin",
				])
					expect(save.description).toContain(words);
				expect(save.inputSchema).toMatchObject({
					additionalProperties: false,
					required: ["operationKey", "machine", "service", "variable", "repository", "purpose"],
				});
				expect(Object.keys(save.inputSchema.properties as object).sort()).toEqual([
					"machine",
					"operationKey",
					"purpose",
					"repository",
					"service",
					"variable",
				]);
				expect((save.inputSchema.properties as Record<string, { enum?: unknown }>).service?.enum).toEqual([
					"npm",
					"github",
					"stripe",
					"resend",
				]);
			} finally {
				for (const f of [agent, helper, without]) f.boundary.close();
			}
		});

		it("takes where the key goes and the machine, never a key, checked as the database checks them", () => {
			const f = fixture(undefined, false, vault());
			try {
				const save = f.tools.find((tool) => tool.name === "save_coding_value")!;
				expect(save.parseArguments(args)).toEqual(args);
				// A purpose is one line of plain text.
				expect(save.parseArguments({ ...args, purpose: "  Installs\nthe  packages. " })).toMatchObject({
					purpose: "Installs the packages.",
				});
				for (const bad of [
					{ ...args, value: `npm_${"a".repeat(36)}` },
					{ ...args, service: "pypi" },
					{ ...args, service: "NPM" },
					{ ...args, variable: "NPM_TOKEN" },
					{ ...args, variable: "path" },
					{ ...args, variable: "git_token" },
					{ ...args, variable: "openai_api_key" },
					{ ...args, repository: "Acme/Web" },
					{ ...args, repository: "web" },
					{ ...args, repository: "acme/web/src" },
					{ ...args, purpose: " " },
					{ ...args, purpose: "x".repeat(301) },
					{ ...args, purpose: "bell\u0007" },
					{ ...args, machine: "Build A" },
					{ ...args, operationKey: "" },
					(({ purpose: _purpose, ...rest }) => rest)(args),
				])
					expect(() => save.parseArguments(bad), JSON.stringify(bad)).toThrow();
			} finally {
				f.boundary.close();
			}
		});

		it("saves through one receipt: the vault's key, the machine's box, then the vault's store", async () => {
			const values = vault();
			const f = fixture(undefined, false, values);
			try {
				const result = await f.boundary.invoke("v1", "qorpera", "save_coding_value", args);
				expect(result.success).toBe(true);
				expect(f.content(result as never)).toEqual({
					saved: { service: "npm", variable: "npm_token", repository: "acme/web", version: 2, unchanged: false },
				});
				const operation = f.execute.mock.calls[0]![0].operation;
				expect(operation).toEqual({
					tool: "save_coding_value",
					toolVersion: "qorpera.machine-tools/v1",
					logicalOperationKey: "npm-key",
					arguments: args,
					target: { realm: "company_machine", machineId: f.listed[0]!.machineId },
					requiresCompanyRevision: false,
				});
				const call = {
					binding: f.binding,
					receiptId: f.receiptId,
					idempotencyKey: "b".repeat(64),
					envelope: cloudNativeToolOperationEnvelope(f.identity, operation),
				};
				expect(values.codingValuePrepare).toHaveBeenCalledWith(call, expect.any(AbortSignal));
				expect(f.gateway.codingValue).toHaveBeenCalledWith(
					{ machineId: f.listed[0]!.machineId },
					{ commandId: f.receiptId, envelope: call.envelope },
					expect.any(AbortSignal),
				);
				const box = (await f.gateway.codingValue.mock.results[0]!.value).box;
				expect(values.codingValueCapture).toHaveBeenCalledWith({ ...call, box }, expect.any(AbortSignal));
				expect(values.codingValuePrepare.mock.invocationCallOrder[0]).toBeLessThan(
					f.gateway.codingValue.mock.invocationCallOrder[0]!,
				);
				expect(f.gateway.codingValue.mock.invocationCallOrder[0]).toBeLessThan(
					values.codingValueCapture.mock.invocationCallOrder[0]!,
				);
				// The model sees where it went and its version, never the box.
				expect(JSON.stringify(result)).not.toContain("ciphertext");
				// No command ran on the machine.
				expect(f.gateway.start).not.toHaveBeenCalled();
			} finally {
				f.boundary.close();
			}
		});

		it("answers the machine's and the vault's refusals in words, and stores nothing after one", async () => {
			for (const code of [
				"CLIPBOARD_EMPTY",
				"CLIPBOARD_NOT_A_KEY",
				"CLIPBOARD_MORE_THAN_ONE_KEY",
				"DESKTOP_NOT_RUNNING",
				"MACHINE_IMAGE_WITHOUT_CODING_VALUES",
			] as const) {
				const values = vault();
				const f = fixture(undefined, false, values);
				try {
					f.gateway.codingValue.mockRejectedValueOnce(new CloudMachineCodingValueRefusal(code));
					const result = await f.boundary.invoke("v2", "qorpera", "save_coding_value", args);
					expect(result.success).toBe(true);
					const answer = f.content(result as never) as {
						saved: boolean;
						refused: { reason: string; message: string };
					};
					expect(answer.saved).toBe(false);
					expect(answer.refused.reason).toBe(code);
					expect(answer.refused.message.length).toBeGreaterThan(20);
					expect(values.codingValueCapture).not.toHaveBeenCalled();
				} finally {
					f.boundary.close();
				}
			}
			// The vault's refusal comes first: the machine is never asked.
			const values = vault();
			values.codingValuePrepare.mockResolvedValueOnce({
				schema: "qorpera.coding-value-refusal/v1",
				code: "42501",
				message: "Only owners and admins can save coding values; ask one of them",
			});
			const f = fixture(undefined, false, values);
			try {
				const result = await f.boundary.invoke("v3", "qorpera", "save_coding_value", args);
				expect(f.content(result as never)).toEqual({
					saved: false,
					refused: {
						reason: "VAULT_REFUSED",
						code: "42501",
						message: "Only owners and admins can save coding values; ask one of them",
					},
				});
				expect(f.gateway.codingValue).not.toHaveBeenCalled();
			} finally {
				f.boundary.close();
			}
			// A machine that is not running: no receipt.
			const asleep = fixture([{ name: "build-a", state: "stopped" }], false, vault());
			try {
				const result = await asleep.boundary.invoke("v4", "qorpera", "save_coding_value", args);
				expect(result.contentItems[0]!.text).toContain("MACHINE_NOT_RUNNING");
				expect(asleep.execute).not.toHaveBeenCalled();
			} finally {
				asleep.boundary.close();
			}
		});
	});
	// 20260930710000: fill_company_account, a company account's value typed by the vault into the machine's browser.
	describe("fill_company_account", () => {
		const account = "6f1c2c1e-3a51-4b9e-9a3e-0d2f6f1b7a10";
		const args = { operationKey: "npm-login-1", machine: "build-a", account, field: "password" };

		it("is offered to a company agent's run on a host with the vault's accounts, never to a worker or without them", () => {
			const agent = fixture(undefined, false, undefined, true);
			const helper = fixture(undefined, true, undefined, true);
			const without = fixture();
			try {
				expect(agent.tools.map((tool) => tool.name).at(-1)).toBe("fill_company_account");
				expect(helper.tools.map((tool) => tool.name)).not.toContain("fill_company_account");
				expect(without.tools.map((tool) => tool.name)).not.toContain("fill_company_account");
				expect(CLOUD_RUNTIME_TOOL_OPERATIONS).toContain("fill_company_account");
				const fill = agent.tools.find((tool) => tool.name === "fill_company_account")!;
				expect(Buffer.byteLength(fill.description)).toBeLessThanOrEqual(4096);
				for (const words of [
					"The vault types it: you never see, pass, say or write a password",
					"desktop open",
					"desktop click into the field",
					"company_account open makes the account first",
					"find_mail",
					"over https",
					"not a frame inside it",
					"Never type, paste, read aloud, write down or screenshot a password",
					"stop at once and never retry: set the account needs_person",
					"give every call a new operationKey",
				])
					expect(fill.description).toContain(words);
				expect(fill.inputSchema).toMatchObject({
					additionalProperties: false,
					required: ["operationKey", "machine", "account", "field"],
				});
				expect(Object.keys(fill.inputSchema.properties as object).sort()).toEqual([
					"account",
					"field",
					"machine",
					"operationKey",
				]);
				const properties = fill.inputSchema.properties as Record<string, { enum?: unknown; description?: string }>;
				expect(properties.field?.enum).toEqual(["login", "password", "code"]);
				expect(properties.field?.description).toContain("authenticator");
				expect(properties.account?.description).toContain("company_account find or open");
			} finally {
				for (const f of [agent, helper, without]) f.boundary.close();
			}
		});

		it("takes the machine, the account and the field, never a value", () => {
			const f = fixture(undefined, false, undefined, true);
			try {
				const fill = f.tools.find((tool) => tool.name === "fill_company_account")!;
				expect(fill.parseArguments(args)).toEqual(args);
				for (const field of ["login", "code"])
					expect(fill.parseArguments({ ...args, field })).toMatchObject({ field });
				for (const bad of [
					{ ...args, value: "hunter2" },
					{ ...args, password: "hunter2" },
					{ ...args, field: "new_password" },
					{ ...args, field: "signing_secret" },
					{ ...args, account: account.toUpperCase() },
					{ ...args, account: "npm" },
					{ ...args, machine: "Build A" },
					{ ...args, operationKey: "" },
					(({ field: _field, ...rest }) => rest)(args),
				])
					expect(() => fill.parseArguments(bad), JSON.stringify(bad)).toThrow();
			} finally {
				f.boundary.close();
			}
		});

		it("types through one receipt: the machine's executor, bound to this call, answers filled and nothing else", async () => {
			const f = fixture(undefined, false, undefined, true);
			try {
				const result = await f.boundary.invoke("f1", "qorpera", "fill_company_account", args);
				expect(result.success).toBe(true);
				expect(f.content(result as never)).toEqual({ filled: { machine: "build-a", account, field: "password" } });
				const operation = f.execute.mock.calls[0]![0].operation;
				expect(operation).toEqual({
					tool: "fill_company_account",
					toolVersion: "qorpera.machine-tools/v1",
					logicalOperationKey: "npm-login-1",
					arguments: args,
					target: { realm: "company_machine", machineId: f.listed[0]!.machineId },
					requiresCompanyRevision: false,
				});
				expect(f.gateway.accountFill).toHaveBeenCalledWith(
					{ machineId: f.listed[0]!.machineId },
					{
						commandId: f.receiptId,
						envelope: cloudNativeToolOperationEnvelope(f.identity, operation),
						idempotencyKey: "b".repeat(64),
					},
					expect.any(AbortSignal),
				);
				expect(f.gateway.start).not.toHaveBeenCalled();
			} finally {
				f.boundary.close();
			}
		});

		it("answers the machine's and the vault's refusals in words, and a stopped machine with no receipt", async () => {
			for (const code of [
				"FILL_WRONG_SITE",
				"FILL_IN_FRAME",
				"FILL_WRONG_BOX",
				"NO_FOCUSED_PAGE",
				"BROWSER_NOT_OPEN",
				"ACCOUNTS_SWITCHED_OFF",
				"MACHINE_IMAGE_WITHOUT_ACCOUNT_FILLS",
				"FILL_UNCONFIRMED",
				"FILL_LOST",
			] as const) {
				const f = fixture(undefined, false, undefined, true);
				try {
					f.gateway.accountFill.mockRejectedValueOnce(new CloudMachineAccountFillRefusal(code));
					const result = await f.boundary.invoke("f2", "qorpera", "fill_company_account", args);
					expect(result.success).toBe(true);
					const answer = f.content(result as never) as {
						filled: boolean;
						refused: { reason: string; message: string };
					};
					expect(answer.filled).toBe(false);
					expect(answer.refused.reason).toBe(code);
					expect(answer.refused.message.length).toBeGreaterThan(20);
				} finally {
					f.boundary.close();
				}
			}
			// A bot check: stop, never retry, needs_person.
			const stopped = fixture(undefined, false, undefined, true);
			try {
				stopped.gateway.accountFill.mockRejectedValueOnce(new CloudMachineAccountFillRefusal("SITE_STOP_CAPTCHA"));
				const result = await stopped.boundary.invoke("f3", "qorpera", "fill_company_account", args);
				const answer = stopped.content(result as never) as { refused: { message: string } };
				expect(answer.refused.message).toContain("never retry");
				expect(answer.refused.message).toContain("needs_person");
			} finally {
				stopped.boundary.close();
			}
			// The vault's own words.
			const vault = fixture(undefined, false, undefined, true);
			try {
				vault.gateway.accountFill.mockRejectedValueOnce(
					new CloudMachineAccountFillRefusal("VAULT_REFUSED", "The company has no such open account"),
				);
				const result = await vault.boundary.invoke("f4", "qorpera", "fill_company_account", args);
				expect(vault.content(result as never)).toEqual({
					filled: false,
					refused: { reason: "VAULT_REFUSED", message: "The company has no such open account" },
				});
			} finally {
				vault.boundary.close();
			}
			// An answer that is no refusal fails the call: its outcome is unconfirmed, never "filled".
			const lost = fixture(undefined, false, undefined, true);
			try {
				lost.gateway.accountFill.mockRejectedValueOnce(new CloudMachineCommandUnanswered());
				const result = await lost.boundary.invoke("f5", "qorpera", "fill_company_account", args);
				expect(JSON.stringify(result)).not.toContain('"filled":{');
			} finally {
				lost.boundary.close();
			}
			const asleep = fixture([{ name: "build-a", state: "stopped" }], false, undefined, true);
			try {
				const result = await asleep.boundary.invoke("f6", "qorpera", "fill_company_account", args);
				expect(result.contentItems[0]!.text).toContain("MACHINE_NOT_RUNNING");
				expect(asleep.execute).not.toHaveBeenCalled();
			} finally {
				asleep.boundary.close();
			}
		});
	});
});
