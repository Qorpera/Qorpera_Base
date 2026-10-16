// deploy/code-host/test/export-code-host-image.sh against a stand-in LXD, image build, folder program build and proxy:
// what it exports, that one export runs at a time, and that a run removes only the build project it made. Nothing
// reaches LXD, Docker or the network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(root, "deploy/code-host/test/export-code-host-image.sh");
const BUILD = "qorpera-export-code-host-build";
const FOLDER_SHA256 = "e".repeat(64);

// The stand-in LXD: projects are directories and images files in $STUB_STATE; every call is logged. STUB_ON_DELETE
// acts right after a project is deleted: "second" runs a second export, "taken" makes a project of that name again.
const LXC = `#!/usr/bin/env bash
set -euo pipefail
S="$STUB_STATE"
echo "lxc $*" >> "$S/log"
args=()
while (($#)); do
	case "$1" in
		--project) shift 2;;
		*) args+=("$1"); shift;;
	esac
done
set -- "\${args[@]}"
case "$1 \${2:-}" in
	"storage get") echo "$S";;
	"network show") ;;
	"network get") echo 10.0.3.1/24;;
	"project create")
		if [[ -e $S/projects/$3 ]]; then echo "Error: Failed creating project \\"$3\\": already exists" >&2; exit 1; fi
		mkdir "$S/projects/$3";;
	"project show") [[ -d $S/projects/$3 ]];;
	"project delete")
		[[ -d $S/projects/$3 ]] || { echo "Error: Project not found" >&2; exit 1; }
		rm -r "$S/projects/$3"
		case "\${STUB_ON_DELETE:-}" in
			second)
				status=0
				STUB_ON_DELETE= bash "$STUB_SCRIPT" "$S/second-out" >"$S/second.out" 2>"$S/second.err" </dev/null || status=$?
				echo "$status" >"$S/second.status";;
			taken) mkdir "$S/projects/$3"; echo another >"$S/projects/$3/owner";;
		esac;;
	"list "*) ;;
	"image list") ;;
	"image info") [[ -f $S/images/$3 ]];;
	"image delete") rm "$S/images/$3";;
	"image export") cp "$S/images/$3" "$4.tar.zst";;
	*) echo "the stand-in has no lxc $*" >&2; exit 1;;
esac
`;

// The stand-in image build (<project> <network> <pool> <folder program>): it builds only in a project that is there,
// and publishes a unified image into the default store.
const BUILD_IMAGE = `#!/usr/bin/env bash
set -euo pipefail
S="$STUB_STATE"
lxc project show "$1" >/dev/null
[[ -z \${STUB_BUILD_FAILS:-} ]] || { echo "the stand-in build fails" >&2; exit 1; }
head -c 4096 /dev/urandom >"$S/image.new"
fingerprint=$(sha256sum "$S/image.new" | cut -d' ' -f1)
mv "$S/image.new" "$S/images/$fingerprint"
echo "published $fingerprint as qorpera-code-host" >&2
jq -n --arg fingerprint "$fingerprint" --arg folder "$(jq -r .sha256 "$(dirname "$0")/../folder-service/folder-program-linux-x64.json")" \\
	'{schema: "qorpera.code-host-image-build/v1", imageFingerprint: $fingerprint, folderProgramSha256: $folder}'
`;

const BUILD_FOLDER = `import { writeFileSync } from "node:fs";
writeFileSync(process.argv[process.argv.indexOf("--out") + 1], "folder program");
console.log(JSON.stringify({ sha256: "${FOLDER_SHA256}" }));
`;

// The test machine's own listing is the real host-state.sh's business; here a snapshot is only logged.
const HOST_STATE = `snapshot() { echo "snapshot $1" >>"$STUB_STATE/log"; }
compare() { return 0; }
`;

const BIN = {
	lxc: LXC,
	// The proxy: a port, then it waits to be stopped.
	setpriv: "#!/usr/bin/env bash\ncat >/dev/null\necho 3128\nexec sleep 600\n",
	df: "#!/usr/bin/env bash\necho Avail\necho 100\n",
	// The 15 seconds between the first two snapshots pass at once.
	sleep: '#!/usr/bin/env bash\n[[ $1 == 15 ]] && exit 0\nPATH=$(cut -d: -f2- <<<"$PATH")\nexec sleep "$@"\n',
	id: "#!/usr/bin/env bash\necho 0\n",
	hostname: "#!/usr/bin/env bash\necho qorpera-testvm-stand-in\n",
	docker: "#!/usr/bin/env bash\nexit 0\n",
	nft: "#!/usr/bin/env bash\nexit 0\n",
	python3: "#!/usr/bin/env bash\nexit 0\n",
	sysctl: "#!/usr/bin/env bash\nexit 0\n",
};

const LOCK_LINE = "LOCK_FILE=/run/lock/qorpera-export-code-host-image.lock\n";

