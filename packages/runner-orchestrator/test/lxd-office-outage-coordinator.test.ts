import { readFile, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { publish } from "../src/lxd-office-journal-files.ts";
import { LxdOfficeOutageCoordinator } from "../src/lxd-office-outage-coordinator.ts";
import { officeOutageLifecycleFixture } from "./fixtures/office-outage-lifecycle.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const signal = () => new AbortController().signal;

it("observes admitted outage history through the provider registry and recovers the original archived guard after a lost final marker", async () => {
	const f = await officeOutageLifecycleFixture(roots);
	const activation = {
		...f.activation,
		activationId: f.admitted.activationId,
		startup: {
			...f.activation.startup,
			bootId: f.completion.command.bootId,
			configurationSha256: f.completion.configurationSha256,
			serviceInvocationId: f.completion.serviceInvocationId,
		},
	};
	const current = { schema: "qorpera.office-provider-activation/v1", officeState: "active", activation };
	const registry = {
		call: vi.fn(async (method: string, args: Record<string, unknown>) => {
			expect(method).toBe("qorpera_runtime_office_provider_activation");
			expect(args).not.toHaveProperty("p_request");
			expect(args.p_provider_id).toBe(f.binding.providerId);
			return structuredClone(current);
		}),
	};
	const guard = {
		status: vi.fn(async (permitId: string) => f.guard().status(permitId)),
		latest: vi.fn(async (allocationId: string) => f.guard().latest(allocationId)),
	};
	const open = () => new LxdOfficeOutageCoordinator(f.admission(), guard, f.client, registry);
	expect(await open().pendingGuard(f.intentId, signal())).toBeNull();
	await expect(open().active(f.intentId, signal())).resolves.toMatchObject({
		state: "active",
		activationId: f.admitted.activationId,
	});
	expect(registry.call).toHaveBeenCalledTimes(2);
	// A concurrent SQL change after the physical reads cannot be reported active.
	registry.call
		.mockImplementationOnce(async () => structuredClone(current))
		.mockImplementationOnce(async () => ({ ...structuredClone(current), officeState: "maintenance" }));
	await expect(open().active(f.intentId, signal())).rejects.toThrow("OFFICE_OUTAGE_ACTIVATION_CHANGED");
	const name = `outage-activation-completed-${f.binding.allocationId}-${f.admitted.activationId}.json`,
		bytes = await readFile(join(f.root, name));
	await unlink(join(f.root, name));
	try {
		const pending = await open().pendingGuard(f.intentId, signal());
		expect(pending).toEqual(f.original);
		expect(guard.status).toHaveBeenLastCalledWith(f.original.permit.permitId, expect.any(AbortSignal));
		expect(guard.latest).not.toHaveBeenCalled();
		expect((await f.guard().latest(f.binding.allocationId))?.permit.permitId).not.toBe(f.original.permit.permitId);
	} finally {
		await publish(f.root, name, bytes);
	}
	const starts = f.client.submitInstanceOperation;
	expect(vi.mocked(starts).mock.calls.filter(([, request]) => request.action === "start")).toHaveLength(2);
}, 120000);
