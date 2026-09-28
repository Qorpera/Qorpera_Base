import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { LxdCodingLeaseTransport } from "../src/coding-lease-transport.ts";
import type { LxdInspectableClient } from "../src/lxd-client.ts";
import { codingMachineFixture, codingMachineInstance, codingMachineStorage } from "./helpers/coding-machine.ts";

function fixture() {
	const workerId = randomUUID();
	const machine = codingMachineFixture();
	const bootId = randomUUID();
	const scope = { workerId, vmId: machine.machineId, requestId: randomUUID(), turn: 1 };
	const helper = Buffer.from("reviewed bundled helper");
	const config = Buffer.from("reviewed guest configuration");
	let staged = "";
	const instance = codingMachineInstance(machine, [workerId]);
	const client = {
		getInstance: vi.fn<LxdInspectableClient["getInstance"]>().mockResolvedValue(instance),
		pushInstanceFile: vi.fn<LxdInspectableClient["pushInstanceFile"]>(async (_p, _n, _path, text) => {
			staged = text;
		}),
		execInstance: vi.fn<LxdInspectableClient["execInstance"]>().mockResolvedValue(undefined),
		readInstanceFile: vi.fn<LxdInspectableClient["readInstanceFile"]>(async (_p, _n, path) => ({
			uid: 0,
			gid: 0,
			mode: 0o444,
			content: path.endsWith("uptime")
				? Buffer.from("100.00 50.00\n")
				: path.endsWith("boot_id")
					? Buffer.from(`${bootId}\n`)
					: path.endsWith(".mjs")
						? helper
						: path.endsWith("guest.json")
							? config
							: path.endsWith("lease-refresh.json")
								? Buffer.from(staged)
								: Buffer.from(
										JSON.stringify({
											schema: "qorpera.coding-guest-lease/v2",
											...scope,
											open: JSON.parse(staged).open,
											bootId,
											leaseTokenSha256: JSON.parse(staged).leaseTokenSha256,
											refreshedAtMonoMs: 100000,
											expiresAtMonoMs: Math.min(
												100000 + JSON.parse(staged).ttlMs,
												JSON.parse(staged).notAfterMonoMs,
											),
										}),
									),
		})),
	};
	const authorize = vi
		.fn<ConstructorParameters<typeof LxdCodingLeaseTransport>[0]["authorize"]>()
		.mockResolvedValue(undefined);
	const transport = new LxdCodingLeaseTransport({
		machine,
		storage: codingMachineStorage,
		scope,
		open: true,
		bootId,
		helperSha256: createHash("sha256").update(helper).digest("hex"),
		guestConfigSha256: createHash("sha256").update(config).digest("hex"),
		client,
		authorize,
	});
	return { scope, workerId, client, authorize, transport, instance };
}
describe("trusted coding guest lease transport", () => {
	it.each(["", "NaN 0\n", "1e3 0\n", "-1.00 0.00\n", "100.00 50.00", "9007199254740.99 0.00\n"])(
		"refuses invalid uptime %j before lease staging",
		async (content) => {
			const f = fixture(),
				original = f.client.readInstanceFile.getMockImplementation()!;
			f.client.readInstanceFile.mockImplementation(async (...args) => ({
				...(await original(...args)),
				...(args[2] === "/proc/uptime" ? { content: Buffer.from(content) } : {}),
			}));
			await expect(
				f.transport.refresh(f.scope, "d".repeat(64), 60000, new AbortController().signal),
			).rejects.toThrow("CLOCK_UNAVAILABLE");
			expect(f.client.pushInstanceFile).not.toHaveBeenCalled();
			expect(f.client.execInstance).not.toHaveBeenCalled();
		},
	);
	it("pins VM/boot/artifacts, stages only a token hash and invokes the fixed root refresh", async () => {
		const f = fixture();
		await f.transport.refresh(f.scope, "d".repeat(64), 60000, new AbortController().signal);
		expect(f.authorize).toHaveBeenCalledTimes(2);
		expect(f.client.execInstance.mock.calls[0][2]).toEqual([
			"/usr/bin/node",
			"/opt/qorpera-coding/cloud-coding-command-guest.mjs",
			"refresh-lease",
			f.workerId,
		]);
		// The session's own inbox and runtime lease on its member's machine.
		expect(f.client.pushInstanceFile.mock.calls[0][2]).toBe(
			`/var/lib/qorpera-coding/${f.workerId}/inbox/lease-refresh.json`,
		);
		expect(f.client.readInstanceFile.mock.calls.map((call) => call[2])).toContain(
			`/run/qorpera-coding/${f.workerId}/lease.json`,
		);
		const staged = JSON.parse(f.client.pushInstanceFile.mock.calls[0][3]);
		expect(staged.leaseTokenSha256).toBe("d".repeat(64));
		expect(staged.ttlMs).toBeLessThanOrEqual(60000);
		expect(staged.leaseToken).toBeUndefined();
		// The attachment's lease names its turn and whether that turn may start commands.
		expect(staged).toMatchObject({ schema: "qorpera.coding-guest-lease-refresh/v2", turn: f.scope.turn, open: true });
	});
	it("fails before guest mutation for revoked admission, scope drift and excessive TTL", async () => {
		const f = fixture();
		await expect(
			f.transport.refresh({ ...f.scope, turn: 2 }, "d".repeat(64), 60000, new AbortController().signal),
		).rejects.toThrow();
		await expect(f.transport.refresh(f.scope, "d".repeat(64), 60001, new AbortController().signal)).rejects.toThrow();
		f.authorize.mockRejectedValueOnce(new Error("revoked"));
		await expect(f.transport.refresh(f.scope, "d".repeat(64), 60000, new AbortController().signal)).rejects.toThrow(
			"revoked",
		);
		expect(f.client.pushInstanceFile).not.toHaveBeenCalled();
	});
	it("rejects physical drift and an unprotected staged refresh", async () => {
		const f = fixture();
		f.client.getInstance.mockResolvedValueOnce({ ...f.instance, profiles: ["default"] });
		await expect(f.transport.refresh(f.scope, "d".repeat(64), 60000, new AbortController().signal)).rejects.toThrow(
			"DRIFTED",
		);
		const original = f.client.readInstanceFile.getMockImplementation()!;
		f.client.readInstanceFile.mockImplementation(async (...args) => ({
			...(await original(...args)),
			uid: args[2].endsWith("lease-refresh.json") ? 1000 : 0,
		}));
		await expect(f.transport.refresh(f.scope, "d".repeat(64), 60000, new AbortController().signal)).rejects.toThrow(
			"STAGING_UNCONFIRMED",
		);
		expect(f.client.execInstance).not.toHaveBeenCalled();
	});
});
