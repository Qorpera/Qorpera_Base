// Execute the exact migration in disposable PostgreSQL. Provider authorization
// and scope helpers are fixture stubs; this tests activation selection and its
// complete returned identity, not the unchanged authorization implementation.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { POSTGRES_IMAGE } from "./test-hosted-db.mjs";

assert(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--sql"),
	"Usage: node scripts/test-runtime-office-current-provider-activation.mjs [--sql]");
const migration = readFileSync(new URL("../supabase/migrations/20260920100000_runtime_office_current_provider_activation.sql", import.meta.url), "utf8");
const original = readFileSync(new URL("../supabase/migrations/20260917010000_runtime_office_host_reboot.sql", import.meta.url), "utf8")
	.match(/create function public\.qorpera_runtime_office_provider_activation\([\s\S]*?\n\$\$;/)?.[0];
assert(original, "Original provider activation function unavailable");
assert.equal(migration.slice(migration.indexOf("create or replace function")).trim(), original
	.replace("create function", "create or replace function")
	.replace("and state='active' for share", "and state='active' and superseded_at is null for share"),
	"Migration must preserve the function except for current activation selection");

const sql = `
begin;
create table public.qorpera_runtime_offices(id uuid primary key,generation bigint,state text);
create table public.qorpera_runtime_office_providers(office_id uuid,provider_id uuid);
create table public.qorpera_runtime_office_activations(
 activation_id uuid primary key,office_id uuid,computer_generation bigint,provider_id uuid,state text,
 superseded_at timestamptz,provider_policy_sha256 text,allocation_id uuid,instance_sha256 text,
 image_sha256 text,bootstrap_sha256 text,attestation jsonb,service_invocation_id text);
create function public.qorpera_assert_runtime_office_provider(jsonb,bigint,uuid,text,boolean)
returns public.qorpera_runtime_office_providers language plpgsql as $$
declare p public.qorpera_runtime_office_providers%rowtype;
begin
 if $1 is distinct from '{"companyComputerId":"10000000-0000-4000-8000-000000000001"}'::jsonb
  or $2 is distinct from 1 or $3 is distinct from '20000000-0000-4000-8000-000000000001'::uuid
  or $4 is distinct from repeat('f',64) or $5 is distinct from false then
  raise exception 'Fixture provider binding differs';
 end if;
 select * into strict p from public.qorpera_runtime_office_providers;
 return p;
end $$;
create function public.qorpera_runtime_office_scope(public.qorpera_runtime_offices)
returns jsonb language sql as $$ select jsonb_build_object('companyComputerId',$1.id) $$;
insert into public.qorpera_runtime_offices values('10000000-0000-4000-8000-000000000001',1,'active');
insert into public.qorpera_runtime_office_providers values('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001');
-- Heap order puts superseded active history first, reproducing the old reader.
insert into public.qorpera_runtime_office_activations values
 ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',1,'20000000-0000-4000-8000-000000000001','active','2026-09-20Z',repeat('f',64),'40000000-0000-4000-8000-000000000001',repeat('a',64),repeat('b',64),repeat('c',64),'{"bootId":"50000000-0000-4000-8000-000000000001","configurationSha256":"old-config"}',repeat('1',32)),
 ('30000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001',1,'20000000-0000-4000-8000-000000000001','active',null,repeat('f',64),'40000000-0000-4000-8000-000000000001',repeat('a',64),repeat('b',64),repeat('c',64),'{"bootId":"50000000-0000-4000-8000-000000000002","configurationSha256":"new-config"}',repeat('2',32));
-- Current rows belonging to another generation, provider or office cannot win.
insert into public.qorpera_runtime_office_activations
select ('30000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 case when n=5 then '10000000-0000-4000-8000-000000000002'::uuid else office_id end,
 case when n=3 then 2 else computer_generation end,
 case when n=4 then '20000000-0000-4000-8000-000000000002'::uuid else provider_id end,
 state,null,provider_policy_sha256,allocation_id,instance_sha256,image_sha256,bootstrap_sha256,attestation,service_invocation_id
from public.qorpera_runtime_office_activations cross join generate_series(3,5) n
where activation_id='30000000-0000-4000-8000-000000000002';
create temporary table before_read as select * from public.qorpera_runtime_office_activations;
${migration}
create function pg_temp.current_activation() returns jsonb language sql as $$
 select public.qorpera_runtime_office_provider_activation(
 '{"companyComputerId":"10000000-0000-4000-8000-000000000001"}',1,
 '20000000-0000-4000-8000-000000000001',repeat('f',64))
$$;
do $$
declare actual jsonb; expected jsonb;
begin
 expected:=jsonb_build_object('schema','qorpera.office-provider-activation/v1','officeState','active',
 'activation',jsonb_build_object('activationId','30000000-0000-4000-8000-000000000002',
 'providerId','20000000-0000-4000-8000-000000000001','providerPolicySha256',repeat('f',64),
 'startup',jsonb_build_object('scope',jsonb_build_object('companyComputerId','10000000-0000-4000-8000-000000000001'),
 'computerGeneration',1,'allocationId','40000000-0000-4000-8000-000000000001',
 'instanceSha256',repeat('a',64),'imageSha256',repeat('b',64),'bootstrapSha256',repeat('c',64),
 'bootId','50000000-0000-4000-8000-000000000002','configurationSha256','new-config','serviceInvocationId',repeat('2',32))));
 actual:=pg_temp.current_activation();
 if actual is distinct from expected then raise exception 'Current activation identity differs'; end if;
 if exists((table public.qorpera_runtime_office_activations except table before_read)
  union all (table before_read except table public.qorpera_runtime_office_activations)) then
  raise exception 'Activation read changed immutable history';
 end if;
 -- A prepared successor and active historical predecessor are not current active identity.
 update public.qorpera_runtime_office_activations set state='prepared'
 where activation_id='30000000-0000-4000-8000-000000000002';
 if pg_temp.current_activation() is distinct from jsonb_build_object(
  'schema','qorpera.office-provider-activation/v1','officeState','active','activation',null) then
  raise exception 'Prepared successor exposed historical activation';
 end if;
 update public.qorpera_runtime_office_activations set state='active',superseded_at='2026-09-21Z'
 where activation_id='30000000-0000-4000-8000-000000000002';
 if pg_temp.current_activation()->'activation' is distinct from 'null'::jsonb then
  raise exception 'Superseded-only history exposed as current';
 end if;
 update public.qorpera_runtime_office_activations set superseded_at=null
 where activation_id='30000000-0000-4000-8000-000000000002';
 delete from public.qorpera_runtime_office_activations where activation_id='30000000-0000-4000-8000-000000000001';
 if pg_temp.current_activation() is distinct from expected then raise exception 'Single current identity differs'; end if;
end $$;
rollback;
select 'PASS: current activation identity, immutable history, prepared successor, superseded-only history, single current activation';
`;

if (process.argv[2] === "--sql") {
	process.stdout.write(sql);
} else {
	const container = `qorpera-current-activation-${randomBytes(6).toString("hex")}`;
	const docker = (args, input) => {
		const result = spawnSync("docker", args, { input, encoding: "utf8", timeout: 60000, maxBuffer: 1048576 });
		assert(!result.error && result.status === 0, result.stderr || String(result.error));
		return result.stdout.trim();
	};
	let started = false;
	try {
		docker(["run", "--rm", "-d", "--network", "none", "--pull", "never", "--name", container,
			"--tmpfs", "/var/lib/postgresql/data:rw,size=128m", "-e", "POSTGRES_PASSWORD=local-fixture-only", POSTGRES_IMAGE]);
		started = true;
		let ready = false;
		for (let i = 0; i < 80; i++) {
			const result = spawnSync("docker", ["logs", container], { encoding: "utf8", timeout: 2000, maxBuffer: 1048576 });
			if ((result.stdout + result.stderr).includes("PostgreSQL init process complete") &&
				spawnSync("docker", ["exec", container, "pg_isready", "-U", "postgres"], { timeout: 2000 }).status === 0) {
				ready = true;
				break;
			}
			await new Promise(resolve => setTimeout(resolve, 250));
		}
		assert(ready, "Disposable PostgreSQL not ready");
		console.log(docker(["exec", "-i", container, "psql", "-X", "-qAt", "-U", "postgres", "-v", "ON_ERROR_STOP=1"], sql));
	} finally {
		if (started) docker(["rm", "-f", "-v", container]);
	}
}
