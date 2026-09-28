// @vitest-environment jsdom
import { File as NodeFile } from "node:buffer";
import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApplication } from "../src/app/application.ts";
import { deferred, fixture, id, profileA, session, settle, timestamp, userA, userB } from "./fixtures.ts";

const cleanups: (() => void)[] = [];
const png = Uint8Array.from(
	Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4X8AAAAASUVORK5CYII=",
		"base64",
	),
);
const hash = createHash("sha256").update(png).digest("hex");
const reference = { objectSha256: hash, bytes: png.length, mediaType: "image/png" };
beforeEach(() => {
	vi.stubGlobal("crypto", webcrypto);
	vi.stubGlobal("File", NodeFile);
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	URL.createObjectURL = vi.fn(() => "blob:fixture-image");
	URL.revokeObjectURL = vi.fn();
	HTMLDialogElement.prototype.showModal = function () {
		this.open = true;
	};
	HTMLDialogElement.prototype.close = function () {
		this.open = false;
	};
	history.replaceState(null, "", `/#/c/${profileA.profileId}/chat/${session.sessionId}`);
});
afterEach(() => {
	for (const close of cleanups.splice(0)) close();
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
function button(root: ParentNode, label: string): HTMLButtonElement {
	const result = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
		(button) => button.getAttribute("aria-label") === label,
	);
	if (!result) throw new Error(`Missing ${label}: ${root.textContent}`);
	return result;
}
function select(root: ParentNode, files: File[]) {
	const chooser = root.querySelector<HTMLInputElement>('input[type="file"]')!;
	Object.defineProperty(chooser, "files", { configurable: true, value: files });
	chooser.dispatchEvent(new Event("change"));
}
async function setup() {
	const f = fixture(),
		root = document.createElement("div");
	f.cloud.config.objectGatewayUrl = "https://objects.fixture.invalid";
	f.cloud.config.publishableKey = "sb_publishable_fixturekey";
	f.cloud.config.nativeProviderLoginUrl = "https://login.fixture.invalid/";
	let admitted = false;
	vi.mocked(f.api.readSessionEvents).mockImplementation(async () =>
		admitted
			? [
					{
						sessionId: session.sessionId,
						eventId: id(90),
						sessionInputId: id(90),
						sequence: 1,
						actorUserId: userA.id,
						eventType: "message",
						eventHash: "a".repeat(64),
						createdAt: timestamp,
						body: {
							schema: "qorpera.runner-transcript-entry/v1",
							entry: {
								type: "message",
								id: id(90),
								message: { role: "user", content: [{ type: "text", text: "Review this image" }] },
								qorperaAttachments: [reference],
							},
						},
					},
				]
			: [],
	);
	const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = String(input);
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-token");
		expect(init).toMatchObject({ redirect: "error", cache: "no-store", credentials: "omit" });
		if (url.endsWith("/qorpera_list_session_turn_requests")) return Response.json([]);
		if (url.endsWith("/qorpera_list_member_notifications")) return Response.json([]);
		if (url.endsWith("/qorpera_select_member_session_account")) return Response.json(id(81));
		if (url.endsWith("/qorpera_begin_native_account_refresh"))
			return Response.json({
				request_id: id(83),
				profile_id: profileA.profileId,
				compute_identity_id: id(80),
				requested_by_user_id: userA.id,
				expires_at: new Date(Date.now() + 300_000).toISOString(),
				status: "completed",
			});
		if (url.endsWith("/qorpera_list_member_native_execution_connections"))
			return Response.json({
				compute_identity: {
					compute_identity_id: id(80),
					ownership_kind: "member",
					owner_user_id: userA.id,
					display_name: "Member computer",
					template_key: "member",
					template_version: "1",
					capabilities: ["agent_turn"],
					policy: {},
					status: "active",
					created_at: timestamp,
					updated_at: timestamp,
				},
				connections: [
					{
						connection_id: id(81),
						client_connection_id: id(181),
						connection_version: 1,
						provider: "openai",
						native_harness: "codex-cli",
						authorization_state: "active",
						max_native_concurrency: 1,
						billing_source: "member",
						consent_version: "1",
						consented_at: timestamp,
						connection_status: "active",
						sponsor_binding_id: id(82),
						sponsor_version: 1,
						policy: { implementation_status: "supported", enablement_status: "enabled", policy_version: 1 },
					},
				],
			});
		if (url.includes("/upload/")) {
			expect(init?.method).toBe("PUT");
			expect(init?.body).toEqual(png);
			expect(url.endsWith(`/${hash}`)).toBe(true);
			return Response.json({ sha256: hash, bytes: png.length, mediaType: "image/png" });
		}
		if (url.endsWith("/qorpera_request_session_turn_v2")) {
			const body = JSON.parse(init!.body as string);
			expect(body.p_session_id).toBe(session.sessionId);
			expect(body.p_client_request_id).toBe(body.p_client_input_id);
			expect(body).toMatchObject({
				p_sponsor_mode: "member_connection",
				p_sponsor_binding_id: id(82),
				p_sponsor_version: 1,
				p_compute_identity_id: id(80),
			});
			expect(body.p_body.images).toEqual([reference]);
			admitted = true;
			return Response.json({
				input_id: id(90),
				turn_request_id: id(91),
				status: "queued",
				sponsor_mode: "member_connection",
			});
		}
		if (
			url ===
			`https://objects.fixture.invalid/v1/member-session-attachments/input/${session.sessionId}/${id(90)}/${hash}`
		)
			return new Response(png);
		throw new Error("Unexpected fixture request");
	});
	vi.stubGlobal("fetch", fetcher);
	document.body.append(root);
	cleanups.push(mountApplication(root, f.cloud, f.api));
	await vi.waitFor(() =>
		expect(root.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')?.disabled).toBe(false),
	);
	// The member's one usable account is chosen for them; sending opens once it is, with no picker.
	const message = root.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!;
	const draft = (value: string) => {
		message.value = value;
		message.dispatchEvent(new Event("input"));
	};
	draft("Account check");
	await vi.waitFor(() => expect(button(root, "Send message").disabled).toBe(false));
	draft("");
	await settle();
	expect(root.querySelector('[aria-label="Model account for this conversation"]')).toBeNull();
	const requests = () =>
		fetcher.mock.calls.filter(
			([url]) =>
				!String(url).endsWith("/qorpera_list_member_notifications") &&
				!String(url).endsWith("/qorpera_list_session_turn_requests") &&
				!String(url).endsWith("/qorpera_select_member_session_account") &&
				!String(url).endsWith("/qorpera_begin_native_account_refresh") &&
				!String(url).endsWith("/qorpera_list_member_native_execution_connections"),
		);
	return { ...f, root, fetcher, requests };
}
describe("actual product conversation attachments", () => {
	it("sends selected images, clears the tray on acceptance and previews only canonical verified bytes", async () => {
		const f = await setup();
		select(f.root, [new File([png], "review.png", { type: "image/png" })]);
		expect(f.requests()).toHaveLength(0);
		const text = f.root.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!;
		text.value = "Review this image";
		text.dispatchEvent(new Event("input"));
		button(f.root, "Send message").click();
		await vi.waitFor(() => expect(f.root.querySelector(".attachment-chip")).toBeNull());
		await vi.waitFor(() => expect(f.root.querySelector(".received-file")).not.toBeNull());
		expect(text.value).toBe("");
		expect(f.requests()).toHaveLength(2);
		button(f.root, "Preview Image attachment").click();
		await vi.waitFor(() => expect(document.querySelector("dialog img")).not.toBeNull());
		expect(f.requests()).toHaveLength(3);
		// Only the thread's own read of its machines reaches the SDK; no attachment does.
		expect(vi.mocked(f.cloud.rpc).mock.calls.filter(([name]) => name !== "qorpera_list_session_machines")).toEqual(
			[],
		);
	});
	it("retains files and the exact input ID after a lost sponsored response without replaying automatically", async () => {
		const f = await setup(),
			normal = f.fetcher.getMockImplementation()!;
		let lose = true;
		f.fetcher.mockImplementation(async (input, init) => {
			const response = await normal(input, init);
			if (String(input).endsWith("/qorpera_request_session_turn_v2") && lose) {
				lose = false;
				throw new Error("Cloud execution could not be confirmed");
			}
			return response;
		});
		select(f.root, [new File([png], "review.png", { type: "image/png" })]);
		button(f.root, "Send message").click();
		await vi.waitFor(() => expect(f.root.textContent).toContain("Cloud execution could not be confirmed"));
		expect(f.root.querySelector(".attachment-chip")).not.toBeNull();
		expect(f.requests()).toHaveLength(2);
		button(f.root, "Send message").click();
		await vi.waitFor(() => expect(f.root.querySelector(".attachment-chip")).toBeNull());
		const turns = f.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/qorpera_request_session_turn_v2"));
		const uploads = f.fetcher.mock.calls.filter(([url]) => String(url).includes("/upload/"));
		expect(f.fetcher.mock.calls.some(([url]) => String(url).includes("append_session_input"))).toBe(false);
		expect(turns).toHaveLength(2);
		expect(uploads).toHaveLength(2);
		expect(turns[0]![1]!.body).toBe(turns[1]![1]!.body);
		expect(uploads[0]![0]).toBe(uploads[1]![0]);
		expect(uploads[0]![1]!.body).toEqual(uploads[1]![1]!.body);
	});
	it("does not request a turn after an uncertain upload and retries that same upload explicitly", async () => {
		const f = await setup();
		const normal = f.fetcher.getMockImplementation()!;
		let lose = true;
		f.fetcher.mockImplementation(async (input, init) => {
			if (String(input).includes("/upload/") && lose) {
				lose = false;
				throw new Error("Upload response lost");
			}
			return normal(input, init);
		});
		select(f.root, [new File([png], "review.png", { type: "image/png" })]);
		button(f.root, "Send message").click();
		await vi.waitFor(() => expect(f.root.textContent).toContain("Upload response lost"));
		expect(f.requests()).toHaveLength(1);
		button(f.root, "Send message").click();
		await vi.waitFor(() => expect(f.root.querySelector(".attachment-chip")).toBeNull());
		expect(f.requests()[0]![0]).toBe(f.requests()[1]![0]);
		expect(f.requests()).toHaveLength(3);
	});
	it("fences an account change during upload and clears local images", async () => {
		const f = await setup(),
			response = deferred<Response>();
		const normal = f.fetcher.getMockImplementation()!;
		f.fetcher.mockImplementation((input, init) =>
			String(input).includes("/upload/") ? response.promise : normal(input, init),
		);
		select(f.root, [new File([png], "private.png", { type: "image/png" })]);
		button(f.root, "Send message").click();
		await vi.waitFor(() => expect(f.requests()).toHaveLength(1));
		expect(button(f.root, "Remove private.png").disabled).toBe(true);
		f.auth(userB);
		response.resolve(Response.json({ sha256: hash, bytes: png.length, mediaType: "image/png" }));
		await settle();
		await vi.waitFor(() => expect(f.root.textContent).not.toContain("private.png"));
		expect(f.requests()).toHaveLength(1);
		expect(URL.revokeObjectURL).toHaveBeenCalled();
	});
	it("rejects unsupported files and the protocol's aggregate image limit before uploading", async () => {
		const f = await setup();
		select(f.root, [new File(["document"], "brief.pdf", { type: "application/pdf" })]);
		expect(button(f.root, "Send message").disabled).toBe(true);
		expect(f.root.textContent).toContain("Upload other files through Company File");
		button(f.root, "Remove brief.pdf").click();
		select(
			f.root,
			Array.from({ length: 6 }, (_, i) => new File([png], `image-${i}.png`, { type: "image/png" })),
		);
		expect(button(f.root, "Send message").disabled).toBe(true);
		expect(f.root.textContent).toContain("up to 5 images");
		expect(f.requests()).toHaveLength(0);
	});
});
