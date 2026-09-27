import {
	CloudCompanyComputerBrowserControl,
	CloudCompanyComputerScreenBrowserControl,
	CompanyComputerBrowserNetworkPausedError,
} from "@qorpera/runtime/cloud-company-computer-browser-control";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	computerBinding,
	computerDeferred,
	computerId,
	computerLease,
	computerScope,
} from "./fixtures/company-computer.ts";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
});
async function fixture() {
	const source = nativeToolAuthorityFixture();
	const run = await CloudNativeToolRun.open(
		source.binding,
		{ describeToolAuthority: async () => source.authority },
		new AbortController().signal,
	);
	runs.push(run);
	const scope = { ...computerScope(), companyId: run.identity.companyId, environmentId: run.identity.environmentId };
	const binding = { ...computerBinding(), ...scope, staffAgentId: run.identity.staffAgentId };
	const lease = {
		...computerLease(),
		binding,
		driver: { kind: "agent" as const, runId: run.identity.runId, staffAgentId: run.identity.staffAgentId },
	};
	const grant = { profileId: computerId(41), grantId: computerId(42), version: 1 };
	const call = vi.fn<(_method: string, _args: Record<string, unknown>, _signal: AbortSignal) => Promise<unknown>>(
		async () => ({ state: "authorized" }),
	);
	const access = new CloudCompanyComputerBrowserControl({ run, scope, lease: () => lease, control: { call } });
	return { run, scope, binding, lease, grant, call, access, signal: new AbortController().signal };
}

describe("durable browser profile access", () => {
	it("rechecks exact profile consent and current full native/screen bindings each time", async () => {
		const f = await fixture();
		await f.access.assertGranted(f.grant, f.binding, f.signal);
		f.lease.epoch = 9;
		await f.access.assertGranted(f.grant, f.binding, f.signal);
		expect(f.call).toHaveBeenCalledTimes(2);
		expect(f.call.mock.calls[0][1]).toEqual({
			p_binding: f.run.binding,
			p_scope: f.scope,
			p_lease: { ...f.lease, epoch: 1 },
			p_grant: f.grant,
		});
		expect(f.call.mock.calls[1][1].p_lease).toEqual(f.lease);
	});

	it("rejects missing, stale, substituted or extended responses", async () => {
		const f = await fixture();
		for (const response of [null, false, { state: "refused" }, { state: "authorized", token: "extra" }]) {
			f.call.mockResolvedValue(response);
			await expect(f.access.assertGranted(f.grant, f.binding, f.signal)).rejects.toThrow(
				"BROWSER_GRANT_UNCONFIRMED",
			);
		}
		f.call.mockRejectedValue(new Error("consent revoked"));
		await expect(f.access.assertGranted(f.grant, f.binding, f.signal)).rejects.toThrow("consent revoked");
	});

	it("never accepts another screen, driver, company or a provider credential as a grant", async () => {
		const f = await fixture();
		await expect(
			f.access.assertGranted(f.grant, { ...f.binding, screenId: computerId(99) }, f.signal),
		).rejects.toThrow();
		await expect(
			f.access.assertGranted(f.grant, { ...f.binding, companyId: computerId(99) }, f.signal),
		).rejects.toThrow();
		await expect(f.access.assertGranted({ ...f.grant, version: 0 }, f.binding, f.signal)).rejects.toThrow();
		f.lease.driver.runId = computerId(99);
		await expect(f.access.assertGranted(f.grant, f.binding, f.signal)).rejects.toThrow();
		expect(f.call).not.toHaveBeenCalled();
	});

	it("uses immutable request copies and cancels consent lookup with the run", async () => {
		const f = await fixture();
		const wait = computerDeferred<unknown>();
		f.call.mockImplementation(() => wait.promise);
		const checking = f.access.assertGranted(f.grant, f.binding, f.signal);
		const rejected = expect(checking).rejects.toThrow();
		await vi.waitFor(() => expect(f.call).toHaveBeenCalledOnce());
		f.grant.version = 99;
		f.lease.epoch = 99;
		expect(f.call.mock.calls[0][1].p_grant).toMatchObject({ version: 1 });
		f.run.close();
		await rejected;
		expect(f.call.mock.calls[0][2].aborted).toBe(true);
		wait.resolve({ state: "authorized" });
	});
});

