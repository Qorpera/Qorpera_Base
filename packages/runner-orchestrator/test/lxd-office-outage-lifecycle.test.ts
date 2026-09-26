import { rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { LxdOfficePowerOffWorker } from "../src/lxd-office-power-off-worker.ts";
import { readLxdOfficeStopEvidence } from "../src/lxd-office-stop-evidence.ts";
import { officeOutageLifecycleFixture } from "./fixtures/office-outage-lifecycle.ts";

const roots: string[] = [];
const signal = () => new AbortController().signal;
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("proves an admitted outage boot before an ordinary guest stop and power-off in its actual VM segment", async () => {
	const f = await officeOutageLifecycleFixture(roots);
	const before = await f.journal.history();
	const evidence = await readLxdOfficeStopEvidence(f.root, f.intentId, f.binding, f.stop.request, f.client, signal());
	expect(evidence.kind).toBe("outage");
	await f.stop.worker.reconcile(f.intentId, f.stop.request, signal());
	expect(f.stop.state.acknowledgements).toBe(1);
	const registry = {
		call: async (...args: Parameters<typeof f.stop.registry>) =>
			args[0] === "qorpera_suspend_runtime_node_machine"
				? {
						state: "suspended",
						allocationId: f.binding.allocationId,
						nodeId: "36000000-0000-4000-8000-000000000010",
						suspendedAt: "2026-09-23T15:00:00.000000+00:00",
					}
				: f.stop.registry(...args),
	};
	const worker = new LxdOfficePowerOffWorker({ policy: f.policy, check: f.check }, registry, {
		client: f.client,
		kernelLock: async () => {},
	});
	await expect(worker.reconcile(f.intentId, f.stop.request, signal())).resolves.toMatchObject({
		state: "powered_off",
	});
	expect((await f.journal.history()).journalHeadSha256).toBe(before.journalHeadSha256);
	await expect(worker.reconcile(f.intentId, f.stop.request, signal())).resolves.toMatchObject({
		state: "powered_off",
	});
	expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(5);
	expect(f.client.submitOfficeOutageServiceStart).toHaveBeenCalledTimes(1);
	expect(f.client.submitOfficeServiceStop).toHaveBeenCalledTimes(1);
}, 60000);
