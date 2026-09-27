// @vitest-environment jsdom
import { File as NodeFile } from "node:buffer";
import { webcrypto } from "node:crypto";
import { cloudFileBytesSha256 } from "@qorpera/cloud-client/cloud-file-bytes";
import type { CompanyPathPresenceView } from "@qorpera/cloud-client/company-path-presence";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApplication } from "../src/app/application.ts";
import { LiveCompanyFileView } from "../src/app/views/live-company-file.ts";
import { WebCompanyFiles } from "../src/cloud/company-files.ts";
import { deferred, fixture, id, profileA, settle, staff, team, userA, userB, visibleText } from "./fixtures.ts";

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
	// The live company: files with their text and version, and folders with theirs.
	const files = new Map<string, { text: string; version: string }>([
		["notes.txt", { text: "Original text", version: id(40) }],
	]);
	const folders = new Map<string, string>();
	let nextVersion = 42;
	const objects = new Map<string, Uint8Array>();
	const parent = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
	const reference = async (text: string) => {
		const bytes = new TextEncoder().encode(text),
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
				items: [
					...[...folders]
						.filter(([path]) => parent(path) === body.p_path)
						.map(([path, version]) => ({ path, version, kind: "directory", bytes: null })),
					...[...files]
						.filter(([path]) => parent(path) === body.p_path)
						.map(([path, file]) => ({
							path,
							version: file.version,
							kind: "file",
							bytes: new TextEncoder().encode(file.text).length,
						})),
				].sort((a, b) => (a.path < b.path ? -1 : 1)),
				hasMore: false,
				nextAfter: null,
			});
		if (method === "qorpera_list_company_path_proposals" && offerProposal)
			return Response.json({ items: [], nextAfter: null });
		if (method === "qorpera_list_member_file_exports") return Response.json({ items: [], nextAfter: null });
		if (["qorpera_list_member_company_path_commands", "qorpera_list_company_path_proposals"].includes(method))
			return Response.json({ items: [], nextAfter: null });
		if (method === "qorpera_read_company_path") {
			const file = files.get(body.p_path),
				folder = folders.get(body.p_path);
			if (folder)
				return Response.json({
					companyId: profileA.profileId,
					path: body.p_path,
					version: folder,
					entry: { path: body.p_path, kind: "directory" },
					manifestBytes: null,
				});
			if (!file)
				return Response.json({
					companyId: profileA.profileId,
					path: body.p_path,
					version: null,
					entry: null,
					manifestBytes: null,
				});
			const ref = await reference(file.text);
			return Response.json({
				companyId: profileA.profileId,
				path: body.p_path,
				version: file.version,
				entry: { path: body.p_path, kind: "file", executable: false, file: ref.file },
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
			const operation = method === "uploads" ? "write" : body.operation;
			expect(intent.expectedVersion).toBe(files.get(intent.path)?.version ?? folders.get(intent.path) ?? null);
			const version = id(nextVersion++);
			let entry: unknown = null;
			if (operation === "mkdir") {
				folders.set(intent.path, version);
				entry = { path: intent.path, kind: "directory" };
			} else if (operation === "delete") files.delete(intent.path);
			else {
				const text = method === "uploads" ? new TextDecoder().decode(init?.body as Uint8Array) : body.text;
				files.set(intent.path, { text, version });
				entry = { path: intent.path, kind: "file", executable: false, file: (await reference(text)).file };
			}
			return Response.json({
				commandId: id(43),
				companyId: profileA.profileId,
				environmentId: profileA.environmentId,
				plan: {
					schema: "qorpera.company-path-mutation/v1",
					path: intent.path,
					operationKey: intent.operationKey,
					expectedVersion: intent.expectedVersion,
					entry,
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
	return { ...f, stop, company, fetch, current, files, folders };
}
/** A button by its words or its accessible name. */
function button(root: ParentNode, label: string) {
	const found = [...root.querySelectorAll("button")].find(
		(node) => node.textContent?.trim() === label || node.getAttribute("aria-label") === label,
	);
	if (!found) throw new Error(`Missing ${label}: ${(root as Element).textContent ?? ""}`);
	return found;
}
function row(root: ParentNode, name: string) {
	const found = [...root.querySelectorAll<HTMLButtonElement>(".files-row-main")].find(
		(node) => node.querySelector(".files-name")?.textContent === name,
	);
	if (!found) throw new Error(`Missing row ${name}: ${(root as Element).textContent ?? ""}`);
	return found;
}
async function open(root: ParentNode, name: string) {
	row(root, name).click();
	await vi.waitFor(() => expect(root.querySelector(".files-preview h2")?.textContent).toBe(name));
}
async function edit(root: ParentNode) {
	button(root, "Edit").click();
	await vi.waitFor(() => expect(root.querySelector(".files-editor")).not.toBeNull());
	return root.querySelector<HTMLTextAreaElement>(".files-editor")!;
}
function type(field: HTMLTextAreaElement | HTMLInputElement, value: string) {
	field.value = value;
	field.dispatchEvent(new Event("input"));
}
function menuItem(label: string) {
	const found = [...document.querySelectorAll<HTMLElement>(".context-menu [role^=menuitem]")].find(
		(node) => node.textContent?.trim() === label,
	);
	if (!found) throw new Error(`Missing menu item ${label}`);
	return found;
}
async function dialogButton(label: string) {
	await vi.waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
	return button(document.querySelector(".modal")!, label);
}
async function mount(f: Awaited<ReturnType<typeof setup>>, readOnly = false) {
	const company = readOnly
		? new WebCompanyFiles(f.cloud, profileA, userA.id, "owner", f.stop.signal, f.current, false)
		: f.company;
	const view = new LiveCompanyFileView(company, f.stop, profileA.profileId, "owner", undefined, () => [staff]);
	document.body.append(view.el);
	disposers.push(() => view.dispose());
	await vi.waitFor(() => expect(row(view.el, "notes.txt")).toBeDefined());
	await settle();
	return view;
}
describe("product governed File boundary", () => {
	it("keeps the configured direct transport until bridge activation", async () => {
		const f = await setup(false, false),
			view = await mount(f);
		await open(view.el, "notes.txt");
		expect(view.el.querySelector(".files-text")?.textContent).toBe("Original text");
		const objects = f.fetch.mock.calls.filter(([url]) => String(url).includes("/v1/member-company-objects/"));
		expect(objects.length).toBeGreaterThan(0);
		for (const [url] of objects) expect(new URL(String(url)).origin).toBe(f.cloud.config.objectGatewayUrl);
		expect(f.fetch.mock.calls.some(([url]) => String(url).includes("/functions/v1/member-company-gateway"))).toBe(
			false,
		);
	});
	it("says what is opening in its status line, outside the inert list, until the list has been read", async () => {
		const f = await setup();
		const view = new LiveCompanyFileView(f.company, f.stop, profileA.profileId, "owner");
		document.body.append(view.el);
		disposers.push(() => view.dispose());
		const status = view.el.querySelector("[role=status]")!;
		expect(status.querySelector(".visually-hidden")?.textContent).toBe("Opening Company File");
		expect(visibleText(status)).toBe("");
		expect(view.el.querySelector(".skeleton-list")).not.toBeNull();
		await vi.waitFor(() => expect(row(view.el, "notes.txt")).toBeDefined());
		await vi.waitFor(() => expect(status.textContent).toBe(""));
		expect(view.el.querySelector(".skeleton")).toBeNull();
	});
	it("mounts the File page, preserves a cancelled navigation draft, and drops edit controls on role downgrade", async () => {
		const f = await setup(),
			root = document.createElement("div");
		history.replaceState(null, "", `/#/c/${profileA.profileId}/file`);
		document.body.append(root);
		disposers.push(mountApplication(root, f.cloud, f.api));
		await vi.waitFor(() => expect(row(root, "notes.txt")).toBeDefined());
		await open(root, "notes.txt");
		const text = await edit(root);
		expect(text.value).toBe("Original text");
		type(text, "Unsaved draft");
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		location.hash = `#/c/${profileA.profileId}/file/history`;
		await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
		expect(location.hash).toBe(`#/c/${profileA.profileId}/file`);
		expect(root.querySelector(".files-editor")).toBe(text);
		expect(text.value).toBe("Unsaved draft");
		vi.mocked(f.api.getTeam).mockResolvedValue({
			...team,
			role: "viewer",
			capabilities: { ...team.capabilities, write: false, authorize: false },
		});
		f.hints.get("qorpera_profile_access_state")!();
		await vi.waitFor(() => expect(root.querySelector(".files-editor")).toBeNull());
		await vi.waitFor(() => expect(row(root, "notes.txt")).toBeDefined());
		await open(root, "notes.txt");
		expect(() => button(root, "Edit")).toThrow();
		expect(() => button(root, "Delete notes.txt")).toThrow();
		expect(root.querySelector<HTMLButtonElement>(".files-new")?.hidden).toBe(true);
		expect(f.api.getCompanyFile).not.toHaveBeenCalled();
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
	it("uses live path reads and writes the observed version through the member gateway", async () => {
		const f = await setup(),
			view = await mount(f);
		await open(view.el, "notes.txt");
		const text = await edit(view.el);
		type(text, "Updated by member");
		expect(view.leaveMessage()).toContain("unsaved");
		button(view.el, "Save").click();
		await vi.waitFor(() => expect(view.el.textContent).toContain("Saved notes.txt."));
		expect(view.leaveMessage()).toBeNull();
		expect(view.el.querySelector(".files-text")?.textContent).toBe("Updated by member");
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
		await vi.waitFor(() => expect(row(root, "notes.txt")).toBeDefined());
		await open(root, "notes.txt");
		const text = await edit(root);
		type(text, "Conflicting edit");
		f.fetch.mockResolvedValueOnce(new Response(null, { status: 409 }));
		button(root, "Save").click();
		await vi.waitFor(() => expect(root.textContent).toContain("operation could not be confirmed"));
		const kept = root.querySelector<HTMLTextAreaElement>(".files-editor")!;
		expect(kept.value).toBe("Conflicting edit");
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		button(root, "Reload").click();
		expect(root.querySelector(".files-editor")).toBe(kept);
		expect(kept.value).toBe("Conflicting edit");
		expect(confirm).toHaveBeenCalledWith(expect.stringContaining("A change you sent may still apply"));
		confirm.mockReturnValue(true);
		button(root, "Reload").click();
		await vi.waitFor(() => expect(row(root, "notes.txt")).toBeDefined());
		await open(root, "notes.txt");
		const fresh = await edit(root);
		expect(fresh).not.toBe(kept);
		expect(fresh.value).toBe("Original text");
		expect(fresh.disabled).toBe(false);
		expect(f.fetch.mock.calls.filter(([url]) => String(url).endsWith("/edits"))).toHaveLength(1);
	});
	it("asks before closing an edited file and forgets the draft once the member agrees", async () => {
		const f = await setup(),
			view = await mount(f);
		await open(view.el, "notes.txt");
		type(await edit(view.el), "Discard me");
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		button(view.el, "Close notes.txt").click();
		expect(view.el.querySelector<HTMLTextAreaElement>(".files-editor")?.value).toBe("Discard me");
		confirm.mockReturnValue(true);
		button(view.el, "Close notes.txt").click();
		expect(view.el.querySelector(".files-preview")?.hasAttribute("hidden")).toBe(true);
		expect(view.leaveMessage()).toBeNull();
		await open(view.el, "notes.txt");
		expect(view.el.querySelector(".files-text")?.textContent).toBe("Original text");
	});
	it("keeps the exact edit across an uncertain response and does not replay automatically", async () => {
		const f = await setup(),
			view = await mount(f);
		await open(view.el, "notes.txt");
		type(await edit(view.el), "One edit");
		f.fetch.mockRejectedValueOnce(new Error("Response lost"));
		button(view.el, "Save").click();
		await vi.waitFor(() => expect(view.el.textContent).toContain("operation could not be confirmed"));
		expect(view.el.querySelector<HTMLTextAreaElement>(".files-editor")?.disabled).toBe(true);
		expect(view.leaveMessage()).toContain("may not have been saved");
		row(view.el, "notes.txt").click();
		await vi.waitFor(() => expect(view.el.textContent).toContain("Retry it before starting another"));
		button(view.el, "Retry save").click();
		await vi.waitFor(() => expect(view.el.textContent).toContain("Saved notes.txt."));
		const writes = f.fetch.mock.calls.filter(([url]) => String(url).endsWith("/edits"));
		expect(writes).toHaveLength(2);
		expect(writes[0]![1]!.body).toBe(writes[1]![1]!.body);
	});
	it("uploads chosen bytes into the open folder and asks before replacing a file", async () => {
		const f = await setup(),
			view = await mount(f);
		const chooser = view.el.querySelector<HTMLInputElement>('input[type="file"]')!;
		Object.defineProperty(chooser, "files", {
			configurable: true,
			value: [new File(["Selected bytes"], "notes.txt", { type: "text/plain" })],
		});
		chooser.dispatchEvent(new Event("change"));
		(await dialogButton("Replace")).click();
		await vi.waitFor(() => expect(view.el.textContent).toContain("Uploaded notes.txt."));
		const writes = f.fetch.mock.calls.filter(([url]) => String(url).endsWith("/uploads"));
		expect(writes).toHaveLength(1);
		expect(new TextDecoder().decode(writes[0]![1]!.body as Uint8Array)).toBe("Selected bytes");
		expect(view.leaveMessage()).toBeNull();
		await open(view.el, "notes.txt");
		expect(view.el.querySelector(".files-text")?.textContent).toBe("Selected bytes");
	});
	it("uploads dropped files as new files without asking", async () => {
		const f = await setup(),
			view = await mount(f);
		const drop = (type: string, files: File[] = []) => {
			const event = new Event(type, { bubbles: true, cancelable: true });
			Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files, dropEffect: "none" } });
			view.el.dispatchEvent(event);
		};
		drop("dragenter");
		expect(view.el.classList.contains("is-dropping")).toBe(true);
		expect(view.el.querySelector(".files-drop")?.textContent).toContain("Drop to upload to Company");
		drop("drop", [new File(["Plan"], "plan.md", { type: "text/markdown" })]);
		expect(view.el.classList.contains("is-dropping")).toBe(false);
		await vi.waitFor(() => expect(view.el.textContent).toContain("Uploaded plan.md."));
		expect(document.querySelector(".modal")).toBeNull();
		expect(f.files.get("plan.md")?.text).toBe("Plan");
		await open(view.el, "plan.md");
		expect(view.el.querySelector(".files-doc")?.textContent).toContain("Plan");
	});
	it("creates a folder, walks into it and back out by the breadcrumb", async () => {
		const f = await setup(),
			view = await mount(f);
		button(view.el, "New").click();
		menuItem("New folder").click();
		await vi.waitFor(() => expect(document.querySelector(".name-dialog-input")).not.toBeNull());
		type(document.querySelector<HTMLInputElement>(".name-dialog-input")!, "reports");
		document.querySelector("form.name-dialog")!.dispatchEvent(new Event("submit", { cancelable: true }));
		await vi.waitFor(() => expect(view.el.textContent).toContain("Created reports."));
		const writes = f.fetch.mock.calls.filter(([url]) => String(url).endsWith("/edits"));
		expect(JSON.parse(writes[0]![1]!.body as string)).toMatchObject({
			operation: "mkdir",
			path: "reports",
			expectedVersion: null,
		});
		const names = [...view.el.querySelectorAll(".files-name")].map((node) => node.textContent);
		expect(names).toEqual(["reports", "notes.txt"]);
		row(view.el, "reports").click();
		await vi.waitFor(() => expect(view.el.querySelector(".files-crumb.is-current")?.textContent).toBe("reports"));
		expect(view.el.textContent).toContain("This folder is empty.");
		button(view.el, "Company").click();
		await vi.waitFor(() => expect(row(view.el, "notes.txt")).toBeDefined());
	});
	it("writes a new text file against no earlier version", async () => {
		const f = await setup(),
			view = await mount(f);
		button(view.el, "New").click();
		menuItem("New text file").click();
		await vi.waitFor(() => expect(document.querySelector(".name-dialog-input")).not.toBeNull());
		type(document.querySelector<HTMLInputElement>(".name-dialog-input")!, "plan");
		document.querySelector("form.name-dialog")!.dispatchEvent(new Event("submit", { cancelable: true }));
		await vi.waitFor(() => expect(view.el.querySelector(".files-preview h2")?.textContent).toBe("plan.md"));
		type(view.el.querySelector<HTMLTextAreaElement>(".files-editor")!, "# Plan");
		button(view.el, "Save").click();
		await vi.waitFor(() => expect(view.el.textContent).toContain("Saved plan.md."));
		expect(f.files.get("plan.md")?.text).toBe("# Plan");
		const writes = f.fetch.mock.calls.filter(([url]) => String(url).endsWith("/edits"));
		expect(JSON.parse(writes[0]![1]!.body as string)).toMatchObject({ path: "plan.md", expectedVersion: null });
		expect(row(view.el, "plan.md")).toBeDefined();
	});
	it("refuses a new name that is already taken without writing", async () => {
		const f = await setup(),
			view = await mount(f);
		button(view.el, "New").click();
		menuItem("New text file").click();
		await vi.waitFor(() => expect(document.querySelector(".name-dialog-input")).not.toBeNull());
		type(document.querySelector<HTMLInputElement>(".name-dialog-input")!, "notes.txt");
		document.querySelector("form.name-dialog")!.dispatchEvent(new Event("submit", { cancelable: true }));
		await vi.waitFor(() => expect(view.el.textContent).toContain("notes.txt already exists in this folder."));
		expect(f.fetch.mock.calls.filter(([url]) => String(url).endsWith("/edits"))).toHaveLength(0);
	});
	it("deletes a file at its listed version only after the member confirms", async () => {
		const f = await setup(),
			view = await mount(f);
		row(view.el, "notes.txt").dispatchEvent(
			new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 40 }),
		);
		menuItem("Delete").click();
		(await dialogButton("Cancel")).click();
		await settle();
		expect(f.fetch.mock.calls.filter(([url]) => String(url).endsWith("/edits"))).toHaveLength(0);
		row(view.el, "notes.txt").dispatchEvent(
			new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 40 }),
		);
		menuItem("Delete").click();
		(await dialogButton("Delete")).click();
		await vi.waitFor(() => expect(view.el.textContent).toContain("Deleted notes.txt."));
		const writes = f.fetch.mock.calls.filter(([url]) => String(url).endsWith("/edits"));
		expect(JSON.parse(writes[0]![1]!.body as string)).toMatchObject({
			operation: "delete",
			path: "notes.txt",
			expectedVersion: id(40),
		});
		expect(view.el.textContent).toContain("This folder is empty.");
	});
	it("filters the open folder by name", async () => {
		const f = await setup();
		f.files.set("plan.md", { text: "Plan", version: id(50) });
		const view = await mount(f);
		const search = view.el.querySelector<HTMLInputElement>(".files-search-input")!;
		type(search, "PLA");
		expect([...view.el.querySelectorAll(".files-name")].map((node) => node.textContent)).toEqual(["plan.md"]);
		type(search, "zzz");
		expect(view.el.textContent).toContain("Nothing in this folder matches “zzz”.");
		search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(view.el.querySelectorAll(".files-row")).toHaveLength(2);
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
		button(view.el, "Download notes.txt").click();
		await vi.waitFor(() => expect(view.el.textContent).toContain("Downloading notes.txt."));
		expect(clicks).toEqual([{ href: "blob:fixture-download", filename: "notes.txt" }]);
		expect(create).toHaveBeenCalledWith(expect.objectContaining({ size: 13 }));
		view.dispose();
		expect(revoke).toHaveBeenCalledWith("blob:fixture-download");
	});
	it("lists files shared from the Company Computer beside the folder", async () => {
		const f = await setup(),
			view = await mount(f);
		button(view.el, "Files shared from the Company Computer").click();
		await vi.waitFor(() =>
			expect(view.el.querySelector(".files-preview")?.textContent).toContain(
				"Nothing has been shared from the Company Computer yet.",
			),
		);
		expect(f.fetch.mock.calls.some(([url]) => String(url).endsWith("/qorpera_list_member_file_exports"))).toBe(true);
		button(view.el, "Close Shared from the Company Computer").click();
		expect(view.el.querySelector(".files-preview")?.hasAttribute("hidden")).toBe(true);
	});
	it("leaves agent proposals to their conversations", async () => {
		const f = await setup(true),
			view = await mount(f);
		await open(view.el, "notes.txt");
		expect(
			f.fetch.mock.calls.some(([url]) =>
				/qorpera_list_company_path_proposals|qorpera_list_member_company_path_commands/.test(String(url)),
			),
		).toBe(false);
		expect(view.el.textContent).not.toMatch(/proposal/i);
	});
	it("shows the agents at work on their rows and in the folder, and clears them on company close", async () => {
		const f = await setup();
		let onChange: ((view: CompanyPathPresenceView) => void) | undefined;
		vi.mocked(WebCompanyFiles.prototype.presence).mockImplementation((callback) => {
			onChange = callback;
			throw new Error("Fixture callback only");
		});
		const view = await mount(f);
		const now = Date.now();
		onChange!({
			schema: "qorpera.company-path-presence-view/v1",
			state: "partial",
			observedAt: now,
			paths: [
				{
					path: "",
					participants: [
						{ staffAgentId: staff.id, activity: "writing", overlap: "within_subtree", expiresAt: now + 30000 },
					],
				},
				{
					path: "notes.txt",
					participants: [
						{ staffAgentId: staff.id, activity: "writing", overlap: "same_object", expiresAt: now + 30000 },
					],
				},
			],
		} as CompanyPathPresenceView);
		expect(view.el.querySelector(".files-here")?.textContent).toBe("Fixture agent is writing in this folder");
		expect(row(view.el, "notes.txt").querySelector(".files-activity")?.textContent).toBe("Fixture agent is writing");
		expect(row(view.el, "notes.txt").querySelector(".files-pulse")).not.toBeNull();
		onChange!({
			schema: "qorpera.company-path-presence-view/v1",
			state: "unavailable",
			observedAt: Date.now(),
			paths: [],
		});
		expect(view.el.querySelector(".files-here")?.textContent).toBe("");
		expect(row(view.el, "notes.txt").querySelector(".files-activity")?.textContent).toBe("");
		f.stop.abort();
		expect(view.el.textContent).toBe("");
	});
	it("honors a read-only capability even when the member role is owner", async () => {
		const f = await setup(),
			view = await mount(f, true);
		await open(view.el, "notes.txt");
		expect(() => button(view.el, "Edit")).toThrow();
		expect(() => button(view.el, "Delete notes.txt")).toThrow();
		expect(view.el.querySelector<HTMLButtonElement>(".files-new")?.hidden).toBe(true);
		expect(view.el.querySelector(".files-drop-hint")).toBeNull();
		row(view.el, "notes.txt").dispatchEvent(
			new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 40 }),
		);
		expect(() => menuItem("Delete")).toThrow();
		expect(menuItem("Download")).toBeDefined();
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
		await open(view.el, "notes.txt");
		f.stop.abort();
		expect(view.el.textContent).toBe("");
		expect(document.body.contains(view.el)).toBe(false);
	});
});
