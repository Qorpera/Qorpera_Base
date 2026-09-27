import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { setImmediate as immediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
	installOfficeLifecycleTiming,
	observeOfficeTimingMethod,
} from "../../../scripts/acceptance/office-lifecycle-timing.ts";
import { projectOfficeResetTiming } from "../../../scripts/acceptance/office-lifecycle-timing-evidence.mjs";
import { LxdUnixClient } from "../src/lxd-client.ts";
import { LxdOfficePhysicalGate } from "../src/lxd-office-physical-gate.ts";
import { type LxdOfficeResetResult, LxdOfficeResetWorker } from "../src/lxd-office-reset-worker.ts";
import { LxdOfficeTypedInspectionControl } from "../src/lxd-office-typed-inspection.ts";

const restores: Array<() => void> = [];
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
	for (const restore of restores.splice(0).reverse()) restore();
	vi.restoreAllMocks();
	for (const server of servers.splice(0))
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// These small wrapper tests never execute a reset or assert physical authority.
// The separately composed profile exercises the actual worker and controllers.
const result: LxdOfficeResetResult = {
	state: "held",
	phase: "prepared",
	intentId: "unit",
	allocationId: "unit",
	resetId: "unit",
	transitionId: "unit",
	activationId: "unit",
};
const attempt = (key: "reconcile" | "reconcileSettled", signal = new AbortController().signal, input: unknown = {}) =>
	Reflect.apply(LxdOfficeResetWorker.prototype[key], {}, [input, signal]) as Promise<LxdOfficeResetResult>;
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}

it("preserves synchronous receiver, argument identities, value, descriptor and exact thrown error", () => {
	const value = {},
		arg = {},
		signal = new AbortController().signal,
		failure = new Error("private error");
	const receiver = {
		method(input: object, caller: AbortSignal) {
			expect(this).toBe(receiver);
			expect(input).toBe(arg);
			expect(caller).toBe(signal);
			return value;
		},
		fail() {
			throw failure;
		},
	};
	const descriptor = Object.getOwnPropertyDescriptor(receiver, "method");
	const restore = observeOfficeTimingMethod(
		receiver,
		"method",
		() => {
			throw new Error("observer");
		},
		() => {
			throw new Error("entry");
		},
	);
	restores.push(
		restore,
		observeOfficeTimingMethod(receiver, "fail", () => {
			throw new Error("observer");
		}),
	);
	expect(receiver.method(arg, signal)).toBe(value);
	try {
		receiver.fail();
		expect.fail("must throw");
	} catch (error) {
		expect(error).toBe(failure);
	}
	restore();
	expect(Object.getOwnPropertyDescriptor(receiver, "method")).toEqual(descriptor);
});

it("preserves original Promise and rejection identity while swallowing async entry and observer failures", async () => {
	const failure = new Error("original"),
		value = {},
		rejected = Promise.reject(failure),
		fulfilled = Promise.resolve(value);
	const receiver = { reject: () => rejected, resolve: () => fulfilled };
	const unhandled: unknown[] = [];
	const listener = (error: unknown) => {
		unhandled.push(error);
	};
	process.on("unhandledRejection", listener);
	try {
		for (const key of ["reject", "resolve"] as const)
			restores.push(
				observeOfficeTimingMethod(
					receiver,
					key,
					async () => {
						throw new Error("async observer");
					},
					async () => {
						throw new Error("async entry");
					},
				),
			);
		expect(receiver.reject()).toBe(rejected);
		await expect(rejected).rejects.toBe(failure);
		expect(receiver.resolve()).toBe(fulfilled);
		await expect(fulfilled).resolves.toBe(value);
		await immediate();
		expect(unhandled).toEqual([]);
	} finally {
		process.off("unhandledRejection", listener);
	}
});

