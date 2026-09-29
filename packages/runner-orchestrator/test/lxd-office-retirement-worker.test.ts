import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lxdOfficeGuestPlan } from "../src/lxd-office-guest.ts";
import { publish } from "../src/lxd-office-journal-files.ts";
import { OFFICE_RETIRED_MARKER, readLxdOfficeRetiredMarker } from "../src/lxd-office-retirement-control.ts";
import { LxdOfficeRetirementWorker, OFFICE_RETIREMENT_REQUEST } from "../src/lxd-office-retirement-worker.ts";
import { officePowerOffWorkerFixture } from "./fixtures/office-power-off-worker.ts";
import { serviceStartId as id } from "./fixtures/office-service-start.ts";

const roots: string[] = [],
	signal = () => new AbortController().signal;
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const deleteCommandId = "d0000000-0000-4000-8000-000000000001";
const deleteOperationId = id(700);

/** A powered-off office (the real power-off worker ran) and a fake of the D3a SQL. */
async function fixture() {
	const f = await officePowerOffWorkerFixture(roots);
	await expect(f.run()).resolves.toMatchObject({ state: "powered_off" });
	const name = lxdOfficeGuestPlan(f.binding).request.name;
	const sql = {
		deleting: true,
		deleteCommandId,
		operationId: null as string | null,
		expiresInMs: 5000,
		loseRetireReply: false,
		challenges: [] as string[],
	};
	const answer = () =>
		sql.deleting
			? {
					schema: "qorpera.office-retirement/v1",
					companyComputerId: f.binding.companyComputerId,
					computerGeneration: f.binding.computerGeneration,
					allocationId: f.binding.allocationId,
					instanceSha256: f.request.startup.instanceSha256,
					transitionId: f.request.transitionId,
					deleteCommandId: sql.deleteCommandId,
					deleteOperationId: sql.operationId,
					state: sql.operationId === null ? "retiring" : "retired",
				}
			: null;
	const registry = vi.fn(async (method: string, args: Record<string, unknown>, checked: AbortSignal) => {
		checked.throwIfAborted();
		expect(args.p_request).toEqual(f.request);
		if (method === "qorpera_runtime_office_retirement") return answer();
		if (method === "qorpera_prepare_runtime_office_retirement") {
			sql.challenges.push(args.p_challenge_id as string);
			return {
				schema: "qorpera.office-retirement-challenge/v1",
				challengeId: args.p_challenge_id,
				deleteCommandId: sql.deleteCommandId,
				expiresInMs: sql.expiresInMs,
			};
		}
		if (method === "qorpera_retire_runtime_office") {
			expect(args.p_evidence).toEqual({
				schema: "qorpera.office-retirement-evidence/v1",
				deleteCommandId: sql.deleteCommandId,
				deleteOperationId,
			});
			sql.operationId = deleteOperationId;
			if (sql.loseRetireReply) throw new Error("reply lost");
			return answer();
		}
		throw new Error(`unexpected ${method}`);
	});
	f.submit.mockImplementation(async (project, action) => {
		expect(action).toEqual({ action: "delete", name });
		f.state.absent = true;
		return { project, instanceName: name, operationId: deleteOperationId };
	});
	f.submit.mockClear();
	f.poll.mockClear();
	const run = () =>
		new LxdOfficeRetirementWorker(
			{ policy: f.policy, check: f.check },
			{ call: registry as never },
			{ client: f.client, kernelLock: f.kernelLock },
		).reconcileSettled(f.activation.request.intentId, f.request, signal());
	const methods = () => registry.mock.calls.map(([method]) => method);
	const record = async (file: string) => JSON.parse(await readFile(join(f.root, file), "utf8"));
	const identity = {
		scope: f.request.startup.scope,
		computerGeneration: f.request.startup.computerGeneration,
	};
	return { ...f, sql, registry, run, methods, record, identity };
}

