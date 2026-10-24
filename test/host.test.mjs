/**
 * Behaviour tests for the Host half's pure decisions: request identity, route
 * notices, live-config reading, and the exact wording a child receives.
 *
 * These do not boot Cordis. They pin the two properties that matter most for
 * "perfect compatibility": a delegation the user did not describe is handed
 * back by identity, and an explicit per-call choice is never overridden.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyDecision,
  decide,
  directiveText,
  isSubagentSession,
  liveConfig,
  messageText,
  parentNoticeMessage,
  routeNotice,
  withExtraModels,
} from '../lib/route.js'

const MATCHED = {
  status: 'matched',
  provider: 'magpie-responses',
  model: 'codex/gpt-6-luna',
  reasoningEffort: 'xhigh',
}

test('a request the user did not describe is returned by identity', () => {
  const request = { prompt: [], parent: {} }
  assert.equal(applyDecision(request, { status: 'not-found' }), request)
  assert.equal(applyDecision(request, { status: 'no-trigger' }), request)
  assert.equal(applyDecision(request, { status: 'empty' }), request)
  assert.equal(applyDecision(request, undefined), request)
})

test('an explicit per-call agentOptions always wins', () => {
  const explicit = { provider: 'p', model: 'm' }
  const request = { prompt: [], parent: {}, agentOptions: explicit }
  const applied = applyDecision(request, MATCHED)
  assert.equal(applied, request)
  assert.equal(applied.agentOptions, explicit)
})

test('a matched directive fills agentOptions without touching anything else', () => {
  const parent = { id: 'parent' }
  const request = { prompt: [{ type: 'text', text: 'task' }], parent, maxDepth: 1 }
  const applied = applyDecision(request, MATCHED)
  assert.notEqual(applied, request)
  assert.deepEqual(applied.agentOptions, {
    provider: 'magpie-responses',
    model: 'codex/gpt-6-luna',
    reasoningEffort: 'xhigh',
  })
  assert.equal(applied.parent, parent)
  assert.equal(applied.maxDepth, 1)
  assert.deepEqual(applied.prompt, request.prompt)
})

test('a route without an effort carries no reasoningEffort key at all', () => {
  const applied = applyDecision({ prompt: [], parent: {} }, { status: 'matched', provider: 'p', model: 'm' })
  assert.equal('reasoningEffort' in applied.agentOptions, false)
})

test('null and undefined requests pass through', () => {
  assert.equal(applyDecision(undefined, MATCHED), undefined)
  assert.equal(applyDecision(null, MATCHED), null)
})

test('liveConfig unwraps volatile references and fills nothing else', () => {
  const section = liveConfig({
    enabled: { get: () => false },
    proximity: { get: () => 120 },
    triggerWords: { get: () => ['subagent'] },
    unknownField: 'ignored',
  })
  assert.equal(section.enabled, false)
  assert.equal(section.proximity, 120)
  assert.deepEqual(section.triggerWords, ['subagent'])
  assert.equal('unknownField' in section, false)
})

test('liveConfig tolerates a missing config', () => {
  assert.deepEqual(liveConfig(undefined), {})
  assert.deepEqual(liveConfig(null), {})
})

test('the route notice names the route and disclaims itself as an instruction', () => {
  const text = routeNotice('magpie-responses', 'codex/gpt-6-luna', 'xhigh')
  assert.match(text, /magpie-responses\/codex\/gpt-6-luna/)
  assert.match(text, /reasoning effort=xhigh/)
  assert.match(text, /not an instruction/)
})

test('an absent effort is reported as the adapter default', () => {
  assert.match(routeNotice('p', 'm', undefined), /reasoning effort=adapter default/)
})

test('the injected message is frozen, identified, and producer-sourced', () => {
  const message = parentNoticeMessage({ provider: 'p', model: 'm' })
  assert.equal(message.role, 'user')
  assert.match(message.id, /^[0-9a-f-]{36}$/u)
  assert.ok(Object.isFrozen(message))
  assert.ok(Object.isFrozen(message.content))
  assert.ok(Object.isFrozen(message.content[0]))
  assert.equal(message.source.kind, 'plugin:dsh-subagent-route')
})

test('two messages never share an identity', () => {
  const build = () => parentNoticeMessage({ provider: 'p', model: 'm' })
  assert.notEqual(build().id, build().id)
})

const userMessage = text => ({ role: 'user', content: [{ type: 'text', text }] })

test('messageText joins only text blocks', () => {
  assert.equal(messageText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }), 'a\nb')
  assert.equal(messageText({ content: [] }), '')
  assert.equal(messageText({}), '')
})

test('isSubagentSession reads the durable header marker', () => {
  assert.equal(isSubagentSession({ header: { origin: 'subagent' } }), true)
  assert.equal(isSubagentSession({ header: {} }), false)
  assert.equal(isSubagentSession(undefined), false)
})

const sessionOf = (...messages) => ({
  header: {},
  deriveMessages: () => messages,
})

test('last-user-message scope reads only the newest user message', () => {
  const session = sessionOf(userMessage('子agent 用 gpt6luna'), userMessage('再改一下这段代码'))
  assert.equal(directiveText(session, 'last-user-message'), '再改一下这段代码')
})

test('session scope reads the whole transcript newest-first', () => {
  const session = sessionOf(userMessage('子agent 用 gpt6luna'), userMessage('继续'))
  assert.equal(directiveText(session, 'session'), '继续\n子agent 用 gpt6luna')
})

test('a session with no user messages yields no directive', () => {
  assert.equal(directiveText(sessionOf(), 'session'), '')
})

test('a session whose log cannot be derived yields no directive instead of throwing', () => {
  const broken = { header: {}, deriveMessages() { throw new Error('corrupt log') } }
  assert.equal(directiveText(broken, 'last-user-message'), '')
})

test('withExtraModels adds rows without mutating the input catalog', () => {
  const catalog = [{ id: 'p', name: 'P', models: [{ id: 'a', name: 'A' }] }]
  const merged = withExtraModels(catalog, [
    { provider: 'p', model: 'b', name: 'B' },
    { provider: 'q', model: 'c', name: '' },
    { provider: '', model: 'ignored', name: '' },
  ])
  assert.deepEqual(catalog[0].models.map(model => model.id), ['a'])
  assert.deepEqual(merged[0].models.map(model => model.id), ['a', 'b'])
  assert.equal(merged[1].id, 'q')
  assert.equal(merged[1].models[0].name, 'c')
})

test('decide returns disabled without touching the session', async () => {
  const decision = await decide({ ctx: {}, parent: sessionOf(userMessage('x')), section: { enabled: false } })
  assert.equal(decision.status, 'disabled')
})

test('decide resolves against the supplied catalog and section', async () => {
  const catalog = [{
    id: 'p',
    name: 'P',
    models: [{ id: 'codex/gpt-6-luna', name: 'Luna', reasoning: { efforts: [{ id: 'xhigh', name: 'X-high' }] } }],
  }]
  const parent = { session: sessionOf(userMessage('这次大任务，子agent用 gpt6luna 思考程度xhigh')) }
  const decision = await decide({
    ctx: {},
    parent,
    section: { enabled: true, requireTrigger: true, scope: 'last-user-message', triggerWords: ['子agent'] },
    catalog,
  })
  assert.equal(decision.status, 'matched')
  assert.equal(decision.model, 'codex/gpt-6-luna')
  assert.equal(decision.reasoningEffort, 'xhigh')
})
