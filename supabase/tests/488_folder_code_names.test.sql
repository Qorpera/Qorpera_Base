-- @fixture 630_folder_core_foundation.test.sql until "-- Writes, conflicts, missing parents"
-- Names under code/ (20260930446100; F3 step 5b: deploy/first-node/RUNTIME-FOLDER-CODING-MACHINES.md, "Code areas and
-- git"). '.git' and 'repo.git' are refused at any depth outside code/<owner>/<name>/ and accepted inside it; under code/ a
-- name may hold '%' and ':' or be a device name, and NFC, trailing dots and case-only siblings stay refused. The company,
-- its members and the helpers are 630's.

-- A whole-call refusal of a malformed path (22023).
create function pg_temp.malformed(p_key text, p_path text) returns void language plpgsql as $$
begin
	perform pg_temp.commit('{"kind":"platform"}', p_key, jsonb_build_array(jsonb_build_object('op','mkdir','path',p_path)));
	raise exception 'A malformed path was accepted: %', p_path;
exception when sqlstate '22023' then null;
end $$;

-- Depth: git's directories only below code/<owner>/<name>/, keys case-folded.
do $$
declare r jsonb;
begin
	r := pg_temp.commit('{"kind":"platform"}', 'n488-tree', '[{"op":"mkdir","path":"code"},{"op":"mkdir","path":"code/acme"},
		{"op":"mkdir","path":"code/acme/app"},{"op":"mkdir","path":"docs"},{"op":"mkdir","path":"docs/x"}]');
	for i in 1..5 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	r := pg_temp.commit('{"kind":"platform"}', 'n488-shallow', '[{"op":"mkdir","path":"code/.git"},
		{"op":"mkdir","path":"code/repo.git"},{"op":"mkdir","path":"code/acme/.git"},{"op":"mkdir","path":"code/acme/REPO.git"},
		{"op":"mkdir","path":"docs/repo.git"},{"op":"mkdir","path":"docs/x/.git"},{"op":"mkdir","path":"repo.git"}]');
	for i in 1..7 loop perform pg_temp.expect(r, i, 'refused', 'reserved'); end loop;
	r := pg_temp.commit('{"kind":"platform"}', 'n488-deep', '[{"op":"mkdir","path":"code/acme/app/repo.git"},
		{"op":"mkdir","path":"code/acme/app/repo.git/worktrees"},{"op":"mkdir","path":"code/acme/app/repo.git/worktrees/w1"},
		{"op":"mkdir","path":"code/acme/app/worktrees"},{"op":"mkdir","path":"code/acme/app/worktrees/w1"},
		{"op":"mkdir","path":"code/acme/app/worktrees/w1/.git"},{"op":"mkdir","path":"code/acme/app/main"},
		{"op":"mkdir","path":"code/acme/app/main/.git"},{"op":"mkdir","path":"code/acme/app/worktrees/w1/node_modules"},
		{"op":"mkdir","path":"code/acme/app/worktrees/w1/vendor"},{"op":"mkdir","path":"code/acme/app/worktrees/w1/vendor/repo.git"}]');
	for i in 1..11 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	-- A copy or move that lands a git directory too high is refused, one deep enough is not.
	r := pg_temp.commit('{"kind":"platform"}', 'n488-copy', '[{"op":"copy","from":"code/acme/app","to":"code/app"},
		{"op":"move","from":"code/acme/app/repo.git","to":"code/acme/repo.git"},
		{"op":"copy","from":"code/acme/app","to":"code/acme/app2"}]');
	perform pg_temp.expect(r, 1, 'refused', 'reserved'); perform pg_temp.expect(r, 2, 'refused', 'reserved');
	perform pg_temp.expect(r, 3, 'saved');
	if (pg_temp.read('code/acme/app2/repo.git/worktrees/w1') ->> 'found')::boolean is not true then
		raise exception 'The copy holds the repository''s git directory'; end if;
end $$;

-- Names: '%', ':' and device names under code/ only; the rest of §6 holds everywhere.
do $$
declare r jsonb;
begin
	r := pg_temp.commit('{"kind":"platform"}', 'n488-names', '[{"op":"mkdir","path":"code/acme/app/worktrees/w1/a%b"},
		{"op":"mkdir","path":"code/acme/app/worktrees/w1/c:d"},{"op":"mkdir","path":"code/acme/app/worktrees/w1/con"},
		{"op":"mkdir","path":"code/acme/app/worktrees/w1/AUX.txt"},{"op":"mkdir","path":"code/50%"},
		{"op":"mkdir","path":"code/acme/app/worktrees/w1/README"},{"op":"mkdir","path":"code/acme/app/worktrees/w1/Readme"},
		{"op":"mkdir","path":"code/acme/app/worktrees/w1/ＲＥＡＤＭＥ"}]');
	for i in 1..6 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	perform pg_temp.expect(r, 7, 'conflict', 'exists'); perform pg_temp.expect(r, 8, 'conflict', 'exists');
	if (pg_temp.read('code/acme/app/worktrees/w1/a%b') ->> 'found')::boolean is not true
		or (pg_temp.read('code/acme/app/worktrees/w1/c:d') ->> 'found')::boolean is not true then
		raise exception 'Names with %% and : read back'; end if;
	-- '%' is no wildcard: deleting the folder code/50% leaves its sibling code/500x.
	r := pg_temp.commit('{"kind":"platform"}', 'n488-pct-tree', '[{"op":"mkdir","path":"code/50%/in"},{"op":"mkdir","path":"code/500x"},
		{"op":"mkdir","path":"code/500x/in"}]');
	for i in 1..3 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	r := pg_temp.commit('{"kind":"platform"}', 'n488-pct-delete', jsonb_build_array(jsonb_build_object('op','delete','path','code/50%',
		'expectedVersion', pg_temp.read('code/50%') -> 'entry' ->> 'version', 'asOfSeq', pg_temp.seq())));
	perform pg_temp.expect(r, 1, 'saved');
	if (pg_temp.read('code/500x/in') ->> 'found')::boolean is not true or (pg_temp.read('code/50%/in') ->> 'found')::boolean then
		raise exception 'A delete of code/50%% took its sibling or left its own'; end if;
	perform pg_temp.malformed('n488-pct', 'docs/a%b');
	perform pg_temp.malformed('n488-colon', 'docs/c:d');
	perform pg_temp.malformed('n488-device', 'docs/con');
	perform pg_temp.malformed('n488-device2', 'docs/x/aux.txt');
	perform pg_temp.malformed('n488-dot', 'code/acme/app/worktrees/w1/x.');
	perform pg_temp.malformed('n488-space', 'code/acme/app/worktrees/w1/x ');
	perform pg_temp.malformed('n488-backslash', 'code/acme/app/worktrees/w1/a' || chr(92) || 'b');
	perform pg_temp.malformed('n488-nfd', 'code/acme/app/worktrees/w1/' || normalize('å', NFD));
	if not public.qorpera_company_path_valid('Code/x:y') or not public.qorpera_company_path_valid('code/%')
		or public.qorpera_company_path_valid('codes/x:y') or public.qorpera_company_path_valid('x/code/a%b') then
		raise exception 'qorpera_company_path_valid decides by the key''s first part'; end if;
end $$;

-- A folder moved or copied out of code/ takes no name only code/ holds: that unit is refused, the change set's others save.
do $$
declare r jsonb;
begin
	r := pg_temp.commit('{"kind":"platform"}', 'n488-out-tree', '[{"op":"mkdir","path":"code/acme/src"},
		{"op":"mkdir","path":"code/acme/src/lib"},{"op":"mkdir","path":"code/acme/src/lib/a%b"},{"op":"mkdir","path":"code/acme/dev"},
		{"op":"mkdir","path":"code/acme/dev/x:y"},{"op":"mkdir","path":"code/acme/plain"},{"op":"mkdir","path":"code/acme/plain/lib"}]');
	for i in 1..7 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	r := pg_temp.commit('{"kind":"platform"}', 'n488-out', '[{"op":"copy","from":"code/acme/src","to":"docs/src"},
		{"op":"move","from":"code/acme/dev","to":"docs/dev"},{"op":"move","from":"code","to":"docs/code"},
		{"op":"mkdir","path":"docs/kept"},{"op":"copy","from":"code/acme/plain","to":"docs/plain"},
		{"op":"copy","from":"code/acme/src","to":"code/src"}]');
	for i in 1..3 loop perform pg_temp.expect(r, i, 'refused', 'reserved'); end loop;
	for i in 4..6 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	if (pg_temp.read('docs/src') ->> 'found')::boolean or (pg_temp.read('docs/dev') ->> 'found')::boolean
		or (pg_temp.read('docs/code') ->> 'found')::boolean
		or (pg_temp.read('code/acme/dev/x:y') ->> 'found')::boolean is not true
		or (pg_temp.read('docs/kept') ->> 'found')::boolean is not true
		or (pg_temp.read('docs/plain/lib') ->> 'found')::boolean is not true
		or (pg_temp.read('code/src/lib/a%b') ->> 'found')::boolean is not true then
		raise exception 'A folder left code/ with a name only code/ holds, or the change set''s other units did not save'; end if;
end $$;

rollback;
