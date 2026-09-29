import type { CloudCompanyPathControl } from "@qorpera/runtime/cloud-company-path-gateway";
import { cloudEventTools } from "@qorpera/runtime/cloud-event-tools";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { CloudNativeToolBoundary } from "@qorpera/runtime/cloud-native-tool-boundary";
import { describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const DELIVERY = "73100000-0000-4000-8000-00000000000a";
const HOOK = "73100000-0000-4000-8000-0000000000b1";

async function fixture(result?: (method: string, args: Record<string, unknown>, runId: string) => unknown) {
	const { binding, authority } = nativeToolAuthorityFixture();
	const run = await CloudNativeToolRun.open(
		binding,
		{ describeToolAuthority: async () => authority },
		new AbortController().signal,
	);
	const call = vi.fn<CloudCompanyPathControl["call"]>(async (method, args) => {
		if (result) return result(method, args as Record<string, unknown>, binding.runId);
		if (method === "qorpera_list_agent_event_hooks")
			return {
				schema: "qorpera.agent-event-hooks/v1",
				runId: binding.runId,
				hooks: [{ id: HOOK, name: "forms", proof: "address", status: "active", address: "A".repeat(43) }],
			};
		const request = (args as { p_request: { deliveryId: string; offset?: number } }).p_request;
		return {
			schema: "qorpera.agent-event/v1",
			runId: binding.runId,
			deliveryId: request.deliveryId,
			hook: { id: HOOK, name: "forms" },
			type: "contact.submitted",
			encoding: "utf8",
			offset: request.offset ?? 0,
			text: '{"name":"Ada"}',
			total: 14,
			done: true,
		};
	});
	const boundary = new CloudNativeToolBoundary({
		companyId: run.identity.companyId,
		runId: run.identity.runId,
		identity: run.identity,
		tools: cloudEventTools(binding, run.identity, { call }),
		assertActive: (signal) => run.assertActive(signal),
		signal: run.signal,
	});
	return { binding, run, call, boundary };
}

describe("agent event tools", () => {
	it("lists the company's hooks and reads one event through the run binding", async () => {
		const f = await fixture();
		try {
			const hooks = await f.boundary.invoke("h1", "qorpera", "list_hooks", {});
			expect(hooks.success, JSON.stringify(hooks)).toBe(true);
			expect(f.call.mock.calls[0].slice(0, 2)).toEqual(["qorpera_list_agent_event_hooks", { p_binding: f.binding }]);
			const event = await f.boundary.invoke("e1", "qorpera", "read_event", {
				deliveryId: DELIVERY.toUpperCase(),
				offset: 16000,
			});
			expect(event.success, JSON.stringify(event)).toBe(true);
			expect(f.call.mock.calls[1].slice(0, 2)).toEqual([
				"qorpera_read_agent_event",
				{ p_binding: f.binding, p_request: { deliveryId: DELIVERY, offset: 16000 } },
			]);
			expect(event.contentItems[0].text).toContain("Ada");
			expect(JSON.stringify(event)).not.toContain(f.binding.credentialCapsuleId);
		} finally {
			f.run.close();
		}
	});

	it("refuses a malformed request without calling the cloud", async () => {
		const f = await fixture();
		try {
			for (const [callId, name, args] of [
				["bad_1", "list_hooks", { all: true }],
				["bad_2", "read_event", {}],
				["bad_3", "read_event", { deliveryId: "forms" }],
				["bad_4", "read_event", { deliveryId: DELIVERY, offset: -1 }],
				["bad_5", "read_event", { deliveryId: DELIVERY, offset: 1.5 }],
				["bad_6", "read_event", { deliveryId: DELIVERY, hookId: HOOK }],
				["bad_7", "read_event", { deliveryId: DELIVERY, offset: 1048577 }],
			] as const) {
				const refused = await f.boundary.invoke(callId, "qorpera", name, args);
				expect(refused.success, callId).toBe(false);
			}
			expect(f.call).not.toHaveBeenCalled();
		} finally {
			f.run.close();
		}
	});

	it("refuses a receipt for another run or another event", async () => {
		const f = await fixture((method, args, runId) =>
			method === "qorpera_list_agent_event_hooks"
				? { schema: "qorpera.agent-event-hooks/v1", runId: "73100000-0000-4000-8000-0000000000ff", hooks: [] }
				: {
						schema: "qorpera.agent-event/v1",
						runId,
						deliveryId: "73100000-0000-4000-8000-0000000000ee",
						done: true,
						...(args as object),
					},
		);
		try {
			expect((await f.boundary.invoke("h2", "qorpera", "list_hooks", {})).success).toBe(false);
			expect((await f.boundary.invoke("e2", "qorpera", "read_event", { deliveryId: DELIVERY })).success).toBe(false);
		} finally {
			f.run.close();
		}
	});

	it("passes a next piece's offset on and refuses one that does not move forward", async () => {
		const receipt = (next: unknown) => (_method: string, args: Record<string, unknown>, runId: string) => ({
			schema: "qorpera.agent-event/v1",
			runId,
			deliveryId: (args.p_request as { deliveryId: string }).deliveryId,
			encoding: "utf8",
			offset: (args.p_request as { offset?: number }).offset ?? 0,
			text: "x",
			total: 20000,
			done: false,
			next,
		});
		const moving = await fixture(receipt(9000));
		try {
			const piece = await moving.boundary.invoke("n1", "qorpera", "read_event", {
				deliveryId: DELIVERY,
				offset: 10,
			});
			expect(piece.success, JSON.stringify(piece)).toBe(true);
			expect(piece.contentItems[0].text).toContain('\\"next\\":9000');
		} finally {
			moving.run.close();
		}
		const stuck = await fixture(receipt(10));
		try {
			expect(
				(await stuck.boundary.invoke("n2", "qorpera", "read_event", { deliveryId: DELIVERY, offset: 10 })).success,
			).toBe(false);
		} finally {
			stuck.run.close();
		}
	});

	it("refuses a call made for another run than the one it was built for", async () => {
		const f = await fixture();
		try {
			const readEvent = cloudEventTools(f.binding, f.run.identity, { call: f.call }).find(
				(tool) => tool.name === "read_event",
			)!;
			const context = {
				companyId: f.run.identity.companyId,
				runId: "73100000-0000-4000-8000-0000000000dd",
				callId: "c1",
				argumentSha256: "0".repeat(64),
				signal: new AbortController().signal,
				identity: f.run.identity,
			};
			await expect(readEvent.execute({ deliveryId: DELIVERY }, context)).rejects.toThrow(
				"Event tool identity differs",
			);
			await expect(
				readEvent.execute(
					{ deliveryId: DELIVERY },
					{ ...context, runId: f.run.identity.runId, identity: undefined },
				),
			).rejects.toThrow("Event tool identity differs");
			expect(f.call).not.toHaveBeenCalled();
		} finally {
			f.run.close();
		}
	});

	it("refuses to be built for another identity than its binding", async () => {
		const f = await fixture();
		try {
			expect(() =>
				cloudEventTools(
					f.binding,
					{ ...f.run.identity, runId: "73100000-0000-4000-8000-0000000000cc" },
					{ call: f.call },
				),
			).toThrow("Event binding differs");
		} finally {
			f.run.close();
		}
	});
});
