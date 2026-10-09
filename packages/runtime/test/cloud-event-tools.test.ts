import {
	type CloudCompanyFolderBytes,
	CloudCompanyFolderClient,
	type CloudCompanyFolderSignedHooks,
} from "@qorpera/runtime/cloud-company-folder-client";
import type { CloudCompanyPathControl } from "@qorpera/runtime/cloud-company-path-gateway";
import { CloudCompanyFolderRpcError } from "@qorpera/runtime/cloud-company-path-refusal";
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
	withFolder: boolean | CloudCompanyFolderSignedHooks = false,
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
	// A folder-v2 run's folder client, on the same wire, with the secret broker's signed hooks when given.
	const folder = withFolder
		? new CloudCompanyFolderClient({
				binding,
				identity: run.identity,
				control: { call },
				bytes: {} as CloudCompanyFolderBytes,
				...(withFolder === true ? {} : { signedHooks: withFolder }),
			})
		: undefined;
	const boundary = new CloudNativeToolBoundary({
		companyId: run.identity.companyId,
		runId: run.identity.runId,
		identity: run.identity,
		tools: cloudEventTools(binding, run.identity, { call }, folder),
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

	it("accepts what the database gives past the end, after the body is cleared, and a padded last piece", async () => {
		for (const [callId, offset, piece] of [
			["a1", 10, { encoding: "utf8", offset: 10, text: "", total: 10, done: true }],
			["a2", 0, { bodyCleared: true, done: true }],
			["a3", 10, { bodyCleared: true, done: true }],
			["a4", 24576, { encoding: "base64", offset: 24576, data: "/w==", total: 24577, done: true }],
			["a5", 24576, { encoding: "base64", offset: 24576, data: "AA==", total: 24600, done: false, next: 24577 }],
			["a6", 99999, { encoding: "base64", offset: 99999, data: "", total: 24577, done: true }],
		] as const) {
			const f = await fixture((_method, args, runId) => ({
				schema: "qorpera.agent-event/v1",
				runId,
				deliveryId: (args.p_request as { deliveryId: string }).deliveryId,
				hook: { id: HOOK, name: "forms" },
				headers: {},
				bytes: 0,
				...piece,
			}));
			try {
				const read = await f.boundary.invoke(callId, "qorpera", "read_event", { deliveryId: DELIVERY, offset });
				expect(read.success, callId).toBe(true);
			} finally {
				f.run.close();
			}
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
			["n12", { encoding: "base64", data: "AA==", next: 13 }],
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
				for (const [place, piece] of pieces.entries()) {
					expect(piece.encoding).toBe("utf8");
					expect(piece.total).toBe(characters);
					// The headers come with the first piece only.
					expect(piece.headers).toEqual(place === 0 ? mailHeaders : undefined);
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

		it("cuts headers too long to leave the body room, every value to one length, and still reads it all fast", async () => {
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
				const [first, ...rest] = pieces;
				expect(first.headersCut).toBe(true);
				const kept = first.headers as Record<string, string>;
				const most = Math.max(...Object.values(kept).map((value) => [...value].length));
				for (const [name, value] of Object.entries(headers)) {
					expect(value.startsWith(kept[name]), name).toBe(true);
					expect([...kept[name]].length, name).toBe(Math.min([...value].length, most));
				}
				expect(kept["delivered-to"]).toBe(headers["delivered-to"]);
				// The first piece keeps about a kilobyte of the result for the body.
				expect(
					Buffer.byteLength(JSON.stringify(JSON.stringify(first.text)).replace(/[<>&\u2028\u2029]/g, "\\u0000")),
				).toBeGreaterThan(1000);
				// The rest carry no headers, so a sender's long ones cannot make the body slow to read.
				for (const piece of rest) {
					expect(piece.headers).toBeUndefined();
					expect(piece.headersCut).toBeUndefined();
				}
				const plain = await delivery(body, mailHeaders);
				try {
					expect(pieces.length).toBeLessThanOrEqual((await readAll(plain)).length + 1);
				} finally {
					plain.run.close();
				}
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

	describe("manage_hook (E3a)", () => {
		type Fixture = Awaited<ReturnType<typeof fixture>>;
		const ADDRESS = "Ab_-".repeat(10).concat("xyz");
		const PATH = `/functions/v1/event-intake/${ADDRESS}`;
		const CREATE = {
			action: "create",
			kind: "hook",
			name: "site-form",
			purpose: "Leads from the website.",
			operationKey: "hook-1",
		} as const;
		/** SQL's receipt for the request, as the folder client checks it (test 939 pins the real one). */
		const receipt = (f: Fixture, args: Record<string, unknown>) => {
			const request = args.p_request as Record<string, unknown>;
			const mailbox = request.kind === "mailbox";
			return {
				schema: "qorpera.agent-hook-receipt/v1",
				runId: f.binding.runId,
				receiptId: "73900000-0000-4000-8000-0000000000c1",
				action: request.action,
				hook: {
					schema: "qorpera.event-hook/v1",
					id: HOOK,
					companyId: f.run.identity.companyId,
					environmentId: f.run.identity.environmentId,
					name: mailbox ? `mail-${request.localPart}` : (request.name ?? request.hook),
					purpose: request.purpose ?? "Leads from the website.",
					proof: mailbox ? "mail" : "address",
					status: (
						{ create: "active", pause: "paused", resume: "active", remove: "removed" } as Record<string, string>
					)[request.action as string],
					maxBodyBytes: request.maxBodyBytes ?? 65536,
					perMinute: request.perMinute ?? 60,
					createdAt: "2026-10-06T12:00:00.123456+00:00",
					...(mailbox
						? { email: `${request.localPart}@mail.example.test` }
						: request.action === "create"
							? { address: ADDRESS, path: PATH }
							: {}),
				},
			};
		};

		it("opens a hook and a mailbox and pauses one, through the run's folder client, as the run", async () => {
			const f: Fixture = await fixture((_method, args) => receipt(f, args), true);
			try {
				const opened = await f.boundary.invoke("k1", "qorpera", "manage_hook", {
					...CREATE,
					purpose: "  Leads from the website.  ",
					proof: "address",
					perMinute: 10,
				});
				expect(opened.success, JSON.stringify(opened)).toBe(true);
				const text = opened.contentItems[0].text;
				expect(text).toContain("qorpera.agent-hook-receipt/v1");
				expect(text).toContain(PATH);
				expect(text).not.toContain(f.binding.credentialCapsuleId);
				const mailbox = await f.boundary.invoke("k2", "qorpera", "manage_hook", {
					action: "create",
					kind: "mailbox",
					localPart: "sales",
					purpose: "Sales mail.",
					operationKey: "box-1",
				});
				expect(mailbox.success, JSON.stringify(mailbox)).toBe(true);
				expect(mailbox.contentItems[0].text).toContain("sales@mail.example.test");
				const paused = await f.boundary.invoke("k3", "qorpera", "manage_hook", {
					action: "pause",
					hook: "site-form",
					operationKey: "pause-1",
				});
				expect(paused.success, JSON.stringify(paused)).toBe(true);
				// The purpose trimmed of its spaces, proof left to SQL, an unnamed limit left to SQL's default.
				expect(f.call.mock.calls.map(([method, args]) => [method, args])).toEqual([
					["qorpera_folder_manage_hook", { p_binding: f.binding, p_request: { ...CREATE, perMinute: 10 } }],
					[
						"qorpera_folder_manage_hook",
						{
							p_binding: f.binding,
							p_request: {
								action: "create",
								kind: "mailbox",
								localPart: "sales",
								purpose: "Sales mail.",
								operationKey: "box-1",
							},
						},
					],
					[
						"qorpera_folder_manage_hook",
						{ p_binding: f.binding, p_request: { action: "pause", hook: "site-form", operationKey: "pause-1" } },
					],
				]);
			} finally {
				f.run.close();
			}
		});

		/** The secret broker's answer to a signed create, as the folder client checks it (test 987 pins the real one). */
		const signedReceipt = (f: Fixture, request: Record<string, unknown>) => {
			const base = receipt(f, { p_request: request });
			return {
				...base,
				hook: {
					...base.hook,
					proof: request.proof,
					signingSecret: { connectorId: "event_hook", secretName: `h${HOOK.replaceAll("-", "")}`, ready: true },
				},
				secretSite: request.site,
			};
		};

		it("opens a GitHub and an HMAC hook through the secret broker, which makes the secret, and never through SQL", async () => {
			const eventHook = vi.fn<CloudCompanyFolderSignedHooks["eventHook"]>(async ({ request }) =>
				signedReceipt(f, { ...request }),
			);
			const f: Fixture = await fixture(undefined, { eventHook });
			try {
				const github = await f.boundary.invoke("s1", "qorpera", "manage_hook", {
					...CREATE,
					name: "github-pushes",
					proof: "github",
					operationKey: "gh-1",
				});
				expect(github.success, JSON.stringify(github)).toBe(true);
				const text = github.contentItems[0].text;
				expect(text).toContain('\\"secretSite\\":\\"github.com\\"');
				expect(text).toContain('\\"proof\\":\\"github\\"');
				expect(text).toContain(`\\"secretName\\":\\"h${HOOK.replaceAll("-", "")}\\"`);
				expect(text).not.toContain(f.binding.credentialCapsuleId);
				const hmac = await f.boundary.invoke("s2", "qorpera", "manage_hook", {
					...CREATE,
					name: "billing-events",
					proof: "hmac-sha256",
					site: "  App.Billing.Example.COM ",
					perMinute: 30,
					operationKey: "hmac-1",
				});
				expect(hmac.success, JSON.stringify(hmac)).toBe(true);
				expect(hmac.contentItems[0].text).toContain('\\"secretSite\\":\\"app.billing.example.com\\"');
				// GitHub's site by default, a named one trimmed and lowercased; the run's binding; nothing through SQL.
				expect(eventHook.mock.calls.map(([sent]) => sent)).toEqual([
					{
						binding: f.binding,
						request: {
							...CREATE,
							name: "github-pushes",
							proof: "github",
							site: "github.com",
							operationKey: "gh-1",
						},
					},
					{
						binding: f.binding,
						request: {
							...CREATE,
							name: "billing-events",
							proof: "hmac-sha256",
							site: "app.billing.example.com",
							perMinute: 30,
							operationKey: "hmac-1",
						},
					},
				]);
				expect(f.call).not.toHaveBeenCalled();
			} finally {
				f.run.close();
			}
		});

		it("refuses a signed hook as unavailable without the secret broker, and passes the broker's refusal on", async () => {
			const bare = await fixture(undefined, true);
			try {
				const result = await bare.boundary.invoke("u1", "qorpera", "manage_hook", { ...CREATE, proof: "github" });
				expect(result.success).toBe(false);
				expect(result.contentItems[0].text).not.toContain("REFUSED");
				expect(bare.call).not.toHaveBeenCalled();
			} finally {
				bare.run.close();
			}
			const eventHook = vi.fn<CloudCompanyFolderSignedHooks["eventHook"]>(async () => ({
				schema: "qorpera.event-hook-refusal/v1",
				code: "22023",
				message: "A site is a host name such as github.com",
			}));
			const refused = await fixture(undefined, { eventHook });
			try {
				const result = await refused.boundary.invoke("u2", "qorpera", "manage_hook", {
					...CREATE,
					proof: "hmac-sha256",
					site: "hooks.example.com",
				});
				expect(result.success).toBe(false);
				expect(result.contentItems[0].text).toContain("REFUSED: A site is a host name such as github.com");
				expect(eventHook).toHaveBeenCalledTimes(1);
				expect(refused.call).not.toHaveBeenCalled();
			} finally {
				refused.run.close();
			}
		});

		it("says why a request is malformed without calling the cloud", async () => {
			const f = await fixture(undefined, true);
			const mailbox = {
				action: "create",
				kind: "mailbox",
				localPart: "sales",
				purpose: "Sales mail.",
				operationKey: "k",
			};
			const purpose = "purpose is one line of 1 to 512 characters saying what it is for";
			const name =
				"name uses lowercase letters, digits and hyphens, starts with a letter, has at most 64 characters and does not start with mail-";
			try {
				for (const [callId, args, says] of [
					["h1", [CREATE], "manage_hook takes an object with action and operationKey"],
					["h2", { ...CREATE, action: "open" }, "action is create, pause, resume or remove"],
					["h3", { ...CREATE, kind: "webhook" }, "create takes kind hook or mailbox"],
					[
						"h4",
						{ ...CREATE, secret: "s" },
						"create with kind hook takes only action, kind, name, purpose, proof, site, maxBodyBytes, perMinute, operationKey",
					],
					[
						"h5",
						{ ...mailbox, name: "sales" },
						"create with kind mailbox takes only action, kind, localPart, purpose, operationKey",
					],
					[
						"h6",
						{ action: "pause", hook: "site-form", purpose: "p", operationKey: "k" },
						"pause takes only action, hook, operationKey",
					],
					[
						"h7",
						{ action: "resume", hook: "site-form" },
						"operationKey is 1 to 192 letters, digits, dots, underscores, colons and hyphens, starting with a letter or digit",
					],
					[
						"h8",
						{ action: "remove", hook: "Site Form", operationKey: "k" },
						"hook is the name of one of your company's hooks, as list_hooks shows it",
					],
					["h9", { ...CREATE, purpose: "   " }, purpose],
					["h10", { ...CREATE, purpose: "Leads\nand spam" }, purpose],
					["h11", { ...CREATE, purpose: "p".repeat(513) }, purpose],
					["h12", { ...CREATE, name: "mail-sales" }, name],
					["h13", { ...CREATE, name: "Site" }, name],
					[
						"h14",
						{ ...CREATE, proof: "stripe" },
						"A Stripe hook comes later: its secret is taken from Stripe's screen",
					],
					["h15", { ...CREATE, proof: "basic" }, "proof is address, github or hmac-sha256"],
					["h16", { ...CREATE, maxBodyBytes: 512 }, "maxBodyBytes is a whole number from 1024 to 262144"],
					["h17", { ...CREATE, perMinute: 1.5 }, "perMinute is a whole number from 1 to 120"],
					[
						"h18",
						{ ...mailbox, localPart: "sales..team" },
						"localPart is 1 to 64 lowercase letters, digits, dots, hyphens and underscores, starting and ending with a letter or digit, never two dots in a row",
					],
					["h19", { ...CREATE, site: "github.com" }, "Only a signed hook names the site its secret is typed into"],
					[
						"h20",
						{ ...CREATE, proof: "address", site: "github.com" },
						"Only a signed hook names the site its secret is typed into",
					],
					["h21", { ...CREATE, proof: "hmac-sha256" }, "An HMAC hook names the site its secret is typed into"],
					["h22", { ...CREATE, proof: "github", site: "github" }, "A site is a host name such as github.com"],
					[
						"h23",
						{ ...CREATE, proof: "hmac-sha256", site: "https://hooks.example.com" },
						"A site is a host name such as github.com",
					],
					["h24", { ...CREATE, proof: "github", site: 42 }, "A site is a host name such as github.com"],
					["h25", { ...CREATE, proof: "github", site: "   " }, "A site is a host name such as github.com"],
					[
						"h26",
						{
							...CREATE,
							proof: "hmac-sha256",
							site: `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}`,
						},
						"A site is a host name such as github.com",
					],
					["h27", { ...CREATE, proof: "github", site: "-github.com" }, "A site is a host name such as github.com"],
					[
						"h28",
						{ action: "pause", hook: "site-form", site: "github.com", operationKey: "k" },
						"pause takes only action, hook, operationKey",
					],
				] as const) {
					const refused = await f.boundary.invoke(callId, "qorpera", "manage_hook", args);
					expect(refused.success, callId).toBe(false);
					expect(refused.contentItems[0].text, callId).toContain(`INVALID_ARGUMENTS: ${says}`);
				}
				expect(f.call).not.toHaveBeenCalled();
			} finally {
				f.run.close();
			}
		});

		it("passes SQL's refusal on in the model's words, and never confirms an answer it could not check", async () => {
			const refuse = () => {
				throw new CloudCompanyFolderRpcError("42501", "Only owners and admins can open hooks; ask one of them");
			};
			const refused = await fixture(refuse, true);
			try {
				const result = await refused.boundary.invoke("r1", "qorpera", "manage_hook", CREATE);
				expect(result.success).toBe(false);
				expect(result.contentItems[0].text).toContain(
					"REFUSED: Only owners and admins can open hooks; ask one of them",
				);
			} finally {
				refused.run.close();
			}
			const other: Fixture = await fixture(
				(_method, args) => ({ ...receipt(other, args), runId: "73100000-0000-4000-8000-0000000000ff" }),
				true,
			);
			try {
				const result = await other.boundary.invoke("r2", "qorpera", "manage_hook", CREATE);
				expect(result.success).toBe(false);
				expect(result.contentItems[0].text).toContain("TOOL_OUTCOME_UNCONFIRMED");
				// That call may have opened the hook: SQL refusing the same key now says nothing of it.
				other.call.mockImplementationOnce(async () => {
					throw new CloudCompanyFolderRpcError("23505", "A hook with this name already exists");
				});
				const again = await other.boundary.invoke("r3", "qorpera", "manage_hook", CREATE);
				expect(again.contentItems[0].text).toContain("TOOL_OUTCOME_UNCONFIRMED");
			} finally {
				other.run.close();
			}
		});

		it("is offered only with a folder-v2 run's folder client, and only for its own run", async () => {
			const f = await fixture();
			try {
				expect((await f.boundary.invoke("o1", "qorpera", "manage_hook", CREATE)).success).toBe(false);
				expect(cloudEventTools(f.binding, f.run.identity, { call: f.call }).map((tool) => tool.name)).not.toContain(
					"manage_hook",
				);
				const own = new CloudCompanyFolderClient({
					binding: f.binding,
					identity: f.run.identity,
					control: { call: f.call },
					bytes: {} as CloudCompanyFolderBytes,
				});
				expect(
					cloudEventTools(f.binding, f.run.identity, { call: f.call }, own).map((tool) => tool.name),
				).toContain("manage_hook");
				const another = nativeToolAuthorityFixture();
				const theirs = new CloudCompanyFolderClient({
					binding: another.binding,
					identity: another.authority.identity,
					control: { call: f.call },
					bytes: {} as CloudCompanyFolderBytes,
				});
				expect(() => cloudEventTools(f.binding, f.run.identity, { call: f.call }, theirs)).toThrow(
					"Event binding differs",
				);
				expect(f.call).not.toHaveBeenCalled();
			} finally {
				f.run.close();
			}
		});
	});
});
