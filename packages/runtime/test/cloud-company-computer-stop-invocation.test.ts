import { describe, expect, it } from "vitest";
import { readCompanyComputerStopInvocation } from "../src/cloud-company-computer-stop-invocation.ts";
import { bootFixtureEncode as encode, bootFixtureId as id } from "./fixtures/company-computer-boot-configuration.ts";
import { bootServiceStopFixture } from "./fixtures/company-computer-boot-service-stop.ts";

const root = "/run/qorpera-office-preparation";
function fixture() {
	const f = bootServiceStopFixture(),
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
		reads,
		read,
		select: (activation = f.startCompletion.activationId, boot = f.startCommand.bootId) =>
			readCompanyComputerStopInvocation(activation, boot, read),
	};
}
describe("stop evidence after retained boot activation", () => {
	it("selects the actual new schema and public paths without credentials, preparation or mutable workbench reads", async () => {
		const f = fixture(),
			result = await f.select();
		expect(result.kind).toBe("boot");
		expect(result.start).toEqual(f.startCompletion);
		expect(result.request).toEqual(f.request);
		expect(result.adoptionPath).toBe(`${f.directory}/adoption.json`);
		expect(result.configurationPath).toBe(`${f.directory}/credentials/config.json`);
		expect(result.stopPaths.completion).toBe(
			`${root}/service-stop-completion-${f.startCompletion.activationId}.json`,
		);
		expect(
			f.reads.some((path) => /credentials|workbench|preparation\.json|boot-configuration-incoming/.test(path)),
		).toBe(false);
	});
	it.each(["completion", "claim", "receipt", "config-completion", "config-claim", "packet"])(
		"refuses a missing %s without falling back to original activation history",
		async (fault) => {
			const f = fixture();
			const paths = {
				completion: `${root}/boot-service-start-completion.json`,
				claim: `${root}/boot-service-start-claim.json`,
				receipt: `${f.directory}/adoption.json`,
				"config-completion": `${f.directory}/configuration-completion.json`,
				"config-claim": `${f.directory}/configuration-claim.json`,
				packet: `${root}/boot-service-start-incoming-${f.startCommand.requestSha256}.json`,
			};
			f.files.delete(paths[fault as keyof typeof paths]);
			await expect(f.select()).rejects.toThrow();
			expect(f.reads.some((path) => path.includes("/service-start-incoming-"))).toBe(false);
		},
	);
	it.each([
		"completion",
		"claim",
		"receipt",
		"config-completion",
		"config-claim",
		"packet",
		"ambiguous-original",
		"activation",
		"boot",
	])("refuses mismatched %s", async (fault) => {
		const f = fixture();
		if (fault === "completion")
			f.files.get(`${root}/boot-service-start-completion.json`)!.bytes = encode({
				...f.startCompletion,
				activationId: id(900),
			});
		if (fault === "claim") f.files.get(`${root}/boot-service-start-claim.json`)!.bytes = encode({});
		if (fault === "receipt")
			f.files.get(`${f.directory}/adoption.json`)!.bytes = encode({
				...f.receipt,
				bootObservationSha256: "e".repeat(64),
			});
		if (fault === "config-completion")
			f.files.get(`${f.directory}/configuration-completion.json`)!.bytes = encode({
				...f.completion,
				activationId: id(900),
			});
		if (fault === "config-claim") f.files.get(`${f.directory}/configuration-claim.json`)!.bytes = encode({});
		if (fault === "packet")
			f.files.get(`${root}/boot-service-start-incoming-${f.startCommand.requestSha256}.json`)!.bytes = encode({});
		if (fault === "ambiguous-original")
			f.files.set(`${root}/service-start-completion.json`, { bytes: encode({}), mode: 0o600 });
		await expect(
			f.select(fault === "activation" ? id(900) : undefined, fault === "boot" ? id(900) : undefined),
		).rejects.toThrow();
	});
	it("does not interpret a custody error as absence", async () => {
		const f = fixture();
		await expect(
			readCompanyComputerStopInvocation(f.startCompletion.activationId, f.startCommand.bootId, async () => {
				throw Object.assign(new Error("custody"), { code: "EACCES" });
			}),
		).rejects.toThrow("custody");
	});
});
