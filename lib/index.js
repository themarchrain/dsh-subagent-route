/**
 * dsh-subagent-route — Host half.
 *
 * Lets a user fix the routing of the NEXT subagent delegation from ordinary
 * conversation prose ("this time the subagent should run on gpt6luna with
 * xhigh thinking") without giving up a single stock capability:
 *
 *   · When the user names a route, delegations in this session use it.
 *   · When the user says nothing, nothing changes: the request object is
 *     returned by identity, so the harness's own inheritance still applies.
 *   · An explicit per-call `agentOptions` always wins over both.
 *
 * Two seams, neither of which replaces host behaviour:
 *
 *   1. `ctx.subagents.startActivation` is wrapped. That is the one entry point
 *      every 0.2.x delegation path uses (`subagent`, `subagent_fork`, workflow
 *      agents, `spawn_teammate`), so one wrapper covers them all.
 *   2. `agent/created` runs for every published child before it may claim any
 *      input, which is the one deterministic moment to hand the child a
 *      durable statement of its own route.
 *
 * Every decision is fail-open: any resolution problem leaves the delegation
 * exactly as the harness would have made it, because a plugin that blocks
 * subagents is worse than one that occasionally misses.
 *
 * @module dsh-subagent-route
 */

import z from '@deepseek-ai/schemastery'
import { MATCHER_VERSION } from './matcher.js'
import {
  applyDecision,
  decide,
  isSubagentSession,
  liveConfig,
  parentNoticeMessage,
  routeNotice,
} from './route.js'

export const name = 'dsh-subagent-route'

/** Cordis services consulted at call time; absence only disables the matching feature. */
export const inject = ['subagents']

/** How long an applied directive stays associated with its delegating parent. */
const APPLIED_TTL_MS = 120_000

/** A schema field the settings page may edit without a remount. */
function volatile(schema) {
  // `volatile()` is schemastery 3.18.4+; `extra()` carries the same marker on
  // older builds and is harmless alongside it.
  if (typeof schema?.volatile === 'function') return schema.volatile()
  if (typeof schema?.extra === 'function') return schema.extra('volatile', true)
  return schema
}

/**
 * Every field carries `.default(...)`, including the string ones.
 *
 * The settings surface is built by `projectForm()`, which drops a field whose
 * resolved value is `undefined`. A bare `z.string()` therefore disappears from
 * the descriptor the page reads and writes against, and every save is refused
 * with a message about a field the form cannot see. Declaring `''` keeps the
 * field present-and-empty, which is the "not configured" state this plugin
 * treats as unset.
 */
export const Config = z.object({
  enabled: volatile(z.boolean().default(true)
    .description('Apply a route the user names in conversation to subagent delegations')),
  requireTrigger: volatile(z.boolean().default(true)
    .description('Only read a message that names a subagent (trigger word); disable to match any message')),
  scope: volatile(z.union([z.const('last-user-message'), z.const('session')]).default('last-user-message')
    .description('Where the directive is searched: the latest user message, or the whole session')),
  triggerWords: volatile(z.array(z.string()).default(['子agent', '子代理', 'subagent', '派发', '委派'])
    .description('Words that announce a subagent rule')),
  aliases: volatile(z.array(z.object({
    alias: z.string().default(''),
    provider: z.string().default(''),
    model: z.string().default(''),
  })).default([]).description('Extra names for an existing provider/model route')),
  effortAliases: volatile(z.array(z.object({
    alias: z.string().default(''),
    effort: z.string().default(''),
  })).default([]).description('Extra spellings for a reasoning effort')),
  defaultEffort: volatile(z.string().default('')
    .description('Effort to apply when a message names a model but no thinking level')),
  proximity: volatile(z.number().step(1).min(20).max(2000).default(80)
    .description('How many characters after the trigger word a model name may appear')),
  minKeyLength: volatile(z.number().step(1).min(3).max(32).default(4)
    .description('Shortest model-name fragment accepted as a match')),
  extraModels: volatile(z.array(z.object({
    provider: z.string().default(''),
    model: z.string().default(''),
    name: z.string().default(''),
  })).default([]).description('Catalog rows to add for models an adapter does not advertise')),
  notifyChild: volatile(z.boolean().default(true)
    .description('Tell each routed subagent which route it is running on, in its own context')),
  notifyParent: volatile(z.boolean().default(false)
    .description('Also tell the delegating agent which route its subagent was given')),
  strict: volatile(z.boolean().default(false)
    .description('Refuse an ambiguous name instead of falling back to inheritance')),
})

/**
 * Report one decision at the level its outcome deserves: a miss is per-delegation
 * noise, a match or a genuine ambiguity is worth a log line.
 */
