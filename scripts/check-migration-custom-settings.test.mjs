import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkFiles, customSettings } from "./check-migration-custom-settings.mjs";

/** In order of appearance would need source offsets; the check needs only the set. */
const parameters = (sql) => customSettings(sql)
	.map(({ statement, parameter }) => `${statement}: ${parameter}`)
	.sort();

test("finds a custom parameter stored with a function, role or database", () => {
	// 20260928339380 as v158's production dry run refused it (42501).
	assert.deepEqual(
		parameters(`alter function public.qorpera_check_company_path_mutation(uuid,jsonb,jsonb)
	set lock_timeout = '2s' set qorpera.company_fence_wait = '2s';`),
		["alter function: qorpera.company_fence_wait"],
	);
	assert.deepEqual(
		parameters(`create or replace function public.f(p uuid) returns void language plpgsql security definer
set search_path = '' set "qorpera.wait" to '2s' as $$ begin perform 1; end $$;
CREATE PROCEDURE public.p() LANGUAGE sql SET app . mode = 'x' AS 'select 1';`),
		["create or replace function: qorpera.wait", "create procedure: app.mode"],
	);
	assert.deepEqual(
		parameters(`alter role authenticated set qorpera.mode = 'on';
alter role postgres in database postgres set app.x to 1;
alter database postgres set app.y from current;
alter routine public.f() reset qorpera.wait;`),
		["alter database: app.y", "alter role: app.x", "alter role: qorpera.mode", "alter routine: qorpera.wait"],
	);
});

test("finds one in dynamic SQL and in a DO block", () => {
	assert.deepEqual(
		parameters(`do $$
begin
	execute 'alter function public.f() set qorpera.wait = ''2s''';
	execute format($q$alter role %I set app.flag = 'on'$q$, 'anon');
	if true then alter database postgres set app.z = 1; end if;
end
$$;
select pg_temp.patch($old$ perform 1;$old$, E'alter function public.g()\\n set qorpera.e = 1');`),
		["alter database: app.z", "alter function: qorpera.e", "alter function: qorpera.wait", "alter role: app.flag"],
	);
});

test("leaves run-time settings, real parameters, comments and other SET clauses alone", () => {
	assert.deepEqual(
		parameters(`-- alter function public.f() set qorpera.wait = '2s' (a comment)
/* alter role r set app.x = 1 /* nested */ */
set request.jwt.claims = '{"role":"service_role"}';
set local request.path = '/rpc/f';
select set_config('qorpera.company_fence_wait', '2s', true);
alter function public.f(uuid) set lock_timeout = '2s' set search_path = '';
create function public.g() returns setof public.t language plpgsql set search_path = '' as $f$
begin
	set local qorpera.wait = '2s';
	perform pg_catalog.set_config('qorpera.company_fence_wait', '2s', true);
	update public.t set composite.field = 1;
end
$f$;
update public.t set composite.field = 1;`),
		[],
	);
});

test("no migration stores a custom parameter with a function, role or database", () => {
	const migrations = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "supabase", "migrations");
	const files = readdirSync(migrations)
		.filter((name) => name.endsWith(".sql"))
		.map((name) => join(migrations, name));
	assert.ok(files.length > 500);
	assert.deepEqual(checkFiles(files), []);
});
