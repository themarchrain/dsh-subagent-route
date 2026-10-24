/**
 * Guards against the two drifts that would silently break this plugin:
 *
 *   1. The client page's `DEFAULTS` diverging from the Host `Config` schema, so
 *      the page offers a value the Host rejects — or hides one it applies.
 *   2. The built `lib/client.js` not matching `src/client.template.js`, so a
 *      source edit was never rebuilt and the browser keeps running old code.
 *
 * Both checks read the files as text: the Host module imports `schemastery`,
 * which is not installed while these tests run, so it cannot be imported here.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Read one repository file. */
function read(relative) {
  return readFileSync(join(ROOT, relative), 'utf8')
}

/** The Host config keys, in declaration order, from the schema literal. */
function hostConfigKeys() {
  const source = read('lib/index.js')
  const start = source.indexOf('export const Config = z.object({')
  assert.ok(start > 0, 'the Host Config schema must be declared in lib/index.js')
  const body = source.slice(start)
  return [...body.matchAll(/^ {2}(\w+): volatile\(/gmu)].map(match => match[1])
}

/** The client page's `DEFAULTS` keys, in declaration order. */
function clientDefaultKeys() {
  const source = read('src/client.template.js')
  const start = source.indexOf('const DEFAULTS = {')
  assert.ok(start > 0, 'the client page must declare DEFAULTS')
  const end = source.indexOf('\n    }', start)
  const body = source.slice(start, end)
  return [...body.matchAll(/^ {6}(\w+):/gmu)].map(match => match[1])
}

test('the schema and the page describe exactly the same fields', () => {
  assert.deepEqual(clientDefaultKeys(), hostConfigKeys())
})

test('every default the page offers matches the schema default', () => {
  const host = read('lib/index.js')
  const client = read('src/client.template.js')
  const pageBody = client.slice(client.indexOf('const DEFAULTS = {'), client.indexOf('\n    }', client.indexOf('const DEFAULTS = {')))
  // Numbers and booleans are compared by their literal spelling; arrays and
  // strings are compared by presence, because the schema carries descriptions.
  for (const key of ['proximity', 'minKeyLength']) {
    const hostMatch = new RegExp(`${key}: volatile\\(z\\.number\\(\\)[\\s\\S]*?\\.default\\((\\d+)\\)`, 'u').exec(host)
    const pageMatch = new RegExp(`^ {6}${key}: (\\d+),`, 'mu').exec(pageBody)
    assert.ok(hostMatch !== null, `the schema must default ${key}`)
    assert.ok(pageMatch !== null, `the page must default ${key}`)
    assert.equal(pageMatch[1], hostMatch[1], `${key} defaults must agree`)
  }
  for (const key of ['enabled', 'requireTrigger', 'notifyChild', 'notifyParent', 'strict']) {
    const hostMatch = new RegExp(`${key}: volatile\\(z\\.boolean\\(\\)\\.default\\((true|false)\\)`, 'u').exec(host)
    const pageMatch = new RegExp(`^ {6}${key}: (true|false),`, 'mu').exec(pageBody)
    assert.ok(hostMatch !== null, `the schema must default ${key}`)
    assert.ok(pageMatch !== null, `the page must default ${key}`)
    assert.equal(pageMatch[1], hostMatch[1], `${key} defaults must agree`)
  }
  const hostScope = /scope: volatile\(z\.union\(\[z\.const\('([\w-]+)'\)/u.exec(host)
  assert.ok(hostScope !== null)
  assert.match(pageBody, new RegExp(`scope: '${hostScope[1]}'`, 'u'))
})

test('every Host config field is marked volatile, so the page can save it', () => {
  const host = read('lib/index.js')
  const start = host.indexOf('export const Config = z.object({')
  const end = host.indexOf('\n})', start)
  const body = host.slice(start, end)
  const declared = [...body.matchAll(/^ {2}(\w+): /gmu)].map(match => match[1])
  const volatileFields = [...body.matchAll(/^ {2}(\w+): volatile\(/gmu)].map(match => match[1])
  assert.deepEqual(volatileFields, declared)
})

test('every Host config field declares a default', () => {
  const host = read('lib/index.js')
  const start = host.indexOf('export const Config = z.object({')
  const end = host.indexOf('\n})', start)
  const body = host.slice(start, end)
  // Walk the field blocks: a field starts at `  <key>: volatile(` and runs to
  // the next field or the end of the literal, so a multi-line builder chain
  // stays with its own field.
  const fieldStarts = [...body.matchAll(/^ {2}(\w+): volatile\(/gmu)]
  assert.ok(fieldStarts.length > 10, 'the schema must declare its fields')
  fieldStarts.forEach((match, index) => {
    const from = match.index
    const to = index + 1 < fieldStarts.length ? fieldStarts[index + 1].index : body.length
    const block = body.slice(from, to)
    assert.match(block, /\.default\(/u, `${match[1]} must declare a default`)
  })
})

test('the built client matches its template and carries the inlined matcher', () => {
  const built = read('lib/client.js')
  const template = read('src/client.template.js')
  assert.ok(built.includes('function parseDirective'), 'the matcher must be inlined')
  assert.ok(built.includes('function foldText'), 'the matcher must be inlined whole')
  assert.equal(/^import /mu.test(built), false, 'a dynamic bundle cannot use static imports')
  assert.equal(/^export /mu.test(built), false, 'a dynamic bundle registers itself, not exports')
  // Every copy key the page renders must exist in the built bundle too.
  for (const key of ['rehearseRun', 'unavailable', 'strictDesc']) {
    assert.ok(template.includes(`${key}:`), `${key} must exist in the template`)
    assert.ok(built.includes(`${key}:`), `${key} must reach the built bundle`)
  }
})

test('the manifest exposes exactly the files the runtime imports', () => {
  const manifest = JSON.parse(read('package.json'))
  for (const entry of ['lib/index.js', 'lib/matcher.js', 'lib/message.js', 'lib/route.js', 'lib/client.js']) {
    assert.ok(manifest.files.includes(entry), `${entry} must be published`)
  }
  assert.equal(manifest.exports['.'], './lib/index.js')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
})

test('the patch mounts exactly one row, named after the package', () => {
  const manifest = JSON.parse(read('package.json'))
  const patch = read('cordis.patch.yml')
  assert.ok(patch.includes(`- id: ${manifest.name}`))
  assert.ok(patch.includes(`name: '${manifest.name}'`))
  assert.equal([...patch.matchAll(/- id:/gu)].length, 1)
})

test('both locales describe the plugin under meta', () => {
  for (const locale of ['en', 'zh']) {
    const dict = JSON.parse(read(`locale/${locale}.json`))
    assert.equal(typeof dict.meta.title, 'string')
    assert.ok(dict.meta.title.length > 0)
    assert.ok(dict.meta.description.length > 0)
  }
})
