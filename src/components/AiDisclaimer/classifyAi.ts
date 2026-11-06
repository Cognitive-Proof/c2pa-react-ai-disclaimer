import type { ManifestEntry, ManifestStore, ValidationResults, VerificationOutcome } from 'c2pa-react-component-types'

/**
 * Answers "does the signed provenance declare generative AI in the current content?" from
 * C2PA data alone.
 *
 * A port of the reference classifier in c2pa-ai-examples (src/classify.rs). The four
 * categories are an application policy, not something the C2PA specification prescribes.
 * It concerns *generative* AI, following the IPTC split between generative and
 * non-generative tools: `computationalCapture` and `digitalCreation` count as no AI.
 *
 * - No readable manifest, or a validation failure in the active manifest → unknown.
 * - Actions are read as a consumer must see them: templates merged in, then each
 *   `related` action merged onto its primary.
 * - The origin comes from `c2pa.created`'s digitalSourceType, or from the parent ingredient
 *   for `c2pa.opened`, classified recursively. An update manifest can't change the content,
 *   so it takes its parent's verdict.
 * - `ai` needs an AI origin (or an `empty` origin built from AI components), all current
 *   components AI, a complete history, and no later change that may have added other content.
 * - Otherwise any AI in the origin, actions or current components → `includes-ai`.
 * - Otherwise anything uncertain (unknown origin, unclear source type, an edit or processing
 *   step with no source type, redacted provenance, an incomplete history) → `unknown`.
 * - Anything else → `no-ai`.
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
  /** Neither confirms nor rules out generative AI, or is not a recognised term. */
  | 'unclear'

const IPTC_SOURCES: Record<string, Source> = {
  trainedAlgorithmicMedia: 'ai',
  compositeWithTrainedAlgorithmicMedia: 'includes-ai',
  // "at least one of which is Generative AI"
  compositeSynthetic: 'includes-ai',
  digitalCapture: 'no-ai',
  // Merges frames with "non-generative AI" at most.
  computationalCapture: 'no-ai',
  negativeFilm: 'no-ai',
  positiveFilm: 'no-ai',
  print: 'no-ai',
  digitalCreation: 'no-ai',
  compositeCapture: 'no-ai',
  algorithmicMedia: 'no-ai',
  humanEdits: 'human-edits',
  minorHumanEdits: 'human-edits',
  // screenCapture says how a screen was captured, not where its content came from;
  // virtualRecording may be generative; algorithmicallyEnhanced doesn't say whether the
  // algorithm is generative. All fall through to unclear.
}

function sourceOf(uri: string): Source {
  // Data from a trained model (CSV, pickle): the model may as well be a classifier.
  if (uri === `${C2PA}trainedAlgorithmicData`) return 'unclear'
  if (uri === `${C2PA}empty`) return 'empty'
  if (!uri.startsWith(IPTC)) return 'unclear'
  return IPTC_SOURCES[uri.slice(IPTC.length)] ?? 'unclear'
}

/** Source types that declare any AI involvement, generative or not. */
function declaresAiUse(uri: string) {
  const source = sourceOf(uri)
  return (
    source === 'ai' ||
    source === 'includes-ai' ||
    uri === `${C2PA}trainedAlgorithmicData` ||
    uri === `${IPTC}computationalCapture` ||
    uri === `${IPTC}algorithmicallyEnhanced`
  )
}

/** How an action from the specification's list (`actions.yaml`) affects the content. */
type Effect =
  /** Removes, rearranges or repackages existing content, or touches none of it. */
  | 'preserves'
  /** Reprocesses existing content; adds no material, but could be a generative model. */
  | 'processes'
  /** May add content of its own (drawing, text, a filter, a generic edit). */
  | 'adds'
  /** Not a specification action, or `c2pa.unknown`. */
  | 'unknown'

const PRESERVING = new Set([
  'c2pa.converted', 'c2pa.cropped', 'c2pa.deleted', 'c2pa.edited.metadata', 'c2pa.orientation',
  'c2pa.published', 'c2pa.redacted', 'c2pa.removed', 'c2pa.repackaged', 'c2pa.reviewed',
  'c2pa.trimmed', 'c2pa.watermarked', 'c2pa.watermarked.bound', 'c2pa.watermarked.unbound',
])

