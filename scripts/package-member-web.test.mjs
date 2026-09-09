import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { packageMemberWeb } from "./package-member-web.mjs";
import { assertMemberWebInputs } from "./check-headless-packages.mjs";
const config = { schema: "qorpera.member-web-config/v1", supabaseUrl: "https://control.test", publishableKey: "sb_publishable_fixture1", objectGatewayUrl: "https://objects.test", officeViewerOrigin: null };
test("standalone web package contains only hashed static assets and explicit public configuration", async () => {
	const scratch = await mkdtemp(join(tmpdir(), "qorpera-web-package-"));
	try {
		const out = join(scratch, "client"), manifest = await packageMemberWeb({ out, config });
		assert.equal(manifest.runtimeIncluded, false);
		for (const file of manifest.files) {
			const bytes = await readFile(join(out, file.path)); assert.equal(bytes.length, file.bytes); assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
		}
		assert.deepEqual(JSON.parse(await readFile(join(out, "config.json"), "utf8")), config);
		assert.match(await readFile(join(out, "_headers"), "utf8"), /frame-ancestors 'none'/);
		assert(!String(await readFile(join(out, "index.html"))).includes("__QORPERA_CSP__"));
		await assert.rejects(packageMemberWeb({ out, config }), /EEXIST/);
		await assert.rejects(packageMemberWeb({ out: join(scratch, "private"), config: { ...config, publishableKey: "sb_secret_do-not-ship" } }));
	} finally { await rm(scratch, { recursive: true, force: true }); }
});
test("browser artifact gate rejects runtime, desktop, Node adapters and external module imports", () => {
	for (const path of ["packages/runtime/src/authority.ts", "packages/shell/src/main.ts", "packages/cloud-client/src/node/transport.ts", "node_modules/electron/index.js", "packages/object-gateway/src/service.ts"]) assert.throws(() => assertMemberWebInputs({ inputs: { [path]: {} }, outputs: {} }));
	assert.throws(() => assertMemberWebInputs({ inputs: {}, outputs: { "app.js": { imports: [{ path: "node:fs", external: true }] } } }));
});
