/**
 * Message construction with no Harness import.
 *
 * A profile-installed plugin is mounted from its own directory, so a bare
 * `@deepseek-ai/dsh-llm` specifier would resolve there and find nothing. These
 * two functions reproduce what `createUserMessage` does — branded random id and
 * a deeply frozen snapshot — which is all this plugin needs.
 *
 * @module dsh-subagent-route/message
 */

import { randomUUID } from 'node:crypto'

/** Recursively freeze a JSON-shaped value in place. */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/**
 * Build one immutable user-role message.
 *
 * `source.kind` must be producer-owned: session format v4 rejects a bare
 * `plugin` wrapper and the whole session then refuses to load, so the caller
 * passes `plugin:<package-name>`.
 */
export function createPluginUserMessage(input) {
  return deepFreeze(structuredClone({
    id: randomUUID(),
    role: 'user',
    content: input.content,
    source: input.source,
  }))
}
