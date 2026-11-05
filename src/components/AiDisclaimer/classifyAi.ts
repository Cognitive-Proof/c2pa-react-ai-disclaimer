import type { ManifestEntry, ManifestStore, ValidationResults, VerificationOutcome } from 'c2pa-react-component-types'

/**
 * Answers "was AI involved in making this?" from C2PA provenance alone.
 *
 * A port of the reference classifier in c2pa-ai-examples (src/classify.rs):
 *
 * 1. No readable manifest, or a validation failure in the active manifest → unknown.
 * 2. The origin comes from `c2pa.created`'s digitalSourceType, or from the parent
 *    ingredient for `c2pa.opened` (classified recursively).
 * 3. An AI origin makes it `ai`, whatever human edits follow.
 * 4. Otherwise an AI action or AI `componentOf` ingredient makes it `includes-ai`.
 * 5. Otherwise an unknown origin, an unclear source type or unknown component → `unknown`.
 * 6. Anything else is `no-ai`.
 *
 * `signingCredential.untrusted` is ignored: trust belongs to the reader's trust list,
 * not to whether AI was used.
 */
export type AiVerdict = 'ai' | 'includes-ai' | 'no-ai' | 'unknown'

export interface AiClassification {
  verdict: AiVerdict
  /** Why, in the same wording as the reference classifier's `classifierReason`. */
  reason: string
}

type Source = 'ai' | 'includes-ai' | 'no-ai' | 'unclear' | 'empty'

const IPTC_SOURCES: Record<string, Source> = {
  trainedAlgorithmicMedia: 'ai',
  trainedAlgorithmicData: 'ai',
  compositeWithTrainedAlgorithmicMedia: 'includes-ai',
  digitalCapture: 'no-ai',
  negativeFilm: 'no-ai',
  positiveFilm: 'no-ai',
  print: 'no-ai',
  digitalCreation: 'no-ai',
  compositeCapture: 'no-ai',
  screenCapture: 'no-ai',
  algorithmicMedia: 'no-ai',
  humanEdits: 'no-ai',
  minorHumanEdits: 'no-ai',
  virtualRecording: 'no-ai',
  empty: 'empty',
}

function sourceName(uri: string) {
  return uri.split('/').pop() ?? uri
}

function sourceOf(uri: string): Source {
  return IPTC_SOURCES[sourceName(uri)] ?? 'unclear'
}

// Readers disagree on shapes: c2pa-rs JSON is snake_case with assertions as a
// [{label, data}] array, wasm readers use Maps and `manifestId`, and this library's
// types use camelCase with assertions keyed by label. Accept all of them.
type LooseRecord = Record<string, unknown>

interface LooseIngredient {
  title?: string
  relationship?: string
  active_manifest?: string
  manifestId?: string
  validation_results?: { activeManifest?: Partial<ValidationResults> }
}

interface LooseAction {
  action?: string
  digitalSourceType?: string
}

interface Store {
  active?: string
  manifests: Map<string, LooseRecord>
  failures: string[]
}

function toMap(value: unknown): Map<string, LooseRecord> {
  if (value instanceof Map) return value as Map<string, LooseRecord>
  if (value && typeof value === 'object') return new Map(Object.entries(value as Record<string, LooseRecord>))
  return new Map()
}

function failureCodes(results: { activeManifest?: Partial<ValidationResults> } | undefined): string[] {
  return (results?.activeManifest?.failure ?? [])
    .map((f) => f.code)
    .filter((code) => code && code !== 'signingCredential.untrusted')
}

function toStore(outcome: VerificationOutcome | ManifestStore | undefined): Store | undefined {
  if (!outcome) return undefined
  const store = ('manifestStore' in outcome ? outcome.manifestStore : outcome) as
    | (ManifestStore & { active_manifest?: string })
    | undefined
  if (!store?.manifests) return undefined
  return {
    active: store.activeManifest ?? store.active_manifest,
    manifests: toMap(store.manifests),
    failures: failureCodes(store.validation_results),
  }
}

function getActions(entry: LooseRecord): LooseAction[] {
  const assertions = entry.assertions
  const pairs: [string, unknown][] = Array.isArray(assertions)
    ? (assertions as { label?: string; data?: unknown }[]).map((a) => [a.label ?? '', a.data])
    : Array.from(toMap(assertions).entries())
  return pairs
    .filter(([label]) => label.startsWith('c2pa.actions'))
    .flatMap(([, data]) => ((data as { actions?: LooseAction[] } | undefined)?.actions ?? []))
}

function getIngredients(entry: LooseRecord): LooseIngredient[] {
  return Array.isArray(entry.ingredients) ? (entry.ingredients as LooseIngredient[]) : []
}