it("wraps an actual Unix client method without changing its receiver, transport, args, signal or Promise", async () => {
	const root = await mkdtemp("/tmp/office-timing-");
	roots.push(root);
	const socket = `${root}/lxd.sock`,
		requests: string[] = [];
	const server = createServer((request, response) => {
		requests.push(request.url ?? "");
		response.writeHead(404, { "content-type": "application/json" });
		response.end(JSON.stringify({ type: "error", error: "absent", error_code: 404 }));
	});
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socket, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const client = new LxdUnixClient(socket),
		caller = new AbortController().signal;
	const original = client.getInstance;
	let originalPromise: ReturnType<typeof original> | undefined;
	const spy = vi.spyOn(client, "getInstance").mockImplementation(function (this: LxdUnixClient, ...args) {
		expect(this).toBe(client);
		expect(args).toEqual(["offices", "guest", caller]);
		originalPromise = original.apply(this, args);
		return originalPromise;
	});
	const observed: unknown[] = [];
	restores.push(
		observeOfficeTimingMethod(client, "getInstance", (...args) => {
			observed.push(args);
		}),
	);
	const promise = client.getInstance("offices", "guest", caller);
	expect(promise).toBe(originalPromise);
	await expect(promise).resolves.toBeUndefined();
	expect(spy).toHaveBeenCalledOnce();
	expect(requests).toEqual(["/1.0/instances/guest?project=offices"]);
	expect(observed).toHaveLength(1);
});

it.each(["reconcile", "reconcileSettled"] as const)(
	"scopes %s and preserves exact Promise/error despite rejected emit",
	async (key) => {
		const failure = new Error("original private message"),
			input = {},
			caller = new AbortController().signal;
		let originalPromise: Promise<LxdOfficeResetResult> | undefined;
		vi.spyOn(LxdOfficeResetWorker.prototype, key).mockImplementation((actual, signal) => {
			expect(actual).toBe(input);
			expect(signal).toBe(caller);
			originalPromise = Promise.reject(failure);
			return originalPromise;
		});
		const emitted: unknown[] = [];
		restores.push(
			installOfficeLifecycleTiming(async (row) => {
				emitted.push(row);
				throw new Error("emit");
			}),
		);
		const promise = attempt(key, caller, input);
		expect(promise).toBe(originalPromise);
		await expect(promise).rejects.toBe(failure);
		await immediate();
		expect(emitted).toHaveLength(1);
		expect(projectOfficeResetTiming(emitted[0])).toMatchObject({
			outcome: "rejected",
			total: 0,
			pendingAtSettlement: 0,
		});
		expect(JSON.stringify(emitted)).not.toContain("private");
	},
);

it("reads the typed inspector caller at index five and never the settle flag at six", async () => {
	const caller = new AbortController(),
		operation = new AbortController(),
		failure = new Error("inspection");
	operation.abort(failure);
	vi.spyOn(LxdOfficeTypedInspectionControl.prototype, "inspectAndUse").mockRejectedValue(failure);
	vi.spyOn(LxdOfficeResetWorker.prototype, "reconcileSettled").mockImplementation(async () => {
		await expect(
			Reflect.apply(LxdOfficeTypedInspectionControl.prototype.inspectAndUse, {}, [
				{},
				{},
				{},
				() => {},
				() => {},
				operation.signal,
				true,
			]),
		).rejects.toBe(failure);
		return result;
	});
	const emitted: unknown[] = [];
	restores.push(
		installOfficeLifecycleTiming((row) => {
			emitted.push(row);
		}),
	);
	await expect(attempt("reconcileSettled", caller.signal)).resolves.toBe(result);
	expect(projectOfficeResetTiming(emitted[0])?.records).toMatchObject([
		{
			stage: "typed_inspection",
			outcome: "rejected",
			operationAborted: true,
			parentAborted: false,
			physicalAborted: null,
		},
	]);
});

