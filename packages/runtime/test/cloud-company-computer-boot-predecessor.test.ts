import { afterEach, describe, expect, it, vi } from "vitest";
import {
	bootFixtureEncode as encode,
	bootFixtureHash as hash,
} from "./fixtures/company-computer-boot-configuration.ts";
import { laterBootConfigurationFixture } from "./fixtures/company-computer-later-boot-configuration.ts";

const mocked = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../src/cloud-company-computer-stop-history.ts", () => ({ readCompanyComputerStopHistory: mocked.read }));

import { verifyCompanyComputerBootPredecessor } from "../src/cloud-company-computer-boot-predecessor.ts";

afterEach(() => vi.resetAllMocks());
/** Layout version 2 (the production office) adds the company root to every
 * retained receipt a later boot rereads from the previous boot. */
const layoutV2 = {
	layoutVersion: 2 as const,
	entries: [".", "company", "desktop", "profiles", "screens", "workbench"].map((path) => ({
		path,
		kind: "directory" as const,
		mode: 0o700,
		bytes: 0,
		sha256: null,
	})),
};
function fixture(restarts = 2, layoutVersion: 1 | 2 = 1) {
	const f = laterBootConfigurationFixture({ restarts, ...(layoutVersion === 2 ? { original: layoutV2 } : {}) }),
		reads: string[] = [];
	mocked.read.mockImplementation(async () => ({
		manifest: f.manifest,
		manifestSha256: hash(encode(f.manifest)),
		files: new Map([...f.sources].map(([path, file]) => [path, Buffer.from(file.bytes)])),
	}));
	const run = () =>
		verifyCompanyComputerBootPredecessor(
			{
				command: f.command,
				intent: f.input.bootIntent.request,
				original: f.original,
				originPreparationSha256: f.input.originPreparationSha256,
				originReceipt: encode(f.originReceipt),
				originalConfiguration: f.originFiles.get("/etc/qorpera-office/credentials/config.json")!.bytes,
			},
			async (path, limit, mode) => {
				reads.push(path);
				const file = f.originFiles.get(path);
				if (!file || file.mode !== mode || file.bytes.length > limit) throw new Error("custody");
				return Buffer.from(file.bytes);
			},
			new AbortController().signal,
		);
	return { ...f, reads, run };
}
describe("retained boot predecessor for subsequent VM configuration", () => {
	it.each([0, 1, 2])(
		"verifies a completed later boot after %s service restarts without prior /run reads",
		async (restarts) => {
			const f = fixture(restarts);
			await f.run();
			expect(f.reads).toHaveLength(4);
			expect(f.reads.every((path) => path.startsWith(f.previous.directory))).toBe(true);
		},
	);
	it("verifies a later boot of a layout version 2 office: the previous boot's receipt carries the company root", async () => {
		const f = fixture(1, 2);
		expect(f.originReceipt.layout).toHaveProperty("companyRoot");
		expect(f.previous.receipt.layout).toEqual(f.originReceipt.layout);
		await f.run();
		expect(f.reads).toHaveLength(4);
	});
	it.each([
		"configuration",
		"receipt",
		"configurationClaim",
		"start",
		"restart",
		"predecessorStop",
		"inspection",
		"persistent",
		"mode",
	])("refuses changed %s", async (fault) => {
		const f = fixture();
		const path =
			fault === "configuration"
				? `${f.previous.directory}/credentials/config.json`
				: fault === "receipt"
					? `${f.previous.directory}/adoption.json`
					: fault === "configurationClaim"
						? `${f.previous.directory}/configuration-claim.json`
						: fault === "start"
							? "/run/qorpera-office-preparation/boot-service-start-completion.json"
							: fault === "restart"
								? `/run/qorpera-office-preparation/boot-service-restart-completion-${f.selected.activationId}.json`
								: fault === "predecessorStop"
									? `/run/qorpera-office-preparation/service-stop-completion-00000000-0000-4000-8000-000000000410.json`
									: [...f.sources.keys()].find((path) =>
											path.includes("service-stop-inspection-00000000-0000-4000-8000-000000000423"),
										)!;
		if (fault === "persistent") f.originFiles.get(`${f.previous.directory}/adoption.json`)!.bytes = encode({});
		else if (fault === "mode") f.originFiles.get(`${f.previous.directory}/configuration-claim.json`)!.mode = 0o444;
		else f.sources.get(path)!.bytes = encode({});
		await expect(f.run()).rejects.toThrow();
	});
});
