import { chmod, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootFixtureId as id } from "../../runtime/test/fixtures/company-computer-boot-configuration.ts";
import { bootServiceStartFixture } from "../../runtime/test/fixtures/company-computer-boot-service-start.ts";
import type { LxdOfficeBootServiceStartClient } from "../src/lxd-client.ts";
import { LxdOfficeBootServiceInspectionControl } from "../src/lxd-office-boot-service-inspection.ts";
import { lxdOfficeGuestPlan } from "../src/lxd-office-guest.ts";
import { officePhysicalFixture } from "./fixtures/office-physical-policy.ts";

const roots: string[] = [];
const signal = () => new AbortController().signal;
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "office-inspection-")));
	await chmod(root, 0o700);
	roots.push(root);
	const { binding } = officePhysicalFixture();
	const f = bootServiceStartFixture();
	const data = { request: f.request, command: f.startCommand, completion: f.startCompletion };
	const name = lxdOfficeGuestPlan(binding).request.name;
	let nonce = "";
	const submit = vi.fn<LxdOfficeBootServiceStartClient["submitOfficeBootServiceInspection"]>(
		async (_project, _name, command, inspectionId) => {
			nonce = inspectionId;
			const files = await readdir(root);
			const dispatch = `boot-service-inspection-${binding.allocationId}-${nonce}.json`;
			expect(files).toContain(dispatch);
			expect(JSON.parse(await readFile(join(root, dispatch), "utf8"))).toMatchObject({
				command,
				inspectionId: nonce,
				completion: data.completion,
				binding,
			});
			return { project: binding.project, instanceName: name, operationId: id(100) };
		},
	);
	const poll = vi.fn<LxdOfficeBootServiceStartClient["inspectOfficeBootServiceStart"]>(async () => "succeeded");
	const read = vi.fn<LxdOfficeBootServiceStartClient["readInstanceFile"]>(async (_project, _name, path) => {
		expect(path).toBe(`/run/qorpera-office-preparation/boot-service-inspection-${nonce}.json`);
		return {
			uid: 0,
			gid: 0,
			mode: 0o600,
			content: Buffer.from(
				JSON.stringify({
					schema: "qorpera.office-boot-service-inspection/v1",
					inspectionId: nonce,
					start: data.completion,
				}),
			),
		};
	});
	const authorize = vi.fn(async (_signal: AbortSignal) => signal());
	const use = vi.fn(async (_completion: typeof data.completion, checked: AbortSignal) => {
		checked.throwIfAborted();
		return "active";
	});
	const create = () =>
		new LxdOfficeBootServiceInspectionControl(root, binding, {
			submitOfficeBootServiceInspection: submit,
			inspectOfficeBootServiceStart: poll,
			readInstanceFile: read,
		});
	const control = create();
	const run = (caller = signal(), selected = control) =>
		selected.inspectAndUse(data.command, data.request, data.completion, authorize, use, caller);
	return { root, data, binding, submit, poll, read, authorize, use, control, create, run };
}

