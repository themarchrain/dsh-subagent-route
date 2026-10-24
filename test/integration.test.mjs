/**
 * End-to-end wiring test: `apply()` against a stand-in Host.
 *
 * This is deliberately not a unit test of a helper. It builds the smallest
 * Cordis-shaped context the plugin actually touches, then drives the real
 * `apply` → `install` → wrapper → `agent/created` path, so it proves the three
 * behaviours that make the plugin "perfectly compatible":
 *
 *   1. an undescribed delegation is dispatched with the SAME request object;
 *   2. a described delegation gains `agentOptions` and nothing else changes;
 *   3. an explicit per-call choice is never overridden;
 *
 * plus the two route-visibility behaviours: the child receives a system-prompt
 * context describing its route, and nothing is injected when the user is silent.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../lib/index.js'

/** A live config object shaped like a resolved schemastery Config. */
function configOf(overrides = {}) {
  return {
    enabled: true,
    requireTrigger: true,
    scope: 'last-user-message',
    triggerWords: ['子agent', 'subagent'],
    aliases: [],
    effortAliases: [],
    defaultEffort: '',
    proximity: 80,
    minKeyLength: 4,
    extraModels: [],
    notifyChild: true,
    notifyParent: false,
    strict: false,
    ...overrides,
  }
}

/** The catalog the fake LLM service advertises. */
const PROVIDERS = [{ id: 'magpie-responses', name: 'Magpie · Responses' }]
const MODELS = {
  'magpie-responses': [
    { id: 'codex/gpt-6-luna', name: 'GPT-6-Luna', reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'xhigh', name: 'Extra high' }] } },
    { id: 'codex/gpt-6.1-sol', name: 'GPT-6.1-Sol', reasoning: { efforts: [{ id: 'high', name: 'High' }] } },
  ],
}

/**
 * Build the Host stand-in.
 *
 * @param options - the parent's last message and the config to mount with.
 * @returns the fake context, its recorded effects, and the dispatch log.
 */
function createHost(options = {}) {
  const dispatched = []
  const listeners = new Map()
  const effects = []
  const injected = []
  const contextSections = []
  const childAgent = {
    id: 'child-1',
    session: { header: { origin: 'subagent', parentSession: 'parent-1' } },
    options: { provider: 'magpie-responses', model: 'codex/gpt-6-luna', reasoningEffort: 'xhigh' },
    ctx: {
      get: name => (name === 'systemPrompt'
        ? {
            context: section => { contextSections.push(section); return () => {} },
            getContextOrder: () => 120,
          }
        : undefined),
    },
  }

  const rawSubagents = {
    startActivation: async spec => {
      dispatched.push(spec)
      return { childId: 'child-1', messageId: 'm-1', result: Promise.resolve({ output: [] }), dispose: async () => {} }
    },
  }

  const lastMessage = options.lastMessage ?? '帮我看看这个仓库'
  const parent = {
    id: 'parent-1',
    session: {
      header: { origin: undefined },
      deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: lastMessage }] }],
    },
    inject: message => { injected.push(message) },
  }

  // The real `ctx.subagents` is a Cordis traceable proxy: property reads forward
  // to the service instance, so replacing a method on the instance is visible
  // through the proxy. A plain object spread would copy the method instead and
  // hide the wrapper, which is exactly the bug this shape avoids.
  const service = new Proxy(rawSubagents, {
    get(target, property) {
      if (property === Symbol.for('cordis.original')) return target
      return Reflect.get(target, property)
    },
    set(target, property, value) {
      return Reflect.set(target, property, value)
    },
  })

  const ctx = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    config: options.config ?? configOf(),
    get(name) {
      if (name === 'llm') {
        return {
          listProviders: () => PROVIDERS,
          listModels: async provider => MODELS[provider] ?? [],
        }
      }
      if (name === 'agents') return { get: id => (id === 'child-1' ? childAgent : undefined) }
      return undefined
    },
    effect(fn) {
      effects.push(fn())
      return () => {}
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    },
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) listener(payload)
    },
    inject(names, install) {
      // The real fiber waits for these services; here they are all present.
      const childCtx = { ...ctx, subagents: service }
      install(childCtx)
      return () => {}
    },
  }

  return {
    ctx,
    parent,
    dispatched,
    listeners,
    injected,
    contextSections,
    /** Dispatch one delegation and return what the wrapper produced. */
    async delegate(request) {
      return await service.startActivation({ provider: 'spawn', label: 'task', request, signal: new AbortController().signal, delivery: 'parent' })
    },
    /** Publish the child the way the Host does after a successful start. */
    async publish() {
      for (const listener of listeners.get('agent/created') ?? []) await listener({ agent: childAgent, source: 'startup' })
    },
  }
}

