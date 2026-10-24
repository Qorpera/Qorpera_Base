// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { DigitalPostView } from "../src/app/views/settings-digital-post.ts";
import { type Cloud, CloudRpcError } from "../src/cloud/client.ts";
import {
	createDigitalPostKeys,
	type DigitalPostConnection,
	digitalPostAdminUrl,
	digitalPostKeyLooksValid,
	parseDigitalPostLetters,
	parseDigitalPostLetterText,
	readDigitalPost,
} from "../src/cloud/digital-post.ts";
import { CloudShapeError } from "../src/cloud/parse.ts";
import { id, settle, timestamp } from "./fixtures.ts";
import { digitalPostConnected, letter, letterId, letterIndex, letterMarkdown } from "./mail-fixtures.ts";

/* The company's Digital Post as a member reads it (cloud/digital-post.ts) and its card in Settings → Company connections
 * (views/settings-digital-post.ts): the connection's state, the folder's index of letters read leniently, a letter's
 * text and documents, a pasted key checked before it goes to the company vault, and connecting, replacing and
 * disconnecting as an owner or admin. */

const profile = { profileId: id(10), environmentId: id(11) };

function cloudWith(rpc: (name: string, args: Record<string, unknown>) => unknown) {
	return {
		rpc: vi.fn(async (name: string, args: Record<string, unknown>) => rpc(name, args)),
	} as unknown as Cloud & { rpc: ReturnType<typeof vi.fn> };
}

/** An API key as Administrativ Adgang's receipt shows it: base64 of the system's id, a colon and its key. */
const apiKey = (system = id(871), value = "k3y-Value_0123456789") => btoa(`${system}:${value}`);

afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("the Digital Post read", () => {
	it("reads the connection's state, and a company that has none", async () => {
		const cloud = cloudWith(() => digitalPostConnected({ held: 2, lastError: "Digital Post answered 503" }));
		expect(await readDigitalPost(cloud, profile.environmentId)).toEqual({
			connected: true,
			status: "current",
			secretId: id(870),
			supplier: { environment: "test", cvr: "12345678", addresses: ["203.0.113.10"] },
			systemId: id(871),
			fetchedAt: expect.any(String),
			lastError: "Digital Post answered 503",
			letters: 1,
			waitingForFolder: 0,
			held: 2,
		});
		expect(cloud.rpc).toHaveBeenCalledWith("qorpera_member_digital_post", {
			p_environment_id: profile.environmentId,
		});
		const none = cloudWith(() => ({
			schema: "qorpera.member-digital-post/v1",
			connected: false,
			status: "disconnected",
			secretId: null,
			supplier: null,
			systemId: null,
			fetchedAt: null,
			lastError: null,
			letters: 0,
			waitingForFolder: 0,
			held: 0,
		}));
		expect(await readDigitalPost(none, profile.environmentId)).toEqual({
			connected: false,
			status: "disconnected",
			letters: 0,
			waitingForFolder: 0,
			held: 0,
		});
	});

	it("takes any system id PostgreSQL takes, as the vault records it", async () => {
		const system = "6f1d3c2a-9b8e-0d7c-8a6b-5e4f3d2c1b0a";
		const read = await readDigitalPost(
			cloudWith(() => digitalPostConnected({ systemId: system })),
			profile.environmentId,
		);
		expect(read.systemId).toBe(system);
		await expect(
			readDigitalPost(
				cloudWith(() => digitalPostConnected({ systemId: "not-a-system" })),
				profile.environmentId,
			),
		).rejects.toBeInstanceOf(CloudShapeError);
	});

	it("refuses an answer of another shape", async () => {
		await expect(
			readDigitalPost(
				cloudWith(() => digitalPostConnected({ schema: "qorpera.member-digital-post/v2" })),
				profile.environmentId,
			),
		).rejects.toBeInstanceOf(CloudShapeError);
		await expect(
			readDigitalPost(
				cloudWith(() => digitalPostConnected({ supplier: { environment: "test", cvr: "1234", addresses: [] } })),
				profile.environmentId,
			),
		).rejects.toBeInstanceOf(CloudShapeError);
		await expect(
			readDigitalPost(
				cloudWith(() => digitalPostConnected({ status: "lost" })),
				profile.environmentId,
			),
		).rejects.toBeInstanceOf(CloudShapeError);
	});
});