it("pins in-flight calls to their own gate and never attributes a rejected new inspect to the prior expired signal", async () => {
	const old = new AbortController(),
		caller = new AbortController().signal;
	const failure = new Error("new physical inspection");
	vi.spyOn(LxdOfficePhysicalGate.prototype, "inspect")
		.mockResolvedValueOnce({ signal: old.signal, validForMs: 5000, hostBootId: "unit" })
		.mockRejectedValueOnce(failure);
	const read = deferred<undefined>();
	vi.spyOn(LxdUnixClient.prototype, "getInstance").mockReturnValue(read.promise);
	vi.spyOn(LxdOfficeResetWorker.prototype, "reconcileSettled").mockImplementation(async () => {
		await Reflect.apply(LxdOfficePhysicalGate.prototype.inspect, {}, [caller]);
		const pending = Reflect.apply(LxdUnixClient.prototype.getInstance, {}, ["project", "guest", caller]);
		old.abort();
		await expect(Reflect.apply(LxdOfficePhysicalGate.prototype.inspect, {}, [caller])).rejects.toBe(failure);
		read.resolve(undefined);
		await pending;
		return result;
	});
	const emitted: unknown[] = [];
	restores.push(
		installOfficeLifecycleTiming((row) => {
			emitted.push(row);
		}),
	);
	await attempt("reconcileSettled", caller);
	const rows = projectOfficeResetTiming(emitted[0])?.records;
	expect(rows).toMatchObject([
		{ stage: "physical_inspect", physicalLease: 1, physicalAborted: false },
		{ stage: "physical_inspect", physicalLease: 2, physicalAborted: null, outcome: "rejected" },
		{ stage: "guest_instance", physicalLease: 1, physicalAborted: true, operationAborted: false },
	]);
	expect(JSON.stringify(rows)).not.toContain('"abort":');
});

it("isolates interleaved attempts and reports outstanding observed work without changing settlement", async () => {
	const slow = deferred<undefined>(),
		emitted: unknown[] = [];
	vi.spyOn(LxdUnixClient.prototype, "getInstance").mockReturnValueOnce(slow.promise).mockResolvedValue(undefined);
	vi.spyOn(LxdOfficeResetWorker.prototype, "reconcileSettled").mockImplementation((_input, caller) => {
		void Reflect.apply(LxdUnixClient.prototype.getInstance, {}, ["project", "guest", caller]);
		return Promise.resolve(result);
	});
	restores.push(
		installOfficeLifecycleTiming((row) => {
			emitted.push(row);
		}),
	);
	await Promise.all([attempt("reconcileSettled"), attempt("reconcileSettled")]);
	expect(emitted.map(projectOfficeResetTiming)).toMatchObject([
		{ attempt: 1, total: 0, pendingAtSettlement: 1 },
		{ attempt: 2, total: 1, pendingAtSettlement: 0 },
	]);
	const snapshot = structuredClone(emitted);
	slow.resolve(undefined);
	await slow.promise;
	await immediate();
	expect(emitted).toEqual(snapshot);
});

it("bounds per-attempt first and recent observations independently of result identity", async () => {
	vi.spyOn(LxdUnixClient.prototype, "getInstance").mockResolvedValue(undefined);
	vi.spyOn(LxdOfficeResetWorker.prototype, "reconcileSettled").mockImplementation(async (_input, caller) => {
		for (let index = 0; index < 120; index++)
			await Reflect.apply(LxdUnixClient.prototype.getInstance, {}, ["project", "guest", caller]);
		return result;
	});
	const emitted: unknown[] = [];
	restores.push(
		installOfficeLifecycleTiming((row) => {
			emitted.push(row);
		}),
	);
	await expect(attempt("reconcileSettled")).resolves.toBe(result);
	const projected = projectOfficeResetTiming(emitted[0]);
	expect(projected).toMatchObject({ total: 120, omitted: 24, pendingAtSettlement: 0 });
	expect(projected?.records).toHaveLength(96);
});
