/**
 * Smoke test for the built browser bundle.
 *
 * The bundle registers itself through `window.__ModuleLoader__.load`, so this
 * test supplies that hook, captures the factory, and calls it with a stub
 * `require` — exactly the shape the shell provides. It proves three things a
 * syntax check cannot:
 *
 *   1. the factory body evaluates (no syntax, reference, or top-level error);
 *   2. it registers the two slot surfaces with the right keys;
 *   3. the inlined matcher resolves a sentence the same way the Host does.
 *
 * Run after `node scripts/build-client.mjs`.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

/** Minimal module table mirroring what the shell hands a dynamic bundle. */
function createShell() {
  let factory
  let registeredId
  const slots = []
  const effects = []
  const page = {
    hooks: {},
    write: async () => true,
    resolve: async () => ({ status: 'empty' }),
    locale: 'en',
  }

  globalThis.window = {
    __ModuleLoader__: {
      load({ id, factory: make }) {
        registeredId = id
        factory = make
      },
    },
  }

  const ctx = {
    effect(fn, label) {
      const disposer = fn()
      effects.push({ label, disposer })
      return () => {}
    },
    slots: {
      inject(name, register) { register() },
      register(options) {
        slots.push(options)
        return () => {}
      },
    },
    locale: {
      getSnapshot: () => ({ active: 'zh' }),
      bind: () => key => key,
      register: () => () => {},
    },
    configForms: {
      get: ns => ({
        getSnapshot: () => ({ status: 'ready', writable: true, revision: 3, value: {} }),
        subscribe: () => () => {},
        mutate: async () => true,
      }),
      describe: () => ({ getSnapshot: () => ({ view: { namespaces: [] } }) }),
    },
    remote: {
      session: {
        modelCatalog: async () => ({
          ok: true,
          value: {
            groups: [{
              id: 'p',
              name: 'P',
              models: [{ id: 'codex/gpt-6-luna', name: 'Luna', reasoning: { efforts: [{ id: 'xhigh', name: 'X-high' }] } }],
            }],
          },
        }),
      },
    },
  }

  const require = (specifier) => {
    if (specifier === 'react') {
      const createElement = () => null
      return { createElement, useState: () => [undefined, () => {}], useEffect: () => {}, useCallback: fn => fn, useRef: () => ({ current: undefined }) }
    }
    throw new Error(`unexpected module request: ${specifier}`)
  }

  return {
    get id() { return registeredId },
    get slots() { return slots },
    get page() { return page },
    /** Run the registered factory and unpack the plugin face. */
    boot() {
      const plugin = factory(require)
      plugin.apply(ctx)
      return plugin
    },
    ctx,
    effects,
  }
}

const shell = createShell()
// The bundle registers on load, which is what this import triggers.
await import('../lib/client.js')

test('the bundle registers under the package name', () => {
  assert.equal(shell.id, 'dsh-subagent-route')
})

test('the plugin declares the services it actually uses', () => {
  const plugin = shell.boot()
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'configForms'])
})

test('both configuration surfaces are registered with their dispatch keys', () => {
  assert.deepEqual(shell.slots.map(entry => entry.name), ['plugins.row.config', 'plugins.bundle.config'])
  assert.equal(shell.slots[0].key, 'dsh-subagent-route#dsh-subagent-route')
  assert.equal(shell.slots[1].key, 'dsh-subagent-route')
})

test('the injected face exposes one snapshot source and a write path', () => {
  const injected = shell.slots[0].inject()
  assert.ok(injected.hooks.form !== undefined)
  assert.equal(typeof injected.write, 'function')
  assert.equal(typeof injected.resolve, 'function')
  assert.equal(injected.locale, 'zh')
})

test('the inlined matcher resolves a sentence exactly like the Host', async () => {
  const injected = shell.slots[0].inject()
  const decision = await injected.resolve('这次大任务，子agent用 gpt6luna 思考程度xhigh')
  assert.equal(decision.status, 'matched')
  assert.equal(decision.provider, 'p')
  assert.equal(decision.model, 'codex/gpt-6-luna')
  assert.equal(decision.reasoningEffort, 'xhigh')
})

test('a sentence with no trigger word is reported, not guessed', async () => {
  const injected = shell.slots[0].inject()
  const decision = await injected.resolve('帮我把这段代码格式化一下')
  assert.equal(decision.status, 'no-trigger')
})

test('an unknown model is not found', async () => {
  const injected = shell.slots[0].inject()
  const decision = await injected.resolve('子agent 用 gpt9unicorn')
  assert.equal(decision.status, 'not-found')
})