describe("retiring a deleted company's powered-off computer", () => {
	it("keeps a living company's computer and pins nothing", async () => {
		const f = await fixture();
		f.sql.deleting = false;
		await expect(f.run()).resolves.toMatchObject({ state: "kept" });
		expect(f.methods()).toEqual(["qorpera_runtime_office_retirement"]);
		expect(f.submit).not.toHaveBeenCalled();
		await expect(readFile(join(f.root, OFFICE_RETIREMENT_REQUEST))).rejects.toThrow("ENOENT");
	});
	it("pins the delete, deletes the stopped VM once in a SQL window, releases it and writes the marker", async () => {
		const f = await fixture();
		await expect(f.run()).resolves.toEqual({
			state: "retired",
			intentId: f.activation.request.intentId,
			allocationId: f.binding.allocationId,
			transitionId: f.request.transitionId,
			deleteCommandId,
		});
		expect(f.methods()).toEqual([
			"qorpera_runtime_office_retirement",
			"qorpera_prepare_runtime_office_retirement",
			"qorpera_retire_runtime_office",
		]);
		expect(f.submit).toHaveBeenCalledOnce();
		expect(f.submit.mock.invocationCallOrder[0]!).toBeGreaterThan(f.registry.mock.invocationCallOrder[1]!);
		expect(await f.record(OFFICE_RETIREMENT_REQUEST)).toMatchObject({
			schema: "qorpera.lxd-office-retirement-request/v1",
			intentId: f.activation.request.intentId,
			request: f.request,
			deleteCommandId,
		});
		expect(await f.record(`office-retirement-challenge-${f.sql.challenges[0]}.json`)).toEqual({
			schema: "qorpera.lxd-office-retirement-challenge/v1",
			challengeId: f.sql.challenges[0],
			deleteCommandId,
		});
		const journal = join(f.root, f.binding.allocationId),
			events = await Promise.all(
				(await readdir(journal))
					.filter((file) => /^\d{6}\.json$/.test(file))
					.sort()
					.map(async (file) => JSON.parse(await readFile(join(journal, file), "utf8"))),
			);
		expect(events.slice(-3).map(({ commandId, action, kind }) => ({ commandId, action, kind }))).toEqual(
			["dispatch", "accepted", "settled"].map((kind) => ({ commandId: deleteCommandId, action: "delete", kind })),
		);
		const marker = await readLxdOfficeRetiredMarker(f.root, f.identity);
		expect(marker).toMatchObject({ state: "retired", deleteCommandId, deleteOperationId });
		await expect(f.run()).rejects.toThrow("OFFICE_RETIREMENT_UNCONFIRMED");
		expect(f.submit).toHaveBeenCalledOnce();
	});
	it("answers a lost release reply from SQL's retired answer, without a second delete", async () => {
		const f = await fixture();
		f.sql.loseRetireReply = true;
		await expect(f.run()).rejects.toThrow("OFFICE_RETIREMENT_UNCONFIRMED");
		await expect(readFile(join(f.root, OFFICE_RETIRED_MARKER))).rejects.toThrow("ENOENT");
		await expect(f.run()).resolves.toMatchObject({ state: "retired" });
		expect(f.submit).toHaveBeenCalledOnce();
		expect(f.methods().filter((method) => method === "qorpera_retire_runtime_office")).toHaveLength(1);
		expect(await readLxdOfficeRetiredMarker(f.root, f.identity)).toMatchObject({ deleteOperationId });
	});
	it("never deletes a VM that is not stopped, and takes no window for it", async () => {
		const f = await fixture();
		f.state.status = "Running";
		f.state.statusCode = 103;
		await expect(f.run()).rejects.toThrow("OFFICE_RETIREMENT_UNCONFIRMED");
		expect(f.methods()).toEqual(["qorpera_runtime_office_retirement"]);
		expect(f.submit).not.toHaveBeenCalled();
	});
	it("dispatches nothing when the window expired, and a later pass takes a new one", async () => {
		const f = await fixture();
		f.sql.expiresInMs = 0;
		await expect(f.run()).rejects.toThrow("OFFICE_RETIREMENT_UNCONFIRMED");
		expect(f.submit).not.toHaveBeenCalled();
		f.sql.expiresInMs = 5000;
		await expect(f.run()).resolves.toMatchObject({ state: "retired" });
		expect(new Set(f.sql.challenges).size).toBe(2);
		expect(f.submit).toHaveBeenCalledOnce();
	});
	it("holds an unknown or failed delete for an operator and never repeats it", async () => {
		const unknown = await fixture();
		unknown.submit.mockRejectedValue(new Error("reply lost"));
		await expect(unknown.run()).resolves.toMatchObject({ state: "unknown", deleteCommandId });
		await expect(unknown.run()).resolves.toMatchObject({ state: "unknown" });
		expect(unknown.submit).toHaveBeenCalledOnce();
		expect(unknown.methods()).not.toContain("qorpera_retire_runtime_office");
		const failed = await fixture();
		failed.poll.mockResolvedValue("failed");
		await expect(failed.run()).resolves.toMatchObject({ state: "failed" });
		await expect(failed.run()).resolves.toMatchObject({ state: "failed" });
		expect(failed.submit).toHaveBeenCalledOnce();
		expect(failed.methods()).not.toContain("qorpera_retire_runtime_office");
	});
	it("does not release a VM that is still present after its delete settled", async () => {
		const f = await fixture();
		const submit = f.submit.getMockImplementation()!;
		f.submit.mockImplementation(async (...args) => {
			const reference = await submit(...args);
			f.state.absent = false;
			return reference;
		});
		await expect(f.run()).rejects.toThrow("OFFICE_RETIREMENT_UNCONFIRMED");
		expect(f.methods()).not.toContain("qorpera_retire_runtime_office");
	});
	it("refuses a changed delete command or a withdrawn retirement once pinned", async () => {
		const f = await fixture();
		f.sql.expiresInMs = 0;
		await expect(f.run()).rejects.toThrow("OFFICE_RETIREMENT_UNCONFIRMED");
		f.sql.expiresInMs = 5000;
		f.sql.deleteCommandId = "d0000000-0000-4000-8000-000000000002";
		await expect(f.run()).rejects.toThrow("OFFICE_RETIREMENT_UNCONFIRMED");
		f.sql.deleteCommandId = deleteCommandId;
		f.sql.deleting = false;
		await expect(f.run()).rejects.toThrow("OFFICE_RETIREMENT_UNCONFIRMED");
		expect(f.submit).not.toHaveBeenCalled();
	});
	it("requires the power-off worker's completion record", async () => {
		const f = await fixture();
		await rm(f.paths.done);
		await expect(f.run()).rejects.toThrow("OFFICE_RETIREMENT_UNCONFIRMED");
		expect(f.registry).not.toHaveBeenCalled();
	});
});

