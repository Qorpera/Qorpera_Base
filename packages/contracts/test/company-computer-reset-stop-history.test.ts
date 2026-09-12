import { describe, expect, it } from "vitest";
import { companyComputerBootDirectory, parseCompanyComputerStopHistoryManifest } from "../src/index.ts";

const bootId = "00000000-0000-4000-8000-000000000001";
const activationId = "00000000-0000-4000-8000-000000000002";
const completionPath = `/run/qorpera-office-preparation/service-stop-completion-${activationId}.json`;
const manifest = (path: string) => ({
	schema: "qorpera.office-stop-history/v1",
	command: { commandId: "00000000-0000-4000-8000-000000000003", bootId, requestSha256: "1".repeat(64) },
	activationId,
	completionPath,
	entries: [path, completionPath].sort().map((path) => ({ path, bytes: 1, sha256: "2".repeat(64), mode: 0o600 })),
});
describe("reset stop history public paths", () => {
	it.each(["reset-configuration-claim.json", "reset-configuration-completion.json"])(
		"retains %s only for the exact stopped boot",
		(file) => {
			const value = manifest(`${companyComputerBootDirectory(bootId)}/${file}`);
			expect(parseCompanyComputerStopHistoryManifest(value, bootId, activationId)).toEqual(value);
			expect(() =>
				parseCompanyComputerStopHistoryManifest(
					manifest(`${companyComputerBootDirectory(activationId)}/${file}`),
					bootId,
					activationId,
				),
			).toThrow();
		},
	);
	it.each([
		"credentials/native-key.pem",
		"credentials/cloud-token.json",
		"reset-configuration-request.json",
		"../reset-configuration-claim.json",
	])("refuses nonpublic path %s", (file) => {
		expect(() =>
			parseCompanyComputerStopHistoryManifest(
				manifest(`${companyComputerBootDirectory(bootId)}/${file}`),
				bootId,
				activationId,
			),
		).toThrow();
	});
});
