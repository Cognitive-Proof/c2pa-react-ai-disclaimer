import type { ManifestEntry, ManifestStore, ValidationResults, VerificationOutcome } from 'c2pa-react-component-types'

/**
 * Answers "does the signed provenance declare AI in the current content?" from C2PA
 * data alone.
 *
 * A port of the reference classifier in c2pa-ai-examples (src/classify.rs). The four
 * categories are an application policy, not something the C2PA specification prescribes:
 *
 * 1. No readable manifest, or a validation failure in the active manifest → unknown.
 * 2. The origin comes from `c2pa.created`'s digitalSourceType (after action templates
 *    are applied), or from the parent ingredient for `c2pa.opened`, classified
 *    recursively. An update manifest with no actions inherits its parent.
 * 3. An AI origin whose current components are all AI (or an `empty` origin made only
 *    of AI components) → `ai`.
 * 4. Otherwise an AI origin, an AI action, an AI component that hasn't been removed by
 *    `c2pa.deleted`, or a `c2pa.ai-disclosure` assertion → `includes-ai`.
 * 5. Otherwise an unknown origin, an unclear source type, an unknown component, or a
 *    history that may be incomplete (no `allActionsIncluded: true`) → `unknown`.
 * 6. Anything else → `no-ai`.
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

const IPTC = 'http://cv.iptc.org/newscodes/digitalsourcetype/'
const C2PA = 'http://c2pa.org/digitalsourcetype/'

/** What a source type says about the content it describes. */
type Source =
  | 'ai'
  | 'includes-ai'
  | 'no-ai'
  /** `empty`: the content comes entirely from the ingredients. */
  | 'empty'
  /** Edits made by people with non-generative tools; says nothing about the origin. */
  | 'human-edits'
  /** Neither confirms nor rules out a trained model, or is not a recognised term. */
  | 'unclear'

const IPTC_SOURCES: Record<string, Source> = {
  trainedAlgorithmicMedia: 'ai',
  compositeWithTrainedAlgorithmicMedia: 'includes-ai',
  digitalCapture: 'no-ai',
  negativeFilm: 'no-ai',
  positiveFilm: 'no-ai',
  print: 'no-ai',
  digitalCreation: 'no-ai',
  compositeCapture: 'no-ai',
  algorithmicMedia: 'no-ai',
  humanEdits: 'human-edits',
  minorHumanEdits: 'human-edits',
  // screenCapture says how a screen was captured, not where its content came from;
  // virtualRecording explicitly allows synthetic elements. Both fall through to unclear.
}

function sourceOf(uri: string): Source {
  if (uri === `${C2PA}trainedAlgorithmicData`) return 'ai'
  if (uri === `${C2PA}empty`) return 'empty'
  if (!uri.startsWith(IPTC)) return 'unclear'
  return IPTC_SOURCES[uri.slice(IPTC.length)] ?? 'unclear'
}

function short(uri: string) {
  return uri.split('/').pop() ?? uri
}

// Readers disagree on shapes: c2pa-rs JSON is snake_case with assertions as a
// [{label, data}] array, wasm readers use Maps and `manifestId`, and this library's
// types use camelCase with assertions keyed by label (repeats suffixed `__1`, `__2`, …).
// Accept all of them.
type LooseRecord = Record<string, unknown>

interface LooseIngredient {
  title?: string
  label?: string
  relationship?: string
  active_manifest?: string
  manifestId?: string
  digital_source_type?: string
  digitalSourceType?: string
  validation_results?: { activeManifest?: Partial<ValidationResults> }
}

interface LooseAction extends LooseRecord {
  action?: string
  digitalSourceType?: string
  parameters?: LooseRecord
}

