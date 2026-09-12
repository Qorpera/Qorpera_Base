import { describe, expect, it } from "vitest";
import { readCompanyComputerStopInvocation } from "../src/cloud-company-computer-stop-invocation.ts";
import { bootFixtureId as id } from "./fixtures/company-computer-boot-configuration.ts";
import { resetInvocationFixture } from "./fixtures/company-computer-reset-invocation.ts";

function fixture() {
	const f = resetInvocationFixture(),
		reads: string[] = [];
	const read = async (path: string, limit: number, mode: number) => {
		reads.push(path);
		const file = f.files.get(path);
		if (!file) throw Object.assign(new Error("missing"), { code: "ENOENT" });
		expect(file.mode).toBe(mode);
		expect(file.bytes.length).toBeLessThanOrEqual(limit);
		return Buffer.from(file.bytes);
	};
	return {
		...f,
		read,
		reads,
		select: (activation = f.activationId, boot = f.bootId) =>
			readCompanyComputerStopInvocation(activation, boot, read),
	};
}

describe("reset-born invocation selection", () => {
	it("selects exact public reset evidence for measurement and stop without replaying preparation or reading secrets", async () => {
		const f = fixture(),
			result = await f.select();
		expect(result.kind).toBe("reset");
		expect(result.start).toEqual(f.start);
		expect(result.request).toEqual(f.request);
		expect(result.configurationPath).toBe(`${f.directory}/credentials/config.json`);
		expect(result.stopPaths.completion).toContain(f.activationId);
		expect(
			f.reads.some((path) => /credentials|workbench|preparation\.json|reset-configuration-incoming/.test(path)),
		).toBe(false);
	});
	it.each(["completion", "claim", "packet", "configuration", "configurationClaim", "receipt"] as const)(
		"refuses missing %s without selecting a different lineage",
		async (key) => {
			const f = fixture();
			f.files.delete(f.paths[key]);
			await expect(f.select()).rejects.toThrow();
		},
	);
	it.each(["completion", "claim", "packet", "configuration", "configurationClaim", "receipt"] as const)(
		"refuses altered %s",
		async (key) => {
			const f = fixture();
			const file = f.files.get(f.paths[key])!;
			file.bytes = Buffer.from("{}\n");
			await expect(f.select()).rejects.toThrow();
		},
	);
	it.each([
		"service-start-completion.json",
		"service-start-claim.json",
		"boot-service-start-completion.json",
		"boot-service-start-claim.json",
	])("refuses mixed lineage %s", async (name) => {
		const f = fixture();
		f.put(`/run/qorpera-office-preparation/${name}`, {});
		await expect(f.select()).rejects.toThrow("ambiguous reset");
	});
	it("refuses another activation and another boot", async () => {
		await expect(fixture().select(id(799))).rejects.toThrow();
		await expect(fixture().select(undefined, id(798))).rejects.toThrow();
	});
	it("keeps protected-read failures distinct from absence", async () => {
		const f = fixture();
		await expect(
			readCompanyComputerStopInvocation(f.activationId, f.bootId, async () => {
				throw Object.assign(new Error("custody changed"), { code: "EACCES" });
			}),
		).rejects.toThrow("custody changed");
	});
});
