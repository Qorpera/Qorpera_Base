// The kit as a machine gets it: `git archive` of deploy/company-data/kit leaves out the drill and its platform
// stand-in (.gitattributes export-ignore) and keeps everything a machine runs. The test machine's copy of the
// repository is no git repository, so the kit is committed into a throwaway one here.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const kit = dirname(fileURLToPath(import.meta.url));
const KIT = "deploy/company-data/kit";

test("an archive of the kit holds what a machine runs and never the drill", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "qorpera-company-data-kit-test-"));
	try {
		await cp(kit, join(temporary, KIT), { recursive: true, filter: (source) => !source.endsWith("/.env") });
		const git = (...args) =>
			execFileSync("git", ["-c", "user.name=kit-test", "-c", "user.email=kit-test@example.invalid", "-c", "commit.gpgsign=false", ...args], {
				cwd: temporary,
				encoding: "utf8",
			});
		git("init", "-q");
		git("add", KIT);
		git("commit", "-q", "-m", "kit");
		const tracked = git("ls-files", KIT).trim().split("\n");
		assert.ok(tracked.includes(`${KIT}/drill.mjs`) && tracked.includes(`${KIT}/drill/platform-standin.mjs`), "the drill is in the repository");
		const archived = execFileSync("tar", ["-t"], { input: execFileSync("git", ["archive", "HEAD", KIT], { cwd: temporary }), encoding: "utf8" })
			.trim()
			.split("\n")
			.filter((path) => !path.endsWith("/"));
		for (const path of archived) assert.doesNotMatch(path, /\/drill(\.mjs|\/)|kit\.test\.mjs$/, path);
		for (const file of ["docker-compose.yml", "replication.yml", "gateway-main.mjs", "lib.sh", "tls.sh", "init.sh", "base-backup.sh", "restore.sh", "standby.sh", "README.md",
			"postgres/postgresql.conf", "postgres/pg_hba.conf", "postgres/pg_ident.conf", "postgres/archive-wal.sh", "postgres/restore-wal.sh"])
			assert.ok(archived.includes(`${KIT}/${file}`), `${file} is in the archive`);
		assert.equal(archived.length, tracked.length - 4, archived.join(" "));
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});
