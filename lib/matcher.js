/**
 * Route-directive matcher: turns one piece of user prose into an exact
 * `{ provider, model, reasoningEffort }` child route.
 *
 * Dependency-free and side-effect free, so it can be unit-tested directly and a
 * Host build can never fail on a missing package. Every function is pure.
 *
 * The matcher NEVER echoes the user's words back as an id. It only returns a
 * route that exists in the catalog (or in a user-configured alias); anything it
 * cannot resolve uniquely becomes an explicit `ambiguous` / `not-found`
 * decision, which callers must treat as "inject nothing".
 *
 * @module dsh-subagent-route/matcher
 */

/** Separators that carry no meaning when comparing a user word with a model id. */
const SEPARATORS = /[^a-z0-9]+/gu

/** Shortest normalized key considered a real mention, so "6" or "ai" cannot match. */
const DEFAULT_MIN_KEY_LENGTH = 4

/** How far after a trigger word a model mention may appear. */
const DEFAULT_PROXIMITY = 80

/**
 * Fold a string to its comparison form: lowercase, separators and CJK removed,
 * so `GPT-6-Luna`, `gpt_6_luna` and `gpt6luna` all become `gpt6luna`.
 * This is what lets a user type a model id the way they remember it.
 */
export function foldText(value) {
  return typeof value === 'string' ? value.toLowerCase().replace(SEPARATORS, '') : ''
}

/** Split text into lowercase `[a-z0-9]` runs, dropping punctuation and CJK. */
export function textRuns(value) {
  if (typeof value !== 'string') return []
  return value.toLowerCase().split(SEPARATORS).filter(run => run.length > 0)
}

/**
 * Fold text to its comparison form while remembering where each folded
 * character came from.
 *
 * Boundaries cannot be tested on the folded string: folding erases the
 * separators that delimit a word, so `off` would match inside `office` and
 * `high` inside `xhigh`. Carrying the source index of every folded character
 * lets a match be validated against the original text, where
 * `子agent用gpt6luna跑` still ends `gpt6luna` at a real boundary.
 */
export function squash(value) {
  const source = typeof value === 'string' ? value.toLowerCase() : ''
  let text = ''
  const map = []
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (!/[a-z0-9]/u.test(character)) continue
    text += character
    map.push(index)
  }
  return { source, text, map }
}

/**
 * Whether one folded key occurs in folded text on a real token boundary.
 *
 * @param squashed - result of {@link squash}.
 * @returns the matched index in the folded text, or -1.
 */
function findKey(squashed, key, minimumLength = DEFAULT_MIN_KEY_LENGTH) {
  if (key.length < minimumLength) return -1
  const { text, map, source } = squashed
  let from = 0
  while (true) {
    const at = text.indexOf(key, from)
    if (at < 0) return -1
    const startSource = map[at]
    const endSource = map[at + key.length - 1]
    const before = startSource === undefined ? undefined : source[startSource - 1]
    const after = endSource === undefined ? undefined : source[endSource + 1]
    const leftOk = before === undefined || !/[a-z0-9]/u.test(before)
    const rightOk = after === undefined || !/[a-z0-9]/u.test(after)
    if (leftOk && rightOk) return at
    from = at + 1
  }
}

/**
 * Every normalized spelling a model can be recognized by: the full id, its last
 * path segment, the display name, and each contiguous run-word join — so
 * `codex/gpt-6-luna` and `GPT-6-Luna · Codex` both yield `gpt6luna`.
 */
function modelKeys(provider, model) {
  const keys = new Set()
  const id = typeof model?.id === 'string' ? model.id : ''
  const name = typeof model?.name === 'string' ? model.name : ''
  const add = (value) => {
    const folded = foldText(value)
    if (folded.length >= DEFAULT_MIN_KEY_LENGTH) keys.add(folded)
  }
  add(id)
  add(`${provider}/${id}`)
  const lastSegment = id.split('/').at(-1)
  if (lastSegment !== undefined) add(lastSegment)
  add(name)
  for (const source of [id, name, lastSegment ?? '']) {
    const runs = textRuns(source)
    for (let start = 0; start < runs.length; start += 1) {
      let joined = ''
      for (let end = start; end < runs.length; end += 1) {
        joined += runs[end]
        add(joined)
      }
    }
  }
  return [...keys].sort((left, right) => right.length - left.length)
}