describe("provider fresh inspection through the activation deadline", () => {
	it("bounds retained unknown inspection attempts across process replacements without deleting evidence", async () => {
		const f = await fixture();
		for (let i = 1; i <= 256; i++)
			await writeFile(join(f.root, `boot-service-inspection-${f.binding.allocationId}-${id(i)}.json`), "{}", {
				mode: 0o600,
			});
		await expect(f.run(signal(), f.create())).rejects.toThrow("OFFICE_BOOT_SERVICE_INSPECTION_UNCONFIRMED");
		expect(f.submit).not.toHaveBeenCalled();
		expect(f.use).not.toHaveBeenCalled();
		expect(await readdir(f.root)).toHaveLength(256);
	});
	it("retains dispatch before exec, consumes exact live identity and issues new nonces after process replacement", async () => {
		const f = await fixture();
		f.poll.mockResolvedValueOnce("pending");
		await expect(f.run()).resolves.toBe("active");
		await expect(f.run(signal(), f.create())).resolves.toBe("active");
		expect(f.submit).toHaveBeenCalledTimes(2);
		expect(new Set(f.submit.mock.calls.map((args) => args[3])).size).toBe(2);
		expect(f.use).toHaveBeenCalledTimes(2);
		expect(f.use.mock.calls[0][0]).toEqual(f.data.completion);
		expect((await readdir(f.root)).filter((n) => n.endsWith("-accepted.json"))).toHaveLength(2);
	});
	it("retains an unknown inspection and recovers only with a new nonce", async () => {
		const f = await fixture();
		const submit = f.submit.getMockImplementation()!;
		f.submit.mockImplementationOnce(async (...args) => {
			await submit(...args);
			throw new Error("private backend error");
		});
		await expect(f.run()).rejects.toThrow(/^OFFICE_BOOT_SERVICE_INSPECTION_UNCONFIRMED$/);
		expect(f.poll).not.toHaveBeenCalled();
		expect(f.use).not.toHaveBeenCalled();
		await expect(f.run(signal(), f.create())).resolves.toBe("active");
		expect(new Set(f.submit.mock.calls.map((args) => args[3])).size).toBe(2);
	});
	it.each(["submit", "poll", "read", "authorize", "use"] as const)(
		"counts %s latency in the same five-second lifetime",
		async (phase) => {
			const f = await fixture();
			let elapsed = 0;
			vi.spyOn(performance, "now").mockImplementation(() => elapsed);
			if (phase === "submit") {
				const original = f.submit.getMockImplementation()!;
				f.submit.mockImplementation(async (...args) => {
					const result = await original(...args);
					elapsed = 5000;
					return result;
				});
			} else if (phase === "poll")
				f.poll.mockImplementation(async () => {
					elapsed = 5000;
					return "succeeded";
				});
			else if (phase === "read") {
				const original = f.read.getMockImplementation()!;
				f.read.mockImplementation(async (...args) => {
					const result = await original(...args);
					elapsed = 5000;
					return result;
				});
			} else if (phase === "authorize")
				f.authorize.mockImplementation(async () => {
					elapsed = 5000;
					return signal();
				});
			else
				f.use.mockImplementation(async () => {
					elapsed = 5000;
					return "active";
				});
			await expect(f.run()).rejects.toThrow(/^OFFICE_BOOT_SERVICE_INSPECTION_UNCONFIRMED$/);
			if (phase !== "use") expect(f.use).not.toHaveBeenCalled();
			if (phase === "authorize") expect(f.submit).not.toHaveBeenCalled();
		},
	);
	it.each(["uid", "gid", "mode", "nonce", "invocation", "pid", "extra", "invalid utf8", "truncated"])(
		"refuses %s observation before activation",
		async (fault) => {
			const f = await fixture();
			const original = f.read.getMockImplementation()!;
			f.read.mockImplementation(async (...args) => {
				const file = await original(...args);
				if (fault === "uid") file.uid = 1000;
				if (fault === "gid") file.gid = 1000;
				if (fault === "mode") file.mode = 0o644;
				const value = JSON.parse(file.content.toString());
				if (fault === "nonce") value.inspectionId = id(99);
				if (fault === "invocation") value.start.serviceInvocationId = "c".repeat(32);
				if (fault === "pid") value.start.mainPid++;
				if (fault === "extra") value.extra = "secret";
				file.content =
					fault === "invalid utf8"
						? Buffer.from([0xff])
						: fault === "truncated"
							? Buffer.from("{")
							: Buffer.from(JSON.stringify(value));
				return file;
			});
			await expect(f.run()).rejects.toThrow(/^OFFICE_BOOT_SERVICE_INSPECTION_UNCONFIRMED$/);
			expect(f.use).not.toHaveBeenCalled();
		},
	);
	it.each(["project", "instanceName", "operationId", "extra"])("refuses unbound accepted %s", async (field) => {
		const f = await fixture();
		const original = f.submit.getMockImplementation()!;
		f.submit.mockImplementation(async (...args) => ({ ...(await original(...args)), [field]: "other" }));
		await expect(f.run()).rejects.toThrow(/^OFFICE_BOOT_SERVICE_INSPECTION_UNCONFIRMED$/);
		expect(f.poll).not.toHaveBeenCalled();
		expect(f.use).not.toHaveBeenCalled();
	});
	it("does not refresh revoked authority using a later successful check", async () => {
		const f = await fixture(),
			revoked = new AbortController();
		f.authorize.mockResolvedValueOnce(revoked.signal);
		f.poll.mockImplementation(async () => {
			revoked.abort();
			return "succeeded";
		});
		await expect(f.run()).rejects.toThrow(/^OFFICE_BOOT_SERVICE_INSPECTION_UNCONFIRMED$/);
		expect(f.use).not.toHaveBeenCalled();
	});
	it("refuses a changed durable dispatch after guest success", async () => {
		const f = await fixture();
		f.poll.mockImplementation(async () => {
			const name = (await readdir(f.root)).find((n) => n.endsWith(".json") && !n.endsWith("-accepted.json"))!;
			await writeFile(join(f.root, name), "{}");
			return "succeeded";
		});
		await expect(f.run()).rejects.toThrow(/^OFFICE_BOOT_SERVICE_INSPECTION_UNCONFIRMED$/);
		expect(f.read).not.toHaveBeenCalled();
		expect(f.use).not.toHaveBeenCalled();
	});
	it("keeps cancelled IO occupied until settlement and never consumes its late reply", async () => {
		const f = await fixture(),
			abort = new AbortController();
		let enter!: () => void, release!: () => void;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		f.poll.mockImplementationOnce(async () => {
			enter();
			await pending;
			return "succeeded";
		});
		const result = f.run(abort.signal);
		await entered;
		abort.abort();
		await expect(result).rejects.toThrow(/^OFFICE_BOOT_SERVICE_INSPECTION_UNCONFIRMED$/);
		await expect(f.run()).rejects.toThrow(/^OFFICE_BOOT_SERVICE_INSPECTION_PENDING$/);
		release();
		await vi.waitFor(async () => {
			await expect(f.run()).resolves.toBe("active");
		});
		expect(f.use).toHaveBeenCalledOnce();
	});
	it("does not consume nonzero guest exit or pre-aborted authority", async () => {
		const f = await fixture();
		await expect(f.run(AbortSignal.abort())).rejects.toThrow();
		expect(f.submit).not.toHaveBeenCalled();
		f.poll.mockResolvedValue("failed");
		await expect(f.run()).rejects.toThrow(/^OFFICE_BOOT_SERVICE_INSPECTION_UNCONFIRMED$/);
		expect(f.use).not.toHaveBeenCalled();
	});
	it.each([
		["caller", "POLL"],
		["window", "POLL"],
		["caller", "AUTHORIZATION"],
		["window", "AUTHORIZATION"],
	] as const)("identifies %s cancellation during %s without exposing backend details", async (source, phase) => {
		const f = await fixture(),
			caller = new AbortController(),
			window = new AbortController();
		const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(window.signal);
		if (phase === "AUTHORIZATION")
			f.authorize.mockImplementation(async () => {
				(source === "caller" ? caller : window).abort(new Error("private backend detail"));
				return signal();
			});
		else
			f.poll.mockImplementation(async () => {
				(source === "caller" ? caller : window).abort(new Error("private backend detail"));
				return "succeeded";
			});
		await expect(
			f.control.inspectAndUse(
				f.data.command,
				f.data.request,
				f.data.completion,
				f.authorize,
				f.use,
				caller.signal,
				true,
			),
		).rejects.toMatchObject({
			message: "OFFICE_BOOT_SERVICE_INSPECTION_UNCONFIRMED",
			cause: {
				message: `OFFICE_INSPECTION_${source === "caller" ? "CALLER_ABORTED" : "WINDOW_EXPIRED"}_DURING_${phase}`,
			},
		});
		expect(timeout).toHaveBeenCalledExactlyOnceWith(5000);
		expect(f.read).not.toHaveBeenCalled();
		expect(f.use).not.toHaveBeenCalled();
	});
});
