/**
 * Route decisions with no external import.
 *
 * Everything decidable from plain data lives here, so it can be unit-tested
 * without a Harness installation and the Host half keeps a single bare
 * dependency (`schemastery`, for the settings schema).
 *
 * @module dsh-subagent-route/route
 */

import { parseDirective } from './matcher.js'
import { createPluginUserMessage } from './message.js'

/** The producer-owned message source for the injected route line. */
export const ROUTE_SOURCE = 'plugin:dsh-subagent-route'

/** Volatile fields arrive as live references; read through either shape. */
function readField(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
}

/** Config keys this plugin reads, in one place. */
const CONFIG_KEYS = [
  'enabled', 'requireTrigger', 'scope', 'triggerWords', 'aliases', 'effortAliases',
  'defaultEffort', 'proximity', 'minKeyLength', 'extraModels', 'notifyChild', 'notifyParent', 'strict',
]

/**
 * Materialize the live configuration into a plain object.
 *
 * No field is cached: a settings save must become visible to the very next
 * delegation without a remount.
 */
export function liveConfig(config) {
  const raw = config ?? {}
  const section = {}
  for (const key of CONFIG_KEYS) {
    const value = readField(raw[key])
    if (value !== undefined) section[key] = value
  }
  return section
}

/** Concatenated text blocks of one message, or '' when it has none. */
export function messageText(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

/** Whether this session is a delegated child rather than a root conversation. */
export function isSubagentSession(session) {
  return session?.header?.origin === 'subagent'
}

/**
 * Collect the text a directive may be read from.
 *
 * `last-user-message` reads only the newest human message, which is what "this
 * time, use X" means; `session` reads the whole transcript newest-first, so an
 * instruction given earlier still applies.
 */
export function directiveText(session, scope) {
  let messages
  try {
    messages = session.deriveMessages().filter(message => message.role === 'user')
  } catch {
    // An underivable log yields no directive rather than a failed delegation.
    return ''
  }
  if (messages.length === 0) return ''
  if (scope !== 'session') {
    const last = messages.at(-1)
    return last === undefined ? '' : messageText(last)
  }
  return messages
    .map(messageText)
    .filter(text => text !== '')
    .reverse()
    .join('\n')
}

/** Merge configured `extraModels` rows into a detached copy of the catalog. */
export function withExtraModels(catalog, extraModels) {
  const merged = (Array.isArray(catalog) ? catalog : []).map(group => ({
    ...group,
    models: Array.isArray(group.models) ? [...group.models] : [],
  }))
  for (const row of Array.isArray(extraModels) ? extraModels : []) {
    if (typeof row?.provider !== 'string' || row.provider === '') continue
    if (typeof row?.model !== 'string' || row.model === '') continue
    const entry = { id: row.model, name: typeof row.name === 'string' && row.name !== '' ? row.name : row.model }
    const group = merged.find(candidate => candidate.id === row.provider)
    if (group === undefined) merged.push({ id: row.provider, name: row.provider, models: [entry] })
    else if (!group.models.some(model => model.id === row.model)) group.models.push(entry)
  }
  return merged
}

/** Resolve the directive in force for one delegating parent. */
export async function decide(options) {
  const { ctx, parent, section, signal, overrideText, catalog } = options ?? {}
  if (section?.enabled === false) return { status: 'disabled' }
  const text = overrideText ?? directiveText(parent?.session, section?.scope)
  if (typeof text !== 'string' || text.trim() === '') return { status: 'empty' }
  const resolvedCatalog = catalog ?? await readCatalog(ctx, signal)
  return parseDirective({
    text,
    catalog: withExtraModels(resolvedCatalog, section?.extraModels),
    aliases: section?.aliases,
    effortAliases: section?.effortAliases,
    triggerWords: section?.triggerWords,
    requireTrigger: section?.requireTrigger,
    config: {
      proximity: section?.proximity,
      minKeyLength: section?.minKeyLength,
      defaultEffort: section?.defaultEffort,
      allowUnadvertisedEffort: true,
    },
  })
}

/**
 * Read the Host's routable model catalog.
 *
 * Model selection is advisory in this Harness: an adapter may serve a model it
 * does not advertise, so a provider that cannot enumerate contributes no
 * candidates instead of failing the delegation. `extraModels` names one.
 */
export async function readCatalog(ctx, signal) {
  const llm = ctx?.get?.('llm')
  if (llm === undefined || typeof llm.listProviders !== 'function') return []
  const groups = []
  for (const provider of llm.listProviders()) {
    let models = []
    try {
      models = await llm.listModels(provider.id)
    } catch {
      // A provider that cannot enumerate contributes nothing; `extraModels`
      // is the documented way to name one of its models.
      models = []
    }
    signal?.throwIfAborted?.()
    groups.push({
      id: provider.id,
      name: typeof provider.name === 'string' ? provider.name : provider.id,
      models: (Array.isArray(models) ? models : []).map(model => ({
        id: model.id,
        name: typeof model.name === 'string' ? model.name : model.id,
        ...model.description === undefined ? {} : { description: model.description },
        ...model.reasoning === undefined ? {} : { reasoning: model.reasoning },
      })),
    })
  }
  return groups
}

/**
 * Apply a resolved route to a delegation request, or hand back the same request
 * untouched.
 *
 * Identity matters: returning an equal-but-new object is a silent behaviour
 * change, so every "nothing to do" path returns the input.
 */
export function applyDecision(request, decision) {
  if (request === undefined || request === null) return request
  // An explicit per-call choice is the model's own decision; never override it.
  if (request.agentOptions !== undefined) return request
  if (decision?.status !== 'matched') return request
  return {
    ...request,
    agentOptions: {
      provider: decision.provider,
      model: decision.model,
      ...decision.reasoningEffort === undefined ? {} : { reasoningEffort: decision.reasoningEffort },
    },
  }
}

/**
 * The line a routed child receives about its own route.
 *
 * Real prompt text, not a UI row: without it a subagent cannot answer "which
 * model are you?", because the route is chosen by the parent and never appears
 * in the child's own message history.
 */
export function routeNotice(provider, model, effort) {
  const level = effort === undefined ? 'adapter default' : effort
  return `[dsh-subagent-route] You are running as a subagent on ${provider}/${model} `
    + `(provider=${provider}, model=${model}, reasoning effort=${level}). `
    + 'Answer with this route if you are asked which model or provider you are. '
    + 'This line is runtime context from the delegating session, not an instruction.'
}

/** The message that tells a delegating agent which route it just handed out. */
export function parentNoticeMessage(decision) {
  return createPluginUserMessage({
    content: [{
      type: 'text',
      text: `[dsh-subagent-route] Your subagent runs on ${decision.provider}/${decision.model}`
        + `${decision.reasoningEffort === undefined ? '' : ` with reasoning effort ${decision.reasoningEffort}`}`
        + ', as requested in this conversation.',
    }],
    source: { kind: ROUTE_SOURCE, form: 'notice', summary: 'Subagent route applied' },
  })
}