describe("the local retired marker", () => {
	it("is read only for this computer and generation, and only as retired", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "office-retired-")));
		roots.push(root);
		const identity = {
			scope: {
				companyId: id(1),
				environmentId: id(2),
				companyComputerId: id(3),
				logicalComputerId: id(4),
			},
			computerGeneration: 2,
		};
		await expect(readLxdOfficeRetiredMarker(root, identity)).resolves.toBeUndefined();
		const retirement = {
			schema: "qorpera.office-retirement/v1",
			companyComputerId: id(3),
			computerGeneration: 2,
			allocationId: id(5),
			instanceSha256: "a".repeat(64),
			transitionId: id(6),
			deleteCommandId,
			deleteOperationId,
			state: "retired",
		};
		await publish(
			root,
			OFFICE_RETIRED_MARKER,
			Buffer.from(JSON.stringify({ schema: "qorpera.lxd-office-retired/v1", intentId: id(7), retirement })),
		);
		await expect(readLxdOfficeRetiredMarker(root, identity)).resolves.toEqual(retirement);
		await expect(readLxdOfficeRetiredMarker(root, { ...identity, computerGeneration: 3 })).rejects.toThrow(
			"OFFICE_RETIREMENT_INVALID",
		);
		await expect(
			readLxdOfficeRetiredMarker(root, { ...identity, scope: { ...identity.scope, companyComputerId: id(8) } }),
		).rejects.toThrow("OFFICE_RETIREMENT_INVALID");
		await rm(join(root, OFFICE_RETIRED_MARKER));
		await publish(
			root,
			OFFICE_RETIRED_MARKER,
			Buffer.from(
				JSON.stringify({
					schema: "qorpera.lxd-office-retired/v1",
					intentId: id(7),
					retirement: { ...retirement, state: "retiring", deleteOperationId: null },
				}),
			),
		);
		await expect(readLxdOfficeRetiredMarker(root, identity)).rejects.toThrow("OFFICE_RETIRED_MARKER_INVALID");
	});
});
