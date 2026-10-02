import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseFeedPage, parseListPage, parseViewRenewal } from "../packages/object-gateway/src/folder-service/core.ts";
import { ViewTree } from "../packages/object-gateway/src/folder-service/view-tree.ts";
import { expandTestFixture } from "./test-hosted-db.mjs";
import { hostedDatabase } from "./test-hosted-db-cluster.mjs";

/** The folder service reads the folder core's list and feed answers with its own parsers
 * (packages/object-gateway/src/folder-service/core.ts). Here the real functions answer: the feed test's company and
 * history (supabase/tests/636_folder_core_feed.test.sql, its own fixture up to the history's end), then list and
 * feed pages as JSON, parsed exactly as the service parses them. The tree built from a listing and caught up from the
 * feed must equal a fresh listing, so the service's handling of every operation (write, mkdir, move_out, move_in,
 * delete) is checked against the core's own output. */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV = "63000000-0000-4000-8000-000000000020";
const databaseName = "qorpera_folder_shapes";

function feedSql() {
	const read = (name) => readFileSync(join(root, "supabase/tests", name), "utf8");
	const fixture = expandTestFixture("636_folder_core_feed.test.sql", read);
	const end = fixture.indexOf("-- The platform sees everything");
	if (end < 0) throw new Error("The feed test's history ended elsewhere: update this script");
	const call = (label, sql) => `select '@@shape-${label} ' || (${sql})::text;\n`;
	const platform = `'{"kind":"platform"}'::jsonb`;
	const member = `'{"kind":"member","userId":"63000000-0000-4000-8000-000000000004"}'::jsonb`;
	return (
		`\\pset format unaligned\n\\pset tuples_only on\n${fixture.slice(0, end)}\n` +
		// The listing at seq 0 is empty, so list the history first page by page, the way the service does.
		call("list", `public.qorpera_folder_list('${ENV}', ${platform}, '', null, 1000, true)`) +
		call("list-page-1", `public.qorpera_folder_list('${ENV}', ${platform}, '', null, 3, true)`) +
		call("list-member", `public.qorpera_folder_list('${ENV}', ${member}, '', null, 1000, true)`) +
		call("feed", `public.qorpera_folder_feed('${ENV}', ${platform}, 0, 1000, null)`) +
		call("feed-member", `public.qorpera_folder_feed('${ENV}', ${member}, 0, 1000, null)`) +
		// Seq 3 holds 26 changes: a page of 5 from seq 2 stops inside it, with a cursor.
		call("feed-cursor", `public.qorpera_folder_feed('${ENV}', ${platform}, 2, 5, null)`) +
		call("feed-resync", `public.qorpera_folder_feed('${ENV}', ${platform}, 99, 10, null)`) +
		"rollback;\n"
	);
}

/** A run's box (F3 step 2): the views test's company (639 on 632), a leased run of agent A, its run box view, and
 * what the folder service calls with it: list and feed as the view actor, renew, then close. */
function boxSql() {
	const read = (name) => readFileSync(join(root, "supabase/tests", name), "utf8");
	const fixture = expandTestFixture("639_folder_core_views.test.sql", read);
	const end = fixture.indexOf("-- A run box: opened by its run");
	if (end < 0) throw new Error("The views test's run box section moved: update this script");
	const env = "63200000-0000-4000-8000-000000000020";
	const call = (label, sql) => `select '@@shape-${label} ' || (${sql})::text;\n`;
	const box = "(select b from shape_box)";
	const actor = `pg_temp.vactor(${box})`;
	const id = `(${box} ->> 'viewId')::uuid`;
	const pass = `${box} ->> 'pass'`;
	return (
		`\\pset format unaligned\n\\pset tuples_only on\n${fixture.slice(0, end)}\n` +
		`create temp table shape_box as select public.qorpera_folder_view_open('${env}', r, 'run_box', '{}') as b
			from (select pg_temp.run('human', '63200000-0000-4000-8000-000000000002') as r) x;\n` +
		`create function pg_temp.box_list_refused() returns text language plpgsql as $$
		begin
			perform public.qorpera_folder_list('${env}', ${actor}, '', null, 10, true);
			return 'served';
		exception when insufficient_privilege then return 'refused';
		end $$;\n` +
		call("box-open", box) +
		call("box-list", `public.qorpera_folder_list('${env}', ${actor}, '', null, 1000, true)`) +
		call("box-feed", `public.qorpera_folder_feed('${env}', ${actor}, 0, 1000, null)`) +
		call("box-renew", `public.qorpera_folder_view_renew(${id}, ${pass})`) +
		call("box-close", `public.qorpera_folder_view_close(${id}, ${pass})`) +
		call("box-renew-closed", `public.qorpera_folder_view_renew(${id}, ${pass})`) +
		`select '@@shape-box-after-close "' || pg_temp.box_list_refused() || '"';\n` +
		"rollback;\n"
	);
}

function answers(output) {
	const out = new Map();
	for (const line of output.split("\n")) {
		const match = /^@@shape-([a-z0-9-]+) (.*)$/.exec(line);
		if (match) out.set(match[1], JSON.parse(match[2]));
	}
	return out;
}

/** The service's way: the first page's position, then the feed from there. */
function caughtUp(list, feedPages) {
	const tree = new ViewTree();
	for (const entry of list.entries) tree.put(entry);
	for (const page of feedPages)
		for (const event of page.events) if (event.kind === "change_set") for (const change of event.changes) tree.apply(change);
	return tree;
}

