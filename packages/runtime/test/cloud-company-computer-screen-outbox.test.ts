import { createHash } from "node:crypto";
import { chmod, link, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CompanyComputerScreenLifecyclePublisher,
	type CompanyComputerScreenObservation,
} from "@qorpera/runtime/cloud-company-computer-screen-lifecycle";
import { CompanyComputerScreenOutbox } from "@qorpera/runtime/cloud-company-computer-screen-outbox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computerBinding, computerDeferred, computerId, computerScope } from "./fixtures/company-computer.ts";
import { screenReceipt, screenStartup } from "./fixtures/screen-lifecycle.ts";

const roots: string[] = [],
	queues: CompanyComputerScreenOutbox[] = [];
const signal = () => new AbortController().signal;
const observation = (): CompanyComputerScreenObservation => ({
	schema: "qorpera.runtime-screen-observation/v1",
	startup: screenStartup(),
	binding: computerBinding(),
	privacy: null,
	event: {
		lifetimeId: computerId(90),
		eventId: computerId(91),
		sequence: 1,
		observedAt: "2026-09-09T01:00:00.000Z",
		state: "requested",
		reason: "SCREEN_REQUESTED",
	},
});
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "screen-outbox-")));
	roots.push(root);
	const call = vi.fn(async (_method: string, args: Record<string, unknown>): Promise<unknown> => screenReceipt(args));
	const queue = await CompanyComputerScreenOutbox.open(root, computerScope(), [], { call });
	queues.push(queue);
	const publisher = new CompanyComputerScreenLifecyclePublisher(screenStartup(), { call }, queue);
	return {
		root,
		call,
		queue,
		publisher,
		life: publisher.create(computerBinding(), null),
		files: async () => (await readdir(root)).filter((name) => name !== "scope.json"),
	};
}
afterEach(async () => {
	await Promise.allSettled(queues.splice(0).map((queue) => queue.close()));
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	vi.restoreAllMocks();
	vi.useRealTimers();
});
describe("private durable screen outbox", () => {
	it("refuses changed record serialization before hashing or delivering it", async () => {
		const f = await fixture();
		await f.life.requested(signal());
		const [name] = await f.files();
		await writeFile(join(f.root, name), `${await readFile(join(f.root, name), "utf8")} `);
		await expect(f.queue.flush(signal())).rejects.toThrow("SCREEN_OUTBOX_RECORD_CHANGED");
		expect(f.call).not.toHaveBeenCalled();
	});
	it("recovers a lost separate retention receipt with the original record after reopening", async () => {
		const f = await fixture();
		await f.life.requested(signal());
		const [name] = await f.files(),
			original = await readFile(join(f.root, name), "utf8");
		const observation = JSON.parse(original),
			event = observation.event;
		const receipt = {
			schema: "qorpera.runtime-screen-retention-receipt/v1",
			confirmation: "unconfirmed",
			...event,
			observationSha256: createHash("sha256").update(original).digest("hex"),
			retainedAt: new Date().toISOString(),
		};
		delete receipt.reason;
		let lost = true;
		f.call.mockImplementation(async (method, args) => {
			if (method === "qorpera_record_runtime_screen_event") throw new Error("historical authority refused");
			expect(method).toBe("qorpera_retain_runtime_screen_observation");
			expect(args).toEqual({ p_record: original });
			if (lost) {
				lost = false;
				throw new Error("discarded committed retention reply");
			}
			return receipt;
		});
		await f.queue.flush(signal());
		expect(await f.files()).toEqual([name]);
		await f.queue.close();
		const recovered = await CompanyComputerScreenOutbox.open(f.root, computerScope(), [], { call: f.call });
		queues.push(recovered);
		await recovered.flush(signal());
		expect(await f.files()).toEqual([]);
	});
	it("refuses a retention receipt with a changed hash without deleting local custody", async () => {
		const f = await fixture();
		await f.life.requested(signal());
		f.call.mockImplementation(async (method, args) => {
			if (method === "qorpera_record_runtime_screen_event") throw new Error("denied");
			const { reason: _reason, ...event } = JSON.parse(args.p_record as string).event;
			return {
				schema: "qorpera.runtime-screen-retention-receipt/v1",
				confirmation: "unconfirmed",
				...event,
				observationSha256: "0".repeat(64),
				retainedAt: new Date().toISOString(),
			};
		});
		await f.queue.flush(signal());
		expect(await f.files()).toHaveLength(1);
	});
	it("accepts the original canonical receipt when the retention RPC finds a late commit", async () => {
		const f = await fixture();
		await f.life.requested(signal());
		f.call.mockImplementation(async (method, args) => {
			if (method === "qorpera_record_runtime_screen_event") throw new Error("discarded committed reply");
			return screenReceipt({ p_event: JSON.parse(args.p_record as string).event });
		});
		await f.queue.flush(signal());
		expect(await f.files()).toEqual([]);
	});
	it("rejects broadened observation metadata before writing or exporting", async () => {
		const f = await fixture(),
			item = observation();
		expect(() =>
			f.queue.retain(
				{ ...item, binding: { ...item.binding, extra: "not metadata" } } as CompanyComputerScreenObservation,
				signal(),
			),
		).toThrow("INVALID_SCREEN_OBSERVATION");
		expect(await f.files()).toEqual([]);
		expect(f.call).not.toHaveBeenCalled();
	});
	it("omits backed-up heartbeats and resumes with the next sequence without filling the gap", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-09-09T01:00:00Z"));
		const f = await fixture();
		await f.life.requested(signal());
		await f.life.ready(signal());
		vi.setSystemTime(new Date("2026-09-09T01:01:00Z"));
		await f.life.heartbeat(signal());
		expect(await f.files()).toHaveLength(2);
		await f.queue.flush(signal());
		await f.queue.flush(signal());
		await f.life.heartbeat(signal());
		const [name] = await f.files();
		expect(JSON.parse(await readFile(join(f.root, name), "utf8")).event).toMatchObject({
			sequence: 3,
			reason: "SCREEN_HEARTBEAT",
			observedAt: "2026-09-09T01:01:00.000Z",
		});
	});
	it("refuses invalid local transitions before SQL delivery", async () => {
		const f = await fixture();
		await f.life.requested(signal());
		await expect(f.life.closed(signal())).rejects.toThrow("SCREEN_LIFECYCLE_TRANSITION_INVALID");
		await f.life.failed("DESKTOP_START_FAILED", signal());
		await expect(f.life.ready(signal())).rejects.toThrow("SCREEN_LIFECYCLE_TRANSITION_INVALID");
		await f.life.closed(signal());
		expect(await f.files()).toHaveLength(3);
		expect(f.call).not.toHaveBeenCalled();
	});
	it("refuses a missing scope file in flight and after reopening without recreating it", async () => {
		const f = await fixture();
		await f.life.requested(signal());
		await rm(join(f.root, "scope.json"));
		await expect(f.queue.flush(signal())).rejects.toThrow("SCREEN_OUTBOX_SCOPE_MISSING");
		await f.queue.close();
		await expect(CompanyComputerScreenOutbox.open(f.root, computerScope(), [], { call: f.call })).rejects.toThrow(
			"SCREEN_OUTBOX_SCOPE_MISSING",
		);
		expect(await readdir(f.root)).toHaveLength(1);
		expect(f.call).not.toHaveBeenCalled();
	});
	it("aborts an in-flight manual export on close and preserves its unacknowledged record", async () => {
		const f = await fixture(),
			pending = computerDeferred<ReturnType<typeof screenReceipt>>();
		await f.life.requested(signal());
		f.call.mockReturnValueOnce(pending.promise);
		const flushing = f.queue.flush(signal());
		await vi.waitFor(() => expect(f.call).toHaveBeenCalledOnce());
		await f.queue.close();
		await flushing;
		pending.resolve(screenReceipt(f.call.mock.calls[0][1]));
		expect(await f.files()).toHaveLength(1);
		await expect(f.queue.flush(signal())).rejects.toThrow("SCREEN_OUTBOX_CLOSED");
	});
	it("retains lifecycle records while SQL is unavailable and replays exact bytes after reopening", async () => {
		const f = await fixture();
		f.call.mockRejectedValue(new Error("offline"));
		await f.life.requested(signal());
		await f.life.ready(signal());
		await f.life.closing("OFFICE_SERVICE_STOPPING", signal());
		await f.life.closed(signal());
		expect(f.call).not.toHaveBeenCalled();
		const names = (await f.files()).sort(),
			before = await Promise.all(names.map((name) => readFile(join(f.root, name), "utf8")));
		expect(names).toHaveLength(4);
		await f.queue.flush(signal());
		expect(await Promise.all(names.map((name) => readFile(join(f.root, name), "utf8")))).toEqual(before);
		await f.queue.close();
		const recovered = await CompanyComputerScreenOutbox.open(f.root, computerScope(), [], { call: f.call });
		queues.push(recovered);
		f.call.mockImplementation(async (_method, args) => screenReceipt(args));
		for (let i = 0; i < 4; i++) await recovered.flush(signal());
		expect(await f.files()).toEqual([]);
		const direct = f.call.mock.calls.filter(([method]) => method === "qorpera_record_runtime_screen_event");
		expect(direct[0][1]).toEqual(direct[1][1]);
		expect(direct.slice(1).map(([, args]) => args.p_event)).toEqual(before.map((text) => JSON.parse(text).event));
	});
	it("does not hold local recording behind an in-flight export", async () => {
		const f = await fixture(),
			pending = computerDeferred<ReturnType<typeof screenReceipt>>();
		await f.life.requested(signal());
		f.call.mockReturnValueOnce(pending.promise);
		const flushing = f.queue.flush(signal());
		await vi.waitFor(() => expect(f.call).toHaveBeenCalledOnce());
		await f.life.ready(signal());
		await f.life.closing("PRIVACY_FENCE", signal());
		await f.life.closed(signal());
		expect(await f.files()).toHaveLength(4);
		pending.resolve(screenReceipt(f.call.mock.calls[0][1]));
		await flushing;
		expect(await f.files()).toHaveLength(3);
	});
	it("keeps a lost or malformed receipt pending without starving another lifetime", async () => {
		const f = await fixture();
		await f.life.requested(signal());
		const second = f.publisher.create(computerBinding(), null);
		await second.requested(signal());
		f.call.mockImplementation(async (_method, args) => {
			const receipt = screenReceipt(args);
			return receipt.lifetimeId === f.life.lifetimeId ? { ...receipt, sequence: 999 } : receipt;
		});
		await f.queue.flush(signal());
		expect(await f.files()).toHaveLength(1);
		await f.queue.flush(signal());
		expect(await f.files()).toHaveLength(1);
		expect(await f.queue.canHeartbeat(f.life.lifetimeId)).toBe(false);
		expect(await f.queue.canHeartbeat(second.lifetimeId)).toBe(true);
	});
	it("publishes a sequence once and refuses changed observations without overwriting", async () => {
		const f = await fixture(),
			item = observation();
		await Promise.all([f.queue.retain(item, signal()), f.queue.retain(structuredClone(item), signal())]);
		const [name] = await f.files(),
			before = await readFile(join(f.root, name));
		await expect(
			f.queue.retain({ ...item, event: { ...item.event, eventId: computerId(92) } }, signal()),
		).rejects.toThrow("SCREEN_OUTBOX_RECORD_CHANGED");
		expect(await readFile(join(f.root, name))).toEqual(before);
	});
	it("recovers an interrupted atomic link and removes only uncommitted private temporaries", async () => {
		const f = await fixture();
		await f.queue.retain(observation(), signal());
		await f.queue.close();
		const [name] = await f.files();
		await link(join(f.root, name), join(f.root, `.write-${computerId(92)}`));
		await writeFile(join(f.root, `.write-${computerId(93)}`), "partial", { mode: 0o600 });
		const recovered = await CompanyComputerScreenOutbox.open(f.root, computerScope(), [], { call: f.call });
		queues.push(recovered);
		expect(await f.files()).toEqual([name]);
		await recovered.flush(signal());
		expect(await f.files()).toEqual([]);
	});
	it("refuses another scope, guest-visible roots, aliases and permissive custody", async () => {
		const f = await fixture();
		await f.queue.close();
		await expect(
			CompanyComputerScreenOutbox.open(f.root, { ...computerScope(), companyId: computerId(99) }, [], {
				call: f.call,
			}),
		).rejects.toThrow();
		for (const excluded of [f.root, join(f.root, "child"), tmpdir()])
			await expect(
				CompanyComputerScreenOutbox.open(f.root, computerScope(), [excluded], { call: f.call }),
			).rejects.toThrow("SCREEN_OUTBOX_PATH_UNSAFE");
		const alias = `${f.root}-alias`;
		roots.push(alias);
		await symlink(f.root, alias);
		await expect(CompanyComputerScreenOutbox.open(alias, computerScope(), [], { call: f.call })).rejects.toThrow();
		await chmod(f.root, 0o755);
		await expect(CompanyComputerScreenOutbox.open(f.root, computerScope(), [], { call: f.call })).rejects.toThrow(
			"SCREEN_OUTBOX_DIRECTORY_UNSAFE",
		);
	});
	it("refuses replaced or linked record bytes before exporting them", async () => {
		const f = await fixture();
		await f.queue.retain(observation(), signal());
		const [name] = await f.files();
		await chmod(join(f.root, name), 0o644);
		await expect(f.queue.flush(signal())).rejects.toThrow("SCREEN_OUTBOX_RECORD_UNSAFE");
		expect(f.call).not.toHaveBeenCalled();
		await chmod(join(f.root, name), 0o600);
		await link(join(f.root, name), join(f.root, "scope-hardlink"));
		await expect(f.queue.flush(signal())).rejects.toThrow("SCREEN_OUTBOX_INVENTORY_UNSAFE");
		expect(f.call).not.toHaveBeenCalled();
	});
});
