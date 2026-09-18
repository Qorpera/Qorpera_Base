import { CloudCompanyComputerBrowserControl } from "@qorpera/runtime/cloud-company-computer-browser-control";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "../../shell/test/fixtures/native-tool-authority-fixture.ts";
import {
	computerBinding,
	computerDeferred,
	computerId,
	computerLease,
	computerScope,
} from "./fixtures/company-computer.ts";

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