const baseRequest = parent => ({ prompt: [{ type: 'text', text: 'task' }], parent })

test('a described delegation gains the named route and keeps everything else', async () => {
  const host = createHost({ lastMessage: '这次大任务，子agent用 gpt6luna 思考程度xhigh' })
  apply(host.ctx, host.ctx.config)
  const request = baseRequest(host.parent)
  await host.delegate(request)
  assert.equal(host.dispatched.length, 1)
  const spec = host.dispatched[0]
  assert.deepEqual(spec.request.agentOptions, {
    provider: 'magpie-responses',
    model: 'codex/gpt-6-luna',
    reasoningEffort: 'xhigh',
  })
  // Everything the Host built is still there: only agentOptions was added.
  assert.equal(spec.request.prompt, request.prompt)
  assert.equal(spec.request.parent, host.parent)
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.delivery, 'parent')
})

test('a silent user gets the identical request object back', async () => {
  const host = createHost({ lastMessage: '帮我把这段代码格式化一下' })
  apply(host.ctx, host.ctx.config)
  const request = baseRequest(host.parent)
  await host.delegate(request)
  assert.equal(host.dispatched[0].request, request)
  assert.equal('agentOptions' in host.dispatched[0].request, false)
})

test('an explicit per-call route is never overridden', async () => {
  const host = createHost({ lastMessage: '子agent用 gpt6luna 思考程度xhigh' })
  apply(host.ctx, host.ctx.config)
  const explicit = { provider: 'explicit', model: 'chosen' }
  const request = { ...baseRequest(host.parent), agentOptions: explicit }
  await host.delegate(request)
  assert.equal(host.dispatched[0].request.agentOptions, explicit)
})

test('enabled:false changes nothing at all', async () => {
  const host = createHost({ lastMessage: '子agent用 gpt6luna', config: configOf({ enabled: false }) })
  apply(host.ctx, host.ctx.config)
  const request = baseRequest(host.parent)
  await host.delegate(request)
  assert.equal(host.dispatched[0].request, request)
})

test('an unknown model leaves the delegation untouched rather than guessing', async () => {
  const host = createHost({ lastMessage: '子agent用 gpt9unicorn' })
  apply(host.ctx, host.ctx.config)
  const request = baseRequest(host.parent)
  await host.delegate(request)
  assert.equal(host.dispatched[0].request, request)
})

test('strict mode refuses an ambiguous name, and fail-open mode delegates anyway', async () => {
  const ambiguous = 'subagent 用 gpt-6-luna'
  const models = {
    'magpie-responses': [
      { id: 'gpt-6-luna', name: 'Luna' },
      { id: 'gpt6/luna', name: 'Luna' },
    ],
  }
  const build = (strict) => {
    const host = createHost({ lastMessage: ambiguous, config: configOf({ strict }) })
    // Two providers advertising the same display name at the same specificity.
    host.ctx.get = (name) => {
      if (name === 'llm') {
        return { listProviders: () => [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }], listModels: async () => models['magpie-responses'] }
      }
      return undefined
    }
    apply(host.ctx, host.ctx.config)
    return host
  }
  await assert.rejects(
    () => build(true).delegate(baseRequest(build(true).parent)),
    /ambiguous/u,
  )
  const lenient = build(false)
  const request = baseRequest(lenient.parent)
  await lenient.delegate(request)
  assert.equal(lenient.dispatched[0].request, request)
})

test('the published child is told its route in its own context', async () => {
  const host = createHost({ lastMessage: '子agent用 gpt6luna 思考效果xhigh' })
  apply(host.ctx, host.ctx.config)
  await host.delegate(baseRequest(host.parent))
  await host.publish()
  assert.equal(host.contextSections.length, 1)
  const [section] = host.contextSections
  assert.equal(section.name, 'dsh-subagent-route:route')
  assert.equal(section.order, 120)
  assert.match(section.text, /magpie-responses\/codex\/gpt-6-luna/u)
  assert.match(section.text, /reasoning effort=xhigh/u)
})

