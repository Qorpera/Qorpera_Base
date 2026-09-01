import { describe, expect, it } from "vitest";
import { runNativeCodexCompactionProbe } from "./fixtures/native-codex-compaction-probe.ts";

const binary = process.env.QORPERA_CODEX_FENCE_BINARY;
describe.skipIf(!binary)("pinned native compaction trust boundary", () => {
	it.each(["local", "remote", "remote-v2"] as const)(
		"fences %s compaction and restores runtime laws",
		async (mode) => {
			if (!binary) throw new Error("Missing pinned native binary");
			expect(await runNativeCodexCompactionProbe(binary, mode)).toMatchObject({
				compactions: 1,
				modelRequests: 4,
				fencedCompactionOutputs: 2,
				readEffects: 1,
				writeEffects: 1,
				revoked: false,
				resumedWithLaws: true,
			});
		},
		30_000,
	);

	it.each(["local", "remote", "remote-v2"] as const)(
		"does not revive revoked authority after %s compaction",
		async (mode) => {
			if (!binary) throw new Error("Missing pinned native binary");
			expect(await runNativeCodexCompactionProbe(binary, mode, true)).toMatchObject({
				compactions: 1,
				modelRequests: 2,
				readEffects: 1,
				writeEffects: 0,
				revoked: true,
				resumedWithLaws: false,
			});
		},
		30_000,
	);
});
