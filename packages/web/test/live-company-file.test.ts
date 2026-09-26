// @vitest-environment jsdom
import { File as NodeFile } from "node:buffer";
import { webcrypto } from "node:crypto";
import { cloudFileBytesSha256 } from "@qorpera/cloud-client/cloud-file-bytes";
import type { CompanyPathPresenceView } from "@qorpera/cloud-client/company-path-presence";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApplication } from "../src/app/application.ts";
import { LiveCompanyFileView } from "../src/app/views/live-company-file.ts";
import { WebCompanyFiles } from "../src/cloud/company-files.ts";
import { deferred, fixture, id, profileA, settle, team, userA, userB, visibleText } from "./fixtures.ts";

const disposers: (() => void)[] = [];
beforeEach(() => {
	vi.stubGlobal("crypto", webcrypto);
	vi.stubGlobal("File", NodeFile);
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	vi.spyOn(WebCompanyFiles.prototype, "presence").mockImplementation(() => {
		throw new Error("No fixture realtime");
	});
});
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});
async function setup(offerProposal = false, useBridge = true) {
	const f = fixture(),
		stop = new AbortController();
	f.cloud.config.objectGatewayUrl = "https://objects.fixture.invalid";
	if (useBridge)
		f.cloud.config.memberCompanyGatewayUrl = `${f.cloud.config.projectUrl}/functions/v1/member-company-gateway`;
	let contents = "Original text",
		version = id(40),
		exists = true;
	const objects = new Map<string, Uint8Array>();
	const proposal = {
		proposalId: id(44),
		plan: {
			schema: "qorpera.company-path-mutation/v1",
			operationKey: "fixture-proposal",
			path: "notes.txt",
			expectedVersion: version,
			entry: null,
		},
		planSha256: "b".repeat(64),
		state: "open",
		snapshotId: null,
	};
	const reference = async () => {
		const bytes = new TextEncoder().encode(contents),
			hash = await cloudFileBytesSha256(bytes);
		const manifest = new TextEncoder().encode(
			JSON.stringify({
				schema: "qorpera.cloud-file-manifest/v1",
				fileSha256: hash,
				bytes: bytes.length,
				mediaType: "application/octet-stream",
				chunks: [{ sha256: hash, bytes: bytes.length }],
			}),
		);
		const manifestHash = await cloudFileBytesSha256(manifest);
		objects.set(hash, bytes);
		objects.set(manifestHash, manifest);
		return {
			manifestBytes: manifest.length,
			file: {
				manifestSha256: manifestHash,
				fileSha256: hash,
				bytes: bytes.length,
				mediaType: "application/octet-stream",
			},
		};
	};
	const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(String(input)),
			method = url.pathname.split("/").at(-1)!;
		if (url.pathname.includes("/v1/member-")) {
			expect(url.origin).toBe(
				new URL(useBridge ? f.cloud.config.projectUrl : f.cloud.config.objectGatewayUrl).origin,
			);
			expect(url.pathname).toMatch(
				useBridge ? /^\/functions\/v1\/member-company-gateway\/v1\/member-/ : /^\/v1\/member-/,
			);
		} else expect(url.origin).toBe(new URL(f.cloud.config.projectUrl).origin);
		expect(init?.redirect).toBe("error");
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-token");
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
		if (method === "qorpera_member_company_file_mode")
			return Response.json({
				companyId: profileA.profileId,
				environmentId: profileA.environmentId,
				mode: "governed",
			});
		if (method === "qorpera_list_company_paths")
			return Response.json({
				snapshotId: id(41),
				items: exists
					? [{ path: "notes.txt", version, kind: "file", bytes: new TextEncoder().encode(contents).length }]
					: [],
				hasMore: false,
				nextAfter: null,
			});
		if (method === "qorpera_list_company_path_proposals" && offerProposal)
			return Response.json({ items: [proposal], nextAfter: null });
		if (["qorpera_list_member_company_path_commands", "qorpera_list_company_path_proposals"].includes(method))
			return Response.json({ items: [], nextAfter: null });
		if (url.pathname.endsWith(`/proposals/${proposal.proposalId}/review`)) {
			expect(body).toEqual({ planSha256: proposal.planSha256, decision: "approve" });
			offerProposal = false;
			exists = false;
			return Response.json({ ...proposal, state: "applied", snapshotId: id(41) });
		}
		if (method === "qorpera_read_company_path") {
			if (!exists || body.p_path !== "notes.txt")
				return Response.json({
					companyId: profileA.profileId,
					path: body.p_path,
					version: null,
					entry: null,
					manifestBytes: null,
				});
			const ref = await reference();
			return Response.json({
				companyId: profileA.profileId,
				path: "notes.txt",
				version,
				entry: { path: "notes.txt", kind: "file", executable: false, file: ref.file },
				manifestBytes: ref.manifestBytes,
			});
		}
		if (url.pathname.includes("/v1/member-company-objects/")) {
			const bytes = objects.get(method);
			if (!bytes) throw new Error("Unknown fixture object");
			return new Response(Uint8Array.from(bytes), { headers: { "x-qorpera-access-mode": "live-path-authority" } });
		}
		if (method === "edits" || method === "uploads") {
			const uploadHeader = new Headers(init?.headers).get("x-qorpera-company-upload");
			const intent = uploadHeader ? JSON.parse(Buffer.from(uploadHeader, "base64url").toString("utf8")) : body;
			if (method === "uploads") {
				expect(init?.method).toBe("PUT");
				expect(init?.body).toBeInstanceOf(Uint8Array);
			}
			expect(intent.expectedVersion).toBe(version);
			contents = method === "uploads" ? new TextDecoder().decode(init?.body as Uint8Array) : body.text;
			version = id(42);
			exists = body.operation !== "delete";
			const ref = await reference();
			return Response.json({
				commandId: id(43),
				companyId: profileA.profileId,
				environmentId: profileA.environmentId,
				plan: {
					schema: "qorpera.company-path-mutation/v1",
					path: intent.path,
					operationKey: intent.operationKey,
					expectedVersion: intent.expectedVersion,
					entry: exists ? { path: intent.path, kind: "file", executable: false, file: ref.file } : null,
				},
				planSha256: "a".repeat(64),
				state: "applied",
				expiresAt: "2030-01-01T00:00:00Z",
				result: {
					state: "applied",
					path: intent.path,
					operationKey: intent.operationKey,
					version,
					snapshotId: id(41),
				},
			});
		}
		throw new Error(`Unexpected fixture endpoint: ${url.pathname}`);
	});
	vi.stubGlobal("fetch", fetch);
	const current = vi.fn();
	const company = new WebCompanyFiles(f.cloud, profileA, userA.id, "owner", stop.signal, current);
	disposers.push(() => stop.abort());
	return { ...f, stop, company, fetch, current };
}
function button(root: HTMLElement, label: string) {
	const found = [...root.querySelectorAll("button")].find((node) => node.textContent === label);
	if (!found) throw new Error(`Missing ${label}: ${root.textContent}`);
	return found;
}
async function mount(f: Awaited<ReturnType<typeof setup>>) {
	const view = new LiveCompanyFileView(f.company, f.stop, profileA.profileId, "owner");
	document.body.append(view.el);
	disposers.push(() => view.dispose());
	await vi.waitFor(() => expect(button(view.el, "notes.txt")).toBeDefined());
	await settle();
	return view;
}
describe("product governed File boundary", () => {
	it("keeps the configured direct transport until bridge activation", async () => {
		const f = await setup(false, false),
			view = await mount(f);
		button(view.el, "notes.txt").click();
		await vi.waitFor(() => expect(view.el.querySelector("textarea")?.value).toBe("Original text"));
		const objects = f.fetch.mock.calls.filter(([url]) => String(url).includes("/v1/member-company-objects/"));
		expect(objects.length).toBeGreaterThan(0);
		for (const [url] of objects) expect(new URL(String(url)).origin).toBe(f.cloud.config.objectGatewayUrl);
		expect(f.fetch.mock.calls.some(([url]) => String(url).includes("/functions/v1/member-company-gateway"))).toBe(
			false,
		);
	});
	it("says what is opening in its status line, outside the inert panel, until the panel has read the files", async () => {
		const f = await setup();
		const view = new LiveCompanyFileView(f.company, f.stop, profileA.profileId, "owner");
		document.body.append(view.el);
		disposers.push(() => view.dispose());
		const status = view.el.querySelector("p[role=status]")!;
		expect(status.querySelector(".visually-hidden")?.textContent).toBe("Opening Company File");
		expect(visibleText(status)).toBe("");
		expect(view.el.querySelector(".skeleton-list")).not.toBeNull();
		await vi.waitFor(() => expect(button(view.el, "notes.txt")).toBeDefined());
		await vi.waitFor(() => expect(status.textContent).toBe(""));
		expect(view.el.querySelector(".skeleton")).toBeNull();
	});
	it("mounts the live File page, preserves a cancelled navigation draft, and drops edit controls on role downgrade", async () => {
		const f = await setup(),
			root = document.createElement("div");
		history.replaceState(null, "", `/#/c/${profileA.profileId}/file`);
		document.body.append(root);
		disposers.push(mountApplication(root, f.cloud, f.api));
		await vi.waitFor(() => expect(button(root, "notes.txt")).toBeDefined());
		button(root, "notes.txt").click();
		await vi.waitFor(() => expect(root.querySelector("textarea")?.value).toBe("Original text"));
		const text = root.querySelector("textarea")!;
		text.value = "Unsaved draft";
		text.dispatchEvent(new Event("input"));
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		location.hash = `#/c/${profileA.profileId}/file/history`;
		await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
		expect(location.hash).toBe(`#/c/${profileA.profileId}/file`);
		expect(root.querySelector("textarea")).toBe(text);
		expect(text.value).toBe("Unsaved draft");
		vi.mocked(f.api.getTeam).mockResolvedValue({
			...team,
			role: "viewer",
			capabilities: { ...team.capabilities, write: false, authorize: false },
		});
		f.hints.get("qorpera_profile_access_state")!();
		await vi.waitFor(() => expect(root.querySelector("textarea")).not.toBe(text));
		await vi.waitFor(() => expect(button(root, "notes.txt")).toBeDefined());
		expect(button(root, "Save to company").disabled).toBe(true);
		expect(f.api.getCompanyFile).not.toHaveBeenCalled();
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
	it("uses live path reads and writes the observed version through the member gateway", async () => {
		const f = await setup(),
			view = await mount(f);
		button(view.el, "notes.txt").click();
		const text = view.el.querySelector<HTMLTextAreaElement>('[aria-label="File content"]')!;
		await vi.waitFor(() => expect(text.value).toBe("Original text"));
		text.value = "Updated by member";
		text.dispatchEvent(new Event("input"));
		expect(view.leaveMessage()).toContain("unsaved");
		button(view.el, "Save to company").click();
		await vi.waitFor(() => expect(view.el.textContent).toContain("Saved to the live company"));
		expect(view.leaveMessage()).toBeNull();
		const writes = f.fetch.mock.calls.filter(([url]) => String(url).endsWith("/edits"));
		expect(writes).toHaveLength(1);
		expect(JSON.parse(writes[0]![1]!.body as string)).toMatchObject({
			path: "notes.txt",
			expectedVersion: id(40),
			text: "Updated by member",
		});
		expect(String(writes[0]![0])).toBe(
			`${f.cloud.config.projectUrl}/functions/v1/member-company-gateway/v1/member-company-file/${profileA.environmentId}/edits`,
		);
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
	it("recovers from a version conflict only after explicit reload without replaying the rejected edit", async () => {
		const f = await setup(),
			root = document.createElement("div");
		history.replaceState(null, "", `/#/c/${profileA.profileId}/file`);
		document.body.append(root);
		disposers.push(mountApplication(root, f.cloud, f.api));
		await vi.waitFor(() => expect(button(root, "notes.txt")).toBeDefined());
		button(root, "notes.txt").click();
		await vi.waitFor(() => expect(root.querySelector("textarea")?.value).toBe("Original text"));
		const text = root.querySelector("textarea")!;
		text.value = "Conflicting edit";
		text.dispatchEvent(new Event("input"));
		f.fetch.mockResolvedValueOnce(new Response(null, { status: 409 }));
		button(root, "Save to company").click();
		await vi.waitFor(() => expect(root.textContent).toContain("operation could not be confirmed"));
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		button(root, "Reload Company File").click();
		expect(root.querySelector("textarea")).toBe(text);
		expect(text.value).toBe("Conflicting edit");
		expect(confirm).toHaveBeenCalledWith(expect.stringContaining("submitted change may still apply"));
		confirm.mockReturnValue(true);
		button(root, "Reload Company File").click();
		await vi.waitFor(() => expect(button(root, "notes.txt")).toBeDefined());
		button(root, "notes.txt").click();
		await vi.waitFor(() => expect(root.querySelector("textarea")?.value).toBe("Original text"));
		expect(root.querySelector("textarea")).not.toBe(text);
		expect(root.querySelector("textarea")?.disabled).toBe(false);
		expect(f.fetch.mock.calls.filter(([url]) => String(url).endsWith("/edits"))).toHaveLength(1);
	});
	it.each(["Up", "New file"])("clears an accepted discarded draft when choosing %s", async (label) => {
		const f = await setup(),
			view = await mount(f);
		button(view.el, "notes.txt").click();
		const text = view.el.querySelector<HTMLTextAreaElement>('[aria-label="File content"]')!;
		await vi.waitFor(() => expect(text.value).toBe("Original text"));
		text.value = "Discard me";
		text.dispatchEvent(new Event("input"));
		vi.spyOn(window, "confirm").mockReturnValue(true);
		button(view.el, label).click();
		await vi.waitFor(() => expect(text.value).toBe(""));
		expect(view.leaveMessage()).toBeNull();
		expect(text.disabled).toBe(true);
		expect(view.el.textContent).not.toContain("Loaded the current company version");
	});
	it("keeps the exact edit across an uncertain response and does not replay automatically", async () => {
		const f = await setup(),
			view = await mount(f);
		button(view.el, "notes.txt").click();
		const text = view.el.querySelector<HTMLTextAreaElement>('[aria-label="File content"]')!;
		await vi.waitFor(() => expect(text.value).toBe("Original text"));
		text.value = "One edit";
		text.dispatchEvent(new Event("input"));
		f.fetch.mockRejectedValueOnce(new Error("Response lost"));
		button(view.el, "Save to company").click();
		await vi.waitFor(() => expect(view.el.textContent).toContain("operation could not be confirmed"));
		expect(text.disabled).toBe(true);
		expect(view.leaveMessage()).toContain("unconfirmed");
		button(view.el, "Retry this exact save").click();
		await vi.waitFor(() => expect(view.el.textContent).toContain("Saved to the live company"));
		const writes = f.fetch.mock.calls.filter(([url]) => String(url).endsWith("/edits"));
		expect(writes).toHaveLength(2);
		expect(writes[0]![1]!.body).toBe(writes[1]![1]!.body);
	});
	it("uploads only the selected bytes to the explicitly checked destination", async () => {
		const f = await setup(),
			view = await mount(f);
		const chooser = view.el.querySelector<HTMLInputElement>('input[type="file"]')!;
		Object.defineProperty(chooser, "files", {
			value: [new File(["Selected bytes"], "notes.txt", { type: "text/plain" })],
		});
		chooser.dispatchEvent(new Event("change"));
		await vi.waitFor(() => expect(view.el.textContent).toContain("Check the destination before uploading"));
		expect(button(view.el, "Upload to company").disabled).toBe(true);
		button(view.el, "Check destination").click();
		await vi.waitFor(() => expect(button(view.el, "Upload to company").disabled).toBe(false));
		expect(view.el.textContent).toContain("Replace notes.txt at the checked version");
		button(view.el, "Upload to company").click();
		await vi.waitFor(() => expect(view.el.textContent).toContain("Upload submitted to the live company"));
		const writes = f.fetch.mock.calls.filter(([url]) => String(url).endsWith("/uploads"));
		expect(writes).toHaveLength(1);
		expect(new TextDecoder().decode(writes[0]![1]!.body as Uint8Array)).toBe("Selected bytes");
		expect(view.leaveMessage()).toBeNull();
		button(view.el, "notes.txt").click();
		await vi.waitFor(() => expect(view.el.querySelector("textarea")?.value).toBe("Selected bytes"));
	});
	it("hands verified live bytes to a browser download and releases its object URL on close", async () => {
		const f = await setup(),
			view = await mount(f);
		const create = vi.fn(() => "blob:fixture-download"),
			revoke = vi.fn();
		vi.stubGlobal(
			"URL",
			class extends URL {
				static override createObjectURL = create;
				static override revokeObjectURL = revoke;
			},
		);
		const clicks: { href: string; filename: string }[] = [];
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
			clicks.push({ href: this.href, filename: this.download });
		});
		button(view.el, "Download…").click();
		await vi.waitFor(() => expect(view.el.textContent).toContain("Download handed to your browser"));
		expect(clicks).toEqual([{ href: "blob:fixture-download", filename: "notes.txt" }]);
		expect(create).toHaveBeenCalledWith(expect.objectContaining({ size: 13 }));
		view.dispose();
		expect(revoke).toHaveBeenCalledWith("blob:fixture-download");
	});
	it("reviews the exact agent proposal and submits its digest only after explicit confirmation", async () => {
		const f = await setup(true),
			view = await mount(f);
		button(view.el, "Agent proposal · notes.txt").click();
		await vi.waitFor(() => expect(view.el.textContent).toContain("Review exact change"));
		const previews = [...view.el.querySelectorAll("textarea[readonly]")];
		expect(previews.map((node) => (node as HTMLTextAreaElement).value)).toEqual([
			"Original text",
			"This path will be deleted.",
		]);
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		button(view.el, "Apply exact change…").click();
		await settle();
		expect(f.fetch.mock.calls.filter(([url]) => String(url).endsWith("/review"))).toHaveLength(0);
		confirm.mockReturnValue(true);
		button(view.el, "Apply exact change…").click();
		await vi.waitFor(() => expect(view.el.textContent).toContain("Applied the exact approved change"));
		const calls = f.fetch.mock.calls.filter(([url]) => String(url).endsWith("/review"));
		expect(calls).toHaveLength(1);
		expect(JSON.parse(calls[0]![1]!.body as string)).toEqual({ planSha256: "b".repeat(64), decision: "approve" });
	});
	it("shows lossy activity for the selected file and clears it on company close", async () => {
		const f = await setup();
		let onChange: ((view: CompanyPathPresenceView) => void) | undefined;
		vi.mocked(WebCompanyFiles.prototype.presence).mockImplementation((callback) => {
			onChange = callback;
			throw new Error("Fixture callback only");
		});
		const view = await mount(f);
		button(view.el, "notes.txt").click();
		await vi.waitFor(() => expect(view.el.querySelector("textarea")?.value).toBe("Original text"));
		onChange!({
			schema: "qorpera.company-path-presence-view/v1",
			state: "partial",
			observedAt: Date.now(),
			paths: [{ path: "notes.txt", participants: [] }],
		});
		expect(view.el.textContent).toContain("No recent shared activity observed. Some activity could not be checked.");
		onChange!({
			schema: "qorpera.company-path-presence-view/v1",
			state: "unavailable",
			observedAt: Date.now(),
			paths: [],
		});
		expect(view.el.textContent).toContain("Recent agent activity · notes.txt: unavailable.");
		f.stop.abort();
		expect(view.el.textContent).toBe("");
	});
	it("honors a read-only capability even when the member role is owner", async () => {
		const f = await setup();
		const company = new WebCompanyFiles(f.cloud, profileA, userA.id, "owner", f.stop.signal, f.current, false);
		const view = new LiveCompanyFileView(company, f.stop, profileA.profileId, "owner-read-only");
		document.body.append(view.el);
		disposers.push(() => view.dispose());
		await vi.waitFor(() => expect(button(view.el, "notes.txt")).toBeDefined());
		button(view.el, "notes.txt").click();
		await vi.waitFor(() => expect(view.el.querySelector("textarea")?.value).toBe("Original text"));
		expect(view.el.querySelector("textarea")?.disabled).toBe(true);
		expect(button(view.el, "Save to company").disabled).toBe(true);
		expect(button(view.el, "Delete…").disabled).toBe(true);
		expect(view.el.querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(true);
	});
	it.each(["legacy", "foreign"])("refuses %s File mode before listing or fetching objects", async (mode) => {
		const f = await setup();
		f.fetch.mockResolvedValueOnce(
			Response.json({
				companyId: profileA.profileId,
				environmentId: mode === "foreign" ? id(99) : profileA.environmentId,
				mode: mode === "legacy" ? "legacy" : "governed",
			}),
		);
		await expect(f.company.files()).rejects.toThrow("governed");
		expect(f.fetch).toHaveBeenCalledTimes(1);
	});
	it("refuses a different member's token", async () => {
		const f = await setup();
		f.auth(userB);
		await expect(f.company.files()).rejects.toThrow();
		expect(f.fetch).not.toHaveBeenCalled();
	});
	it("discards delayed mode discovery after the company closes", async () => {
		const f = await setup(),
			result = deferred<Response>();
		f.fetch.mockReturnValueOnce(result.promise);
		const opening = f.company.files(),
			rejected = expect(opening).rejects.toThrow();
		await settle();
		f.stop.abort();
		result.resolve(
			Response.json({ companyId: profileA.profileId, environmentId: profileA.environmentId, mode: "governed" }),
		);
		await rejected;
		expect(f.fetch).toHaveBeenCalledTimes(1);
	});
	it("clears displayed content synchronously when its company lifetime ends", async () => {
		const f = await setup(),
			view = await mount(f);
		button(view.el, "notes.txt").click();
		await vi.waitFor(() => expect(view.el.querySelector("textarea")?.value).toBe("Original text"));
		f.stop.abort();
		expect(view.el.textContent).toBe("");
		expect(document.body.contains(view.el)).toBe(false);
	});
});
