import type { CloudCompanyPathControl, CloudCompanyPathGateway } from "@qorpera/runtime/cloud-company-path-gateway";
import { cloudEventTools } from "@qorpera/runtime/cloud-event-tools";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import {
	CloudNativeToolBoundary,
	type CloudToolResult,
	MAX_CLOUD_TOOL_RESULT_BYTES,
} from "@qorpera/runtime/cloud-native-tool-boundary";
import { describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const DELIVERY = "73100000-0000-4000-8000-00000000000a";
const HOOK = "73100000-0000-4000-8000-0000000000b1";

async function fixture(
	result?: (method: string, args: Record<string, unknown>, runId: string) => unknown,
	gateway?: Pick<CloudCompanyPathGateway, "mutate">,
) {
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
			headers: { "content-type": "application/json" },
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
		tools: cloudEventTools(binding, run.identity, { call }, gateway as CloudCompanyPathGateway | undefined),
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

	it("passes a next piece's offset on, and refuses one that skips, stands still or contradicts done", async () => {
		const receipt =
			(piece: Record<string, unknown>) => (_method: string, args: Record<string, unknown>, runId: string) => ({
				schema: "qorpera.agent-event/v1",
				runId,
				deliveryId: (args.p_request as { deliveryId: string }).deliveryId,
				headers: {},
				encoding: "utf8",
				offset: (args.p_request as { offset?: number }).offset ?? 0,
				text: "x\u{1F600}",
				total: 20000,
				done: false,
				...piece,
			});
		const moving = await fixture(receipt({ next: 12 }));
		try {
			const piece = await moving.boundary.invoke("n1", "qorpera", "read_event", {
				deliveryId: DELIVERY,
				offset: 10,
			});
			expect(piece.success, JSON.stringify(piece)).toBe(true);
			expect(piece.contentItems[0].text).toContain('\\"next\\":12');
		} finally {
			moving.run.close();
		}
		for (const [callId, piece] of [
			["n2", { next: 9000 }],
			["n3", { next: 10 }],
			["n4", { next: 13 }],
			["n5", { text: "", next: 10 }],
			["n6", {}],
			["n7", { done: true, next: 12 }],
			["n8", { encoding: "base64", data: "AAAA", next: 12 }],
			["n9", { encoding: "base64", data: "AAA", next: 12 }],
			["n10", { offset: 0, next: 12 }],
			["n11", { headers: { "content-type": 1 }, next: 12 }],
		] as const) {
			const other = await fixture(receipt(piece));
			try {
				expect(
					(await other.boundary.invoke(callId, "qorpera", "read_event", { deliveryId: DELIVERY, offset: 10 }))
						.success,
					callId,
				).toBe(false);
			} finally {
				other.run.close();
			}
		}
	});

	describe("reading a long body piece by piece", () => {
		/** qorpera_read_agent_event's piece as the database cuts it (20260928269290): text when the body is UTF-8, up
		 * to 16,000 characters whose JSON string fits 32 KiB, offsets in characters; else base64 of 24 KiB, offsets in
		 * bytes. */
		const databasePiece = (body: Buffer, offset: number): Record<string, unknown> => {
			const text = body.toString("utf8");
			if (Buffer.from(text, "utf8").equals(body)) {
				const rest = [...text].slice(offset);
				let chars = Math.min(rest.length, 16000);
				for (;;) {
					const size = Buffer.byteLength(JSON.stringify(rest.slice(0, chars).join("")));
					if (size <= 32768 || chars === 0) break;
					chars = Math.max(0, Math.min(chars - 1, Math.floor((chars * 32768) / size)));
				}
				return {
					encoding: "utf8",
					offset,
					text: rest.slice(0, chars).join(""),
					total: offset + rest.length,
					done: chars >= rest.length,
					...(chars < rest.length ? { next: offset + chars } : {}),
				};
			}
			return {
				encoding: "base64",
				offset,
				data: body.subarray(offset, offset + 24576).toString("base64"),
				total: body.length,
				done: offset + 24576 >= body.length,
				...(offset + 24576 < body.length ? { next: offset + 24576 } : {}),
			};
		};
		const delivery = (body: Buffer, headers: Record<string, string>) =>
			fixture((_method, args, runId) => {
				const request = args.p_request as { deliveryId: string; offset?: number };
				return {
					schema: "qorpera.agent-event/v1",
					runId,
					deliveryId: request.deliveryId,
					hook: { id: HOOK, name: "agents" },
					type: "mail.received",
					receivedAt: "2026-10-02T10:00:01.123456+00:00",
					contentType: "application/json",
					headers,
					bytes: body.length,
					...databasePiece(body, request.offset ?? 0),
				};
			});
		/** Reads the whole event as the model sees it, from offset 0 to done, and returns each piece. */
		const readAll = async (f: Awaited<ReturnType<typeof fixture>>) => {
			const pieces: Record<string, unknown>[] = [];
			let offset = 0;
			for (;;) {
				// The longest call id the boundary takes, so its provenance is as large as it gets.
				const callId = `read-${String(pieces.length).padStart(4, "0")}-${"c".repeat(150)}`;
				const reply = await f.boundary.invoke(callId, "qorpera", "read_event", { deliveryId: DELIVERY, offset });
				expect(reply.success, JSON.stringify(reply)).toBe(true);
				const wire = reply.contentItems[0].text;
				expect(Buffer.byteLength(wire)).toBeLessThanOrEqual(MAX_CLOUD_TOOL_RESULT_BYTES);
				const envelope = JSON.parse(wire) as CloudToolResult;
				expect(envelope.content.truncated, `piece at ${offset}`).toBe(false);
				const piece = JSON.parse(envelope.content.text) as Record<string, unknown>;
				expect(piece.offset).toBe(offset);
				pieces.push(piece);
				if (piece.done) return pieces;
				expect(piece.next).toBeGreaterThan(offset);
				offset = piece.next as number;
			}
		};
		// Every kind of character the two JSON layers and the fence escape, and multi-byte ones: a quote, a
		// backslash, < > &, the two line separators, a control character, a tab and a new line, two-, three- and
		// four-byte characters, and a combining mark.
		const tricky = `"\\<>&\u2028\u2029\u0001\t\né漢😀e\u0301 `;
		const mail = {
			from: "Ada Lovelace <ada@example.test>",
			to: ["agents@northwind.qorpera.mail"],
			subject: 'Quarterly "numbers" & <notes>',
			text: Array.from({ length: 1500 }, (_, n) => `Line ${n}: ${tricky}${"plain words ".repeat(n % 7)}`).join(""),
			html: Array.from({ length: 400 }, (_, n) => `<p class="x">Para ${n} &amp; ${tricky}</p>`).join(""),
			attachments: [{ filename: "notes.pdf", contentType: "application/pdf", size: 123456 }],
		};
		const mailHeaders = {
			"delivered-to": "agents@northwind.qorpera.mail",
			from: "Ada Lovelace <ada@example.test>",
			subject: 'Quarterly "numbers" & <notes>',
			"authentication-results": "spf=pass dkim=pass dmarc=pass",
		};

		it("cuts each text piece to fit one result, and next continues exactly where it stopped", async () => {
			const body = Buffer.from(JSON.stringify(mail), "utf8");
			const f = await delivery(body, mailHeaders);
			try {
				const pieces = await readAll(f);
				expect(pieces.map((piece) => piece.text).join("")).toBe(body.toString("utf8"));
				const characters = [...body.toString("utf8")].length;
				// The database alone would have given far fewer, larger pieces: the runtime cut every one but the last.
				expect(pieces.length).toBeGreaterThan(Math.ceil(characters / 16000) * 2);
				for (const piece of pieces) {
					expect(piece.encoding).toBe("utf8");
					expect(piece.total).toBe(characters);
					expect(piece.headers).toEqual(mailHeaders);
					expect(piece.headersCut).toBeUndefined();
				}
			} finally {
				f.run.close();
			}
		});

		it("cuts base64 pieces after whole bytes, so the bytes join up exactly", async () => {
			const body = Buffer.from(Array.from({ length: 60001 }, (_, n) => (n * 151 + 7) % 256));
			expect(Buffer.from(body.toString("utf8"), "utf8").equals(body)).toBe(false);
			const f = await delivery(body, { "content-type": "application/octet-stream" });
			try {
				const pieces = await readAll(f);
				expect(Buffer.concat(pieces.map((piece) => Buffer.from(piece.data as string, "base64"))).equals(body)).toBe(
					true,
				);
				expect(pieces.length).toBeGreaterThan(Math.ceil(body.length / 24576) * 2);
				for (const piece of pieces) {
					expect(piece.encoding).toBe("base64");
					expect(piece.total).toBe(body.length);
				}
			} finally {
				f.run.close();
			}
		});

		it("cuts headers too long to leave the body room, every value to one length, and still reads it all", async () => {
			// As long as the intake keeps them: each value at most 2048 characters, all within 8 KiB of JSON.
			const headers = {
				"delivered-to": "agents@northwind.qorpera.mail",
				from: '"<&>'.repeat(512),
				subject: "&<\u2028\u2029".repeat(256),
				"user-agent": "é".repeat(2048),
			};
			const body = Buffer.from(JSON.stringify({ ...mail, text: mail.text.slice(0, 20000), html: "" }), "utf8");
			const f = await delivery(body, headers);
			try {
				const pieces = await readAll(f);
				expect(pieces.map((piece) => piece.text).join("")).toBe(body.toString("utf8"));
				for (const piece of pieces) {
					expect(piece.headersCut).toBe(true);
					const kept = piece.headers as Record<string, string>;
					const most = Math.max(...Object.values(kept).map((value) => [...value].length));
					for (const [name, value] of Object.entries(headers)) {
						expect(value.startsWith(kept[name]), name).toBe(true);
						expect([...kept[name]].length, name).toBe(Math.min([...value].length, most));
					}
					// Every piece but the last keeps about a kilobyte of the result for the body.
					if (!piece.done)
						expect(
							Buffer.byteLength(
								JSON.stringify(JSON.stringify(piece.text)).replace(/[<>&\u2028\u2029]/g, "\\u0000"),
							),
						).toBeGreaterThan(1000);
				}
				expect(pieces[0].headers).toMatchObject({ "delivered-to": headers["delivered-to"] });
			} finally {
				f.run.close();
			}
		});

		it("passes a piece that already fits on unchanged", async () => {
			const body = Buffer.from(JSON.stringify({ ...mail, text: "Short.", html: "" }), "utf8");
			const f = await delivery(body, mailHeaders);
			try {
				const [piece, ...rest] = await readAll(f);
				expect(rest).toEqual([]);
				expect(piece).toMatchObject({ text: body.toString("utf8"), done: true, headers: mailHeaders });
				expect(piece.next).toBeUndefined();
			} finally {
				f.run.close();
			}
		});
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

	it("attaches company files by their paths, each once, and refuses more than 10", async () => {
		const f = await fixture((_method, args, runId) => ({
			schema: "qorpera.agent-mail/v1",
			runId,
			mailId: "73300000-0000-4000-8000-0000000000a1",
			status: "queued",
			...(args.p_request as object),
		}));
		const email = { from: "support@mail.example.test", to: ["bob@acme.test"], subject: "Invoice", text: "Attached." };
		try {
			const sent = await f.boundary.invoke("m3", "qorpera", "send_mail", {
				...email,
				attachments: ["finance/invoice-42.pdf", "finance/totals.csv"],
			});
			expect(sent.success, JSON.stringify(sent)).toBe(true);
			expect((f.call.mock.calls[0][1] as { p_request: unknown }).p_request).toEqual({
				...email,
				attachments: ["finance/invoice-42.pdf", "finance/totals.csv"],
			});
			for (const [callId, attachments] of [
				["mail_a1", ["finance/a.pdf", "finance/a.pdf"]],
				["mail_a2", Array.from({ length: 11 }, (_, n) => `f${n}.pdf`)],
				["mail_a3", ["../secrets.txt"]],
				["mail_a4", "finance/a.pdf"],
				["mail_a5", [42]],
			] as const) {
				const refused = await f.boundary.invoke(callId, "qorpera", "send_mail", { ...email, attachments });
				expect(refused.success, callId).toBe(false);
			}
			expect(f.call).toHaveBeenCalledOnce();
		} finally {
			f.run.close();
		}
	});

	describe("save_attachment", () => {
		const CHUNK = "c".repeat(64);
		const request = {
			deliveryId: DELIVERY.toUpperCase(),
			attachment: 2,
			path: "finance/invoice-42.pdf",
			operationKey: "save-invoice-42",
			expectedVersion: null,
		};
		const receipt = (runId: string, extra: Record<string, unknown>) => ({
			schema: "qorpera.agent-mail-attachment/v1",
			runId,
			deliveryId: DELIVERY,
			attachment: 2,
			filename: "invoice-42.pdf",
			contentType: "application/pdf",
			...extra,
		});
		const writer = () => ({
			mutate: vi.fn<CloudCompanyPathGateway["mutate"]>(async (_operation, input) => ({
				schema: "qorpera.company-path-result/v1",
				state: "applied",
				operationKey: input.operationKey,
				path: input.path,
				version: "73300000-0000-4000-8000-0000000000c3",
				receiptId: "73300000-0000-4000-8000-0000000000c1",
				snapshotId: "73300000-0000-4000-8000-0000000000c2",
				proposalId: null,
			})),
		});

		it("is offered only with the company folder's writer", async () => {
			const f = await fixture();
			try {
				expect((await f.boundary.invoke("s0", "qorpera", "save_attachment", request)).success).toBe(false);
			} finally {
				f.run.close();
			}
		});

		it("waits while the platform fetches it, then writes its stored chunks as the file", async () => {
			const gateway = writer();
			const states = ["fetching", "stored"];
			const f = await fixture(
				(_method, _args, runId) =>
					receipt(
						runId,
						states.shift() === "stored"
							? {
									state: "stored",
									bytes: 12,
									fileSha256: "f".repeat(64),
									chunks: [{ sha256: CHUNK, bytes: 12 }],
								}
							: { state: "fetching" },
					),
				gateway,
			);
			try {
				const saved = await f.boundary.invoke("s1", "qorpera", "save_attachment", request);
				expect(saved.success, JSON.stringify(saved)).toBe(true);
				expect(f.call.mock.calls.map(([method, args]) => [method, args])).toEqual([
					[
						"qorpera_native_mail_attachment",
						{ p_binding: f.binding, p_request: { deliveryId: DELIVERY, attachment: 2 } },
					],
					[
						"qorpera_native_mail_attachment",
						{ p_binding: f.binding, p_request: { deliveryId: DELIVERY, attachment: 2 } },
					],
				]);
				expect(gateway.mutate.mock.calls[0].slice(0, 2)).toEqual([
					"write",
					{
						path: "finance/invoice-42.pdf",
						operationKey: "save-invoice-42",
						expectedVersion: null,
						attachment: { fileSha256: "f".repeat(64), bytes: 12, chunks: [{ sha256: CHUNK, bytes: 12 }] },
					},
				]);
				const text = saved.contentItems[0].text;
				expect(text).toContain("invoice-42.pdf");
				expect(text).toContain("applied");
				expect(text).not.toContain(CHUNK);
			} finally {
				f.run.close();
			}
		});

		it("says why a fetch failed, writing nothing", async () => {
			const gateway = writer();
			const f = await fixture(
				(_method, _args, runId) =>
					receipt(runId, { state: "failed", error: "The mail provider no longer has this attachment" }),
				gateway,
			);
			try {
				const failed = await f.boundary.invoke("s2", "qorpera", "save_attachment", request);
				expect(failed.success, JSON.stringify(failed)).toBe(true);
				expect(failed.contentItems[0].text).toContain("no longer has this attachment");
				expect(gateway.mutate).not.toHaveBeenCalled();
			} finally {
				f.run.close();
			}
		});

		it("stops waiting as soon as the run ends", async () => {
			const gateway = writer();
			const f = await fixture((_method, _args, runId) => receipt(runId, { state: "fetching" }), gateway);
			const waiting = f.boundary.invoke("s3", "qorpera", "save_attachment", request);
			await new Promise((resolve) => setTimeout(resolve, 50));
			const closed = Date.now();
			f.run.close();
			const ended = await waiting;
			expect(Date.now() - closed).toBeLessThan(1000);
			expect(ended.success).toBe(false);
			expect(gateway.mutate).not.toHaveBeenCalled();
		});

		it("refuses a malformed request without calling the cloud, and a receipt for another run or attachment", async () => {
			const gateway = writer();
			const f = await fixture(undefined, gateway);
			try {
				for (const [callId, args] of [
					["s4", { ...request, attachment: 0 }],
					["s5", { ...request, attachment: 51 }],
					["s6", { ...request, attachment: 1.5 }],
					["s7", { ...request, deliveryId: "the invoice" }],
					["s8", { ...request, path: "../outside.pdf" }],
					["s9", { ...request, operationKey: "" }],
					["s10", { ...request, expectedVersion: "latest" }],
					["s11", { ...request, extra: true }],
				] as const) {
					expect((await f.boundary.invoke(callId, "qorpera", "save_attachment", args)).success, callId).toBe(
						false,
					);
				}
				expect(f.call).not.toHaveBeenCalled();
			} finally {
				f.run.close();
			}
			for (const [callId, answer] of [
				["s12", { runId: "73100000-0000-4000-8000-0000000000ff" }],
				["s13", { attachment: 3 }],
				["s14", { state: "saved" }],
				["s15", { state: "stored", bytes: 12, fileSha256: "f".repeat(64), chunks: "all" }],
			] as const) {
				const other = await fixture(
					(_method, _args, runId) => Object.assign(receipt(runId, { state: "fetching" }), answer),
					gateway,
				);
				try {
					expect(
						(await other.boundary.invoke(callId, "qorpera", "save_attachment", request)).success,
						callId,
					).toBe(false);
				} finally {
					other.run.close();
				}
			}
			expect(gateway.mutate).not.toHaveBeenCalled();
		});
	});
});