interface ActionsData {
  actions?: LooseAction[]
  templates?: LooseAction[]
  allActionsIncluded?: boolean
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

/** All assertions of a manifest as (label without instance suffix, data) pairs. */
function getAssertions(entry: LooseRecord): [string, unknown][] {
  const assertions = entry.assertions
  const pairs: [string, unknown][] = Array.isArray(assertions)
    ? (assertions as { label?: string; data?: unknown }[]).map((a) => [a.label ?? '', a.data])
    : Array.from(toMap(assertions).entries())
  return pairs.map(([label, data]) => [label.replace(/__\d+$/, ''), data])
}

function getActionsAssertions(entry: LooseRecord): [string, ActionsData][] {
  return getAssertions(entry)
    .filter(([label]) => label === 'c2pa.actions' || label.startsWith('c2pa.actions.'))
    .map(([label, data]) => [label, (data ?? {}) as ActionsData])
}

/**
 * Every action with its templates applied: the `*` template first, then same-named
 * templates in order, then the action's own fields; `parameters` merge key by key.
 */
function mergedActions(data: ActionsData): LooseAction[] {
  const templates = data.templates ?? []
  return (data.actions ?? []).map((action) => {
    const layers = [
      ...templates.filter((t) => t.action === '*'),
      ...templates.filter((t) => t.action === action.action),
      action,
    ]
    const out: LooseAction = {}
    for (const layer of layers) {
      for (const [key, value] of Object.entries(layer)) {
        out[key] =
          key === 'parameters' && out.parameters && typeof out.parameters === 'object'
            ? { ...out.parameters, ...(value as LooseRecord) }
            : value
      }
    }
    out.action = action.action
    return out
  })
}

/** "manifest|ingredient assertion" key of a hashed JUMBF URI, if it names both. */
function target(url: string): string | undefined {
  const rest = url.split('/c2pa/')[1]
  if (!rest) return undefined
  const i = rest.indexOf('/c2pa.assertions/')
  if (i < 0) return undefined
  return `${rest.slice(0, i)}|${rest.slice(i + '/c2pa.assertions/'.length)}`
}

function getIngredients(entry: LooseRecord): LooseIngredient[] {
  return Array.isArray(entry.ingredients) ? (entry.ingredients as LooseIngredient[]) : []
}

function classifyIngredient(
  store: Store,
  ing: LooseIngredient,
  deleted: Set<string>,
  seen: Set<string>,
): AiClassification {
  const title = ing.title ?? 'untitled ingredient'
  const bad = failureCodes(ing.validation_results)
  if (bad.length > 0) {
    return { verdict: 'unknown', reason: `ingredient '${title}' failed validation: ${bad.join(', ')}` }
  }
  const label = ing.active_manifest ?? ing.manifestId
  if (label) {
    const { verdict, reason } = classifyManifest(store, label, deleted, seen)
    return { verdict, reason: `ingredient '${title}' -> ${reason}` }
  }
  // An ingredient without a manifest may still declare its own source type.
  const dst = ing.digital_source_type ?? ing.digitalSourceType
  if (!dst) {
    return { verdict: 'unknown', reason: `ingredient '${title}' has no manifest or source type` }
  }
  const source = sourceOf(dst)
  const verdict: AiVerdict = source === 'ai' || source === 'includes-ai' || source === 'no-ai' ? source : 'unknown'
  return { verdict, reason: `ingredient '${title}' declares ${short(dst)} (no manifest)` }
}

function classifyManifest(
  store: Store,
  label: string,
  inheritedDeleted: Set<string>,
  seen: Set<string>,
): AiClassification {
  const entry = store.manifests.get(label)
  if (!entry) return { verdict: 'unknown', reason: `manifest '${label}' not found` }
  if (seen.has(label)) return { verdict: 'unknown', reason: `manifest '${label}' references itself` }
  const visiting = new Set(seen).add(label)

  const assertions = getActionsAssertions(entry)
  const actions = assertions.flatMap(([, data]) => mergedActions(data))
  // Only a v2 assertion saying allActionsIncluded: true rules out unrecorded actions.
  const complete =
    assertions.length > 0 &&
    assertions.every(([l, data]) => l === 'c2pa.actions.v2' && data.allActionsIncluded === true)

  // Components removed by c2pa.deleted, here or in a later manifest, are not current content.
  const deleted = new Set(inheritedDeleted)
  for (const a of actions.filter((a) => a.action === 'c2pa.deleted')) {
    const refs = (a.parameters?.ingredients ?? []) as { url?: string }[]
    for (const ref of refs) {
      const key = ref.url && target(ref.url)
      if (key) deleted.add(key)
    }
  }

  const ingredients = getIngredients(entry)
  const parent = ingredients.find((i) => i.relationship === 'parentOf')
  const components = ingredients
    .filter((i) => i.relationship === 'componentOf')
    .filter((i) => !deleted.has(`${label}|${i.label ?? ''}`))
    .map((i) => classifyIngredient(store, i, deleted, visiting))

  const notes: string[] = []
  let aiSignal = false
  let unclear = false
  let emptyOrigin = false
  let origin: AiVerdict | undefined

  for (const { action = '', digitalSourceType: dst } of actions) {
    if (action === 'c2pa.created') {
      if (dst) {
        notes.push(`created as ${short(dst)}`)
        const source = sourceOf(dst)
        if (source === 'empty') emptyOrigin = true
        origin =
          source === 'empty' ? 'no-ai'
          : source === 'human-edits' || source === 'unclear' ? 'unknown'
          : source
      } else {
        notes.push('created with no digitalSourceType')
        origin = 'unknown'
      }
    } else if (action === 'c2pa.opened') {
      const result = parent
        ? classifyIngredient(store, parent, deleted, visiting)
        : { verdict: 'unknown' as const, reason: 'opened with no parent ingredient' }
      notes.push(`opened parent: ${result.reason}`)
      origin = result.verdict
    } else if (action === 'c2pa.deleted') {
      notes.push('c2pa.deleted removes a component')
    } else if (dst) {
      notes.push(`${action} as ${short(dst)}`)
      const source = sourceOf(dst)
      if (source === 'ai' || source === 'includes-ai') aiSignal = true
      else if (source === 'unclear') unclear = true
    }
  }

  if (!origin) {
    // An update manifest need not record an opened action; it inherits its parent.
    if (parent && actions.length === 0) {
      const { verdict, reason } = classifyIngredient(store, parent, deleted, visiting)
      return { verdict, reason: `update manifest over ${reason}` }
    }
    notes.push('no created or opened action')
    origin = 'unknown'
  }

  if (getAssertions(entry).some(([l]) => l === 'c2pa.ai-disclosure')) {
    notes.push('c2pa.ai-disclosure present')
    aiSignal = true
  }
  for (const { verdict, reason } of components) {
    notes.push(`component: ${reason}`)
    if (verdict === 'ai' || verdict === 'includes-ai') aiSignal = true
    else if (verdict === 'unknown') unclear = true
  }
  if (!complete) {
    notes.push('history may be incomplete (allActionsIncluded not true)')
  }

  const allComponentsAi = components.every((c) => c.verdict === 'ai')
  const verdict: AiVerdict =
    (origin === 'ai' && allComponentsAi) || (emptyOrigin && components.length > 0 && allComponentsAi) ? 'ai'
    : origin === 'ai' || origin === 'includes-ai' || aiSignal ? 'includes-ai'
    : origin === 'unknown' || unclear || !complete ? 'unknown'
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
  return classifyManifest(store, target, new Set(), new Set())
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
