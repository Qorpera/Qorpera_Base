import { createHash } from "node:crypto";
import { cpus, totalmem } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLxdOfficeProtectedFile } from "../src/lxd-office-physical-host.ts";
import { readRuntimeNodeHost } from "../src/runtime-node-host.ts";

vi.mock("../src/lxd-office-physical-host.ts", () => ({ readLxdOfficeProtectedFile: vi.fn() }));
vi.mock("node:os", () => ({ cpus: vi.fn(), totalmem: vi.fn() }));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const machineId = "0123456789abcdef0123456789abcdef";
beforeEach(() => {
	Object.defineProperty(process, "platform", { value: "linux" });
	vi.mocked(readLxdOfficeProtectedFile)
		.mockReset()
		.mockResolvedValue(Buffer.from(`${machineId}\n`));
	vi.mocked(cpus)
		.mockReset()
		.mockReturnValue(
			Array.from({ length: 16 }, () => ({
				model: "cpu",
				speed: 1000,
				times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
			})),
		);
	vi.mocked(totalmem)
		.mockReset()
		.mockReturnValue(64 * 1024 ** 3);
});
afterEach(() => {
	Object.defineProperty(process, "platform", platform);
	vi.restoreAllMocks();
});
describe("protected runtime node host evidence", () => {
	it("reads only the fixed protected host identity and returns its digest", async () => {
		const host = await readRuntimeNodeHost(new AbortController().signal);
		expect(host).toEqual({
			machineIdSha256: createHash("sha256").update(machineId).digest("hex"),
			cpuMillis: 16000,
			memoryBytes: 64 * 1024 ** 3,
		});
		expect(readLxdOfficeProtectedFile).toHaveBeenCalledExactlyOnceWith("/etc/machine-id", 64);
		expect(JSON.stringify(host)).not.toContain(machineId);
	});
	it.each(["0".repeat(32), ` ${machineId}`, `${machineId}\n\n`, machineId.toUpperCase(), "invalid"])(
		"refuses malformed host identity %j",
		async (value) => {
			vi.mocked(readLxdOfficeProtectedFile).mockResolvedValue(Buffer.from(value));
			await expect(readRuntimeNodeHost(new AbortController().signal)).rejects.toThrow(
				"RUNTIME_NODE_HOST_UNCONFIRMED",
			);
		},
	);
	it.each([0, 1024 ** 5 + 1, 1.5, Number.NaN])("refuses invalid RAM measurements %s", async (memory) => {
		vi.mocked(totalmem).mockReturnValue(memory);
		await expect(readRuntimeNodeHost(new AbortController().signal)).rejects.toThrow("RUNTIME_NODE_HOST_UNCONFIRMED");
	});
	it("refuses unknown CPUs, non-Linux hosts and unprotected metadata", async () => {
		vi.mocked(cpus).mockReturnValueOnce([]);
		await expect(readRuntimeNodeHost(new AbortController().signal)).rejects.toThrow("RUNTIME_NODE_HOST_UNCONFIRMED");
		vi.mocked(readLxdOfficeProtectedFile).mockRejectedValueOnce(new Error("sensitive local failure"));
		await expect(readRuntimeNodeHost(new AbortController().signal)).rejects.toThrow(
			/^RUNTIME_NODE_HOST_UNCONFIRMED$/,
		);
		Object.defineProperty(process, "platform", { value: "darwin" });
		await expect(readRuntimeNodeHost(new AbortController().signal)).rejects.toThrow("RUNTIME_NODE_HOST_UNCONFIRMED");
	});
	it("refuses elapsed or cancelled observations", async () => {
		vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(5001);
		await expect(readRuntimeNodeHost(new AbortController().signal)).rejects.toThrow("RUNTIME_NODE_HOST_UNCONFIRMED");
		const controller = new AbortController();
		vi.mocked(readLxdOfficeProtectedFile).mockImplementationOnce(async () => {
			controller.abort();
			return Buffer.from(machineId);
		});
		await expect(readRuntimeNodeHost(controller.signal)).rejects.toThrow("RUNTIME_NODE_HOST_UNCONFIRMED");
	});
});
