import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { build } from "esbuild";
import { WebSocketServer } from "ws";
import { testMemberWebPresenceSql } from "./test-member-web-presence-sql.mjs";

// Actual Supabase SDK/Phoenix v2 frames + runtime signing/receiver + real SQL.
// This loopback protocol fixture does not claim hosted Realtime authorization.
export async function testCompanyPresenceWire({ root, query, fixture }) {
	const sql = (value) => `'${String(value).replaceAll("'", "''")}'`;
	const json = (value) => `${sql(JSON.stringify(value))}::jsonb`;
	const paths = (value) => `array[${value.map(sql).join(",")}]::text[]`;
	const service = `set request.jwt.claims='{"role":"service_role"}'; set role service_role;`;
	const setup = query(`${fixture}
		select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress');
		do $$ declare delivery jsonb; bob uuid; begin
			delivery:=public.qorpera_send_coworker_message(current_setting('qorpera_test.wake_binding')::jsonb,
				'30000000-0000-4000-8000-000000000031','presence-fixture','Examine the shared work.');
			perform public.qorpera_materialize_wake_execution_runs(1);
			select run_id into strict bob from public.qorpera_wake_occurrences where id=(delivery->>'occurrenceId')::uuid;
			perform set_config('qorpera_test.presence_bob',pg_temp.wake_start(bob)::text,true);
		end $$;
		select jsonb_build_array(
			jsonb_build_object('binding',current_setting('qorpera_test.wake_binding')::jsonb,'identity',public.qorpera_describe_native_tool_authority(current_setting('qorpera_test.wake_binding')::jsonb)->'identity'),
			jsonb_build_object('binding',current_setting('qorpera_test.presence_bob')::jsonb,'identity',public.qorpera_describe_native_tool_authority(current_setting('qorpera_test.presence_bob')::jsonb)->'identity'));
		commit;`);
	const actors = JSON.parse(setup.split("\n").at(-1)); assert.equal(actors.length,2);
	const durable = () => query(`select jsonb_build_object('receipts',(select count(*) from public.qorpera_run_operation_receipts),
		'wakes',(select count(*) from public.qorpera_wake_occurrences),'head',(select head_snapshot_id from public.qorpera_company_files
		where environment_id='30000000-0000-4000-8000-000000000020'));`);
	const before = durable();
	const control = { async call(method,args,signal) {
		signal.throwIfAborted(); let parameters;
		if(method==='qorpera_native_presence_register') parameters=[json(args.p_binding),sql(args.p_client_id)+'::uuid',sql(args.p_public_key)];
		else if(method==='qorpera_company_presence_scope') parameters=[sql(args.p_environment_id)+'::uuid',json(args.p_binding),paths(args.p_paths)];
		else if(method==='qorpera_native_presence_subject') parameters=[sql(args.p_environment_id)+'::uuid',sql(args.p_client_id)+'::uuid',paths(args.p_paths)];
		else if(method==='qorpera_native_presence_forget') parameters=[json(args.p_binding),sql(args.p_client_id)+'::uuid'];
		else throw new Error('Unexpected presence SQL method');
		const result=query(`${service} select public.${method}(${parameters.join(',')});`);
		signal.throwIfAborted(); return result ? JSON.parse(result) : null;
	} };
	const directory = await mkdtemp(join(tmpdir(),'qorpera-presence-wire-'));
	const unavailable=(_req,res)=>{res.writeHead(404);res.end();};let httpHandler=unavailable;
	const server=createServer((req,res)=>httpHandler(req,res));
	const sockets=new Map(); const frames=[]; const failures=[];
	const ws=new WebSocketServer({server}); let agents=[];
	const send=(socket,joinRef,ref,topic,event,payload)=>socket.send(JSON.stringify([joinRef,ref,topic,event,payload]));
	const state=(topic)=>Object.fromEntries([...sockets.values()].filter((value)=>value.topic===topic && value.presence)
		.map((value)=>[value.clientId,{metas:[value.presence]}]));
	const broadcast=(topic)=>{for(const [socket,value] of sockets) if(value.topic===topic && socket.readyState===1)
		send(socket,value.joinRef,null,topic,'presence_state',state(topic));};
	ws.on('connection',(socket,request)=>{
		assert.equal(new URL(request.url,'http://fixture').searchParams.get('vsn'),'2.0.0');
		socket.on('message',(bytes)=>{
			try {
				const [joinRef,ref,topic,event,payload]=JSON.parse(bytes.toString()); frames.push({event,payload});
				if(event==='phx_join') {
					assert.equal(payload.config.private,true); assert.equal(payload.config.presence.enabled,true);
					sockets.set(socket,{joinRef,topic,clientId:payload.config.presence.key});
					send(socket,joinRef,ref,topic,'phx_reply',{status:'ok',response:{postgres_changes:[]}}); broadcast(topic);
				} else if(event==='presence' && payload.event==='track') {
					sockets.get(socket).presence={...payload.payload,phx_ref:randomUUID()};
					send(socket,joinRef,ref,topic,'phx_reply',{status:'ok',response:{}}); broadcast(topic);
				} else if(event==='phx_leave') {
					sockets.delete(socket); send(socket,joinRef,ref,topic,'phx_reply',{status:'ok',response:{}}); broadcast(topic);
				} else if(event==='heartbeat') send(socket,joinRef,ref,topic,'phx_reply',{status:'ok',response:{}});
				else throw new Error(`Unexpected Phoenix event ${event}`);
			} catch(error) { failures.push(String(error)); socket.close(); }
		});
		socket.on('close',()=>{const value=sockets.get(socket);sockets.delete(socket);if(value)broadcast(value.topic);});
	});
	try {
		await build({entryPoints:[join(root,'packages/runtime/src/cloud-company-path-presence.ts')],outfile:join(directory,'presence.mjs'),bundle:true,platform:'node',format:'esm',target:'node22.19'});
		const {CloudNativeCompanyPresence}=await import(pathToFileURL(join(directory,'presence.mjs')).href);
		await new Promise((accept,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',accept);});
		const endpoint=`http://127.0.0.1:${server.address().port}`;
		agents=actors.map(({binding,identity})=>new CloudNativeCompanyPresence({binding,identity,control,signal:new AbortController().signal,
			client:createClient(endpoint,'fixture-key',{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}})}));
		const signal=new AbortController().signal;
		await agents[1].observe('projects/report.md','object','writing',signal);
		let view; const deadline=Date.now()+20000;
		do {
			assert(Date.now()<deadline,`Presence exchange timed out: ${failures.join('; ')}`);
			await new Promise((accept)=>setTimeout(accept,30));
			view=await agents[0].observe('projects/report.md','object','reading',signal);
		} while(!view.paths[0].participants.length);
		assert.equal(view.state,'available'); assert.equal(view.paths[0].participants[0].runId,actors[1].binding.runId);
		assert.equal(view.paths[0].participants[0].activity,'writing');
		assert(!JSON.stringify(frames).includes('projects/report.md'));
		assert(!JSON.stringify(view).includes('token'));
		await testMemberWebPresenceSql({root,query,actors,endpoint,control,frames,setHttpHandler:handler=>{httpHandler=handler??unavailable;}});
		query(`update public.qorpera_native_provider_connection_leases set status='revoked',released_at=clock_timestamp() where id=${sql(actors[1].binding.leaseId)}::uuid;`);
		const revoked=await agents[0].observe('projects/report.md','object','reading',signal);
		assert.deepEqual(revoked.paths[0].participants,[]); assert.equal(durable(),before);
		await Promise.all(agents.map((agent)=>agent.close())); agents=[];
		assert.equal(query('select count(*) from public.qorpera_native_presence_devices;'),'0');
		assert.deepEqual(failures,[]);
		console.log(JSON.stringify({schema:'qorpera.native-presence-wire-proof/v1',nativeRuns:2,protocol:'Phoenix v2',
			sdk:'installed Supabase client',frames:frames.length,overlap:view.paths[0].participants.length,revoked:0,registered:0,durableStateUnchanged:true}));
	} finally {
		await Promise.allSettled(agents.map((agent)=>agent.close())); for(const socket of ws.clients)socket.terminate();
		await new Promise((accept)=>ws.close(accept)); await new Promise((accept)=>server.close(accept));
		await rm(directory,{recursive:true,force:true});
	}
}
