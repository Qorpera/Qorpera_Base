import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCompanyAppServer } from "../src/core/app-server.ts";
import { scaffoldCompany, scaffoldProductDepartment } from "../src/core/company.ts";

let root: string;
let server: Server | undefined;
let base: string;
const artifactUpdate = vi.fn(() => {
	throw new Error("must not run");
});

beforeEach(async () => {
	root = mkdtempSync(join(realpathSync(tmpdir()), "qorpera-governed-display-"));
	scaffoldCompany(root);
	writeFileSync(join(root, "authority.toml"), "private_file_marker = true\n");
	writeFileSync(join(root, "inbox", "gate-test.md"), "# private_file_marker\nstatus: pending\n");
	scaffoldProductDepartment(root, "private_file_marker");
	server = createCompanyAppServer({
		root,
		authToken: "host-token",
		governedCompanyFile: true,
		artifactUpdateModel: artifactUpdate,
	});
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("test listener unavailable");
	base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
	if (server)
		await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
	server = undefined;
	rmSync(root, { recursive: true, force: true });
	vi.clearAllMocks();
});

describe("governed Company File display host", () => {
	it("does not project cached company files into the shell state", async () => {
		const response = await fetch(`${base}/api/state`);
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).not.toContain("private_file_marker");
		expect(JSON.parse(text)).toMatchObject({ inbox: [], departments: [], companyFile: { mode: "governed" } });
	});

	it.each([
		["GET", "/api/inbox/gate-test.md"],
		["GET", "/api/authority"],
		["GET", "/api/authority/config"],
		["POST", "/api/authority"],
		["POST", "/api/authority/config"],
		["POST", "/api/gate"],
		["POST", "/api/inbox/respond"],
		["POST", "/api/artifact/update"],
	])("refuses the local %s %s route even with the host token", async (method, path) => {
		const response = await fetch(`${base}${path}`, {
			method,
			headers: { "x-qorpera-token": "host-token", "content-type": "application/json" },
			...(method === "POST"
				? { body: JSON.stringify({ content: "changed=true", file: "gate-test.md", action: "approved" }) }
				: {}),
		});
		expect(response.status).toBe(409);
		expect(await response.text()).toContain("live Company File editor");
		expect(readFileSync(join(root, "authority.toml"), "utf8")).toBe("private_file_marker = true\n");
		expect(readFileSync(join(root, "inbox", "gate-test.md"), "utf8")).toContain("status: pending");
		expect(artifactUpdate).not.toHaveBeenCalled();
	});
});
