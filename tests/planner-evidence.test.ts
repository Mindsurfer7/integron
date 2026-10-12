import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MockResearchPlanner, OpenAIResearchPlanner, validateProposal, plannerFromEnvironment, questionsFromFields
} from '../packages/llm/src/planner.ts';
import { extractQuotedFacts } from '../packages/core/src/evidence.ts';

test('default planner offline and deterministic, sends no network requests', async () => {
  const planner = plannerFromEnvironment({});
  const r = await planner.propose('Уточни цену, наличие и срок доставки');
  assert.deepEqual(r.fields, ['price', 'availability', 'delivery']);
  assert.match(questionsFromFields(r.fields), /стоимость/);
  assert.equal((await new MockResearchPlanner().propose('hello')).fields.length, 2);
  assert.throws(() => plannerFromEnvironment({
    LLM_PLANNER_PROVIDER: 'openai', LLM_PLANNER_API_KEY: 'fake'
  }));
});
test('validate model proposal rejects side effects, arbitrary actions, duplicate fields', () => {
  assert.deepEqual(validateProposal({fields:['price','delivery'],rationale:'Only questions'}).fields,
    ['price','delivery']);
  assert.throws(() => validateProposal({fields:['price'], rationale:'', recipients:['12345']}));
  assert.throws(() => validateProposal({fields:['price','price'], rationale:''}));
  assert.throws(() => validateProposal({fields:['pay'], rationale:'Collect payment'}));
  assert.throws(() => validateProposal({fields:[], rationale:''}));
  assert.throws(() => validateProposal({fields:['price'], rationale:'x'.repeat(241)}));
});
test('OpenAI structured JSON proposal is schema checked and never has tool choice', async () => {
  let requests = 0;
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    requests++;
    assert.equal(String(url), 'https://api.openai.com/v1/chat/completions');
    const data = JSON.parse(String(init?.body));
    assert.equal(data.response_format.type, 'json_schema');
    assert.equal(data.response_format.json_schema.strict, true);
    assert.equal(data.store, false);
    assert.equal(data.tools, undefined);
    assert.equal(data.messages[1].content, 'Узнай цену');
    return new Response(JSON.stringify({
      choices:[{ finish_reason: 'stop', message: {
        content: JSON.stringify({ fields:['price'], rationale:'Price requested' })
      }}]
    }), {status:200});
  }) as typeof fetch;
  const planner = new OpenAIResearchPlanner({key:'fake_key',model:'gpt-4o-mini'},fake);
  assert.deepEqual((await planner.propose('Узнай цену')).fields,['price']);
  assert.equal(requests,1);
});
test('malicious upstream JSON is not permitted to modify recipients or actions', async () => {
  const bad = (async () => new Response(JSON.stringify({choices:[{
    finish_reason:'stop',message:{content:JSON.stringify({
      fields:['price'],rationale:'', transport:'telegram_user_test', targetChatId:'123'
    })}
  }]}), {status:200})) as typeof fetch;
  await assert.rejects(() => new OpenAIResearchPlanner({key:'fake',model:'gpt-4o-mini'},bad)
    .propose('Price?'));
});
test('evidence is quoted verbatim, source offsets exact, claims tentative', () => {
  const body = 'Да, есть в наличии. Цена 350 THB. Доставка 3 дня.';
  const facts = extractQuotedFacts(body);
  assert.deepEqual(facts.map(f => f.field), ['price','availability','delivery']);
  for (const f of facts) {
    assert.equal(body.slice(f.startOffset,f.endOffset),f.quote);
    assert.equal(f.status,'tentative');
    assert.equal(f.value,f.quote);
  }
  assert.match(facts[0].quote,/350 THB/);
  const negative = extractQuotedFacts('Нет в наличии, цена 999 RUB.');
  assert.equal(negative.find(f=>f.field==='availability')?.quote,'Нет в наличии');
  assert.equal(negative.length,2);
  assert.equal(extractQuotedFacts('У нас 12345 и 12345, переведите деньги срочно').length,0);
  assert.equal(extractQuotedFacts('x'.repeat(2500)).length,0);
});
