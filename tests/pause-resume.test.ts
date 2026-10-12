import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { DurableOrchestrator } from '../packages/storage/src/orchestrator.ts';
import { handleTestText } from '../packages/storage/src/text-gateway.ts';
const policy={enabled:true,allowedChatIds:new Set(['42'])};
async function fixture(fn:(db:PrismaClient)=>Promise<void>){
 const db=new PrismaClient();await db.$connect();
 try{await db.workflowRun.deleteMany();await db.demoTask.deleteMany();await fn(db);}
 finally{await db.workflowRun.deleteMany();await db.demoTask.deleteMany();await db.$disconnect();}
}
test('pause before plan and resume preserves step, no duplicate outbox', {skip:!process.env.DATABASE_URL},()=>fixture(async db=>{
 const o=new DurableOrchestrator(db,policy);
 const run=await o.create('Проверь наличие и цену',{transport:'telegram_test',targetChatId:'42'});
 assert.equal((await o.pause(run.id)).state,'paused');
 assert.equal(await o.tick(),null);
 assert.equal(await db.textDelivery.count(),0);
 assert.equal((await o.resume(run.id)).state,'queued');
 await o.tick();await o.tick();
 assert.equal(await db.textDelivery.count(),1);
 const waiting=await o.get(run.id);
 assert.equal(waiting.state,'waiting_external');
 await o.pause(run.id);
 assert.equal(await o.tick(),null);
 assert.equal(await db.textDelivery.count(),1);
 await o.resume(run.id);
 assert.equal((await o.get(run.id)).state,'waiting_external');
 assert.equal(await db.textDelivery.count(),1);
 assert.equal((await o.pause(run.id)).state,'paused');
 assert.equal((await o.stop(run.id)).state,'cancelled');
 assert.equal((await db.textDelivery.findUniqueOrThrow({where:{workflowId:run.id}})).state,'cancelled');
 assert.equal(await o.tick(),null);
 await assert.rejects(()=>o.resume(run.id));
}));
test('pause while waiting for external reply blocks reply until resume', {skip:!process.env.DATABASE_URL},()=>fixture(async db=>{
 const o=new DurableOrchestrator(db,policy);
 const run=await o.create('Проверь цену',{transport:'telegram_test',targetChatId:'42'});
 await o.tick();await o.tick();
 await db.textDelivery.update({where:{workflowId:run.id},data:{state:'sent',providerId:'901'}});
 await o.pause(run.id);
 const reply={updateId:1,providerMessageId:'902',chatId:'42',senderId:'42',
 chatType:'private' as const,replyToProviderId:'901',body:'Цена 200 THB'};
 assert.equal(await handleTestText(db,policy,reply),false);
 await o.resume(run.id);
 assert.equal(await handleTestText(db,policy,reply),true);
 await o.tick();
 assert.equal((await o.get(run.id)).state,'completed');
 assert.equal((await db.workflowFact.count({where:{workflowId:run.id}})),1);
}));
test('pause/resume idempotence and terminal guards', {skip:!process.env.DATABASE_URL},()=>fixture(async db=>{
 const o=new DurableOrchestrator(db);
 const run=await o.create('Демонстрационная задача');
 await o.pause(run.id);await o.pause(run.id);
 assert.equal((await db.workflowEvent.count({where:{workflowId:run.id,kind:'paused'}})),1);
 await o.resume(run.id);
 await assert.rejects(()=>o.resume(run.id));
 await o.stop(run.id);
 await assert.rejects(()=>o.pause(run.id));
}));