/** Flatten the catalog into one matchable row per exact provider/model route. */
export function catalogRoutes(catalog) {
  const groups = Array.isArray(catalog) ? catalog : []
  const routes = []
  for (const group of groups) {
    const provider = typeof group?.id === 'string' ? group.id : ''
    if (provider === '') continue
    for (const model of Array.isArray(group.models) ? group.models : []) {
      if (typeof model?.id !== 'string' || model.id === '') continue
      routes.push({
        provider,
        providerName: typeof group.name === 'string' ? group.name : provider,
        model: model.id,
        modelName: typeof model.name === 'string' ? model.name : model.id,
        efforts: Array.isArray(model.reasoning?.efforts)
          ? model.reasoning.efforts
            .filter(effort => typeof effort?.id === 'string' && effort.id !== '')
            .map(effort => ({ id: effort.id, name: typeof effort.name === 'string' ? effort.name : effort.id }))
          : [],
        defaultEffort: typeof model.reasoning?.defaultEffort === 'string' ? model.reasoning.defaultEffort : undefined,
        keys: modelKeys(provider, model),
      })
    }
  }
  return routes
}

/**
 * Fold a user-configured alias into the keys of the route it names.
 *
 * The alias must point at a route that already exists in the catalog (or one
 * declared through `extraModels`), so it can never invent a provider/model pair
 * the adapter cannot serve.
 */
function withAliases(routes, aliases) {
  const entries = Array.isArray(aliases) ? aliases : []
  if (entries.length === 0) return routes
  return routes.map((route) => {
    const extra = entries
      .filter(entry => entry?.provider === route.provider && entry?.model === route.model)
      .map(entry => foldText(entry.alias))
      .filter(key => key.length > 0)
    if (extra.length === 0) return route
    return { ...route, keys: [...new Set([...extra, ...route.keys])].sort((l, r) => r.length - l.length) }
  })
}

/**
 * Score every route and keep the best one.
 *
 * The score is the length of the matching key, so a user who spells the whole
 * id beats one who spells a fragment, and two distinct routes matching at the
 * same length are reported as ambiguous rather than guessed.
 */
function bestRoute(squashed, routes, minimumKeyLength) {
  const scored = []
  for (const route of routes) {
    let best = 0
    for (const key of route.keys) {
      if (key.length < minimumKeyLength) continue
      if (findKey(squashed, key, minimumKeyLength) < 0) continue
      if (key.length > best) best = key.length
    }
    if (best > 0) scored.push({ route, score: best })
  }
  if (scored.length === 0) return { status: 'not-found' }
  scored.sort((left, right) => right.score - left.score)
  const [first, second] = scored
  if (second !== undefined && second.score === first.score) {
    const tied = scored.filter(entry => entry.score === first.score).map(entry => entry.route)
    const distinct = new Set(tied.map(route => `${route.provider}\u0000${route.model}`))
    if (distinct.size > 1) return { status: 'ambiguous', candidates: tied }
  }
  return { status: 'matched', route: first.route }
}

/**
 * Built-in effort spellings, in both languages, mapped to canonical ids.
 *
 * Only a fallback: when the resolved model advertises its own efforts, those
 * ids and names win, because adapters own the vocabulary.
 */
const BUILTIN_EFFORTS = [
  ['minimal', 'minimal'], ['minimal', 'smallest'], ['最小', 'minimal'],
  ['low', 'low'], ['低', 'low'], ['轻度', 'low'],
  ['medium', 'medium'], ['mid', 'medium'], ['中', 'medium'], ['中等', 'medium'],
  ['high', 'high'], ['高', 'high'], ['较高', 'high'],
  ['xhigh', 'xhigh'], ['extrahigh', 'xhigh'], ['veryhigh', 'xhigh'], ['极高', 'xhigh'],
  ['max', 'max'], ['maximum', 'max'], ['highest', 'max'], ['最高', 'max'],
  ['none', 'none'], ['off', 'off'], ['disabled', 'off'], ['disable', 'off'], ['无', 'off'], ['关', 'off'], ['关闭', 'off'],
]

/**
 * Resolve the reasoning effort a directive names.
 *
 * Candidate spellings come from the model's advertised efforts first, then the
 * user's aliases, then the built-in table.
 */