function classifyIngredient(store: Store, ing: LooseIngredient, seen: Set<string>): AiClassification {
  const title = ing.title ?? 'untitled ingredient'
  const bad = failureCodes(ing.validation_results)
  if (bad.length > 0) {
    return { verdict: 'unknown', reason: `ingredient '${title}' failed validation: ${bad.join(', ')}` }
  }
  const label = ing.active_manifest ?? ing.manifestId
  if (!label) {
    return { verdict: 'unknown', reason: `ingredient '${title}' has no C2PA manifest` }
  }
  const { verdict, reason } = classifyManifest(store, label, seen)
  return { verdict, reason: `ingredient '${title}' -> ${reason}` }
}

function classifyManifest(store: Store, label: string, seen: Set<string>): AiClassification {
  const entry = store.manifests.get(label)
  if (!entry) return { verdict: 'unknown', reason: `manifest '${label}' not found` }
  if (seen.has(label)) return { verdict: 'unknown', reason: `manifest '${label}' references itself` }
  const visiting = new Set(seen).add(label)

  const actions = getActions(entry)
  const ingredients = getIngredients(entry)
  const components = ingredients
    .filter((i) => i.relationship === 'componentOf')
    .map((i) => classifyIngredient(store, i, visiting))

  const notes: string[] = []
  let aiSignal = false
  let unclear = false
  let origin: AiVerdict | undefined

  for (const { action = '', digitalSourceType: dst } of actions) {
    if (action === 'c2pa.created') {
      if (dst) {
        notes.push(`created as ${sourceName(dst)}`)
        const source = sourceOf(dst)
        origin =
          source === 'empty' ? (components.length > 0 ? 'no-ai' : 'unknown')
          : source === 'unclear' ? 'unknown'
          : source
      } else {
        notes.push('created with no digitalSourceType')
        origin = 'unknown'
      }
    } else if (action === 'c2pa.opened') {
      const parent = ingredients.find((i) => i.relationship === 'parentOf')
      const result = parent
        ? classifyIngredient(store, parent, visiting)
        : { verdict: 'unknown' as const, reason: 'opened with no parent ingredient' }
      notes.push(`opened parent: ${result.reason}`)
      origin = result.verdict
    } else if (dst) {
      notes.push(`${action} as ${sourceName(dst)}`)
      const source = sourceOf(dst)
      if (source === 'ai' || source === 'includes-ai') aiSignal = true
      else if (source === 'unclear') unclear = true
    }
  }

  for (const { verdict, reason } of components) {
    notes.push(`component: ${reason}`)
    if (verdict === 'ai' || verdict === 'includes-ai') aiSignal = true
    else if (verdict === 'unknown') unclear = true
  }

  if (!origin) {
    notes.push('no created or opened action')
    origin = 'unknown'
  }

  const verdict: AiVerdict =
    origin === 'ai' ? 'ai'
    : origin === 'includes-ai' || aiSignal ? 'includes-ai'
    : origin === 'unknown' || unclear ? 'unknown'
    : 'no-ai'

  return { verdict, reason: notes.join('; ') }
}

/** Validation failures recorded against `label` wherever another manifest uses it as an ingredient. */
function ingredientFailures(store: Store, label: string): string[] {
  for (const entry of store.manifests.values()) {
    for (const ing of getIngredients(entry)) {
      if ((ing.active_manifest ?? ing.manifestId) === label) {
        const bad = failureCodes(ing.validation_results)
        if (bad.length > 0) return bad
      }
    }
  }
  return []
}

/**
 * Classifies a verification outcome (or a bare manifest store). Pass `label` to
 * classify one manifest in the store instead of the active one.
 */
export function classifyAi(
  outcome: VerificationOutcome | ManifestStore | undefined,
  label?: string,
): AiClassification {
  const store = toStore(outcome)
  if (!store || store.manifests.size === 0) {
    return { verdict: 'unknown', reason: 'no readable C2PA manifest' }
  }
  const target = label ?? store.active
  if (!target) return { verdict: 'unknown', reason: 'no active manifest' }

  const isActive = target === store.active
  const bad = isActive ? store.failures : ingredientFailures(store, target)
  if (bad.length > 0) {
    const which = isActive ? 'active manifest' : 'manifest'
    return { verdict: 'unknown', reason: `${which} failed validation: ${bad.join(', ')}` }
  }
  return classifyManifest(store, target, new Set())
}

/** Classifies a list of manifest entries, treating the last one as active. */
export function classifyAiEntries(entries: ManifestEntry[]): AiClassification {
  const manifests: Record<string, ManifestEntry> = {}
  entries.forEach((entry, i) => {
    manifests[entry.label ?? entry.id ?? String(i)] = entry
  })
  const last = entries[entries.length - 1]
  return classifyAi({
    activeManifest: last ? (last.label ?? last.id ?? String(entries.length - 1)) : '',
    manifests,
  })
}
