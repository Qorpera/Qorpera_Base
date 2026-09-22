import { describe, expect, it } from "vitest";
import { runNativeCodexCompactionProbe } from "./fixtures/native-codex-compaction-probe.ts";
import { runNativeCodexFenceFailureProbe } from "./fixtures/native-codex-fence-failure-probe.ts";

const binary = process.env.QORPERA_CODEX_FENCE_BINARY;
const cases = (["offline-probe", "provider-default"] as const).flatMap((model) =>
	(["local", "remote-v2"] as const).map((mode) => ({ model, mode })),
);
describe.skipIf(!binary)("native capture pixels with the source-built artifact", () => {
	it.each(["message_image"] as const)(
		"rejects unissued %s outside tool results",
		async (fault) => {
			if (!binary) throw new Error("Missing source-built native artifact");
			expect(await runNativeCodexFenceFailureProbe(binary, fault)).toMatchObject({
				fault,
				requests: 1,
				effects: 0,
				deniedChecks: 0,
				blocked: true,
			});
		},
		20_000,
	);
	it.each(cases)(
		"preserves authorized pixels through $mode compaction ($model)",
		async ({ mode, model }) => {
			if (!binary) throw new Error("Missing source-built native artifact");
			expect(await runNativeCodexCompactionProbe(binary, mode, false, model, true)).toEqual({
				mode,
				compactions: 1,
				modelRequests: 4,
				fencedCompactionOutputs: 2,
				fencedCompactionImages: 1,
				readEffects: 1,
				writeEffects: 1,
				revoked: false,
				resumedWithLaws: true,
			});
		},
		30_000,
	);
	it.each(cases)(
		"stops after capture revocation during $mode compaction while the run remains active ($model)",
		async ({ mode, model }) => {
			if (!binary) throw new Error("Missing source-built native artifact");
			expect(await runNativeCodexCompactionProbe(binary, mode, true, model, true)).toEqual({
				mode,
				compactions: 1,
				modelRequests: 2,
				fencedCompactionOutputs: 2,
				fencedCompactionImages: 1,
				readEffects: 1,
				writeEffects: 0,
				revoked: true,
				resumedWithLaws: false,
			});
		},
		30_000,
	);
});
