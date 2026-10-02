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

	it("sends an email through the run binding with the call's id, each address once", async () => {
		const f = await fixture((_method, args, runId) => ({
			schema: "qorpera.agent-mail/v1",
			runId,
			mailId: "73300000-0000-4000-8000-0000000000a1",
			status: "queued",
			...(args.p_request as object),
		}));
		try {
			const sent = await f.boundary.invoke("m1", "qorpera", "send_mail", {
				from: " Support@Mail.Example.Test ",
				to: [" Bob@Acme.test", "bob@acme.test", "eve@acme.test"],
				cc: ["eve@acme.test", "Boss@Acme.test"],
				subject: " Your refund ",
				text: "Hi Bob,\n\nIt is on its way.\n",
				inReplyTo: DELIVERY.toUpperCase(),
			});
			expect(sent.success, JSON.stringify(sent)).toBe(true);
			expect(f.call.mock.calls[0].slice(0, 2)).toEqual([
				"qorpera_send_agent_mail",
				{
					p_binding: f.binding,
					p_call_id: "m1",
					p_request: {
						from: "support@mail.example.test",
						to: ["bob@acme.test", "eve@acme.test"],
						cc: ["boss@acme.test"],
						subject: "Your refund",
						text: "Hi Bob,\n\nIt is on its way.\n",
						inReplyTo: DELIVERY,
					},
				},
			]);
			expect(sent.contentItems[0].text).toContain("73300000-0000-4000-8000-0000000000a1");
			expect(JSON.stringify(sent)).not.toContain(f.binding.credentialCapsuleId);
		} finally {
			f.run.close();
		}
	});

	it("refuses a malformed email without calling the cloud", async () => {
		const f = await fixture();
		const email = { from: "support@mail.example.test", to: ["bob@acme.test"], subject: "Hi", text: "Hello" };
		const many = (n: number) => Array.from({ length: n }, (_, i) => `c${i}@acme.test`);
		try {
			for (const [callId, args] of [
				["mail_1", { ...email, to: [] }],
				["mail_2", { ...email, to: many(11) }],
				["mail_3", { ...email, to: many(10), cc: ["boss@acme.test"] }],
				["mail_4", { ...email, to: ["Bob <bob@acme.test>"] }],
				["mail_5", { ...email, to: ["bob@localhost"] }],
				["mail_6", { ...email, to: "bob@acme.test" }],
				["mail_7", { ...email, subject: "Hi\r\nBcc: all@acme.test" }],
				["mail_8", { ...email, subject: "  " }],
				["mail_9", { ...email, text: " \n" }],
				["mail_10", { ...email, text: "t".repeat(20001) }],
				["mail_11", { ...email, bcc: ["boss@acme.test"] }],
				["mail_12", { ...email, inReplyTo: "the last email" }],
				["mail_13", { to: email.to, subject: email.subject, text: email.text }],
				["mail_14", { ...email, subject: "s".repeat(201) }],
			] as const) {
				const refused = await f.boundary.invoke(callId, "qorpera", "send_mail", args);
				expect(refused.success, callId).toBe(false);
			}
			expect(f.call).not.toHaveBeenCalled();
		} finally {
			f.run.close();
		}
	});

	it("refuses a mail receipt for another run", async () => {
		const f = await fixture(() => ({
			schema: "qorpera.agent-mail/v1",
			runId: "73300000-0000-4000-8000-0000000000ff",
			mailId: "73300000-0000-4000-8000-0000000000a1",
			status: "queued",
		}));
		try {
			const sent = await f.boundary.invoke("m2", "qorpera", "send_mail", {
				from: "support@mail.example.test",
				to: ["bob@acme.test"],
				subject: "Hi",
				text: "Hello",
			});
			expect(sent.success).toBe(false);
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
	const mail = {
		deliveryId: DELIVERY,
		mailbox: "agents@northwind.qorpera.mail",
		deliveredTo: ["agents+stripe@northwind.qorpera.mail"],
		from: "Stripe <notifications@stripe.com>",
		subject: "Confirm your email",
		receivedAt: "2026-10-02T10:00:01+00:00",
	};
	const search = (answers: unknown[][]) => (method: string, _args: Record<string, unknown>, runId: string) => {
		if (method !== "qorpera_find_agent_mail") throw new Error(method);
		const mails = answers.shift() ?? [];
		return { schema: "qorpera.agent-mail-search/v1", runId, since: "2026-10-02T09:00:00+00:00", mails, more: false };
	};

	it("finds mail through the run binding, with addresses lowercased and no wait passed on", async () => {
		const f = await fixture(search([[mail]]));
		try {
			const found = await f.boundary.invoke("f1", "qorpera", "find_mail", {
				to: " Agents+Stripe@Northwind.Qorpera.Mail ",
				from: "Stripe",
				subject: "Confirm",
				since: "2026-10-02T09:00:00+02:00",
				before: "2026-10-02T12:00:00Z",
				waitSeconds: 60,
			});
			// A match answers at once, whatever time is left to wait.
			expect(found.success, JSON.stringify(found)).toBe(true);
			expect(f.call.mock.calls.map((call) => call.slice(0, 2))).toEqual([
				[
					"qorpera_find_agent_mail",
					{
						p_binding: f.binding,
						p_request: {
							to: "agents+stripe@northwind.qorpera.mail",
							from: "Stripe",
							subject: "Confirm",
							since: "2026-10-02T09:00:00+02:00",
							before: "2026-10-02T12:00:00Z",
						},
					},
				],
			]);
			expect(found.contentItems[0].text).toContain("Confirm your email");
		} finally {
			f.run.close();
		}
	});

	it("waits for a matching email, and answers with none when the time is up", async () => {
		const arriving = await fixture(search([[], [mail]]));
		try {
			const started = Date.now();
			const found = await arriving.boundary.invoke("w1", "qorpera", "find_mail", {
				mailbox: "agents@x.example",
				waitSeconds: 1,
			});
			expect(found.success, JSON.stringify(found)).toBe(true);
			expect(found.contentItems[0].text).toContain(DELIVERY);
			expect(arriving.call).toHaveBeenCalledTimes(2);
			expect(Date.now() - started).toBeGreaterThanOrEqual(900);
		} finally {
			arriving.run.close();
		}
		const quiet = await fixture(search([]));
		try {
			const none = await quiet.boundary.invoke("w2", "qorpera", "find_mail", { waitSeconds: 1 });
			expect(none.success, JSON.stringify(none)).toBe(true);
			expect(none.contentItems[0].text).toContain('\\"mails\\":[]');
			expect(quiet.call).toHaveBeenCalledTimes(2);
		} finally {
			quiet.run.close();
		}
		const now = await fixture(search([]));
		try {
			expect((await now.boundary.invoke("w3", "qorpera", "find_mail", {})).success).toBe(true);
			expect(now.call).toHaveBeenCalledOnce();
		} finally {
			now.run.close();
		}
	});

	it("stops waiting as soon as the run ends", async () => {
		const f = await fixture(search([]));
		const waiting = f.boundary.invoke("w4", "qorpera", "find_mail", { waitSeconds: 120 });
		await new Promise((resolve) => setTimeout(resolve, 50));
		const closed = Date.now();
		f.run.close();
		const ended = await waiting;
		expect(Date.now() - closed).toBeLessThan(1000);
		expect(ended.success).toBe(false);
		expect(f.call).toHaveBeenCalledOnce();
	});

	it("refuses a malformed search without calling the cloud, and an answer for another run", async () => {
		const f = await fixture(search([]));
		try {
			for (const [callId, args] of [
				["s1", { folder: "inbox" }],
				["s2", { mailbox: "ab" }],
				["s3", { from: "" }],
				["s4", { subject: "s".repeat(201) }],
				["s5", { since: "2026-10-02T09:00:00" }],
				["s6", { since: "yesterday" }],
				["s7", { waitSeconds: 121 }],
				["s8", { waitSeconds: 1.5 }],
				["s9", { from: "a\nb" }],
				["s10", { to: 42 }],
				["s15", { waitSeconds: null }],
				["s16", { before: "yesterday" }],
			] as const) {
				const refused = await f.boundary.invoke(callId, "qorpera", "find_mail", args);
				expect(refused.success, callId).toBe(false);
			}
			expect(f.call).not.toHaveBeenCalled();
		} finally {
			f.run.close();
		}
		for (const [callId, answer] of [
			["s11", { runId: "73100000-0000-4000-8000-0000000000ff" }],
			["s12", { schema: "qorpera.agent-mail/v1" }],
			["s13", { mails: Array.from({ length: 11 }, () => mail) }],
			["s14", { more: "no" }],
		] as const) {
			const other = await fixture((_method, _args, runId) =>
				Object.assign({ schema: "qorpera.agent-mail-search/v1", runId, mails: [], more: false }, answer),
			);
			try {
				expect((await other.boundary.invoke(callId, "qorpera", "find_mail", {})).success, callId).toBe(false);
			} finally {
				other.run.close();
			}
		}
	});
});
