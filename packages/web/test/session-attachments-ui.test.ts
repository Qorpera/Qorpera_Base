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
		if (url.includes("/upload/")) {
			expect(init?.method).toBe("PUT");
			expect(init?.body).toEqual(png);
			expect(url.endsWith(`/${hash}`)).toBe(true);
			return Response.json({ sha256: hash, bytes: png.length, mediaType: "image/png" });
		}
		if (url.endsWith("/qorpera_append_session_input")) {
			const body = JSON.parse(init!.body as string);
			expect(body.p_session_id).toBe(session.sessionId);
			expect(body.p_body.images).toEqual([reference]);
			admitted = true;
			return Response.json({ input_id: id(90), position: 1 });
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
	return { ...f, root, fetcher };
}
describe("actual product conversation attachments", () => {
	it("sends selected images, clears the tray on acceptance and previews only canonical verified bytes", async () => {
		const f = await setup();
		select(f.root, [new File([png], "review.png", { type: "image/png" })]);
		expect(f.fetcher).not.toHaveBeenCalled();
		const text = f.root.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!;
		text.value = "Review this image";
		text.dispatchEvent(new Event("input"));
		button(f.root, "Send message").click();
		await vi.waitFor(() => expect(f.root.querySelector(".attachment-chip")).toBeNull());
		await vi.waitFor(() => expect(f.root.querySelector(".received-file")).not.toBeNull());
		expect(text.value).toBe("");
		expect(f.fetcher).toHaveBeenCalledTimes(2);
		button(f.root, "Preview Image attachment").click();
		await vi.waitFor(() => expect(document.querySelector("dialog img")).not.toBeNull());
		expect(f.fetcher).toHaveBeenCalledTimes(3);
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
	it("retains files and the exact input ID after a lost append response without replaying automatically", async () => {
		const f = await setup(),
			normal = f.fetcher.getMockImplementation()!;
		let lose = true;
		f.fetcher.mockImplementation(async (input, init) => {
			const response = await normal(input, init);
			if (String(input).endsWith("/qorpera_append_session_input") && lose) {
				lose = false;
				throw new Error("Lost append response");
			}
			return response;
		});
		select(f.root, [new File([png], "review.png", { type: "image/png" })]);
		button(f.root, "Send message").click();
		await vi.waitFor(() => expect(f.root.textContent).toContain("Lost append response"));
		expect(f.root.querySelector(".attachment-chip")).not.toBeNull();
		expect(f.fetcher).toHaveBeenCalledTimes(2);
		button(f.root, "Send message").click();
		await vi.waitFor(() => expect(f.root.querySelector(".attachment-chip")).toBeNull());
		const appends = f.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/qorpera_append_session_input"));
		const uploads = f.fetcher.mock.calls.filter(([url]) => String(url).includes("/upload/"));
		expect(appends).toHaveLength(2);
		expect(uploads).toHaveLength(2);
		expect(appends[0]![1]!.body).toBe(appends[1]![1]!.body);
		expect(uploads[0]![0]).toBe(uploads[1]![0]);
		expect(uploads[0]![1]!.body).toEqual(uploads[1]![1]!.body);
	});
	it("does not append a message after an uncertain upload and retries that same upload explicitly", async () => {
		const f = await setup();
		f.fetcher.mockRejectedValueOnce(new Error("Upload response lost"));
		select(f.root, [new File([png], "review.png", { type: "image/png" })]);
		button(f.root, "Send message").click();
		await vi.waitFor(() => expect(f.root.textContent).toContain("Upload response lost"));
		expect(f.fetcher).toHaveBeenCalledTimes(1);
		button(f.root, "Send message").click();
		await vi.waitFor(() => expect(f.root.querySelector(".attachment-chip")).toBeNull());
		expect(f.fetcher.mock.calls[0]![0]).toBe(f.fetcher.mock.calls[1]![0]);
		expect(f.fetcher).toHaveBeenCalledTimes(3);
	});
	it("fences an account change during upload and clears local images", async () => {
		const f = await setup(),
			response = deferred<Response>();
		f.fetcher.mockReturnValueOnce(response.promise);
		select(f.root, [new File([png], "private.png", { type: "image/png" })]);
		button(f.root, "Send message").click();
		await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1));
		expect(button(f.root, "Remove private.png").disabled).toBe(true);
		f.auth(userB);
		response.resolve(Response.json({ sha256: hash, bytes: png.length, mediaType: "image/png" }));
		await settle();
		await vi.waitFor(() => expect(f.root.textContent).not.toContain("private.png"));
		expect(f.fetcher).toHaveBeenCalledTimes(1);
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
		expect(f.fetcher).not.toHaveBeenCalled();
	});
});
