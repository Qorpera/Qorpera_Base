import { open } from "node:fs/promises";
import { companyComputerBrowserAppArmorRequired } from "@qorpera/runtime/cloud-company-computer-linux-host";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<object>()), open: vi.fn() }));
afterEach(() => vi.clearAllMocks());

describe("browser AppArmor admission", () => {
	it.each([
		["Y\n", true],
		["N\n", false],
	] as const)("requires the enforcing profile for kernel state %j", async (state, required) => {
		let read = false;
		const close = vi.fn(async () => undefined);
		vi.mocked(open).mockResolvedValue({
			read: async (buffer: Buffer) => {
				if (read) return { bytesRead: 0 };
				read = true;
				return { bytesRead: buffer.write(state) };
			},
			close,
		} as unknown as Awaited<ReturnType<typeof open>>);
		await expect(companyComputerBrowserAppArmorRequired()).resolves.toBe(required);
		expect(close).toHaveBeenCalledOnce();
	});
	it("allows a kernel without the module but refuses unreadable kernel state", async () => {
		vi.mocked(open).mockRejectedValueOnce(Object.assign(new Error("absent"), { code: "ENOENT" }));
		await expect(companyComputerBrowserAppArmorRequired()).resolves.toBe(false);
		for (const code of ["EACCES", "EPERM", "EIO"] as const) {
			vi.mocked(open).mockRejectedValueOnce(Object.assign(new Error("unconfirmed"), { code }));
			await expect(companyComputerBrowserAppArmorRequired()).rejects.toMatchObject({ code });
		}
	});
	it("refuses malformed or truncated state rather than dropping browser confinement", async () => {
		vi.mocked(open).mockResolvedValue({
			read: async (buffer: Buffer) => ({ bytesRead: buffer.write("unknown") }),
			close: async () => undefined,
		} as unknown as Awaited<ReturnType<typeof open>>);
		await expect(companyComputerBrowserAppArmorRequired()).rejects.toThrow();
	});
});