describe("the folder's letters", () => {
	it("lists the index's letters newest first, leaving out one that does not read and a second of the same id", () => {
		const letters = parseDigitalPostLetters(
			letterIndex([
				letter(9),
				letter(2, { replyBy: "2026-11-01T00:00:00Z", caseId: "SKAT-1" }),
				letter(5, { messageUuid: "not-an-id" }),
				letter(6, { folder: "elsewhere/2026/x" }),
				letter(7, { mandatory: "yes" }),
				{ ...letter(9), title: "Again" },
				letter(4, { snippet: "" }),
			]),
		);
		expect(letters.map((each) => each.title)).toEqual(["Letter 2", "Letter 4", "Letter 9"]);
		expect(letters[0]).toMatchObject({ messageUuid: letterId(2), replyBy: "2026-11-01T00:00:00Z", caseId: "SKAT-1" });
		expect(letters[1]).not.toHaveProperty("snippet");
		// Any UUID the runtime and the SQL take is a letter's id, in lower case as the index keeps it.
		const postgres = "6f1d3c2a-9b8e-0d7c-8a6b-5e4f3d2c1b0a";
		expect(
			parseDigitalPostLetters(
				letterIndex([letter(1, { messageUuid: postgres }), letter(2, { messageUuid: letterId(2).toUpperCase() })]),
			).map((each) => each.messageUuid),
		).toEqual([postgres]);
		expect(parseDigitalPostLetters("{")).toEqual([]);
		expect(parseDigitalPostLetters(JSON.stringify({ schema: "other/v1", letters: [letter(1)] }))).toEqual([]);
	});

	it("reads a letter's text to the end, a heading in it too, and its documents by name", () => {
		const text = "Dear company,\n\n## Decision\n\nYou owe 100 kr.\n\n## Text\n\nThat is all.";
		expect(parseDigitalPostLetterText(letterMarkdown(3, text))).toEqual({
			text,
			documents: ["Afgørelse.pdf", "Bilag 1.pdf"],
		});
		// A name that would leave the letter's folder is no document of it; a file without sections has no text.
		const outside = letterMarkdown(3).replace("<Bilag%201.pdf>", "<..%2Fother.pdf>");
		expect(parseDigitalPostLetterText(outside).documents).toEqual(["Afgørelse.pdf"]);
		expect(parseDigitalPostLetterText("# A letter\r\n\r\nNo sections.")).toEqual({ text: "", documents: [] });
	});
});