async function main() {
	const database = await hostedDatabase(databaseName);
	try {
		const got = answers(database.cluster.psql(databaseName, feedSql()));
		for (const label of ["list", "list-page-1", "list-member", "feed", "feed-member", "feed-cursor", "feed-resync"])
			assert.ok(got.has(label), `no ${label} answer`);
		const list = parseListPage(got.get("list"));
		assert.equal(list.asOfSeq, 8);
		assert.equal(list.next, null);
		const paths = list.entries.map((e) => e.path).sort();
		assert.ok(paths.includes("papers") && paths.includes("big/f25.txt") && paths.includes("notes/secret.txt"), paths.join(","));
		assert.ok(!paths.includes("papers/a.txt") && !paths.includes("docs"), "moved and deleted paths are gone");
		for (const entry of list.entries) {
			assert.match(entry.version, /^[0-9a-f-]{36}$/, `${entry.path} has a uuid version`);
			if (entry.kind === "file") assert.ok(entry.manifestSha256 && entry.bytes !== undefined, entry.path);
		}
		// Paging: the service continues after the last path of a full page.
		const first = parseListPage(got.get("list-page-1"));
		assert.equal(first.entries.length, 3);
		assert.equal(first.next, first.entries[2].path);
		// Another member sees less: member 2's private folder is not theirs.
		const memberList = parseListPage(got.get("list-member"));
		assert.ok(memberList.entries.length < list.entries.length);
		assert.ok(!memberList.entries.some((e) => e.path.startsWith("locked")));

		const feed = parseFeedPage(got.get("feed"));
		assert.equal(feed.resync, false);
		assert.deepEqual(feed.next, { afterSeq: 8, cursor: null });
		assert.ok(feed.events.some((e) => e.kind === "authority"));
		const ops = new Set(feed.events.flatMap((e) => (e.kind === "change_set" ? e.changes.map((c) => c.op) : [])));
		for (const op of ["mkdir", "write", "move_out", "move_in", "delete"]) assert.ok(ops.has(op), `the history has ${op}`);
		// From nothing, the feed alone builds what the listing shows.
		const empty = { asOfSeq: 0, entries: [], next: null };
		assert.deepEqual(ViewTree.diff(caughtUp(empty, [feed]), caughtUp(list, [])), [], "the feed replays to the listing");
		// And replaying it onto the listing (as after a listing taken mid-history) changes nothing.
		assert.deepEqual(ViewTree.diff(caughtUp(list, [feed]), caughtUp(list, [])), []);
		const memberFeed = parseFeedPage(got.get("feed-member"));
		assert.deepEqual(ViewTree.diff(caughtUp(empty, [memberFeed]), caughtUp(memberList, [])), []);

		const cursor = parseFeedPage(got.get("feed-cursor"));
		assert.equal(cursor.more, true);
		assert.equal(cursor.next.afterSeq, 2);
		assert.match(cursor.next.cursor.version, /^[0-9a-f-]{36}$/);
		assert.ok(Number.isSafeInteger(cursor.next.cursor.unitNo));

		const resync = parseFeedPage(got.get("feed-resync"));
		assert.equal(resync.resync, true);
		assert.equal(resync.next, null);

		// A run box view, as the folder service uses it.
		const boxed = answers(database.cluster.psql(databaseName, boxSql()));
		const opened = boxed.get("box-open");
		assert.equal(opened.schema, "qorpera.folder-view/v1");
		assert.match(opened.viewId, /^[0-9a-f-]{36}$/);
		assert.match(opened.pass, /^[A-Za-z0-9_-]{43}$/, "the pass the service's grant accepts");
		const boxList = parseListPage(boxed.get("box-list"));
		const boxPaths = boxList.entries.map((e) => e.path);
		assert.ok(boxPaths.includes("shared/a.txt") && boxPaths.includes("secret/s.txt"), boxPaths.join(","));
		// The view acts as the run's agent: the core lists every entry with its read receipt (2b-2), a member none.
		for (const entry of boxList.entries) assert.match(entry.authority?.resourceId ?? "", /^[0-9a-f-]{36}$/, entry.path);
		assert.ok(memberList.entries.every((e) => e.authority === undefined));
		const boxFeed = parseFeedPage(boxed.get("box-feed"));
		const emptyBox = { asOfSeq: 0, entries: [], next: null };
		// The feed carries no receipts: its replay builds the listing's content.
		const unreceipted = { ...boxList, entries: boxList.entries.map(({ authority: _receipt, ...entry }) => entry) };
		assert.deepEqual(ViewTree.diff(caughtUp(emptyBox, [boxFeed]), caughtUp(unreceipted, [])), [], "the view's feed replays to its listing");
		assert.equal(parseViewRenewal(boxed.get("box-renew")).state, "open");
		assert.deepEqual(boxed.get("box-close"), { schema: "qorpera.folder-view-close/v1", state: "closed", reason: "closed" });
		assert.equal(parseViewRenewal(boxed.get("box-renew-closed")).state, "closed");
		assert.equal(boxed.get("box-after-close"), "refused");
		process.stdout.write(
			`Folder service core shapes passed (${list.entries.length} paths, ${feed.events.length} feed events; list, member list, paging, feed, cursor, resync; a run box view: list, feed, renew, close)\n`,
		);
	} finally {
		database.close();
	}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	await main();
}
