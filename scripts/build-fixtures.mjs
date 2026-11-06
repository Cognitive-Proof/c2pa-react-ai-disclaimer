// Turns the signed test assets in ../c2pa-ai-examples into VerificationOutcome JSON
// fixtures (examples/*.json) by reading each file with c2patool.
//
//   npm run fixtures [-- path/to/c2pa-ai-examples]
//
// Requires c2patool on PATH. The examples' own trust settings are passed so the
// test certificate validates; the classifier ignores signingCredential.untrusted anyway.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const examplesRepo = resolve(process.argv[2] ?? join(root, '../c2pa-ai-examples'))
const outDir = join(root, 'examples')
const settings = join(examplesRepo, 'settings/c2pa-test-settings.json')

const labels = JSON.parse(readFileSync(join(examplesRepo, 'labels.json'), 'utf8'))
mkdirSync(outDir, { recursive: true })

function c2patool(file, ...extra) {
  const args = existsSync(settings) ? ['--settings', settings, file, ...extra] : [file, ...extra]
  return JSON.parse(execFileSync('c2patool', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
}

function readStore(file) {
  let store
  try {
    store = c2patool(file)
  } catch (err) {
    // No manifest, or one that can't be read (e.g. an unreachable remote manifest).
    return { error: String(err.stderr ?? err.message).trim() }
  }
  // c2patool 0.27 leaves an ingredient's own digitalSourceType out of its JSON, though
  // c2pa-rs Reader::json() includes it as digital_source_type. Copy it from the raw assertion.
  const detailed = c2patool(file, '--detailed')
  for (const [label, m] of Object.entries(store.manifests ?? {})) {
    for (const ing of m.ingredients ?? []) {
      const dst = detailed.manifests?.[label]?.assertion_store?.[ing.label]?.digitalSourceType
      if (dst && !ing.digital_source_type) ing.digital_source_type = dst
    }
  }
  return store
}

function assertionRecord(assertions = []) {
  const record = {}
  for (const { label, data, instance } of assertions) {
    const key = label in record ? `${label}__${instance ?? Object.keys(record).length}` : label
    record[key] = data
  }
  return record
}

function failures(results) {
  return (results?.activeManifest?.failure ?? []).filter((f) => f.code !== 'signingCredential.untrusted')
}

function toOutcome(store) {
  if (!store.manifests) return { state: false, manifests: [], error: store.error }

  const entries = Object.entries(store.manifests).map(([label, m]) => ({
    label,
    claim_version: m.claim_version,
    title: m.title,
    instanceId: m.instance_id,
    claimGenerator: m.claim_generator ?? null,
    claimGeneratorInfo: m.claim_generator_info,
    signatureInfo: m.signature_info,
    assertions: assertionRecord(m.assertions),
    ingredients: m.ingredients ?? [],
    credentials: [],
    thumbnail: null,
  }))

  return {
    state: failures(store.validation_results).length === 0,
    manifests: entries.map(({ label, ...rest }) => ({ id: label, ...rest })),
    manifestStore: {
      activeManifest: store.active_manifest,
      manifests: Object.fromEntries(entries.map((e) => [e.label, e])),
      validation_status: store.validation_status,
      validation_results: store.validation_results,
      validation_state: store.validation_state,
    },
  }
}

const index = []
for (const entry of labels) {
  const name = basename(entry.file).replace(/\.[^.]+$/, '')
  const outcome = toOutcome(readStore(join(examplesRepo, entry.file)))
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(outcome, null, 2) + '\n')
  index.push({ ...entry, fixture: `${name}.json` })
  console.log(`${entry.expected.padEnd(12)} ${name}`)
}
writeFileSync(join(outDir, 'labels.json'), JSON.stringify(index, null, 2) + '\n')
