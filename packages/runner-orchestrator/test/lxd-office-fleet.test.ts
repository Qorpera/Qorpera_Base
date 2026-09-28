import { describe, expect, it, vi } from "vitest";
import type { LxdOfficeCreationIdentity } from "../src/lxd-office-creation-journal.ts";
import {
	type OfficeFleetRegistry,
	type OfficeFleetStatus,
	officeFleetOffer,
	officeFleetScope,
	reconcileOfficeFleet,
} from "../src/lxd-office-fleet.ts";
import { renderOfficeFleetUnits } from "../src/lxd-office-fleet-installation.ts";
import { parseOfficeFleetServiceConfig } from "../src/lxd-office-fleet-service.ts";
import { officePhysicalFixture } from "./fixtures/office-physical-policy.ts";

const nodeId = "77777777-7777-4777-8777-777777777777";
const intentId = "88888888-8888-4888-8888-888888888888";
const serviceConfigSha256 = "a".repeat(64);
function fixture() {
	const { policy, binding } = officePhysicalFixture();
	const identity: LxdOfficeCreationIdentity = {
		schema: "qorpera.lxd-office-creation/v1",
		binding,
		intentId,
		createCommandId: "99999999-9999-4999-8999-999999999999",
	};
	const offer = officeFleetOffer(policy, nodeId, serviceConfigSha256, identity);
	const status = (state: OfficeFleetStatus["state"]): OfficeFleetStatus => ({
		schema: "qorpera.office-fleet-status/v1",
		scope: officeFleetScope(policy),
		computerGeneration: 1,
		intentId: state === "waiting" ? null : intentId,
		state,
		offer: state === "placed" ? offer : null,
	});
	const call = vi.fn<OfficeFleetRegistry["call"]>();
	const options = {
		policy,
		nodeId,
		serviceConfigSha256,
		registry: { call },
		inspect: vi.fn(async () => {}),
		identity: vi.fn(async () => identity),
	};
	return { options, offer, status, call };
}

describe("office fleet bootstrap", () => {
	it("stages local identity, selects, and rereads the exact durable identity before starting", async () => {
		const f = fixture();
		f.call
			.mockResolvedValueOnce(f.status("unplaced"))
			.mockResolvedValueOnce(f.status("unplaced"))
			.mockResolvedValueOnce(f.status("placed"));
		const signal = new AbortController().signal;
		expect(await reconcileOfficeFleet(f.options, signal)).toBe("selected");
		expect(f.options.inspect).toHaveBeenCalledExactlyOnceWith(signal);
		expect(f.options.identity.mock.calls).toEqual([
			[intentId, false, signal],
			[intentId, true, signal],
		]);
		expect(f.call.mock.calls.map(([method]) => method)).toEqual([
			"qorpera_runtime_office_fleet_status",
			"qorpera_offer_runtime_office_fleet",
			"qorpera_place_runtime_office_fleet",
		]);
		expect(f.call.mock.calls[1][1]).toEqual({ p_offer: f.offer });
	});
	it("stage-only registers a candidate without choosing a host or dispatching a VM", async () => {
		const f = fixture();
		f.call.mockResolvedValue(f.status("unplaced"));
		expect(await reconcileOfficeFleet({ ...f.options, stageOnly: true }, new AbortController().signal)).toBe(
			"staged",
		);
		expect(f.call).toHaveBeenCalledTimes(2);
		expect(f.options.identity).toHaveBeenCalledTimes(1);
	});
	it("never prepares or launches on the losing host", async () => {
		const f = fixture();
		const selected = f.status("placed");
		selected.offer!.providerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		f.call.mockResolvedValue(selected);
		expect(await reconcileOfficeFleet(f.options, new AbortController().signal)).toBe("elsewhere");
		expect(f.options.inspect).not.toHaveBeenCalled();
		expect(f.options.identity).not.toHaveBeenCalled();
		expect(f.call).toHaveBeenCalledTimes(1);
	});
	it("recovers a committed selection after a lost reply without creating replacement identity", async () => {
		const f = fixture();
		f.call
			.mockResolvedValueOnce(f.status("unplaced"))
			.mockResolvedValueOnce(f.status("unplaced"))
			.mockRejectedValueOnce(new Error("lost reply"))
			.mockResolvedValueOnce(f.status("placed"));
		const signal = new AbortController().signal;
		await expect(reconcileOfficeFleet(f.options, signal)).rejects.toThrow("lost reply");
		expect(await reconcileOfficeFleet(f.options, signal)).toBe("selected");
		expect(f.options.identity.mock.calls).toEqual([
			[intentId, false, signal],
			[intentId, true, signal],
		]);
	});
	it("refuses missing selected journals and mismatched configuration, rather than rebinding", async () => {
		const f = fixture();
		f.call.mockResolvedValue(f.status("placed"));
		f.options.identity.mockRejectedValueOnce(new Error("journal missing"));
		await expect(reconcileOfficeFleet(f.options, new AbortController().signal)).rejects.toThrow("journal missing");
		await expect(
			reconcileOfficeFleet({ ...f.options, serviceConfigSha256: "b".repeat(64) }, new AbortController().signal),
		).rejects.toThrow("OFFICE_FLEET_SELECTION_CHANGED");
		expect(f.call.mock.calls.every(([method]) => method === "qorpera_runtime_office_fleet_status")).toBe(true);
	});
	it.each(["waiting", "held", "retained"] as const)("preserves %s without physical effects", async (state) => {
		const f = fixture();
		f.call.mockResolvedValue(f.status(state));
		expect(await reconcileOfficeFleet(f.options, new AbortController().signal)).toBe(state);
		expect(f.options.inspect).not.toHaveBeenCalled();
		expect(f.options.identity).not.toHaveBeenCalled();
	});
	it("aborting after physical inspection cannot publish an offer", async () => {
		const f = fixture();
		const controller = new AbortController();
		f.call.mockResolvedValue(f.status("unplaced"));
		f.options.inspect.mockImplementation(async () => controller.abort());
		await expect(reconcileOfficeFleet(f.options, controller.signal)).rejects.toThrow();
		expect(f.options.identity).not.toHaveBeenCalled();
		expect(f.call).toHaveBeenCalledTimes(1);
	});
	it("refuses a status from another generation or missing placement evidence", async () => {
		const f = fixture();
		f.call
			.mockResolvedValueOnce({ ...f.status("placed"), computerGeneration: 2 })
			.mockResolvedValueOnce({ ...f.status("placed"), offer: null });
		await expect(reconcileOfficeFleet(f.options, new AbortController().signal)).rejects.toThrow("STATUS_INVALID");
		await expect(reconcileOfficeFleet(f.options, new AbortController().signal)).rejects.toThrow("STATUS_INVALID");
	});
});

