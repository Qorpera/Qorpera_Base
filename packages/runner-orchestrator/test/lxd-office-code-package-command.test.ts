import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLxdOfficeCodePackageCommand } from "../src/lxd-office-code-package-command.ts";
import { lxdOfficeGuestPlan } from "../src/lxd-office-guest.ts";
import { officePhysicalFixture } from "./fixtures/office-physical-policy.ts";

const roots: string[] = [],
	signal = () => new AbortController().signal,
	id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "package-command-")));
	roots.push(root);
	const binding = officePhysicalFixture().binding,
		command = {
			provisionId: id(1),
			commandId: id(2),
			purpose: "bootstrap" as const,
			pin: { bytes: 123, sha256: "a".repeat(64) },
			args: ["preflight", "a".repeat(64), "b".repeat(64), id(3)],
			packetSha256: "a".repeat(64),
		},
		reference = {
			project: binding.project,
			instanceName: lxdOfficeGuestPlan(binding).request.name,
			operationId: id(4),
		},
		client = {
			submitOfficeCodePackageTool: vi.fn(async () => reference),
			inspectOfficeCodePackageTool: vi.fn(async () => "succeeded" as const),
		},
		authorize = vi.fn(async () => {});
	const run = () => runLxdOfficeCodePackageCommand(root, binding, command, client, signal(), authorize);
	return { root, binding, command, reference, client, authorize, run };
}
describe("one-dispatch code package journal", () => {
	it("records exactly one command and uses retained completion after LXD expiry", async () => {
		const f = await fixture();
		expect(await f.run()).toEqual({ state: "succeeded", reference: f.reference });
		f.client.inspectOfficeCodePackageTool.mockRejectedValue(new Error("expired"));
		expect((await f.run()).state).toBe("succeeded");
		expect(f.client.submitOfficeCodePackageTool).toHaveBeenCalledOnce();
		expect(f.authorize).toHaveBeenCalledOnce();
	});
	it("keeps lost submit replies unknown without calling SQL authorization or installation again", async () => {
		const f = await fixture();
		f.client.submitOfficeCodePackageTool.mockRejectedValue(new Error("lost reply"));
		await expect(f.run()).rejects.toThrow("lost reply");
		expect(await f.run()).toEqual({ state: "unknown" });
		expect(f.client.submitOfficeCodePackageTool).toHaveBeenCalledOnce();
		expect(f.authorize).toHaveBeenCalledOnce();
	});
	it("leaves failed authorization fenced before guest dispatch", async () => {
		const f = await fixture();
		f.authorize.mockRejectedValue(new Error("expired"));
		await expect(f.run()).rejects.toThrow("expired");
		expect(await f.run()).toEqual({ state: "unknown" });
		expect(f.client.submitOfficeCodePackageTool).not.toHaveBeenCalled();
	});
	it("does not accept a conflicting packet for the same planned command", async () => {
		const f = await fixture();
		await f.run();
		f.command.packetSha256 = "d".repeat(64);
		await expect(f.run()).rejects.toThrow("COMMAND_CONFLICT");
		expect(f.client.submitOfficeCodePackageTool).toHaveBeenCalledOnce();
	});
	it("rejects missing dispatch with retained acceptance rather than repairing history", async () => {
		const f = await fixture();
		await f.run();
		await rm(join(f.root, `code-package-command-${f.command.provisionId}-${f.command.commandId}.json`));
		await expect(f.run()).rejects.toThrow("COMMAND_UNCONFIRMED");
		expect(f.client.submitOfficeCodePackageTool).toHaveBeenCalledOnce();
	});
	it("retains acceptance even when cancellation arrives with the provider reply", async () => {
		const f = await fixture(),
			controller = new AbortController();
		f.client.submitOfficeCodePackageTool.mockImplementation(async () => {
			controller.abort();
			return f.reference;
		});
		await expect(
			runLxdOfficeCodePackageCommand(f.root, f.binding, f.command, f.client, controller.signal, f.authorize),
		).rejects.toThrow();
		expect((await f.run()).state).toBe("succeeded");
		expect(f.client.submitOfficeCodePackageTool).toHaveBeenCalledOnce();
	});
	it("rejects altered accepted operation identity", async () => {
		const f = await fixture();
		await f.run();
		const path = join(f.root, `code-package-command-${f.command.provisionId}-${f.command.commandId}-accepted.json`),
			record = JSON.parse(await readFile(path, "utf8"));
		record.reference.instanceName = "another-office";
		await writeFile(path, JSON.stringify(record));
		await expect(f.run()).rejects.toThrow("REFERENCE_UNCONFIRMED");
		expect(f.client.submitOfficeCodePackageTool).toHaveBeenCalledOnce();
	});
});
