import { CompanyComputerScreenLifecyclePublisher } from "@qorpera/runtime/cloud-company-computer-screen-lifecycle";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computerBinding, computerDeferred, computerId } from "./fixtures/company-computer.ts";
import { screenReceipt, screenStartup } from "./fixtures/screen-lifecycle.ts";

const signal = () => new AbortController().signal;
function fixture() {
	const call = vi.fn(async (_method: string, args: Record<string, unknown>) => screenReceipt(args));
	const publisher = new CompanyComputerScreenLifecyclePublisher(screenStartup(), { call });
	return { call, publisher, life: publisher.create(computerBinding(), null) };
}
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});
describe("admitted screen lifetime producer", () => {
	it("retains exact bytes and observation time across a lost reply before advancing sequence", async () => {
		const f = fixture();
		f.call.mockRejectedValueOnce(new Error("secret transport response"));
		await expect(f.life.requested(signal())).rejects.toThrow("SCREEN_LIFECYCLE_UNCONFIRMED");
		await f.life.ready(signal());
		expect(f.call.mock.calls[1][1]).toEqual(f.call.mock.calls[0][1]);
		const events = f.call.mock.calls.map(([, args]) => args.p_event as Record<string, unknown>);
		expect(events.map((e) => e.sequence)).toEqual([1, 1, 2]);
		expect(events.map((e) => e.state)).toEqual(["requested", "requested", "ready"]);
		expect(events[2].eventId).not.toBe(events[0].eventId);
	});
	it.each(["eventId", "lifetimeId", "observedAt", "sequence", "state", "schema", "recordedAt", "extra"])(
		"retains pending identity after a malformed %s receipt",
		async (key) => {
			const f = fixture();
			f.call.mockImplementationOnce(async (_method, args) => ({ ...screenReceipt(args), [key]: "invalid" }));
			await expect(f.life.requested(signal())).rejects.toThrow("SCREEN_LIFECYCLE_UNCONFIRMED");
			await f.life.requested(signal());
			expect(f.call.mock.calls[1][1]).toEqual(f.call.mock.calls[0][1]);
		},
	);
	it("serializes queued transitions and preserves their observation times", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-09T12:00:00Z"));
		const f = fixture(),
			pending = computerDeferred<ReturnType<typeof screenReceipt>>();
		f.call.mockReturnValueOnce(pending.promise);
		const request = f.life.requested(signal());
		await vi.advanceTimersByTimeAsync(0);
		vi.setSystemTime(new Date("2026-09-09T12:00:01Z"));
		const ready = f.life.ready(signal());
		await vi.advanceTimersByTimeAsync(0);
		expect(f.call).toHaveBeenCalledTimes(1);
		pending.resolve(screenReceipt(f.call.mock.calls[0][1]));
		await Promise.all([request, ready]);
		expect(f.call.mock.calls[1][1].p_event).toMatchObject({ sequence: 2, observedAt: "2026-09-09T12:00:01.000Z" });
	});
	it("bounds a stalled port and ignores its late response while retrying the same event", async () => {
		vi.useFakeTimers();
		const f = fixture(),
			pending = computerDeferred<ReturnType<typeof screenReceipt>>();
		f.call.mockReturnValueOnce(pending.promise);
		const attempt = f.life.requested(signal()).catch((error) => error);
		await vi.advanceTimersByTimeAsync(3001);
		expect(await attempt).toEqual(new Error("SCREEN_LIFECYCLE_UNCONFIRMED"));
		await f.life.requested(signal());
		pending.resolve(screenReceipt(f.call.mock.calls[0][1]));
		await f.life.ready(signal());
		expect(f.call.mock.calls[1][1]).toEqual(f.call.mock.calls[0][1]);
		expect(f.call.mock.calls[2][1].p_event).toMatchObject({ sequence: 2, state: "ready" });
	});
	it("rate limits heartbeat observations and never emits them after a drain", async () => {
		vi.useFakeTimers();
		const f = fixture();
		await f.life.requested(signal());
		await f.life.ready(signal());
		await f.life.heartbeat(signal());
		await vi.advanceTimersByTimeAsync(5000);
		await f.life.heartbeat(signal());
		await f.life.closing("OFFICE_SERVICE_STOPPING", signal());
		await vi.advanceTimersByTimeAsync(5000);
		await f.life.heartbeat(signal());
		await f.life.closed(signal());
		await f.life.closing("PRIVACY_FENCE", signal());
		await f.life.failed("DESKTOP_EXITED", signal());
		await f.life.closed(signal());
		await f.life.heartbeat(signal());
		expect(f.call.mock.calls.map(([, a]) => (a.p_event as Record<string, unknown>).reason)).toEqual([
			"SCREEN_REQUESTED",
			"DESKTOP_READY",
			"SCREEN_HEARTBEAT",
			"OFFICE_SERVICE_STOPPING",
			"DESKTOP_REAPED",
		]);
	});
	it("does not report physical cleanup when no request was made", async () => {
		const f = fixture();
		await f.life.closing("SCREEN_DRAIN_REQUESTED", signal());
		await f.life.closed(signal());
		expect(f.call).not.toHaveBeenCalled();
		await expect(f.life.ready(signal())).rejects.toThrow("SCREEN_LIFECYCLE_NOT_REQUESTED");
	});
	it("clones producer identities and rejects another computer generation or scope", async () => {
		const f = fixture(),
			startup = { ...screenStartup(), scope: { ...screenStartup().scope } },
			binding = { ...computerBinding() };
		const publisher = new CompanyComputerScreenLifecyclePublisher(startup, { call: f.call });
		const life = publisher.create(binding, null);
		startup.scope.companyId = computerId(100);
		binding.screenId = computerId(101);
		await life.requested(signal());
		expect(f.call.mock.calls[0][1]).toMatchObject({
			p_startup: screenStartup(),
			p_binding: computerBinding(),
			p_privacy: null,
		});
		expect(() => publisher.create({ ...computerBinding(), computerGeneration: 2 }, null)).toThrow();
		expect(() => publisher.create({ ...computerBinding(), companyId: computerId(100) }, null)).toThrow();
	});
});