describe("office fleet service installation", () => {
	it("binds separate per-office units to the same existing local lock and protected configuration", () => {
		const { policy } = officePhysicalFixture();
		const units = renderOfficeFleetUnits(
			policy,
			"/etc/qorpera/office-fleet/company/fleet.json",
			"/opt/qorpera/office-fleet/revision/runner.cjs",
			"/etc/qorpera/registry-ca.pem",
		);
		expect(units.provider.name).toBe(`qorpera-office-fleet-${policy.guest.companyComputerId}-g1.service`);
		expect(units.stage.text).toContain('"$$2" --stage "$$3"');
		expect(units.provider.text).toContain('"$$2" --config "$$3"');
		for (const unit of Object.values(units)) {
			expect(unit.text).toContain(`User=${policy.workbench.uid}`);
			// The namespace helper the node observer installs on every node, not the single-office one.
			expect(unit.text).toContain("Requires=qorpera-node-host-namespace.service");
			expect(unit.text).toContain("After=network-online.target qorpera-node-host-namespace.service");
			expect(unit.text).not.toContain("qorpera-office-host-namespace");
			expect(unit.text).toContain(`SupplementaryGroups=${policy.host.socketGid}`);
			expect(unit.text).toContain(`"${policy.journal.path}/adoption.lock"`);
			expect(unit.text).toContain("NoNewPrivileges=yes");
			expect(unit.text).toContain('Environment="NODE_EXTRA_CA_CERTS=/etc/qorpera/registry-ca.pem"');
		}
	});
	it("validates host and service pins before installation", () => {
		const raw = {
			schema: "qorpera.office-fleet-service/v1",
			nodeId,
			servicePath: "/etc/qorpera/fleet/service.json",
			serviceConfigSha256,
		};
		expect(parseOfficeFleetServiceConfig(raw).nodeId).toBe(nodeId);
		expect(() => parseOfficeFleetServiceConfig({ ...raw, servicePath: "../service.json" })).toThrow();
		expect(() => parseOfficeFleetServiceConfig({ ...raw, serviceConfigSha256: "mutable" })).toThrow();
		expect(() => parseOfficeFleetServiceConfig({ ...raw, nodeId: "node-2" })).toThrow();
	});
});
