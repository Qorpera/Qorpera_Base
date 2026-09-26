import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hostedFoundingOptions, protectedStripeTestKey } from "./founding-stripe-hosted.mjs";

test("hosted acceptance accepts only isolated native tools and explicit private payment paths", () => {
	const args = [
		"--bin",
		"/opt/pg/bin",
		"--tools",
		"/tmp/tools",
		"--out",
		"/tmp/evidence",
		"--stripe-cli",
		"/opt/stripe",
		"--stripe-key",
		"/private/test-key",
	];
	assert.equal(hostedFoundingOptions(args).stripeKey, "/private/test-key");
	for (const extra of [
		["--project-url", "https://production.invalid"],
		["--stripe-cli", "/another/stripe"],
		["--live-mode", "true"],
	])
		assert.throws(() => hostedFoundingOptions([...args, ...extra]));
	assert.throws(() => hostedFoundingOptions(args.slice(0, -2)));
	assert.throws(() => hostedFoundingOptions([...args.slice(0, -2), "--stripe-key", "/tmp/../private"]));
});

test("hosted acceptance refuses live keys, public files and symlink substitutions before provider access", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "founding-stripe-key-"));
	const key = join(root, "key");
	try {
		await writeFile(key, "sk_test_fixture", { mode: 0o600 });
		assert.equal(await protectedStripeTestKey(key), "sk_test_fixture");
		await chmod(key, 0o644);
		await assert.rejects(protectedStripeTestKey(key), /private/);
		await chmod(key, 0o600);
		await writeFile(key, "sk_live_fixture");
		await assert.rejects(protectedStripeTestKey(key), /test-mode/);
		await writeFile(key, "sk_test_fixture");
		await symlink(key, join(root, "alias"));
		await assert.rejects(protectedStripeTestKey(join(root, "alias")), /private/);
	} finally {
		await rm(root, { recursive: true });
	}
});
