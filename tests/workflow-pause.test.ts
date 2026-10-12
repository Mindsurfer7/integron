import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { DurableOrchestrator } from '../packages/storage/src/orchestrator.ts';
import { handleTestText, flushTestTextOutbox } from '../packages/storage/src/text-gateway.ts';
import { buildFastifyApp } from '../apps/api/src/fastify-app.ts';
import { PrismaDemoTaskService } from '../packages/storage/src/prisma.ts';
import { handleOwnerUpdate, TelegramBotClient } from '../packages/notifications/src/telegram.ts';

const policy={enabled:true,allowedChatIds:new Set(['42'])};
async function withDatabase(fn:(db:PrismaClient)=>Promise<void>) {
  const db=new PrismaClient(); await db.$connect();
  try {
    await db.workflowRun.deleteMany();
    await db.demoTask.deleteMany();
    await fn(db);
  } finally {
    await db.workflowRun.deleteMany();
    await db.demoTask.deleteMany();
    await db.$disconnect();
  }
}
test('pause/resume queued and waiting mock workflow, stop while paused', {
  skip:!process.env.DATABASE_URL
},()=>withDatabase(async db=>{
  const runs=new DurableOrchestrator(db);
  const one=await runs.create('Сравни цены трёх демонстрационных организаций');
  assert.equal((await runs.pause(one.id)).state,'paused');
  assert.equal(await runs.tick(),null);
  assert.equal((await runs.pause(one.id)).state,'paused'); // idempotent
  assert.equal((await runs.resume(one.id)).state,'queued');
  await assert.rejects(()=>runs.resume(one.id),e=>(e as any).code==='WORKFLOW_NOT_PAUSED');
  await runs.tick(); // queued -> collect
  await runs.tick(); // owner question created
  const saved=(await runs.get(one.id)).clarificationId;
  assert.equal((await runs.pause(one.id)).state,'paused');
  assert.equal(await runs.tick(),null);
  const reloaded=new DurableOrchestrator(new PrismaClient());
  assert.equal((await reloaded.resume(one.id)).state,'waiting_owner');
  assert.equal((await runs.get(one.id)).clarificationId,saved);
  await runs.pause(one.id);
  assert.equal((await runs.stop(one.id)).state,'cancelled');
  assert.equal(await runs.tick(),null);
  await assert.rejects(()=>runs.resume(one.id),e=>(e as any).code==='WORKFLOW_NOT_PAUSED');
}));
test('paused unsent text remains queued, resumes with exactly one provider call', {
  skip:!process.env.DATABASE_URL
},()=>withDatabase(async db=>{
  const runs=new DurableOrchestrator(db,policy);
  const run=await runs.create('Проверь цену 350 THB в согласованном чате',{
    transport:'telegram_test',targetChatId:'42'
  });
  await runs.tick();await runs.tick();
  await runs.pause(run.id);
  const calls:string[]=[];
  const sender={send:async (intent:{chatId:string})=>{
    calls.push(intent.chatId);
    return {providerMessageId:'300'};
  }};
  assert.equal(await flushTestTextOutbox(db,sender,policy),0);
  assert.equal((await db.textDelivery.findUniqueOrThrow({where:{workflowId:run.id}})).state,'queued');
  await runs.resume(run.id);
  assert.equal(await flushTestTextOutbox(db,sender,policy),1);
  assert.equal(await flushTestTextOutbox(db,sender,policy),0);
  assert.deepEqual(calls,['42']);
  assert.equal((await db.textDelivery.findUniqueOrThrow({where:{workflowId:run.id}})).state,'sent');
}));
test('reply during pause is durably saved once and processed after resume', {
  skip:!process.env.DATABASE_URL
},()=>withDatabase(async db=>{
  const runs=new DurableOrchestrator(db,policy);
  const run=await runs.create('Проверь наличие и цену у согласованного контакта',{
    transport:'telegram_test',targetChatId:'42'
  });
  await runs.tick();await runs.tick();
  await db.textDelivery.update({where:{workflowId:run.id},data:{state:'sent',providerId:'711'}});
  await db.textMessage.create({data:{workflowId:run.id,channel:'telegram_bot_test',
    chatId:'42',direction:'out',providerMessageId:'711',body:'query'}});
  await runs.pause(run.id);
  const message={ updateId:5, chatId:'42', senderId:'42',
    providerMessageId:'712', replyToProviderId:'711',chatType:'private',
    body:'Нет в наличии. Стоимость 250 THB.' };
  assert.equal(await handleTestText(db,policy,message),true);
  assert.equal(await handleTestText(db,policy,message),false);
  assert.equal((await runs.get(run.id)).state,'paused');
  assert.equal(await runs.tick(),null);
  assert.equal(await db.workflowFact.count({where:{workflowId:run.id}}),0);
  const resumed=await runs.resume(run.id);
  assert.equal(resumed.state,'running');
  assert.equal(resumed.step,'process_external');
  assert.equal(await runs.tick(),run.id);
  const result=await runs.get(run.id);
  assert.equal(result.state,'completed');
  assert.equal(result.facts.length,2);
  assert.equal(result.facts.find(f=>f.field==='availability')?.quote,'Нет в наличии');
  assert.equal((await db.workflowEvent.findMany({where:{workflowId:run.id,
    kind:'text_reply_saved_while_paused'}})).length,1);
}));
test('paused workflow can be stopped; queued message not sent or resurrected', {
  skip:!process.env.DATABASE_URL
},()=>withDatabase(async db=>{
  const runs=new DurableOrchestrator(db,policy);
  const run=await runs.create('Спроси условия возврата у тестового контакта',{
    transport:'telegram_test',targetChatId:'42'
  });
  await runs.tick();await runs.tick();
  await runs.pause(run.id);
  assert.equal((await runs.stop(run.id)).state,'cancelled');
  assert.equal((await db.textDelivery.findUniqueOrThrow({where:{workflowId:run.id}})).state,'cancelled');
  let sent=0;
  await flushTestTextOutbox(db,{send:async()=>{sent++;return {providerMessageId:'1'};}},policy);
  assert.equal(sent,0);
}));
test('HTTP workflow pause/resume routes exposed only for postgres workflow API', {
  skip:!process.env.DATABASE_URL
},()=>withDatabase(async db=>{
  const runs=new DurableOrchestrator(db);
  const app=buildFastifyApp(new PrismaDemoTaskService(db),'postgres',runs);
  const headers={host:'127.0.0.1:4317'};
  try {
    const created=await runs.create('Проверь HTTP pause/resume API');
    for(const [path,expected] of [['pause','paused'],['resume','queued']] as const){
      const response=await app.inject({method:'POST',url:'/api/workflows/'+created.id+'/'+path,headers});
      assert.equal(response.statusCode,200);
      assert.equal(response.json().workflow.state,expected);
    }
  }finally{await app.close();}
}));
test('owner workflow Telegram commands check sender and chat identity', {
  skip:!process.env.DATABASE_URL
},()=>withDatabase(async db=>{
  const runs=new DurableOrchestrator(db);
  const run=await runs.create('Проверь Telegram паузу владельца');
  const delivered:string[]=[];
  const fakeFetch=(async (_url:string|URL|Request, init?:RequestInit)=>{
    const payload=JSON.parse(String(init?.body));
    delivered.push(payload.text);
    return new Response(JSON.stringify({ok:true,result:{message_id:123}}),{status:200});
  }) as typeof fetch;
  const bot=new TelegramBotClient({token:'123:testFakeTokenForCI',ownerUserId:'7',ownerChatId:'7'},fakeFetch);
  const msg=(id:number,chat:number,action:string)=>({
    update_id:1,message:{message_id:1,from:{id},chat:{id:chat},text:action}
  });
  await handleOwnerUpdate(db,bot,msg(999,7,'/wpause '+run.id));
  await handleOwnerUpdate(db,bot,msg(7,999,'/wpause '+run.id));
  assert.equal((await runs.get(run.id)).state,'queued');
  await handleOwnerUpdate(db,bot,msg(7,7,'/wpause '+run.id));
  assert.equal((await runs.get(run.id)).state,'paused');
  await handleOwnerUpdate(db,bot,msg(7,7,'/wresume '+run.id));
  assert.equal((await runs.get(run.id)).state,'queued');
  assert.equal(delivered.length,2);
}));
