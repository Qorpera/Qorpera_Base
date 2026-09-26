import assert from 'node:assert/strict';
import test from 'node:test';
import {prepareBillingRecovery} from './computer-billing-recovery.mjs';
import {STRIPE_API_VERSION} from '../supabase/functions/computer-billing/computer-billing.ts';
const now=Date.parse('2026-09-26T12:00:00Z');
const command={commandId:'66400000-0000-4000-8000-000000000001',userId:'66400000-0000-4000-8000-000000000002',kind:'customer',result:null,recoveredTerminal:false,
 createdAt:'2026-09-24T12:00:00Z',customerId:null,payload:{},idempotencyKey:'qorpera-computer-66400000-0000-4000-8000-000000000001'};
const customer={id:'cus_owned',livemode:false,created:Date.parse(command.createdAt)/1000,metadata:{qorpera_user_id:command.userId,qorpera_command_id:command.idempotencyKey}};
function options(objects){const calls=[];return {calls,liveMode:false,now:()=>now,stripe:async path=>{calls.push(path);assert(path in objects,'Unexpected provider request');return structuredClone(objects[path]);}};}
test('positive customer proof uses one canonical GET and never searches or creates',async()=>{
 const o=options({'customers/cus_owned':customer}); const proof=await prepareBillingRecovery(command,'cus_owned',null,o);
 assert.equal(proof.customerId,'cus_owned');assert.equal(proof.providerRequestKey,command.idempotencyKey);assert.deepEqual(o.calls,['customers/cus_owned']);
 assert.equal(proof.objectSha256.length,64);assert.deepEqual(proof.result,{customerId:'cus_owned'});
});
test('mismatched user, environment, metadata and old objects stay held',async()=>{
 for(const patch of [{livemode:true},{created:1},{metadata:{...customer.metadata,qorpera_command_id:'wrong'}},{metadata:{...customer.metadata,qorpera_user_id:'wrong'}}]){
  await assert.rejects(prepareBillingRecovery(command,'cus_owned',null,options({'customers/cus_owned':{...customer,...patch}})));
 }
});
test('legacy recovery needs exact canonical event request correlation',async()=>{
 const event={id:'evt_original',livemode:false,api_version:STRIPE_API_VERSION,request:{idempotency_key:command.idempotencyKey},data:{object:{id:'cus_owned'}}};
 const legacy={...customer,metadata:{qorpera_user_id:command.userId}};
 const proof=await prepareBillingRecovery(command,'cus_owned','evt_original',options({'customers/cus_owned':legacy,'events/evt_original':event}));
 assert.equal(proof.eventId,'evt_original');assert.equal(proof.eventSha256.length,64);
 await assert.rejects(prepareBillingRecovery(command,'cus_owned','evt_original',options({'customers/cus_owned':legacy,'events/evt_original':{...event,request:{idempotency_key:'wrong'}}})));
});
test('terminal checkout verifies exact customer, offer and return URLs without inventing a payment URL',async()=>{
 const checkout={...command,kind:'checkout',customerId:'cus_owned',payload:{priceId:'price_basis',returnUrl:'https://example.test/usage'}};
 const session={id:'cs_closed',livemode:false,created:customer.created,metadata:customer.metadata,customer:'cus_owned',client_reference_id:command.userId,
 mode:'subscription',status:'expired',url:null,success_url:checkout.payload.returnUrl,cancel_url:checkout.payload.returnUrl};
 const objects={'checkout/sessions/cs_closed':session,'checkout/sessions/cs_closed/line_items?limit=2':{has_more:false,data:[{quantity:1,price:{id:'price_basis'}}]}};
 const proof=await prepareBillingRecovery(checkout,'cs_closed',null,options(objects));
 assert.equal(proof.providerState,'expired');assert.equal(proof.result,null);
 for(const patch of [{customer:'cus_other'},{client_reference_id:'other'},{success_url:'https://other.test'},{mode:'payment'}])
  await assert.rejects(prepareBillingRecovery(checkout,'cs_closed',null,options({...objects,'checkout/sessions/cs_closed':{...session,...patch}})));
 await assert.rejects(prepareBillingRecovery(checkout,'cs_closed',null,options({...objects,'checkout/sessions/cs_closed/line_items?limit=2':{has_more:true,data:[]}})));
});
test('already retained proof replays without refetching or changing its identity',async()=>{
 const recovery={schema:'qorpera.billing-command-recovery/v1',objectSha256:'a'.repeat(64)};const o=options({});
 assert.deepEqual(await prepareBillingRecovery({...command,recovery},'cus_owned',null,o),recovery);assert.deepEqual(o.calls,[]);
});
