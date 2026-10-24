/**
 * Behaviour tests for the route matcher. Run with `node --test`.
 *
 * The catalog mirrors the shapes a real Host serves: provider groups with
 * models, some advertising reasoning efforts and some not.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  catalogRoutes,
  findTrigger,
  foldText,
  parseDirective,
  resolveEffort,
  squash,
  textRuns,
} from '../lib/matcher.js'

const CATALOG = [
  {
    id: 'magpie-responses',
    name: 'Magpie · Responses',
    models: [
      {
        id: 'codex/gpt-6-luna',
        name: 'GPT-6-Luna · Codex',
        reasoning: {
          efforts: [
            { id: 'low', name: 'Low' },
            { id: 'high', name: 'High' },
            { id: 'xhigh', name: 'Extra high' },
            { id: 'max', name: 'Max' },
          ],
          defaultEffort: 'medium',
        },
      },
      {
        id: 'codex/gpt-6.1-sol',
        name: 'GPT-6.1-Sol · Codex',
        reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'xhigh', name: 'Extra high' }] },
      },
    ],
  },
  {
    id: 'magpie',
    name: 'Magpie',
    models: [
      // No reasoning block at all: a gateway that advertises nothing.
      { id: 'workbuddy/deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash · WorkBuddy' },
      { id: 'workbuddy/glm-5.3-flash', name: 'GLM-5.3-Flash · WorkBuddy' },
    ],
  },
]

const TRIGGERS = ['子agent', '子代理', 'subagent', '派发', '委派']
const BASE = { catalog: CATALOG, triggerWords: TRIGGERS, requireTrigger: true, config: {} }

test('foldText erases separators and case', () => {
  assert.equal(foldText('GPT-6-Luna'), 'gpt6luna')
  assert.equal(foldText('gpt_6_luna'), 'gpt6luna')
  assert.equal(foldText('codex/gpt-6-luna'), 'codexgpt6luna')
  assert.equal(foldText(undefined), '')
})

test('textRuns splits on non-alphanumerics', () => {
  assert.deepEqual(textRuns('GPT-6.1-Sol · Codex'), ['gpt', '6', '1', 'sol', 'codex'])
})

test('catalogRoutes indexes every provider/model with its keys and efforts', () => {
  const routes = catalogRoutes(CATALOG)
  assert.equal(routes.length, 4)
  const luna = routes.find(route => route.model === 'codex/gpt-6-luna')
  assert.equal(luna.provider, 'magpie-responses')
  assert.ok(luna.keys.includes('gpt6luna'))
  assert.equal(luna.efforts.length, 4)
})

test('the user phrasing from the request resolves to an exact route and effort', () => {
  const decision = parseDirective({ ...BASE, text: '这次大任务，子agent用 gpt6luna 思考程度xhigh' })
  assert.equal(decision.status, 'matched')
  assert.equal(decision.provider, 'magpie-responses')
  assert.equal(decision.model, 'codex/gpt-6-luna')
  assert.equal(decision.reasoningEffort, 'xhigh')
  assert.equal(decision.effortStatus, 'matched')
})

test('a spaced display name matches without the trigger being adjacent', () => {
  const decision = parseDirective({ ...BASE, text: 'subagent 请用 GPT-6-Luna 跑这个分析' })
  assert.equal(decision.status, 'matched')
  assert.equal(decision.model, 'codex/gpt-6-luna')
})

test('no trigger word means no directive by default', () => {
  const decision = parseDirective({ ...BASE, text: '用 gpt6luna 分析一下这个仓库' })
  assert.equal(decision.status, 'no-trigger')
})

test('requireTrigger false lets a bare model mention win', () => {
  const decision = parseDirective({ ...BASE, requireTrigger: false, text: '用 gpt6luna 分析一下这个仓库' })
  assert.equal(decision.status, 'matched')
  assert.equal(decision.model, 'codex/gpt-6-luna')
})

test('the full id beats a shorter fragment', () => {
  const decision = parseDirective({ ...BASE, text: '子agent 用 codex/gpt-6.1-sol 干活' })
  assert.equal(decision.status, 'matched')
  assert.equal(decision.model, 'codex/gpt-6.1-sol')
})

test('an unknown model is not found and never invented', () => {
  const decision = parseDirective({ ...BASE, text: '子agent 用 gpt9unicorn 干活' })
  assert.equal(decision.status, 'not-found')
})

test('a configured alias wins over the catalog spelling', () => {
  const decision = parseDirective({
    ...BASE,
    input: undefined,
    aliases: [{ alias: 'luna', provider: 'magpie-responses', model: 'codex/gpt-6-luna' }],
    text: '子agent 这次用 luna 跑',
  })
  assert.equal(decision.status, 'matched')
  assert.equal(decision.model, 'codex/gpt-6-luna')
})

test('an alias pointing at a route outside the catalog grants nothing', () => {
  const decision = parseDirective({
    ...BASE,
    aliases: [{ alias: 'ghost', provider: 'nope', model: 'nope/none' }],
    text: '子agent 用 ghost 跑',
  })
  assert.equal(decision.status, 'not-found')
})

test('two equally specific matches are ambiguous, not guessed', () => {
  const catalog = [
    { id: 'p1', name: 'P1', models: [{ id: 'model-alpha', name: 'Alpha' }] },
    { id: 'p2', name: 'P2', models: [{ id: 'model-alpha', name: 'Alpha' }] },
  ]
  const decision = parseDirective({ ...BASE, catalog, text: '子agent 用 model-alpha 跑' })
  assert.equal(decision.status, 'ambiguous')
  assert.equal(decision.candidates.length, 2)
})

test('a model advertising nothing accepts a built-in effort', () => {
  const decision = parseDirective({ ...BASE, text: '子agent 用 glm-5.3-flash 思考 high' })
  assert.equal(decision.status, 'matched')
  assert.equal(decision.model, 'workbuddy/glm-5.3-flash')
  assert.equal(decision.reasoningEffort, 'high')
})

test('an effort the model does not declare is withheld, keeping the route', () => {
  const decision = parseDirective({ ...BASE, text: '子agent 用 gpt-6.1-sol 思考 medium' })
  assert.equal(decision.status, 'matched')
  assert.equal(decision.model, 'codex/gpt-6.1-sol')
  assert.equal(decision.reasoningEffort, undefined)
  assert.equal(decision.unsupportedEffort, 'medium')
})

test('Chinese effort words resolve', () => {
  const decision = parseDirective({ ...BASE, text: '子agent 用 gpt6luna 思考程度极高' })
  assert.equal(decision.status, 'matched')
  assert.equal(decision.reasoningEffort, 'xhigh')
})

test('a configured default effort applies when the message names none', () => {
  const decision = parseDirective({
    ...BASE,
    config: { defaultEffort: 'high' },
    text: '子agent 用 gpt6luna 跑',
  })
  assert.equal(decision.status, 'matched')
  assert.equal(decision.reasoningEffort, 'high')
  assert.equal(decision.effortStatus, 'fallback')
})

test('a default effort the model does not declare is dropped', () => {
  const decision = parseDirective({
    ...BASE,
    config: { defaultEffort: 'medium' },
    text: '子agent 用 gpt-6.1-sol 跑',
  })
  assert.equal(decision.status, 'matched')
  assert.equal(decision.reasoningEffort, undefined)
})

test('proximity bounds how far the mention may sit from the trigger', () => {
  const far = `子agent ${'无关内容'.repeat(30)} gpt6luna`
  const decision = parseDirective({ ...BASE, config: { proximity: 40 }, text: far })
  assert.equal(decision.status, 'not-found')
})

test('empty text is empty, not not-found', () => {
  assert.equal(parseDirective({ ...BASE, text: '   ' }).status, 'empty')
})

test('findTrigger reports the earliest trigger', () => {
  const found = findTrigger('先委派再subagent', TRIGGERS)
  assert.equal(found.word, '委派')
})

test('resolveEffort prefers the longest spelling', () => {
  const route = { efforts: [{ id: 'high', name: 'High' }, { id: 'xhigh', name: 'Extra high' }] }
  const resolved = resolveEffort(squash('use xhigh please'), route, [])
  assert.equal(resolved.status, 'matched')
  assert.equal(resolved.effort, 'xhigh')
})