function logDecision(ctx, decision) {
  if (decision.status === 'matched') {
    ctx.logger.info('[dsh-subagent-route] subagent route %s/%s%s',
      decision.provider, decision.model,
      decision.reasoningEffort === undefined ? '' : ` effort=${decision.reasoningEffort}`)
    return
  }
  if (decision.status === 'ambiguous') {
    ctx.logger.warn('[dsh-subagent-route] the session names an ambiguous subagent model (%s); delegating unchanged',
      decision.candidates.map(candidate => `${candidate.provider}/${candidate.model}`).join(', '))
    return
  }
  ctx.logger.debug('[dsh-subagent-route] no route directive (%s)', decision.status)
}

/** Install the delegation seam on one context that can see `subagents`. */
function install(ctx, state) {
  // `ctx.subagents` is a per-call Cordis traceable proxy; the raw service behind
  // it is the stable object whose method can be replaced and restored.
  const raw = ctx.subagents?.[Symbol.for('cordis.original')] ?? ctx.subagents
  if (raw === undefined || raw === null) return
  const original = raw.startActivation
  if (typeof original !== 'function') return

  const wrapped = async function startActivation(spec) {
    if (spec === undefined || spec === null) return original.call(raw, spec)
    const section = liveConfig(state.config)
    if (section.enabled === false) return original.call(raw, spec)
    const parent = spec.request?.parent
    // A subagent delegating further keeps the route it was given; only the root
    // conversation states intent in prose.
    if (parent === undefined || isSubagentSession(parent.session)) return original.call(raw, spec)

    let decision
    try {
      decision = await decide({ ctx, parent, section, signal: spec.signal })
    } catch (error) {
      if (section.strict === true) throw error
      ctx.logger.warn('[dsh-subagent-route] could not read the route directive, delegating unchanged: %s', String(error))
      return original.call(raw, spec)
    }

    if (decision.status === 'ambiguous' && section.strict === true) {
      throw new Error('dsh-subagent-route: the subagent model named in this session is ambiguous ('
        + decision.candidates.map(candidate => `${candidate.provider}/${candidate.model}`).join(', ')
        + '); name the provider as well, or turn strict mode off')
    }

    const request = applyDecision(spec.request, decision)
    if (request === spec.request) {
      logDecision(ctx, decision)
      return original.call(raw, spec)
    }

    logDecision(ctx, decision)
    state.applied.set(parent.id, { decision, at: Date.now() })
    if (section.notifyParent === true) {
      try {
        parent.inject?.(parentNoticeMessage(decision))
      } catch (error) {
        ctx.logger.warn('[dsh-subagent-route] could not notify the delegating agent: %s', String(error))
      }
    }
    return original.call(raw, { ...spec, request })
  }

  raw.startActivation = wrapped
  ctx.effect(() => () => {
    if (raw.startActivation === wrapped) raw.startActivation = original
  }, 'dsh-subagent-route: startActivation wrapper')

  // Every published child passes here before it may claim input.
  ctx.effect(() => ctx.on('agent/created', ({ agent }) => {
    const section = liveConfig(state.config)
    if (section.enabled === false) return
    const session = agent?.session
    if (!isSubagentSession(session)) return
    const parentId = session.header.parentSession
    const applied = parentId === undefined ? undefined : state.applied.get(parentId)
    if (applied === undefined) return
    if (Date.now() - applied.at > APPLIED_TTL_MS) {
      state.applied.delete(parentId)
      return
    }
    // The child's own options are the truth: the wrapper already put the
    // decision there, and the harness may legitimately resolve it further.
    const options = agent.options ?? {}
    if (options.provider === undefined || options.model === undefined) return
    if (section.notifyChild === false) return
    try {
      const systemPrompt = agent.ctx.get('systemPrompt')
      systemPrompt?.context({
        name: 'dsh-subagent-route:route',
        order: systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
        text: routeNotice(options.provider, options.model, options.reasoningEffort),
      })
    } catch (error) {
      ctx.logger.warn('[dsh-subagent-route] could not tell the child its route: %s', String(error))
    }
  }), 'dsh-subagent-route: child route notice')

  ctx.effect(() => ctx.on('agent/disposed', ({ agent }) => {
    if (agent?.session?.header?.origin !== 'subagent') return
    const parentId = agent.session.header.parentSession
    if (parentId !== undefined) state.applied.delete(parentId)
  }), 'dsh-subagent-route: applied state cleanup')
}

/** Mount the plugin. */
export function apply(ctx, config) {
  const state = {
    config,
    /** Parent id → the directive this plugin last applied for it. */
    applied: new Map(),
  }

  // `subagents` may mount after this row; the child fiber re-runs when it does
  // and unwinds the wrapper when it goes away.
  ctx.inject(['subagents'], (subagentCtx) => {
    install(subagentCtx, state)
  })

  ctx.effect(() => () => {
    state.applied.clear()
  }, 'dsh-subagent-route: state')
}

/** Re-exported for diagnostics: a copied build shows up in a stack trace. */
export { MATCHER_VERSION }
