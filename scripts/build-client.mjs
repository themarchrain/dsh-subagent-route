/**
 * Build `lib/client.js` from `src/client.template.js` plus the real matcher.
 *
 * The browser half is a single `window.__ModuleLoader__.load` factory, so it
 * cannot `import` the Host's ESM matcher. Rather than hand-copying the rules
 * (two implementations of one rule set always drift), the build inlines
 * `lib/matcher.js` into the factory body. There is exactly one matcher, and the
 * page's dry run therefore resolves sentences exactly the way the Host does.
 *
 * Run with `node scripts/build-client.mjs`.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TEMPLATE = join(ROOT, 'src', 'client.template.js')
const MATCHER = join(ROOT, 'lib', 'matcher.js')
const OUTPUT = join(ROOT, 'lib', 'client.js')

const PLACEHOLDER = '    /* @inline-matcher */'

/**
 * Turn the ESM matcher into a function block the factory can call.
 *
 * Only `export ` keywords are stripped: the module has no imports, no
 * top-level side effects, and no default export, so the result is valid
 * function-scope JavaScript.
 *
 * @param source - contents of `lib/matcher.js`.
 * @returns the matcher body, ready to be nested inside the factory.
 */
function inlineMatcher(source) {
  return source
    .split('\n')
    .filter(line => !line.startsWith('import '))
    .map(line => (line.startsWith('export ') ? line.slice('export '.length) : line))
    // Nested at factory depth: indent every line two more spaces than the
    // template's placeholder column so the generated file stays readable.
    .map(line => (line === '' ? line : `  ${line}`))
    .join('\n')
}

/**
 * Replace the placeholder with the matcher, or fail loudly.
 *
 * @param template - contents of the client template.
 * @param matcher - contents of the matcher module.
 * @returns the client source.
 */
function compose(template, matcher) {
  if (!template.includes(PLACEHOLDER)) {
    throw new Error(`client template is missing its ${PLACEHOLDER.trim()} placeholder`)
  }
  return template.replace(PLACEHOLDER, inlineMatcher(matcher))
}

const template = readFileSync(TEMPLATE, 'utf8')
const matcher = readFileSync(MATCHER, 'utf8')
const composed = compose(template, matcher)
writeFileSync(OUTPUT, composed, 'utf8')
// Report the size so a mistaken full-file copy is visible in the build log.
process.stdout.write(`built ${join('lib', 'client.js')} (${composed.length} bytes)\n`)
