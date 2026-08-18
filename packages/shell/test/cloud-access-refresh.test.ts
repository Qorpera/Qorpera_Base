import { describe, expect, it, vi } from "vitest";
import { CloudProfileAccessRefresh } from "../src/cloud-access-refresh.ts";

describe("cloud profile access refresh", () => {
	it("restricts immediately and restores only authoritative active access", async () => {
		let finish: ((result: "active") => void) | undefined;
		const restricted = vi.fn();
		const active = vi.fn();
		const refresh = new CloudProfileAccessRefresh({
			refresh: () =>
				new Promise<"active">((resolve) => {
					finish = resolve;
				}),
			onRestricted: restricted,
			onActive: active,
			onRevoked: vi.fn(),
		});

		const result = refresh.trigger();
		expect(restricted).toHaveBeenCalledOnce();
		expect(active).not.toHaveBeenCalled();
		expect(refresh.refreshing()).toBe(true);
		finish?.("active");
		await expect(result).resolves.toBe("active");
		expect(active).toHaveBeenCalledOnce();
		expect(refresh.refreshing()).toBe(false);
	});

	it("replays changes received during refresh before restoring access", async () => {
		let finishFirst: ((result: "active") => void) | undefined;
		const active = vi.fn();
		const hostedRefresh = vi
			.fn<() => Promise<"active">>()
			.mockImplementationOnce(
				() =>
					new Promise<"active">((resolve) => {
						finishFirst = resolve;
					}),
			)
			.mockResolvedValue("active");
		const refresh = new CloudProfileAccessRefresh({
			refresh: hostedRefresh,
			onRestricted: vi.fn(),
			onActive: active,
			onRevoked: vi.fn(),
		});

		const first = refresh.trigger();
		expect(refresh.trigger()).toBe(first);
		finishFirst?.("active");
		await expect(first).resolves.toBe("active");
		expect(hostedRefresh).toHaveBeenCalledTimes(2);
		expect(active).toHaveBeenCalledOnce();
	});

	it("keeps authority restricted after revocation or a failed confirmation", async () => {
		const revoked = vi.fn();
		const active = vi.fn();
		const refresh = new CloudProfileAccessRefresh({
			refresh: vi.fn().mockResolvedValueOnce("revoked").mockRejectedValueOnce(new Error("network unavailable")),
			onRestricted: vi.fn(),
			onActive: active,
			onRevoked: revoked,
			onError: vi.fn(),
		});

		await expect(refresh.trigger()).resolves.toBe("revoked");
		expect(revoked).toHaveBeenCalledOnce();
		expect(active).not.toHaveBeenCalled();
		await expect(refresh.trigger()).resolves.toBeUndefined();
		expect(active).not.toHaveBeenCalled();
	});
});