test('a child of a session that described nothing gets no route context', async () => {
  const host = createHost({ lastMessage: '随便聊聊' })
  apply(host.ctx, host.ctx.config)
  await host.delegate(baseRequest(host.parent))
  await host.publish()
  assert.equal(host.contextSections.length, 0)
})

test('notifyChild:false suppresses the child context', async () => {
  const host = createHost({
    lastMessage: '子agent用 gpt6luna',
    config: configOf({ notifyChild: false }),
  })
  apply(host.ctx, host.ctx.config)
  await host.delegate(baseRequest(host.parent))
  await host.publish()
  assert.equal(host.contextSections.length, 0)
})

test('notifyParent:true injects one notice into the delegating session', async () => {
  const host = createHost({
    lastMessage: '子agent用 gpt6luna 思考程度xhigh',
    config: configOf({ notifyParent: true }),
  })
  apply(host.ctx, host.ctx.config)
  await host.delegate(baseRequest(host.parent))
  assert.equal(host.injected.length, 1)
  const [message] = host.injected
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'plugin:dsh-subagent-route')
  assert.match(message.content[0].text, /magpie-responses\/codex\/gpt-6-luna/u)
})

test('notifyParent defaults to off, so a delegation adds no visible row', async () => {
  const host = createHost({ lastMessage: '子agent用 gpt6luna' })
  apply(host.ctx, host.ctx.config)
  await host.delegate(baseRequest(host.parent))
  assert.equal(host.injected.length, 0)
})

test('a subagent delegating further keeps the route it was given', async () => {
  const host = createHost({ lastMessage: '子agent用 gpt6luna 思考程度xhigh' })
  apply(host.ctx, host.ctx.config)
  const childParent = {
    id: 'parent-2',
    session: {
      header: { origin: 'subagent', parentSession: 'parent-1' },
      deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: '子agent用 gpt-6.1-sol' }] }],
    },
    inject: () => {},
  }
  const request = { prompt: [], parent: childParent }
  await host.delegate(request)
  // The child's own delegation is dispatched untouched: its route was decided
  // when IT was created, not by re-reading prose.
  assert.equal(host.dispatched[0].request, request)
})

test('a catalog read failure degrades to inheritance instead of failing the delegation', async () => {
  const host = createHost({ lastMessage: '子agent用 gpt6luna' })
  host.ctx.get = (name) => {
    if (name === 'llm') {
      return {
        listProviders: () => { throw new Error('provider registry exploded') },
        listModels: async () => [],
      }
    }
    return undefined
  }
  apply(host.ctx, host.ctx.config)
  const request = baseRequest(host.parent)
  await host.delegate(request)
  assert.equal(host.dispatched[0].request, request)
})

test('a live config change applies to the next delegation without a remount', async () => {
  const host = createHost({ lastMessage: '子agent用 gpt6luna' })
  apply(host.ctx, host.ctx.config)
  await host.delegate(baseRequest(host.parent))
  assert.ok(host.dispatched[0].request.agentOptions !== undefined)

  // The Host writes a settings change; volatile fields stay live references,
  // which is exactly what this reproduces.
  let enabled = true
  host.ctx.config.enabled = { get: () => enabled }
  enabled = false
  const second = baseRequest(host.parent)
  await host.delegate(second)
  assert.equal(host.dispatched[1].request, second)
})

test('extraModels lets a gateway that advertises nothing still be named', async () => {
  const host = createHost({
    lastMessage: '子agent用 hidden-9',
    config: configOf({ extraModels: [{ provider: 'silent-gw', model: 'hidden-9', name: 'Hidden 9' }] }),
  })
  host.ctx.get = (name) => {
    if (name === 'llm') return { listProviders: () => [], listModels: async () => [] }
    return undefined
  }
  apply(host.ctx, host.ctx.config)
  await host.delegate(baseRequest(host.parent))
  assert.deepEqual(host.dispatched[0].request.agentOptions, { provider: 'silent-gw', model: 'hidden-9' })
})

test('an alias turns the user word into the exact route', async () => {
  const host = createHost({
    lastMessage: '子agent 这次用 luna 跑',
    config: configOf({ aliases: [{ alias: 'luna', provider: 'magpie-responses', model: 'codex/gpt-6-luna' }] }),
  })
  apply(host.ctx, host.ctx.config)
  await host.delegate(baseRequest(host.parent))
  assert.equal(host.dispatched[0].request.agentOptions.model, 'codex/gpt-6-luna')
})
