import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Step2SecretCanaryLedger, step2SecretCanaryReflection } from "../src/cloud-secret-canary-destination.ts";

const paths: string[] = [];
afterEach(async () => {
	for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});

it("durably deduplicates one effect across a destination restart without persisting its operation key", async () => {
	const directory = await mkdtemp(join(tmpdir(), "qorpera-step2-secret-canary-"));
	paths.push(directory);
	const path = join(directory, "effects.json");
	const operationKey = "effect-lost-response-41";
	const first = await Step2SecretCanaryLedger.open(path);
	const created = await first.admit(operationKey, "lost-response", "drop_once");
	expect(created.reused).toBe(false);
	const recovered = await Step2SecretCanaryLedger.open(path);
	await expect(recovered.admit(operationKey, "lost-response", "drop_once")).resolves.toEqual({
		effectId: created.effectId,
		reused: true,
	});
	const encoded = await readFile(path, "utf8");
	expect(encoded).not.toContain(operationKey);
	expect(encoded).toContain(createHash("sha256").update(operationKey).digest("hex"));
	await expect(recovered.admit(operationKey, "different", "drop_once")).rejects.toThrow("differs");
});

it("constructs each deliberate reflected encoding without retaining a copy in destination state", () => {
	const credential = randomBytes(32);
	const text = credential.toString("base64url");
	expect(step2SecretCanaryReflection(Buffer.from(text), "reflect_raw")).toBe(text);
	expect(step2SecretCanaryReflection(Buffer.from(text), "reflect_url")).toBe(encodeURIComponent(text));
	expect(step2SecretCanaryReflection(Buffer.from(text), "reflect_base64")).toBe(Buffer.from(text).toString("base64"));
	expect(step2SecretCanaryReflection(Buffer.from(text), "reflect_base64url")).toBe(
		Buffer.from(text).toString("base64url"),
	);
	expect(step2SecretCanaryReflection(Buffer.from(text), "safe")).toBeUndefined();
	credential.fill(0);
});
