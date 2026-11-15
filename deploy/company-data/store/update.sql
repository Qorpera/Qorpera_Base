-- Brings a store made from an earlier store/template.sql to today's. Run as the server's superuser inside the template
-- database and inside every company's database (kit/update-store.sh does both, on the primary; a standby follows it).
-- Safe to run again: each part replaces what it changes. Each part says what it carries and since when; the same text
-- stands in template.sql, and deploy/company-data/gateway/gateway.test.mjs holds the two to each other.

-- 14 November 2026 (named changes, slice 7): deleted rows are recorded only in a step's session. A change deletes rows
-- as the write login and is committed, so the record of its deletes was kept for good, one row for every change.
create or replace function qorpera_data.rows_gone() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_rows bigint;
begin
	if tg_op = 'TRUNCATE' then
		if exists (select 1 from qorpera_data.sealed s where s.txid = txid_current()) then
			raise exception 'A step may not destroy data after it was checked: % was emptied', tg_table_schema || '.' || tg_table_name;
		end if;
		insert into qorpera_data.step_effects (kind, object) values ('emptied table', tg_table_schema || '.' || tg_table_name);
	elsif session_user::text ~ '^c_[0-9a-f]{32}_o[0-9]+$' then
		select count(*) into v_rows from gone;
		if v_rows > 0 and exists (select 1 from qorpera_data.sealed s where s.txid = txid_current()) then
			raise exception 'A step may not destroy data after it was checked: rows of % were deleted', tg_table_schema || '.' || tg_table_name;
		end if;
		if v_rows > 0 then
			insert into qorpera_data.step_effects (kind, object, rows)
			values ('deleted rows', tg_table_schema || '.' || tg_table_name, v_rows);
		end if;
	end if;
	return null;
end $$;

-- What an earlier store kept of changes' deleted rows: records of transactions that are over, which nothing reads (a
-- step's record is read only inside the step's own transaction).
delete from qorpera_data.step_effects where txid < txid_snapshot_xmin(txid_current_snapshot());
