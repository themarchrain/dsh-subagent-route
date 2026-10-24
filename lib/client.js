/**
 * dsh-subagent-route — browser half: the settings page.
 *
 * Build `lib/client.js` from this file with `node scripts/build-client.mjs`;
 * the build inlines the Host's real matcher at the placeholder below, so the
 * page's dry run and the Host's dispatch decision can never disagree.
 *
 * Two surfaces share one page:
 *
 *   · `plugins.row.config` (`dsh-subagent-route#dsh-subagent-route`) gives the
 *     plugin row its configure control, exactly like a first-party plugin.
 *   · `plugins.bundle.config` renders the same page on the bundle's own page.
 *
 * The page edits the Host plugin's volatile `Config` through `ctx.configForms`,
 * the same path a first-party settings page uses, so every write is
 * revision-fenced and persisted to the profile patch by the Host.
 *
 * Controls are drawn here rather than imported from another Client package:
 * the theme tokens (`--dsw-alias-*`) are the only shared styling dependency,
 * which is what keeps the page intact across Harness releases.
 */

window.__ModuleLoader__.load({
  id: 'dsh-subagent-route',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    /** The Host entry id this page edits; it is also the settings namespace. */
    const NS = 'dsh-subagent-route'
    /** Row key the Plugins page dispatches for `plugins.row.config`. */
    const ROW_KEY = `${NS}#${NS}`

    // ── the one matcher, inlined from lib/matcher.js at build time ──────────
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
  function foldText(value) {
    return typeof value === 'string' ? value.toLowerCase().replace(SEPARATORS, '') : ''
  }

  /** Split text into lowercase `[a-z0-9]` runs, dropping punctuation and CJK. */
  function textRuns(value) {
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
  function squash(value) {
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
  function catalogRoutes(catalog) {
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
  function resolveEffort(squashed, route, effortAliases, options = {}) {
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
  function findTrigger(text, triggerWords) {
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
  function parseDirective(input) {
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
  const MATCHER_VERSION = 1


    // ── style ───────────────────────────────────────────────────────────────
    // Tokens only. A literal colour here would break the light/dark switch.
    const CSS = [
      '.dsr{display:flex;flex-direction:column;gap:16px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary)}',
      '.dsr-note{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;margin:0}',
      '.dsr-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dsr-row-main{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.dsr-row-title{font-weight:600;font-size:13px}',
      '.dsr-row-desc{color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dsr-grid2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px}',
      '.dsr-grid3{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr) minmax(0,1.1fr) auto;gap:10px;align-items:end}',
      '.dsr-field{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.dsr-label{color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dsr-input,.dsr-select{width:100%;box-sizing:border-box;height:30px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
      '.dsr-input:focus-visible,.dsr-select:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.dsr-input:disabled,.dsr-select:disabled{opacity:.5}',
      '.dsr-textarea{height:64px;padding:6px 8px;resize:vertical;line-height:1.5}',
      '.dsr-group{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px;background:var(--dsw-alias-bg-layer-1)}',
      '.dsr-group-head{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.dsr-group-title{font-weight:600;font-size:13px;margin:0}',
      '.dsr-stack{display:flex;flex-direction:column;gap:8px}',
      '.dsr-inline{display:flex;gap:8px;align-items:center}',
      '.dsr-btn{appearance:none;font:inherit;font-size:12px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:4px 10px;background:transparent;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.dsr-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}',
      '.dsr-btn:disabled{opacity:.45;cursor:default}',
      '.dsr-btn-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-1);border-color:transparent}',
      '.dsr-btn-danger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.dsr-footer{display:flex;align-items:center;gap:10px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dsr-status{flex:1;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dsr-status-error{color:var(--dsw-alias-state-error-primary)}',
      '.dsr-result{margin:0;padding:8px 10px;border-left:2px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:0 6px 6px 0;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
      '.dsr-warn{color:var(--dsw-alias-state-warning-primary)}',
      '@media (max-width:640px){.dsr-grid2,.dsr-grid3{grid-template-columns:minmax(0,1fr)}}',
    ].join('\n')

    /** Inject the page stylesheet once per document, and remove it on unload. */
    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      const id = `${NS}/page.css`
      const existing = document.querySelector(`style[data-plugin-css="${id}"]`)
      if (existing !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = NS
      tag.dataset.pluginCss = id
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        if (tag.parentNode !== null) tag.parentNode.removeChild(tag)
      }
    }

    // ── copy ────────────────────────────────────────────────────────────────
    const ZH = {
      title: '子代理路由',
      intro: '当你在会话里点名子代理要用的模型（例如「这次大任务，子agent用 gpt6luna 思考程度xhigh」），派发时会使用这个配置；你没说的时候，原有的继承机制完全不变。',
      enabled: '启用路由识别',
      enabledDesc: '关闭后插件不改动任何派发，等同于未安装。',
      requireTrigger: '必须出现触发词',
      requireTriggerDesc: '只读取提到子代理的消息，避免误判普通对话。',
      notifyChild: '把实际路由告诉子代理',
      notifyChildDesc: '在子代理的上下文里写入一行真实提示词，它才能回答「你是什么模型」。',
      notifyParent: '把套用的路由回报给主会话',
      notifyParentDesc: '派发后向主会话追加一条注入消息，说明本次使用了什么路由。',
      strict: '严格模式',
      strictDesc: '模型名存在歧义时直接拒绝派发，而不是退回继承。',
      scope: '读取范围',
      scopeLast: '最后一条用户消息',
      scopeSession: '整个会话',
      scopeDesc: '「最后一条」适合「这次用 X」；「整个会话」让早前的指示在后续派发中继续生效。',
      aliases: '模型别名',
      aliasesDesc: '给已有的 provider/model 起别名，用户怎么说都能对上。别名必须指向真实存在的路由。',
      alias: '别名',
      provider: 'Provider',
      model: 'Model',
      effortAliases: '思考程度别名',
      effortAliasesDesc: '把用户可能说的词映射到模型声明的 reasoning effort。',
      effort: 'Effort',
      extraModels: '补充模型',
      extraModelsDesc: '给不公布模型目录的网关补上路由，这样它也能被点名。',
      name: '显示名',
      triggerWords: '触发词',
      triggerWordsDesc: '用逗号或换行分隔。',
      defaultEffort: '默认思考程度',
      defaultEffortDesc: '点了模型但没提强度时使用；留空交给模型默认。',
      proximity: '模型名可出现的距离',
      proximityDesc: '触发词之后多少个字符内允许出现模型名，默认 80。',
      minKeyLength: '最短匹配长度',
      minKeyLengthDesc: '太短的片段容易误匹配，默认 4。',
      add: '添加',
      remove: '移除',
      save: '保存',
      saving: '保存中…',
      discard: '放弃修改',
      saved: '已保存',
      dirty: '有未保存的修改',
      failed: '保存失败，请重试',
      unavailable: '宿主还没有为这个插件提供设置存储。请确认插件已在当前 profile 中启用，然后重启 DSH。',
      rehearse: '试算',
      rehearseDesc: '输入一句话，看看会被解析成什么。只做解析，不改配置、不派发。',
      rehearsePlaceholder: '子agent用 gpt6luna 思考程度xhigh',
      rehearseRun: '解析',
    }
    const EN = {
      title: 'Subagent route',
      intro: 'When you name the model a subagent should use ("this time the subagent runs on gpt6luna with xhigh thinking"), delegations use it. When you say nothing, the inherited route is untouched.',
      enabled: 'Read route directives',
      enabledDesc: 'With this off the plugin changes no delegation at all.',
      requireTrigger: 'Require a trigger word',
      requireTriggerDesc: 'Only messages naming a subagent are read, so ordinary conversation cannot be misread.',
      notifyChild: 'Tell the subagent its route',
      notifyChildDesc: 'Writes one line of real prompt text into the child, so it can answer which model it is.',
      notifyParent: 'Report the route to the delegating session',
      notifyParentDesc: 'Adds one injected message after delegation naming the route that was used.',
      strict: 'Strict mode',
      strictDesc: 'Refuse a delegation whose model name is ambiguous instead of falling back to inheritance.',
      scope: 'Read from',
      scopeLast: 'Latest user message',
      scopeSession: 'Whole session',
      scopeDesc: '"Latest" suits "this time use X"; "whole session" keeps an earlier instruction in force.',
      aliases: 'Model aliases',
      aliasesDesc: 'Extra names for an existing provider/model route. An alias must point at a route that really exists.',
      alias: 'Alias',
      provider: 'Provider',
      model: 'Model',
      effortAliases: 'Effort aliases',
      effortAliasesDesc: 'Map the words a user might say onto an effort the model declares.',
      effort: 'Effort',
      extraModels: 'Extra models',
      extraModelsDesc: 'Add routes for a gateway that does not advertise its catalog, so it can be named too.',
      name: 'Display name',
      triggerWords: 'Trigger words',
      triggerWordsDesc: 'Separated by commas or newlines.',
      defaultEffort: 'Default thinking level',
      defaultEffortDesc: 'Used when a message names a model but no level. Empty defers to the model default.',
      proximity: 'Reach after the trigger',
      proximityDesc: 'How many characters after a trigger word a model name may appear; 80 by default.',
      minKeyLength: 'Shortest match',
      minKeyLengthDesc: 'Very short fragments match by accident; 4 is the default.',
      add: 'Add',
      remove: 'Remove',
      save: 'Save',
      saving: 'Saving…',
      discard: 'Discard',
      saved: 'Saved',
      dirty: 'Unsaved changes',
      failed: 'Save failed; try again',
      unavailable: 'The Host does not serve settings storage for this plugin yet. Confirm it is enabled in this profile, then restart DSH.',
      rehearse: 'Dry run',
      rehearseDesc: 'Type a sentence to see what it resolves to. Parses only; nothing is saved or delegated.',
      rehearsePlaceholder: 'subagent uses gpt6luna with xhigh thinking',
      rehearseRun: 'Resolve',
    }

    /** Pick the copy map for the active locale id. */
    function copyFor(locale) {
      return typeof locale === 'string' && locale.startsWith('zh') ? ZH : EN
    }

    // ── field helpers ───────────────────────────────────────────────────────
    /** Read one settings value, falling back to the schema default. */
    function field(value, key, fallback) {
      const raw = value === undefined || value === null ? undefined : value[key]
      return raw === undefined ? fallback : raw
    }

    /** Clamp a numeric input into the range the Host schema accepts. */
    function clampInt(raw, min, max, fallback) {
      const parsed = Number.parseInt(String(raw), 10)
      if (!Number.isFinite(parsed)) return fallback
      return Math.min(max, Math.max(min, parsed))
    }

    /** Defaults mirroring the Host `Config` schema, so the page works before the first save. */
    const DEFAULTS = {
      enabled: true,
      requireTrigger: true,
      scope: 'last-user-message',
      triggerWords: ['子agent', '子代理', 'subagent', '派发', '委派'],
      aliases: [],
      effortAliases: [],
      defaultEffort: '',
      proximity: 80,
      minKeyLength: 4,
      extraModels: [],
      notifyChild: true,
      notifyParent: false,
      strict: false,
    }

    /** Restore every array field so the page never dereferences undefined. */
    function seedDraft(value) {
      return {
        enabled: field(value, 'enabled', DEFAULTS.enabled),
        requireTrigger: field(value, 'requireTrigger', DEFAULTS.requireTrigger),
        scope: field(value, 'scope', DEFAULTS.scope),
        triggerWords: [...field(value, 'triggerWords', DEFAULTS.triggerWords)],
        aliases: field(value, 'aliases', DEFAULTS.aliases).map(row => ({ alias: row.alias ?? '', provider: row.provider ?? '', model: row.model ?? '' })),
        effortAliases: field(value, 'effortAliases', DEFAULTS.effortAliases).map(row => ({ alias: row.alias ?? '', effort: row.effort ?? '' })),
        defaultEffort: field(value, 'defaultEffort', DEFAULTS.defaultEffort),
        proximity: field(value, 'proximity', DEFAULTS.proximity),
        minKeyLength: field(value, 'minKeyLength', DEFAULTS.minKeyLength),
        extraModels: field(value, 'extraModels', DEFAULTS.extraModels).map(row => ({ provider: row.provider ?? '', model: row.model ?? '', name: row.name ?? '' })),
        notifyChild: field(value, 'notifyChild', DEFAULTS.notifyChild),
        notifyParent: field(value, 'notifyParent', DEFAULTS.notifyParent),
        strict: field(value, 'strict', DEFAULTS.strict),
      }
    }

    /** A text input bound to a draft scalar. */
    function TextField({ label, value, onChange, disabled, placeholder, type }) {
      return h('label', { className: 'dsr-field' },
        h('span', { className: 'dsr-label' }, label),
        h('input', {
          className: 'dsr-input',
          type: type ?? 'text',
          value: value ?? '',
          disabled: disabled === true,
          placeholder: placeholder ?? '',
          onChange: event => { onChange(event.target.value) },
        }))
    }

    /** A two-option select bound to a draft scalar. */
    function SelectField({ label, value, options, onChange, disabled }) {
      return h('label', { className: 'dsr-field' },
        h('span', { className: 'dsr-label' }, label),
        h('select', {
          className: 'dsr-select',
          value,
          disabled: disabled === true,
          onChange: event => { onChange(event.target.value) },
        }, options.map(option => h('option', { key: option.value, value: option.value }, option.label))))
    }

    /** One label + description + switch row. */
    function ToggleRow({ title, desc, checked, onChange, disabled }) {
      return h('div', { className: 'dsr-row' },
        h('div', { className: 'dsr-row-main' },
          h('span', { className: 'dsr-row-title' }, title),
          desc === undefined ? null : h('span', { className: 'dsr-row-desc' }, desc)),
        h('input', {
          type: 'checkbox',
          checked: checked === true,
          disabled: disabled === true,
          'aria-label': title,
          onChange: event => { onChange(event.target.checked) },
        }))
    }

    /** One editable list of rows, rendered by the caller's field renderer. */
    function RowList({ title, desc, rows, renderRow, onAdd, addLabel, disabled }) {
      return h('div', { className: 'dsr-group' },
        h('div', { className: 'dsr-group-head' },
          h('h5', { className: 'dsr-group-title' }, title),
          h('button', { type: 'button', className: 'dsr-btn', disabled: disabled === true, onClick: onAdd }, addLabel)),
        desc === undefined ? null : h('p', { className: 'dsr-note' }, desc),
        rows.length === 0
          ? null
          : h('div', { className: 'dsr-stack' }, rows.map((row, index) => renderRow(row, index))))
    }

    /** One row's remove button. */
    function RemoveButton({ label, onClick, disabled }) {
      return h('button', {
        type: 'button',
        className: 'dsr-btn dsr-btn-danger',
        disabled: disabled === true,
        'aria-label': label,
        onClick,
      }, label)
    }

    /** The footer's status line. */
    function statusText(status, dirty, t) {
      if (status === 'saving') return t.saving
      if (status === 'saved') return t.saved
      if (status === 'failed') return t.failed
      if (dirty) return t.dirty
      return ''
    }

    /**
     * Render one dry-run answer in the engine's own vocabulary, so the preview
     * never promises more than the Host would do.
     */
    function renderRehearsal(result, t) {
      if (result === undefined || result === null) return ''
      if (result.status === 'running') return '…'
      if (result.status === 'matched') {
        return `✓ ${result.provider}/${result.model}`
          + `${result.reasoningEffort === undefined ? '' : `  effort=${result.reasoningEffort}`}`
          + `${result.unsupportedEffort === undefined ? '' : `\n! this model does not declare "${result.unsupportedEffort}"; the route is used without it`}`
          + `${result.window === undefined ? '' : `\nread from: ${result.window}`}`
      }
      if (result.status === 'ambiguous') {
        return `? ambiguous — name the provider too\n${(result.candidates ?? []).map(candidate => `${candidate.provider}/${candidate.model}`).join('\n')}`
      }
      if (result.status === 'no-trigger') return '– no trigger word found, so nothing would be applied'
      if (result.status === 'not-found') return `× no catalog model matched${result.window === undefined ? '' : `\nread from: ${result.window}`}`
      if (result.status === 'empty') return '– nothing entered'
      if (result.status === 'disabled') return '– routing is switched off'
      if (result.status === 'error') return `× ${result.message ?? 'failed'}`
      return String(result.status ?? '')
    }

    // ── page component ──────────────────────────────────────────────────────
    /**
     * The settings page, rendered by both slot surfaces.
     *
     * @param props - the slot's owner props plus the injected face.
     */
    function RoutePage(props) {
      const t = copyFor(props.locale)
      const snapshot = props.useForm(s => s)
      const value = snapshot?.value
      const writable = snapshot?.status === 'ready' && snapshot?.writable === true
      const disabled = !writable || snapshot?.saving === true

      const [draft, setDraft] = useState(undefined)
      const [status, setStatus] = useState(undefined)
      const [rehearsal, setRehearsal] = useState('')
      const [rehearsalResult, setRehearsalResult] = useState(undefined)
      const revisionRef = useRef(undefined)

      const seeded = JSON.stringify(seedDraft(value ?? {}))
      // A first render with no draft adopts the Host value. A later revision
      // only re-seeds a draft the user has not touched.
      useEffect(() => {
        if (value === undefined) return
        if (draft === undefined) {
          revisionRef.current = snapshot?.revision
          setDraft(seedDraft(value))
          return
        }
        if (JSON.stringify(draft) !== seeded) return
        revisionRef.current = snapshot?.revision
        setDraft(seedDraft(value))
      }, [seeded, draft, value, snapshot?.revision])

      /** Stage one scalar edit. */
      const set = useCallback((key, next) => {
        setDraft(current => ({ ...(current ?? seedDraft(value ?? {})), [key]: next }))
        setStatus(undefined)
      }, [value])

      /** Stage one row edit inside an array field. */
      const setRow = useCallback((key, index, patch) => {
        setDraft((current) => {
          const base = current ?? seedDraft(value ?? {})
          const rows = [...(base[key] ?? [])]
          rows[index] = { ...rows[index], ...patch }
          return { ...base, [key]: rows }
        })
        setStatus(undefined)
      }, [value])

      /** Append one blank row to an array field. */
      const addRow = useCallback((key, blank) => {
        setDraft((current) => {
          const base = current ?? seedDraft(value ?? {})
          return { ...base, [key]: [...(base[key] ?? []), { ...blank }] }
        })
        setStatus(undefined)
      }, [value])

      /** Drop one row from an array field. */
      const removeRow = useCallback((key, index) => {
        setDraft((current) => {
          const base = current ?? seedDraft(value ?? {})
          return { ...base, [key]: (base[key] ?? []).filter((_row, at) => at !== index) }
        })
        setStatus(undefined)
      }, [value])

      const save = useCallback(async () => {
        if (draft === undefined || !writable) return
        setStatus('saving')
        const accepted = await props.write(draft, revisionRef.current)
        if (accepted === true) {
          setStatus('saved')
          revisionRef.current = undefined
          setDraft(undefined)
        } else setStatus('failed')
      }, [draft, props, writable])

      const discard = useCallback(() => {
        setDraft(undefined)
        revisionRef.current = undefined
        setStatus(undefined)
      }, [])

      const rehearse = useCallback(async () => {
        setRehearsalResult({ status: 'running' })
        setRehearsalResult(await props.resolve(rehearsal))
      }, [props, rehearsal])

      if (snapshot === undefined || snapshot.status === 'loading') return null
      if (snapshot.status !== 'ready') {
        return h('div', { className: 'dsr' },
          h('h4', { className: 'dsr-group-title' }, t.title),
          h('p', { className: 'dsr-note' }, t.unavailable))
      }

      const state = draft ?? seedDraft(value ?? {})
      const dirty = JSON.stringify(state) !== seeded

      return h('div', { className: 'dsr' },
        h('div', null,
          h('h4', { className: 'dsr-group-title', style: { marginBottom: '4px' } }, t.title),
          h('p', { className: 'dsr-note' }, t.intro)),

        h('div', null,
          h(ToggleRow, {
            title: t.enabled, desc: t.enabledDesc,
            checked: state.enabled, disabled, onChange: next => { set('enabled', next) },
          }),
          h(ToggleRow, {
            title: t.requireTrigger, desc: t.requireTriggerDesc,
            checked: state.requireTrigger, disabled, onChange: next => { set('requireTrigger', next) },
          }),
          h(ToggleRow, {
            title: t.notifyChild, desc: t.notifyChildDesc,
            checked: state.notifyChild, disabled, onChange: next => { set('notifyChild', next) },
          }),
          h(ToggleRow, {
            title: t.notifyParent, desc: t.notifyParentDesc,
            checked: state.notifyParent, disabled, onChange: next => { set('notifyParent', next) },
          }),
          h(ToggleRow, {
            title: t.strict, desc: t.strictDesc,
            checked: state.strict, disabled, onChange: next => { set('strict', next) },
          })),

        h('div', { className: 'dsr-grid2' },
          h(SelectField, {
            label: t.scope, value: state.scope, disabled,
            options: [{ value: 'last-user-message', label: t.scopeLast }, { value: 'session', label: t.scopeSession }],
            onChange: next => { set('scope', next) },
          }),
          h(TextField, {
            label: t.defaultEffort, value: state.defaultEffort, disabled, placeholder: 'xhigh',
            onChange: next => { set('defaultEffort', next) },
          })),
        h('p', { className: 'dsr-note' }, t.scopeDesc),

        h('div', { className: 'dsr-grid2' },
          h(TextField, {
            label: t.proximity, type: 'number', value: String(state.proximity ?? ''), disabled,
            onChange: next => { set('proximity', clampInt(next, 20, 2000, 80)) },
          }),
          h(TextField, {
            label: t.minKeyLength, type: 'number', value: String(state.minKeyLength ?? ''), disabled,
            onChange: next => { set('minKeyLength', clampInt(next, 3, 32, 4)) },
          })),
        h('p', { className: 'dsr-note' }, `${t.proximityDesc} ${t.minKeyLengthDesc}`),

        h('div', { className: 'dsr-field' },
          h('span', { className: 'dsr-label' }, t.triggerWords),
          h('textarea', {
            className: 'dsr-input dsr-textarea',
            value: (state.triggerWords ?? []).join(', '),
            disabled,
            'aria-label': t.triggerWords,
            onChange: (event) => {
              set('triggerWords', event.target.value
                .split(/[,，\n]/u)
                .map(word => word.trim())
                .filter(word => word !== ''))
            },
          }),
          h('span', { className: 'dsr-row-desc' }, t.triggerWordsDesc)),

        h(RowList, {
          title: t.aliases, desc: t.aliasesDesc, addLabel: t.add, disabled,
          rows: state.aliases ?? [],
          onAdd: () => { addRow('aliases', { alias: '', provider: '', model: '' }) },
          renderRow: (row, index) => h('div', { className: 'dsr-grid3', key: `alias-${index}` },
            h(TextField, { label: t.alias, value: row.alias, disabled, onChange: next => { setRow('aliases', index, { alias: next }) } }),
            h(TextField, { label: t.provider, value: row.provider, disabled, onChange: next => { setRow('aliases', index, { provider: next }) } }),
            h(TextField, { label: t.model, value: row.model, disabled, onChange: next => { setRow('aliases', index, { model: next }) } }),
            h(RemoveButton, { label: t.remove, disabled, onClick: () => { removeRow('aliases', index) } })),
        }),

        h(RowList, {
          title: t.effortAliases, desc: t.effortAliasesDesc, addLabel: t.add, disabled,
          rows: state.effortAliases ?? [],
          onAdd: () => { addRow('effortAliases', { alias: '', effort: '' }) },
          renderRow: (row, index) => h('div', { className: 'dsr-grid2', key: `effort-${index}` },
            h(TextField, { label: t.alias, value: row.alias, disabled, onChange: next => { setRow('effortAliases', index, { alias: next }) } }),
            h('div', { className: 'dsr-inline' },
              h('div', { style: { flex: '1', minWidth: '0' } },
                h(TextField, { label: t.effort, value: row.effort, disabled, onChange: next => { setRow('effortAliases', index, { effort: next }) } })),
              h(RemoveButton, { label: t.remove, disabled, onClick: () => { removeRow('effortAliases', index) } }))),
        }),

        h(RowList, {
          title: t.extraModels, desc: t.extraModelsDesc, addLabel: t.add, disabled,
          rows: state.extraModels ?? [],
          onAdd: () => { addRow('extraModels', { provider: '', model: '', name: '' }) },
          renderRow: (row, index) => h('div', { className: 'dsr-grid3', key: `extra-${index}` },
            h(TextField, { label: t.provider, value: row.provider, disabled, onChange: next => { setRow('extraModels', index, { provider: next }) } }),
            h(TextField, { label: t.model, value: row.model, disabled, onChange: next => { setRow('extraModels', index, { model: next }) } }),
            h(TextField, { label: t.name, value: row.name, disabled, onChange: next => { setRow('extraModels', index, { name: next }) } }),
            h(RemoveButton, { label: t.remove, disabled, onClick: () => { removeRow('extraModels', index) } })),
        }),

        h('div', { className: 'dsr-group' },
          h('div', { className: 'dsr-group-head' }, h('h5', { className: 'dsr-group-title' }, t.rehearse)),
          h('p', { className: 'dsr-note' }, t.rehearseDesc),
          h('div', { className: 'dsr-inline' },
            h('input', {
              className: 'dsr-input',
              value: rehearsal,
              placeholder: t.rehearsePlaceholder,
              'aria-label': t.rehearse,
              onChange: event => { setRehearsal(event.target.value) },
            }),
            h('button', {
              type: 'button', className: 'dsr-btn',
              disabled: rehearsal.trim() === '',
              onClick: () => { void rehearse() },
            }, t.rehearseRun)),
          rehearsalResult === undefined
            ? null
            : h('pre', { className: 'dsr-result' }, renderRehearsal(rehearsalResult, t))),

        h('div', { className: 'dsr-footer' },
          h('span', {
            className: status === 'failed' ? 'dsr-status dsr-status-error' : 'dsr-status',
          }, statusText(status, dirty, t)),
          h('button', {
            type: 'button', className: 'dsr-btn', disabled: !dirty || snapshot.saving === true,
            onClick: discard,
          }, t.discard),
          h('button', {
            type: 'button', className: 'dsr-btn dsr-btn-primary', disabled: !dirty || disabled,
            onClick: () => { void save() },
          }, snapshot.saving === true ? t.saving : t.save)))
    }

    // ── plugin ──────────────────────────────────────────────────────────────
    return {
      inject: ['slots', 'locale', 'configForms'],

      apply(ctx) {
        ctx.effect(() => installStyles(), `${NS}: page styles`)

        const form = ctx.configForms.get(NS)

        /** Read the active locale id without the page owning a subscription. */
        const activeLocale = () => {
          try {
            return ctx.locale.getSnapshot().active
          } catch {
            return 'en'
          }
        }

        /**
         * Resolve one sentence with the very matcher the Host dispatches with.
         *
         * The browser cannot import a Host file, so the build inlines the
         * matcher into this factory; the preview therefore cannot drift from
         * the real decision.
         *
         * @param text - the sentence to parse.
         * @returns the decision, or an error decision.
         */
        const resolve = async (text) => {
          try {
            // Read through `seedDraft` so the preview uses the same defaults the
            // form would show, even before the Host has served a full section.
            const value = seedDraft(form.getSnapshot().value ?? {})
            const response = await ctx.remote.session.modelCatalog()
            const groups = response.ok ? response.value.groups : []
            const catalog = groups.map(group => ({
              id: group.id,
              name: group.name,
              models: group.models.map(model => ({
                id: model.id,
                name: model.name,
                ...model.reasoning === undefined ? {} : { reasoning: model.reasoning },
              })),
            }))
            return parseDirective({
              text,
              catalog,
              aliases: value.aliases,
              effortAliases: value.effortAliases,
              triggerWords: value.triggerWords,
              requireTrigger: value.requireTrigger,
              config: {
                proximity: value.proximity,
                minKeyLength: value.minKeyLength,
                defaultEffort: value.defaultEffort,
                allowUnadvertisedEffort: true,
              },
            })
          } catch (error) {
            return { status: 'error', message: String(error) }
          }
        }

        /** The injected face shared by both slot surfaces. */
        const injected = () => ({
          hooks: { form },
          get locale() { return activeLocale() },
          resolve,
          /**
           * Write the whole draft as one revision-fenced mutation.
           *
           * @param draft - every editable field.
           * @param revision - the revision the draft was read at.
           * @returns whether the Host accepted the write.
           */
          write: async (draft, revision) => await form.mutate([
            { op: 'set', path: ['enabled'], value: draft.enabled === true },
            { op: 'set', path: ['requireTrigger'], value: draft.requireTrigger === true },
            { op: 'set', path: ['scope'], value: draft.scope },
            { op: 'set', path: ['triggerWords'], value: draft.triggerWords },
            { op: 'set', path: ['aliases'], value: draft.aliases },
            { op: 'set', path: ['effortAliases'], value: draft.effortAliases },
            { op: 'set', path: ['defaultEffort'], value: draft.defaultEffort },
            { op: 'set', path: ['proximity'], value: draft.proximity },
            { op: 'set', path: ['minKeyLength'], value: draft.minKeyLength },
            { op: 'set', path: ['extraModels'], value: draft.extraModels },
            { op: 'set', path: ['notifyChild'], value: draft.notifyChild === true },
            { op: 'set', path: ['notifyParent'], value: draft.notifyParent === true },
            { op: 'set', path: ['strict'], value: draft.strict === true },
          ], revision),
        })

        // The row key is what gives the plugin row its configure control; the
        // bundle key renders the same page on the bundle's own detail page.
        ctx.effect(() => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: ROW_KEY,
          order: 10,
          inject: injected,
        }, RoutePage)), `${NS}: row page`)
        ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: NS,
          order: 10,
          inject: injected,
        }, RoutePage)), `${NS}: bundle page`)
      },
    }
  },
})