describe("a pasted key", () => {
	it("reads as a key only when it is the Basic credential of a system id and its key", () => {
		expect(digitalPostKeyLooksValid(apiKey())).toBe(true);
		expect(digitalPostKeyLooksValid(`  Basic ${apiKey()}\n`)).toBe(true);
		expect(digitalPostKeyLooksValid(apiKey(id(871).toUpperCase()))).toBe(true);
		// Any UUID the vault takes as a system id, in either case.
		expect(digitalPostKeyLooksValid(apiKey("6f1d3c2a-9b8e-0d7c-8a6b-5e4f3d2c1b0a"))).toBe(true);
		expect(digitalPostKeyLooksValid(apiKey("6F1D3C2A-9B8E-0D7C-8A6B-5E4F3D2C1B0A"))).toBe(true);
		expect(digitalPostKeyLooksValid("")).toBe(false);
		expect(digitalPostKeyLooksValid("k3y-Value_0123456789")).toBe(false);
		expect(digitalPostKeyLooksValid(btoa("system:k3y-Value_0123456789"))).toBe(false);
		expect(digitalPostKeyLooksValid(apiKey(id(871), "short"))).toBe(false);
		expect(digitalPostKeyLooksValid(apiKey(id(871), "has a space in it"))).toBe(false);
		expect(digitalPostKeyLooksValid(`${apiKey()}!`)).toBe(false);
	});

	it("goes to the company vault as the Digital Post connection, replacing the one there, and Disconnect revokes it", async () => {
		const origin = "https://company41-node-01.tailbb15c7.ts.net:10000";
		const cloud = cloudWith((name) =>
			name === "qorpera_begin_cloud_secret_capture"
				? {
						schema: "qorpera.cloud-secret-capture/v1",
						ticketId: id(20),
						captureCapability: "c".repeat(43),
						serviceOrigin: origin,
						expiresAt: timestamp,
						scope: { companyId: id(10) },
					}
				: null,
		);
		const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({}));
		const keys = createDigitalPostKeys(cloud, profile, fetch);
		await keys.save(`  ${apiKey()}\n`, id(870));
		expect(cloud.rpc).toHaveBeenCalledWith("qorpera_begin_cloud_secret_capture", {
			p_profile_id: profile.profileId,
			p_environment_id: profile.environmentId,
			p_owner_kind: "company",
			p_owner_user_id: null,
			p_connector_id: "digital_post",
			p_secret_name: "primary",
			p_purpose: "Digital Post",
			p_existing_secret_id: id(870),
		});
		expect(fetch.mock.calls[0]![0]).toBe(`${origin}/v1/captures/${id(20)}?company=${id(10)}`);
		expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toMatchObject({ fields: { api_key: apiKey() } });
		await keys.disconnect(id(870));
		expect(cloud.rpc).toHaveBeenLastCalledWith("qorpera_revoke_cloud_secret", {
			p_profile_id: profile.profileId,
			p_secret_id: id(870),
		});
	});

	it("keeps a replacement's ticket when its send fails, and the next try sends with it", async () => {
		const origin = "https://company41-node-01.tailbb15c7.ts.net:10000";
		let tickets = 0;
		const cloud = cloudWith((name) => {
			if (name !== "qorpera_begin_cloud_secret_capture") return null;
			tickets += 1;
			return {
				schema: "qorpera.cloud-secret-capture/v1",
				ticketId: id(20 + tickets),
				captureCapability: "c".repeat(43),
				serviceOrigin: origin,
				expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
				scope: { companyId: id(10) },
			};
		});
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockRejectedValueOnce(new TypeError("Failed to fetch"))
			.mockResolvedValueOnce(Response.json({}, { status: 409 }))
			.mockResolvedValue(Response.json({}));
		const keys = createDigitalPostKeys(cloud, profile, fetch);
		const url = (ticket: number) => `${origin}/v1/captures/${id(ticket)}?company=${id(10)}`;
		// The answer is lost: SQL keeps the replacement open, so the next try sends with the same ticket.
		await expect(keys.save(apiKey(), id(870))).rejects.toThrow();
		// The broker refuses it: the earlier try may have saved, so a fresh ticket saves this key.
		await keys.save(apiKey(), id(870));
		expect(tickets).toBe(2);
		expect(fetch.mock.calls.map(([target]) => target)).toEqual([url(21), url(21), url(22)]);
		// A first connection asks for a fresh ticket on each try.
		fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
		await expect(keys.save(apiKey(), undefined)).rejects.toThrow();
		await keys.save(apiKey(), undefined);
		expect(tickets).toBe(4);
		expect(cloud.rpc).toHaveBeenLastCalledWith(
			"qorpera_begin_cloud_secret_capture",
			expect.objectContaining({ p_existing_secret_id: null }),
		);
	});

	it("opens Administrativ Adgang of the environment the platform uses", () => {
		expect(digitalPostAdminUrl("test")).toBe("https://admin.test.digitalpost.dk/login");
		expect(digitalPostAdminUrl("production")).toBe("https://admin.digitalpost.dk/login");
	});
});

