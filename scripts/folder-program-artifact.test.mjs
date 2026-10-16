import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { folderProgramSourceSha256, readFolderProgramRecord } from "./folder-program-artifact.mjs";
import { RUST_IMAGE } from "./run-on-node-plan.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("the folder program's build record names today's source, the pinned image and the installers' pins", () => {
	const record = readFolderProgramRecord();
	assert.equal(
		record.sourceSha256,
		folderProgramSourceSha256(),
		"crates/qorpera-folder changed: build it with scripts/build-folder-program.mjs and commit the record it prints, then re-pin EXPECTED_FOLDER_PROGRAM_SHA256",
	);
	assert.equal(record.image, RUST_IMAGE);
	const installer = readFileSync(join(repositoryRoot, "deploy/shared-execution/install-shared-execution-guest.sh"), "utf-8");
	assert.ok(installer.includes(`EXPECTED_FOLDER_PROGRAM_SHA256="${record.sha256}"`));
	// The company machine image (F3 step 6c) installs the same build.
	const machineImage = readFileSync(join(repositoryRoot, "deploy/machine/build-machine-image.sh"), "utf-8");
	assert.ok(machineImage.includes(`EXPECTED_FOLDER_PROGRAM_SHA256="${record.sha256}"`));
});