describe("screen-owned browser authority (an agent lease or a live input viewer, decided by SQL)", () => {
	function screenFixture() {
		const grant = { profileId: computerId(41), grantId: computerId(42), version: 3 };
		const call = vi.fn<(_method: string, _args: Record<string, unknown>, _signal: AbortSignal) => Promise<unknown>>(
			async () => ({ state: "authorized", grant, validForMs: 5000 }),
		);
		const access = new CloudCompanyComputerScreenBrowserControl({
			scope: computerScope(),
			computerGeneration: 1,
			control: { call },
		});
		return { grant, call, access, binding: computerBinding(), signal: new AbortController().signal };
	}

	it("opens with the grant SQL names for the screen and sends only the binding and who asked", async () => {
		const f = screenFixture();
		await expect(f.access.open(f.binding, "desktop", f.signal)).resolves.toEqual(f.grant);
		expect(f.call).toHaveBeenCalledExactlyOnceWith(
			"qorpera_office_screen_browser_grant",
			{ p_binding: f.binding, p_opener: "desktop" },
			expect.any(AbortSignal),
		);
		// No member, viewer, run or profile is asserted by the guest: SQL derives them.
		expect(Object.keys(f.call.mock.calls[0][1]).sort()).toEqual(["p_binding", "p_opener"]);
		await f.access.open(f.binding, "agent", f.signal);
		expect(f.call.mock.calls[1][1].p_opener).toBe("agent");
		await expect(f.access.open(f.binding, "member" as "desktop", f.signal)).rejects.toThrow("INVALID_BROWSER_OPENER");
		expect(f.call).toHaveBeenCalledTimes(2);
	});

	it("rechecks without recording an open, and only the exact current grant passes", async () => {
		const f = screenFixture();
		await expect(f.access.assertGranted(f.grant, f.binding, f.signal)).resolves.toBeUndefined();
		expect(f.call.mock.calls[0][1]).toEqual({ p_binding: f.binding, p_opener: null });
		for (const changed of [
			{ ...f.grant, version: 4 },
			{ ...f.grant, grantId: computerId(43) },
			{ ...f.grant, profileId: computerId(44) },
		])
			await expect(f.access.assertGranted(changed, f.binding, f.signal)).rejects.toThrow(
				"BROWSER_GRANT_UNCONFIRMED",
			);
		await expect(
			f.access.assertGranted({ ...f.grant, path: "/srv/profiles/other" } as typeof f.grant, f.binding, f.signal),
		).rejects.toThrow("INVALID_BROWSER_GRANT");
	});

	it("reads idle as a paused network for the same grant, never as an open or for a changed grant", async () => {
		const f = screenFixture();
		f.call.mockResolvedValue({ state: "idle", grant: f.grant, validForMs: 5000 });
		await expect(f.access.assertGranted(f.grant, f.binding, f.signal)).rejects.toBeInstanceOf(
			CompanyComputerBrowserNetworkPausedError,
		);
		await expect(f.access.assertGranted({ ...f.grant, version: 4 }, f.binding, f.signal)).rejects.toThrow(
			"BROWSER_GRANT_UNCONFIRMED",
		);
		// SQL never answers idle to an open; one that did is no authority at all.
		await expect(f.access.open(f.binding, "desktop", f.signal)).rejects.toThrow("BROWSER_GRANT_UNCONFIRMED");
	});

	it("treats a refusal, a lost answer and every malformed answer as no authority", async () => {
		const f = screenFixture();
		f.call.mockRejectedValueOnce(new Error("Browser authority unavailable: sensitive SQL detail"));
		const refused = await f.access.open(f.binding, "desktop", f.signal).catch((error: Error) => error);
		expect((refused as Error).message).toBe("BROWSER_GRANT_UNCONFIRMED");
		for (const response of [
			null,
			[],
			{ state: "authorized" },
			{ state: "refused", grant: f.grant, validForMs: 5000 },
			{ state: "authorized", grant: f.grant, validForMs: 0 },
			{ state: "authorized", grant: f.grant, validForMs: 5001 },
			{ state: "authorized", grant: f.grant, validForMs: 5000, memberId: computerId(9) },
			{ state: "authorized", grant: { ...f.grant, version: 0 }, validForMs: 5000 },
			{ state: "authorized", grant: { ...f.grant, profileId: "../other" }, validForMs: 5000 },
			{ state: "authorized", grant: { ...f.grant, directory: "/srv" }, validForMs: 5000 },
		]) {
			f.call.mockResolvedValueOnce(response);
			await expect(f.access.open(f.binding, "desktop", f.signal)).rejects.toThrow("BROWSER_GRANT_UNCONFIRMED");
		}
	});

	it.each([{ companyId: computerId(99) }, { computerGeneration: 2 }, { screenOrdinal: 0 }])(
		"rejects another office, generation or screen %j before any RPC",
		async (changed) => {
			const f = screenFixture();
			await expect(f.access.open({ ...f.binding, ...changed }, "desktop", f.signal)).rejects.toThrow();
			await expect(f.access.assertGranted(f.grant, { ...f.binding, ...changed }, f.signal)).rejects.toThrow();
			expect(f.call).not.toHaveBeenCalled();
		},
	);
});