describe("the Settings card", () => {
	const supplier = { environment: "test" as const, cvr: "12345678", addresses: ["203.0.113.10", "203.0.113.11"] };
	const notConnected: DigitalPostConnection = {
		connected: false,
		status: "disconnected",
		supplier,
		letters: 0,
		waitingForFolder: 0,
		held: 0,
	};
	const connected: DigitalPostConnection = {
		connected: true,
		status: "current",
		secretId: id(870),
		supplier,
		systemId: id(871),
		fetchedAt: timestamp,
		letters: 3,
		waitingForFolder: 0,
		held: 1,
	};

	function card(read: () => Promise<DigitalPostConnection>, manage: () => boolean = () => true) {
		const client = {
			read: vi.fn(read),
			save: vi.fn(async (_key: string, _secretId: string | undefined) => {}),
			disconnect: vi.fn(async (_secretId: string) => {}),
		};
		const lifetime = new AbortController();
		const view = new DigitalPostView(client, lifetime.signal, { access: { canManage: manage } });
		document.body.append(view.el);
		return { client, view, lifetime, el: view.el };
	}
	const buttonOf = (root: ParentNode, label: string) =>
		[...root.querySelectorAll<HTMLButtonElement>("button")].find((each) => each.textContent?.trim() === label);
	const small = (root: ParentNode) => [...root.querySelectorAll("small")].map((each) => each.textContent);
	function paste(root: ParentNode, value: string): void {
		const field = root.querySelector<HTMLInputElement>("input[type=password]")!;
		field.value = value;
		root.querySelector<HTMLFormElement>("form")!.requestSubmit();
	}

	it("lists the steps in Administrativ Adgang with Qorpera's CVR and addresses, and saves a pasted key", async () => {
		let now = notConnected;
		const { client, el } = card(async () => now);
		await settle();
		expect(small(el)).toContain(
			"Letters from public authorities (Skattestyrelsen, Erhvervsstyrelsen, the municipality) arrive in the Mailbox and the company folder, where the agents read them.",
		);
		buttonOf(el, "Connect")!.click();
		expect(el.querySelector<HTMLAnchorElement>(".digital-post-steps a")?.href).toBe(
			"https://admin.test.digitalpost.dk/login",
		);
		expect([...el.querySelectorAll(".digital-post-steps code")].map((each) => each.textContent)).toEqual([
			"203.0.113.10, 203.0.113.11",
			"12345678",
		]);
		// A typo is caught here, before the key goes anywhere.
		paste(el, "not a key");
		expect(el.querySelector(".service-outcome")?.textContent).toBe(
			"This is not a Digital Post API key. Copy the key from the receipt Administrativ Adgang shows.",
		);
		expect(client.save).not.toHaveBeenCalled();
		now = connected;
		paste(el, apiKey());
		await settle();
		expect(client.save).toHaveBeenCalledWith(apiKey(), undefined, expect.any(AbortSignal));
		expect(el.querySelector(".service-outcome")?.textContent).toBe(
			"Digital Post is connected. Letters arrive in the Mailbox within a few minutes.",
		);
		expect(el.querySelector(".digital-post-steps")).toBeNull();
		expect(client.read).toHaveBeenCalledTimes(2);
	});

	it("shows how a connection stands, replaces its key and disconnects it", async () => {
		let now = connected;
		const { client, el } = card(async () => now);
		await settle();
		const [standing] = small(el);
		expect(standing).toMatch(/^Connected · checked .+ · system 11111111 · 3 letters$/);
		expect(small(el)).toContain(
			"1 letter couldn't be read here; Digital Post puts it in the company's Virk mailbox.",
		);
		expect(small(el)).toContain("Every agent in the company can read the letters.");
		buttonOf(el, "Replace key")!.click();
		expect(el.querySelector(".digital-post-steps")).toBeNull();
		paste(el, apiKey());
		await settle();
		expect(client.save).toHaveBeenCalledWith(apiKey(), id(870), expect.any(AbortSignal));
		now = notConnected;
		buttonOf(el, "Disconnect")!.click();
		await settle();
		expect(client.disconnect).toHaveBeenCalledWith(id(870), expect.any(AbortSignal));
		expect(el.querySelector(".service-outcome")?.textContent).toMatch(
			/^Digital Post is disconnected\. Remove the Qorpera system in Administrativ Adgang too/,
		);
		expect(buttonOf(el, "Connect")).toBeDefined();
	});

	it("says why a connection doesn't fetch: a refused key, an unreachable Digital Post", async () => {
		let now: DigitalPostConnection = { ...connected, status: "refused", held: 0 };
		const first = card(async () => now);
		await settle();
		expect(small(first.el)[0]).toMatch(/^Digital Post refused the key\. Save the key again\./);
		first.view.dispose();
		now = { ...connected, status: "failed", lastError: "Digital Post answered 503", held: 0 };
		const second = card(async () => now);
		await settle();
		expect(small(second.el)[0]).toMatch(/^Digital Post wasn't reached at the last try: Digital Post answered 503/);
	});

	it("can't be connected before the platform is set up, and only an owner or admin connects it", async () => {
		const unset = card(async () => ({ ...notConnected, supplier: undefined }));
		await settle();
		expect(small(unset.el)).toContain("Not available yet: Qorpera's Digital Post connection is being set up.");
		expect(buttonOf(unset.el, "Connect")).toBeUndefined();
		unset.view.dispose();
		document.body.replaceChildren();
		const member = card(
			async () => connected,
			() => false,
		);
		await settle();
		expect(small(member.el)).toContain("Only founders and admins can connect or disconnect it.");
		expect(member.el.querySelectorAll(".connection-actions button")).toHaveLength(0);
	});

	it("draws an owner's actions once the role arrives after the card, and takes them away when it goes", async () => {
		const role = { manage: false };
		const { view, el } = card(
			async () => notConnected,
			() => role.manage,
		);
		await settle();
		expect(buttonOf(el, "Connect")).toBeUndefined();
		expect(small(el)).toContain("Only founders and admins can connect or disconnect it.");
		role.manage = true;
		view.update();
		buttonOf(el, "Connect")!.click();
		expect(el.querySelector("form")).not.toBeNull();
		role.manage = false;
		view.update();
		expect(el.querySelector("form")).toBeNull();
		expect(buttonOf(el, "Connect")).toBeUndefined();
	});

	it("shows once read, says when Digital Post could not be read, and stays hidden on a cloud without it", async () => {
		let release: (value: DigitalPostConnection) => void = () => {};
		const slow = card(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		expect(slow.el.hidden).toBe(true);
		release(connected);
		await settle();
		expect(slow.el.hidden).toBe(false);
		slow.view.dispose();
		document.body.replaceChildren();
		const failed = card(async () => {
			throw new Error("offline");
		});
		await settle();
		expect(failed.el.hidden).toBe(false);
		expect(failed.el.querySelector(".service-error")?.textContent).toBe("Digital Post could not be read.");
		failed.view.dispose();
		document.body.replaceChildren();
		const before = card(async () => {
			throw new CloudRpcError(
				"qorpera_member_digital_post",
				{ message: "Could not find the function", code: "PGRST202" },
				404,
			);
		});
		await settle();
		expect(before.el.hidden).toBe(true);
		expect(before.el.childElementCount).toBe(0);
	});

	it("stops when Settings closes", async () => {
		let release: (value: DigitalPostConnection) => void = () => {};
		const slow = card(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		slow.lifetime.abort();
		release(connected);
		await settle();
		expect(slow.el.hidden).toBe(true);
		expect(slow.el.childElementCount).toBe(0);
	});
});