export function resolveEffort(squashed, route, effortAliases, options = {}) {
  const advertised = route?.efforts ?? []
  /** @type {{ key: string, raw: string, effort: string }[]} */
  const candidates = []
  const add = (raw, effort) => {
    if (typeof raw !== 'string' || raw === '') return
    candidates.push({ key: foldText(raw), raw: raw.toLowerCase(), effort })
  }
  // Every spelling stays a candidate even when this model does not advertise
  // it: naming what the user asked for in the diagnostic beats ignoring it.
  for (const effort of advertised) {
    add(effort.id, effort.id)
    add(effort.name, effort.id)
  }
  for (const entry of Array.isArray(effortAliases) ? effortAliases : []) add(entry?.alias, entry?.effort)
  for (const [alias, effort] of BUILTIN_EFFORTS) add(alias, effort)

  let best
  for (const candidate of candidates) {
    if (typeof candidate.effort !== 'string' || candidate.effort === '') continue
    // A CJK spelling folds away entirely; match those on the raw source text.
    const at = candidate.key.length >= 3
      ? findKey(squashed, candidate.key, 3)
      : squashed.source.indexOf(candidate.raw) >= 0 ? 0 : -1
    if (at < 0) continue
    const length = candidate.key.length >= 3 ? candidate.key.length : candidate.raw.length
    if (best === undefined || length > best.length) best = { length, effort: candidate.effort, at }
  }
  if (best === undefined) {
    const fallback = typeof options.fallbackEffort === 'string' ? options.fallbackEffort : ''
    if (fallback === '') return { status: 'none' }
    if (advertised.length > 0 && !advertised.some(candidate => candidate.id === fallback)) {
      return { status: 'unsupported', effort: fallback }
    }
    return { status: 'fallback', effort: fallback }
  }
  // A model that advertises nothing imposes no vocabulary of its own; its
  // adapter owns the validation, so the request is passed through.
  if (advertised.length > 0 && !advertised.some(candidate => candidate.id === best.effort)) {
    return { status: 'unsupported', effort: best.effort }
  }
  return { status: 'matched', effort: best.effort }
}

/**
 * Locate the trigger word that scopes a directive, if any.
 *
 * @returns the earliest trigger and its end offset in the raw text, or undefined.
 */
export function findTrigger(text, triggerWords) {
  if (typeof text !== 'string' || text.length === 0) return undefined
  const lower = text.toLowerCase()
  let earliest
  for (const word of Array.isArray(triggerWords) ? triggerWords : []) {
    if (typeof word !== 'string' || word.length === 0) continue
    const at = lower.indexOf(word.toLowerCase())
    if (at < 0) continue
    if (earliest === undefined || at < earliest.at) earliest = { at, end: at + word.length, word }
  }
  return earliest
}

/**
 * Parse one user message into a child-route decision.
 *
 * A route is returned only when a single catalog entry matches unambiguously.
 * Callers treat every failure status as "leave the delegation exactly as the
 * harness would have made it".
 */
export function parseDirective(input) {
  const { text, catalog, aliases, effortAliases, triggerWords, requireTrigger } = input ?? {}
  const config = input?.config ?? {}
  if (typeof text !== 'string' || text.trim() === '') return { status: 'empty' }

  const trigger = findTrigger(text, triggerWords)
  if (trigger === undefined && requireTrigger !== false) return { status: 'no-trigger' }

  const proximity = Number.isSafeInteger(config.proximity) && config.proximity > 0
    ? config.proximity
    : DEFAULT_PROXIMITY
  const window = trigger === undefined
    ? text
    : text.slice(trigger.at, trigger.end + proximity)

  const squashed = squash(window)
  if (squashed.text === '') return { status: 'not-found', window }

  const routes = withAliases(catalogRoutes(catalog), aliases)
  const minimumKeyLength = Number.isSafeInteger(config.minKeyLength) && config.minKeyLength > 0
    ? config.minKeyLength
    : DEFAULT_MIN_KEY_LENGTH
  const matched = bestRoute(squashed, routes, minimumKeyLength)
  if (matched.status === 'not-found') return { status: 'not-found', window }
  if (matched.status === 'ambiguous') {
    return {
      status: 'ambiguous',
      window,
      candidates: matched.candidates.map(route => ({ provider: route.provider, model: route.model })),
    }
  }

  const route = matched.route
  const effort = resolveEffort(squashed, route, effortAliases, {
    allowUnadvertised: config.allowUnadvertisedEffort !== false,
    fallbackEffort: typeof config.defaultEffort === 'string' && config.defaultEffort !== ''
      ? config.defaultEffort
      : undefined,
  })

  return {
    status: 'matched',
    provider: route.provider,
    model: route.model,
    modelName: route.modelName,
    ...effort.status === 'matched' || effort.status === 'fallback' ? { reasoningEffort: effort.effort } : {},
    effortStatus: effort.status,
    ...effort.status === 'unsupported' ? { unsupportedEffort: effort.effort } : {},
    trigger: trigger?.word,
    window,
  }
}

/** The matcher's stable identity, so a copied build can be spotted in a stack trace. */
export const MATCHER_VERSION = 1
