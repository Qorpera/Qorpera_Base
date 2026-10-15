import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertGuest, assertTarget, credentialProbeSource, parseArgs } from "./test-office-folder-substrate.mjs";

const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const digest = "a".repeat(64);
const argv = ["--project", `qorpera-substrate-${uuid}`, "--vm", `qorpera-substrate-${uuid}`, "--uuid", uuid, "--image", digest, "--image-kind", "prepared-substrate", "--folder-binary", "/tmp/pinned-folder", "--folder-sha256", digest, "--record", "/tmp/record.json"];
const options = parseArgs(argv);
const instance = { name: options.vm, type: "virtual-machine", status: "Running", config: { "user.qorpera.acceptance": "office-folder-substrate", "volatile.uuid": uuid, "volatile.base_image": digest } };
const guest = { boot: uuid, container: false, virtualization: "kvm", unitSha256: digest, officeState: "inactive", hasCredentials: false };

test("preflight is default; execution and image provenance must be explicit", () => {
	assert.equal(options.execute, false);
	assert.equal(options["image-kind"], "prepared-substrate");
	assert.equal(options["owner-mode"], "root-default");
	assert.equal(parseArgs([...argv, "--owner-mode", "office-account"])["owner-mode"], "office-account");
	assert.equal(parseArgs([...argv, "--execute"]).execute, true);
	assert.doesNotThrow(() => assertTarget(instance, options));
	assert.doesNotThrow(() => assertGuest(guest, "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee", digest));
});

test("reject ambiguous, incomplete or unsafe CLI targets before LXD is called", () => {
	for (const extra of [["--execute", "--execute"], ["--unexpected"], ["--vm", "another"], ["--record"], ["--owner-mode", "root"], ["--owner-mode"], ["--owner-mode", "office-account", "--owner-mode", "root-default"]]) assert.throws(() => parseArgs([...argv, ...extra]));
	for (const [flag, value] of [["--vm", "production"], ["--project", "remote:project"], ["--uuid", "prefix"], ["--image", "short-digest"], ["--folder-sha256", "short-digest"], ["--image-kind", "unknown"], ["--folder-binary", "--execute"]]) {
		const changed = [...argv];
		changed[changed.indexOf(flag) + 1] = value;
		assert.throws(() => parseArgs(changed), flag);
	}
});

test("refuse container, stopped VM, missing marker or identity/image drift", () => {
	for (const field of [{ name: "other" }, { type: "container" }, { status: "Stopped" }, { config: {} }, { config: { ...instance.config, "volatile.uuid": "different" } }, { config: { ...instance.config, "volatile.base_image": "b".repeat(64) } }]) assert.throws(() => assertTarget({ ...instance, ...field }, options));
});

test("refuse shared kernel, unknown virtualization, active office and credentials", () => {
	assert.throws(() => assertGuest(guest, uuid, digest));
	for (const field of [{ boot: "" }, { container: true }, { container: undefined }, { virtualization: "none" }, { unitSha256: "different" }, { officeState: "active" }, { officeState: "activating" }, { officeState: "deactivating" }, { officeState: undefined }, { hasCredentials: true }, { hasCredentials: undefined }]) assert.throws(() => assertGuest({ ...guest, ...field }, "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee", digest));
});

test("synthetic node handles real wire framing and closes persisted writes without privilege", () => {
	const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/office-folder-substrate.py");
	const result = JSON.parse(execFileSync("python3", [fixture, "selftest"], { encoding: "utf8", timeout: 15_000 }));
	assert.deepEqual(result, { wireFixture: "passed", privilegedProof: "not-run" });
});

test("preflight finds boot and legacy credentials, and refuses credential symlinks", () => {
	const directory = mkdtempSync(join(tmpdir(), "qorpera-substrate-credentials-"));
	const legacy = join(directory, "credentials");
	const boot = join(directory, "boots", uuid, "credentials");
	const probe = () => JSON.parse(execFileSync("python3", ["-c", `import json,pathlib,sys\n${credentialProbeSource}\nprint(json.dumps(has_credentials(pathlib.Path(sys.argv[1]))))`, directory], { encoding: "utf8", timeout: 5000 }));
	try {
		assert.equal(probe(), false);
		mkdirSync(legacy);
		mkdirSync(boot, { recursive: true });
		assert.equal(probe(), false);
		writeFileSync(join(legacy, "config.json"), "synthetic");
		assert.equal(probe(), true);
		rmSync(join(legacy, "config.json"));
		writeFileSync(join(boot, "native"), "synthetic");
		assert.equal(probe(), true);
		rmSync(join(boot, "native"));
		rmSync(legacy, { recursive: true });
		symlinkSync("missing-target", legacy);
		assert.equal(probe(), true);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