// A tree with the script (its lock in the fixture) beside stand-ins for what it runs from the repository.
function setup() {
	const dir = mkdtempSync(join(tmpdir(), "export-code-host-image-"));
	const tree = join(dir, "tree");
	const bin = join(dir, "bin");
	const state = join(dir, "state");
	for (const path of [
		bin,
		join(state, "projects"),
		join(state, "images"),
		join(tree, "deploy/code-host/test"),
		join(tree, "deploy/coding-machine/test"),
		join(tree, "deploy/folder-service"),
		join(tree, "scripts"),
	]) {
		mkdirSync(path, { recursive: true });
	}
	for (const [name, text] of Object.entries(BIN)) {
		writeFileSync(join(bin, name), text);
		chmodSync(join(bin, name), 0o755);
	}
	const text = readFileSync(script, "utf8");
	assert.equal(text.split(LOCK_LINE).length, 2, "the lock's file is where the test expects it");
	const copy = join(tree, "deploy/code-host/test/export-code-host-image.sh");
	writeFileSync(copy, text.replace(LOCK_LINE, 'LOCK_FILE="$STUB_STATE/export.lock"\n'));
	writeFileSync(join(tree, "deploy/code-host/build-code-host-image.sh"), BUILD_IMAGE);
	writeFileSync(join(tree, "deploy/coding-machine/test/host-state.sh"), HOST_STATE);
	writeFileSync(join(tree, "deploy/coding-machine/test/proof-proxy.py"), "");
	writeFileSync(join(tree, "deploy/folder-service/folder-program-linux-x64.json"), JSON.stringify({ sha256: FOLDER_SHA256 }));
	writeFileSync(join(tree, "scripts/build-folder-program.mjs"), BUILD_FOLDER);
	writeFileSync(join(state, "log"), "");
	return { dir, bin, state, copy, out: join(dir, "out") };
}

function exportImage(fixture, env = {}) {
	const result = spawnSync("bash", [fixture.copy, fixture.out], {
		encoding: "utf8",
		timeout: 60_000,
		env: { PATH: `${fixture.bin}:${process.env.PATH}`, STUB_STATE: fixture.state, STUB_SCRIPT: fixture.copy, ...env },
	});
	const log = readFileSync(join(fixture.state, "log"), "utf8");
	return {
		...result,
		log,
		creates: log.split("\n").filter((line) => line === `lxc project create ${BUILD} -c features.images=true -c features.profiles=false`).length,
		deletes: log.split("\n").filter((line) => line === `lxc project delete ${BUILD}`).length,
		projects: readdirSync(join(fixture.state, "projects")),
		images: readdirSync(join(fixture.state, "images")),
	};
}

// bash 5 (empty arrays under set -u), GNU stat and df, flock and jq: the test machine's tools.
const linux = process.platform === "linux" || "needs the Linux tools a test machine has";

test("an export gives the image's files and its record, and leaves no project or image", { skip: linux === true ? false : linux }, () => {
	const fixture = setup();
	try {
		const result = exportImage(fixture);
		assert.equal(result.status, 0, result.stderr);
		const fingerprint = /^EXPORTED ([0-9a-f]{64}) into (.*)$/m.exec(result.stdout)?.[1];
		assert.ok(fingerprint, result.stdout);
		const image = readFileSync(join(fixture.out, "image.tar.zst"));
		assert.equal(createHash("sha256").update(image).digest("hex"), fingerprint);
		assert.deepEqual(JSON.parse(readFileSync(join(fixture.out, "code-host-image-export.json"), "utf8")), {
			schema: "qorpera.code-host-image-export/v1",
			imageFingerprint: fingerprint,
			folderProgramSha256: FOLDER_SHA256,
			files: [{ name: "image.tar.zst", bytes: image.length, sha256: fingerprint }],
		});
		assert.equal(JSON.parse(readFileSync(join(fixture.out, "code-host-image-build.json"), "utf8")).imageFingerprint, fingerprint);
		assert.deepEqual([result.creates, result.deletes], [1, 1]);
		assert.deepEqual(result.projects, []);
		assert.deepEqual(result.images, [], "the image left the default store");
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("a second export that starts during the first one's teardown stops at the lock and claims nothing", { skip: linux === true ? false : linux }, () => {
	const fixture = setup();
	try {
		const result = exportImage(fixture, { STUB_ON_DELETE: "second" });
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /^EXPORTED [0-9a-f]{64} into /m);
		const second = readFileSync(join(fixture.state, "second.err"), "utf8");
		assert.equal(readFileSync(join(fixture.state, "second.status"), "utf8").trim(), "1", second);
		assert.match(second, /FAIL: another code host image export runs here/);
		assert.equal(existsSync(join(fixture.state, "second-out")), false, "the second run made no <out dir>");
		assert.deepEqual([result.creates, result.deletes], [1, 1], "only the first run claimed and removed the project");
		assert.deepEqual(result.projects, []);
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("a project of that name made after the run deleted its own is not the run's: the run fails and leaves it", { skip: linux === true ? false : linux }, () => {
	const fixture = setup();
	try {
		const result = exportImage(fixture, { STUB_ON_DELETE: "taken" });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, new RegExp(`FAIL: an LXD project ${BUILD} is there again, not this run's`));
		assert.equal(result.deletes, 1, "the cleanup deleted nothing more");
		assert.equal(readFileSync(join(fixture.state, "projects", BUILD, "owner"), "utf8").trim(), "another");
		assert.equal(existsSync(fixture.out), false, "<out dir> is removed on failure");
		assert.deepEqual(result.images, []);
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("a failed build removes its project and <out dir>", { skip: linux === true ? false : linux }, () => {
	const fixture = setup();
	try {
		const result = exportImage(fixture, { STUB_BUILD_FAILS: "1" });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /FAIL: the build or the export failed/);
		assert.deepEqual([result.creates, result.deletes], [1, 1]);
		assert.deepEqual(result.projects, []);
		assert.equal(existsSync(fixture.out), false);
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});