const PROCESSING = new Set([
  'c2pa.adjustedColor', 'c2pa.changedSpeed', 'c2pa.color_adjustments', 'c2pa.enhanced',
  'c2pa.mastered', 'c2pa.resized', 'c2pa.resized.proportional', 'c2pa.transcoded',
])

function effectOf(action: string): Effect {
  if (PRESERVING.has(action)) return 'preserves'
  if (PROCESSING.has(action)) return 'processes'
  if (action === 'c2pa.unknown') return 'unknown'
  if (action.startsWith('c2pa.') || action.startsWith('font.')) return 'adds'
  return 'unknown'
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
  parameters?: { ingredients?: { url?: string }[] } & LooseRecord
  related?: LooseAction[]
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
  /**
   * Whether the store carries hard-binding (`c2pa.hash.*`) assertions. c2pa-rs
   * `Reader::json()` leaves them out, so only then does lacking one mark an update manifest.
   */
  showsHardBindings: boolean
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

/** All assertions of a manifest as (label without instance suffix, data) pairs. */
function getAssertions(entry: LooseRecord): [string, unknown][] {
  const assertions = entry.assertions
  const pairs: [string, unknown][] = Array.isArray(assertions)
    ? (assertions as { label?: string; data?: unknown }[]).map((a) => [a.label ?? '', a.data])
    : Array.from(toMap(assertions).entries())
  return pairs.map(([label, data]) => [label.replace(/__\d+$/, ''), data])
}

function hasHardBinding(entry: LooseRecord) {
  return getAssertions(entry).some(([label]) => label.startsWith('c2pa.hash.'))
}

function hasDisclosure(entry: LooseRecord) {
  return getAssertions(entry).some(([label]) => label === 'c2pa.ai-disclosure')
}

function toStore(outcome: VerificationOutcome | ManifestStore | undefined): Store | undefined {
  if (!outcome) return undefined
  const store = ('manifestStore' in outcome ? outcome.manifestStore : outcome) as
    | (ManifestStore & { active_manifest?: string })
    | undefined
  if (!store?.manifests) return undefined
  const manifests = toMap(store.manifests)
  return {
    active: store.activeManifest ?? store.active_manifest,
    manifests,
    failures: failureCodes(store.validation_results),
    showsHardBindings: Array.from(manifests.values()).some(hasHardBinding),
  }
}

function getActionsAssertions(entry: LooseRecord): [string, ActionsData][] {
  return getAssertions(entry)
    .filter(([label]) => label === 'c2pa.actions' || label.startsWith('c2pa.actions.'))
    .map(([label, data]) => [label, (data ?? {}) as ActionsData])
}

/**
 * Overlays `layer` onto `out`. `parameters` merge key by key; in a template, the
 * deprecated `templateParameters` is treated as `parameters`.
 */
function overlay(out: LooseAction, layer: LooseAction, template: boolean) {
  for (const [k, value] of Object.entries(layer)) {
    const key = template && k === 'templateParameters' ? 'parameters' : k
    const current = out[key]
    if (key === 'parameters' && current && typeof current === 'object' && !Array.isArray(current)) {
      Object.assign(current, value && typeof value === 'object' ? value : {})
    } else {
      out[key] = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : value
    }
  }
}

/** `action` followed by each of its `related` actions merged onto it, recursively. */
function withRelated(action: LooseAction, out: LooseAction[]) {
  const { related, ...primary } = action
  out.push(primary)
  for (const r of Array.isArray(related) ? related : []) {
    const merged: LooseAction = structuredClone(primary)
    overlay(merged, r, false)
    withRelated(merged, out)
  }
}

/**
 * Every action as a consumer must see it: the `*` template first, then same-named
 * templates in order, then the action's own fields; then each `related` action merged
 * onto its primary.
 */
function mergedActions(data: ActionsData): LooseAction[] {
  const templates = data.templates ?? []
  const out: LooseAction[] = []
  for (const action of data.actions ?? []) {
    const merged: LooseAction = {}
    for (const t of templates.filter((t) => t.action === '*')) overlay(merged, t, true)
    for (const t of templates.filter((t) => t.action === action.action)) overlay(merged, t, true)
    overlay(merged, action, false)
    merged.action = action.action
    withRelated(merged, out)
  }
  return out
}

/** The ingredient assertion labels an action's `ingredients` parameter references. */
function placedRefs(action: LooseAction): string[] {
  const refs = Array.isArray(action.parameters?.ingredients) ? action.parameters.ingredients : []
  return refs
    .map((r) => r?.url)
    .filter((url): url is string => typeof url === 'string' && url.includes('c2pa.assertions/'))
    .map((url) => url.slice(url.lastIndexOf('c2pa.assertions/') + 'c2pa.assertions/'.length))
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

/** `declared` is a digitalSourceType that the action placing this ingredient gave it. */
function classifyIngredient(
  store: Store,
  ing: LooseIngredient,
  deleted: Set<string>,
  seen: Set<string>,
  declared?: string,
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
  // An ingredient without a manifest may still declare its own source type, or the
  // action that placed it may.
  const dst = ing.digital_source_type ?? ing.digitalSourceType ?? declared
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

  const ingredients = getIngredients(entry)
  const parent = ingredients.find((i) => i.relationship === 'parentOf')

  // An update manifest can't change the content, whatever actions it records, so the
  // content's provenance is the parent's.
  if (store.showsHardBindings && !hasHardBinding(entry)) {
    if (!parent) return { verdict: 'unknown', reason: 'update manifest with no parent ingredient' }
    const { verdict, reason } = classifyIngredient(store, parent, inheritedDeleted, visiting)
    // It can't change the content, but it can add what was not recorded before.
    if (verdict === 'no-ai' && hasDisclosure(entry)) {
      return { verdict: 'unknown', reason: `update manifest adds c2pa.ai-disclosure over ${reason}` }
    }
    return { verdict, reason: `update manifest over ${reason}` }
  }

  const assertions = getActionsAssertions(entry)
  const actions = assertions.flatMap(([, data]) => mergedActions(data))
  // Only a v2 assertion saying allActionsIncluded: true rules out unrecorded actions.
  const complete =
    assertions.length > 0 &&
    assertions.every(([l, data]) => l === 'c2pa.actions.v2' && data.allActionsIncluded === true)

  // Components removed by c2pa.deleted, here or in a later manifest, are not current content.
  const deleted = new Set(inheritedDeleted)
  for (const a of actions.filter((a) => a.action === 'c2pa.deleted')) {
    const refs = Array.isArray(a.parameters?.ingredients) ? a.parameters.ingredients : []
    for (const ref of refs) {
      const key = typeof ref?.url === 'string' ? target(ref.url) : undefined
      if (key) deleted.add(key)
    }
  }
  const isDeleted = (ingredientLabel: string) => deleted.has(`${label}|${ingredientLabel}`)

  // Source types declared on the c2pa.placed action, by the ingredient assertion they placed.
  const placedAs = new Map<string, string>()
  for (const a of actions.filter((a) => a.action === 'c2pa.placed')) {
    if (a.digitalSourceType) for (const l of placedRefs(a)) placedAs.set(l, a.digitalSourceType)
  }

  const components = ingredients
    .filter((i) => i.relationship === 'componentOf')
    .filter((i) => !isDeleted(i.label ?? ''))
    .map((i) => classifyIngredient(store, i, deleted, visiting, i.label ? placedAs.get(i.label) : undefined))

  const notes: string[] = []
  let aiSignal = false
  let unclear = false
  // A later action may have added content that isn't AI, so an AI origin is no longer all.
  let mixed = false
  // Processing with no source type: can't rule out a generative model, but it adds no
  // material, so it only stands in the way of a no-ai verdict.
  let undeclaredProcessing = false
  let aiUseDeclared = false
  let emptyOrigin = false
  let origin: AiVerdict | undefined

  for (const a of actions) {
    const name = a.action ?? ''
    const dst = a.digitalSourceType
    if (name === 'c2pa.created') {
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
    } else if (name === 'c2pa.opened') {
      const result = parent
        ? classifyIngredient(store, parent, deleted, visiting)
        : { verdict: 'unknown' as const, reason: 'opened with no parent ingredient' }
      notes.push(`opened parent: ${result.reason}`)
      origin = result.verdict
    } else if (name === 'c2pa.deleted') {
      notes.push(
        Array.isArray(a.parameters?.ingredients)
          ? 'c2pa.deleted removes a whole component'
          : 'c2pa.deleted of part of the content',
      )
    } else if (name === 'c2pa.placed') {
      // Placed content is judged by its componentOf ingredient below, with any source type
      // declared here filling in for an ingredient that declares none. Evidence about a
      // component that a later c2pa.deleted removed no longer applies.
      const refs = placedRefs(a)
      if (!dst || (refs.length > 0 && refs.every(isDeleted))) continue
      notes.push(`c2pa.placed as ${short(dst)}`)
      const source = sourceOf(dst)
      if (source === 'ai' || source === 'includes-ai') aiSignal = true
      else if (source === 'unclear') unclear = true
      else mixed = true
    } else if (dst) {
      notes.push(`${name} as ${short(dst)}`)
      aiUseDeclared ||= declaresAiUse(dst)
      const adds = ['adds', 'unknown'].includes(effectOf(name))
      const source = sourceOf(dst)
      if (source === 'ai') {
        // Generative augmentation of AI content keeps it AI...
        aiSignal = true
      } else if (source === 'includes-ai') {
        // ...but compositeSynthetic declares a mix with other elements.
        aiSignal = true
        if (dst !== `${IPTC}compositeWithTrainedAlgorithmicMedia`) mixed = true
      } else if (source === 'unclear') {
        unclear = true
      } else {
        mixed ||= adds
      }
    } else {
      const effect = effectOf(name)
      if (effect === 'processes') {
        notes.push(`${name} has no digitalSourceType`)
        undeclaredProcessing = true
      } else if (effect === 'adds') {
        // The spec doesn't require a generative edit to declare a source type, so an edit
        // that may add content and declares none could be either.
        notes.push(`${name} may add content and has no digitalSourceType`)
        unclear = true
        mixed = true
      } else if (effect === 'unknown') {
        notes.push(`${name} has unknown effect and no digitalSourceType`)
        unclear = true
      }
    }
  }

  if (!origin) {
    notes.push('no created or opened action')
    origin = 'unknown'
  }

  // Redacting an ingredient or actions assertion hides provenance, not content: whatever it
  // recorded can no longer be seen, so it can't count as absent.
  const redactions = Array.isArray(entry.redactions) ? (entry.redactions as unknown[]) : []
  for (const r of redactions.filter((r): r is string => typeof r === 'string')) {
    const i = r.lastIndexOf('c2pa.assertions/')
    const assertion = i < 0 ? '' : r.slice(i + 'c2pa.assertions/'.length)
    if (assertion.startsWith('c2pa.ingredient') || assertion.startsWith('c2pa.actions')) {
      notes.push(`redacts ${r}`)
      unclear = true
    }
  }

  // The disclosure names AI/ML models but not that they generated content. With a source
  // type that already declares AI use it adds nothing; without one, a model was used in an
  // undeclared way.
  for (const a of actions) {
    if (a.digitalSourceType) aiUseDeclared ||= declaresAiUse(a.digitalSourceType)
  }
  if (hasDisclosure(entry)) {
    if (aiUseDeclared || origin === 'ai' || origin === 'includes-ai' || aiSignal) {
      notes.push('c2pa.ai-disclosure present')
    } else {
      notes.push('c2pa.ai-disclosure present but no source type declares AI use')
      unclear = true
    }
  }

  for (const { verdict, reason } of components) {
    notes.push(`component: ${reason}`)
    if (verdict === 'ai' || verdict === 'includes-ai') aiSignal = true
    else if (verdict === 'unknown') unclear = true
  }
  if (!complete) {
    notes.push('history may be incomplete (allActionsIncluded not true)')
  }

  const allAiInputs =
    components.every((c) => c.verdict === 'ai') &&
    (origin === 'ai' || (emptyOrigin && components.length > 0))
  if (mixed && allAiInputs) {
    notes.push('a later action may have added non-AI content')
  }

  // "Entirely AI" needs the whole history: an unrecorded, unclear or content-adding later
  // change could have added content that isn't AI. Without it, AI is still known to be in
  // the provenance, and nothing shows it was removed.
  const verdict: AiVerdict =
    allAiInputs && complete && !unclear && !mixed ? 'ai'
    : allAiInputs || origin === 'ai' || origin === 'includes-ai' || aiSignal ? 'includes-ai'
    : origin === 'unknown' || unclear || undeclaredProcessing || !complete ? 'unknown'
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
