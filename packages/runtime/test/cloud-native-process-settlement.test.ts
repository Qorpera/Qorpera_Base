import { ChildProcess } from "node:child_process";
import { expect, it, vi } from "vitest";
import {
	closeNativeTransportThenSettle,
	hasUnconfirmedNativeProcessSettlement,
	NativeProcessSettlementError,
	stopNativeNamespaceChild,
} from "../src/cloud-native-process-settlement.ts";

function child() {
	const process = new ChildProcess();
	Object.defineProperty(process, "pid", { value: 123456 });
	vi.spyOn(process, "kill").mockReturnValue(true);
	return process;
}
it("requires confirmed namespace supervisor termination", async () => {
	const process = child();
	const stopped = stopNativeNamespaceChild(process, 100);
	expect(process.kill).toHaveBeenCalledWith("SIGKILL");
	process.emit("close", null, "SIGKILL");
	await stopped;
});
it("rejects timeout instead of treating a possibly live credential writer as settled", async () => {
	const process = child();
	await expect(stopNativeNamespaceChild(process, 5)).rejects.toBeInstanceOf(NativeProcessSettlementError);
	expect(process.listenerCount("close")).toBe(0);
});
it("propagates an unsuccessful kill as unknown settlement", async () => {
	const process = child();
	vi.mocked(process.kill).mockImplementation(() => {
		throw new Error("denied");
	});
	await expect(stopNativeNamespaceChild(process, 10)).rejects.toBeInstanceOf(NativeProcessSettlementError);
});
it("recognizes a supervisor whose termination was already observed", async () => {
	const process = child();
	Object.defineProperty(process, "signalCode", { value: "SIGKILL" });
	await stopNativeNamespaceChild(process, 10);
});

it("always settles after a synchronous transport-close failure and preserves that failure", async () => {
	const original = new Error("transport close failed");
	const settle = vi.fn(async () => undefined);
	await expect(
		closeNativeTransportThenSettle(() => {
			throw original;
		}, settle),
	).rejects.toBe(original);
	expect(settle).toHaveBeenCalledOnce();
});
it("unknown settlement overrides an ordinary transport failure", async () => {
	const unknown = new NativeProcessSettlementError();
	await expect(
		closeNativeTransportThenSettle(
			() => {
				throw new Error("transport");
			},
			async () => {
				throw unknown;
			},
		),
	).rejects.toBe(unknown);
});
it("finds settlement markers through aggregate and cause wrappers and tolerates cycles", () => {
	const wrapper = new Error("wrapper");
	wrapper.cause = wrapper;
	expect(hasUnconfirmedNativeProcessSettlement(wrapper)).toBe(false);
	expect(
		hasUnconfirmedNativeProcessSettlement(
			new AggregateError([wrapper, new Error("outer", { cause: new NativeProcessSettlementError() })]),
		),
	).toBe(true);
});
