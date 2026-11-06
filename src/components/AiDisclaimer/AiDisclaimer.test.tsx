import { render, screen } from '@testing-library/react'
import type { ManifestEntry, VerificationOutcome } from 'c2pa-react-component-types'
import { AiDisclaimer } from './AiDisclaimer'
import { classifyAi, type AiVerdict } from './classifyAi'
import labels from '../../../examples/labels.json'

const fixtures = import.meta.glob<VerificationOutcome>('../../../examples/[a-z][0-9]*.json', { eager: true, import: 'default' })

function loadFixture(name: string): VerificationOutcome {
  const fixture = fixtures[`../../../examples/${name}`]
  if (!fixture) throw new Error(`missing fixture ${name}`)
  return structuredClone(fixture)
}

interface Label {
  fixture: string
  expected: string
  classifierReason: string
  knownSdkIssue?: { code: string; sdkVerdict: string }
}

/**
 * Drops a failure code that c2pa-rs reports in error, everywhere in the store (active
 * manifest and ingredients), as the reference check does. Returns whether it was there.
 */
function setAside(value: unknown, code: string): boolean {
  if (Array.isArray(value)) return value.map((v) => setAside(v, code)).some(Boolean)
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  let found = false
  for (const key of ['failure', 'validation_status']) {
    const list = obj[key]
    if (Array.isArray(list)) {
      const kept = list.filter((x) => x?.code !== code)
      found ||= kept.length !== list.length
      obj[key] = kept
    }
  }
  return Object.values(obj).map((v) => setAside(v, code)).some(Boolean) || found
}

describe('classifyAi against c2pa-ai-examples', () => {
  it.each((labels as Label[]).map((l) => [l.fixture, l.expected, l] as const))(
    '%s → %s',
    (fixture, expected, { classifierReason: reason, knownSdkIssue }) => {
      const outcome = loadFixture(fixture)
      if (knownSdkIssue) {
        const before = classifyAi(structuredClone(outcome)).verdict
        // Older readers don't all report the code; when this one does, it decides the verdict.
        if (setAside(outcome, knownSdkIssue.code)) expect(before).toBe(knownSdkIssue.sdkVerdict)
      }
      const result = classifyAi(outcome)
      expect(result.verdict).toBe(expected)
      // Fixtures without a manifest carry no reason we can match word for word.
      if (reason !== 'no readable C2PA manifest') expect(result.reason).toBe(reason)
    },
  )
})

// Ports of the reference classifier's unit tests: cases c2pa-rs can't build as files.
describe('classifyAi rules', () => {
  const AI = 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia'
  const CAPTURE = 'http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture'
  const FILL = 'http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia'
  const HUMAN_EDITS = 'http://cv.iptc.org/newscodes/digitalsourcetype/humanEdits'
  const SYNTHETIC = 'http://cv.iptc.org/newscodes/digitalsourcetype/compositeSynthetic'

  /** [label, actions data, ingredients, is an update manifest]; the first is active. */
  type Spec = [string, object, object[], boolean]

  function classifyStore(specs: Spec[]): AiVerdict {
    const manifests = Object.fromEntries(
      specs.map(([label, actions, ingredients, update]) => [
        label,
        {
          assertions: { 'c2pa.actions.v2': actions, ...(update ? {} : { 'c2pa.hash.data': {} }) },
          ingredients,
        },
      ]),
    )
    return classifyAi({ activeManifest: specs[0][0], manifests } as never).verdict
  }

  const single = (actions: object) => classifyStore([['m', actions, [], false]])
  const after = (origin: string, edit: object) =>
    single({ actions: [{ action: 'c2pa.created', digitalSourceType: origin }, edit], allActionsIncluded: true })

  const aiParent: Spec = ['parent', { actions: [{ action: 'c2pa.created', digitalSourceType: AI }], allActionsIncluded: true }, [], false]
  const updateOver = (action: string, update = true): Spec => [
    'update',
    { actions: [{ action }] },
    [{ relationship: 'parentOf', active_manifest: 'parent', title: 'parent' }],
    update,
  ]

  it('update manifests inherit their parent, whatever they record', () => {
    expect(classifyStore([updateOver('c2pa.published'), aiParent])).toBe('ai')
    expect(classifyStore([updateOver('c2pa.edited.metadata'), aiParent])).toBe('ai')
    expect(classifyStore([updateOver('c2pa.published', false), aiParent])).toBe('unknown')
  })

  it('finds a generative edit in nested related actions', () => {
    expect(single({
      actions: [
        { action: 'c2pa.created', digitalSourceType: CAPTURE },
        { action: 'c2pa.edited', related: [{ action: 'c2pa.color_adjustments', related: [{ action: 'c2pa.edited', digitalSourceType: FILL }] }] },
      ],
      allActionsIncluded: true,
    })).toBe('includes-ai')
  })

  it('lets later edits decide whether an AI origin stays entirely AI', () => {
    expect(after(AI, { action: 'c2pa.cropped' })).toBe('ai')
    expect(after(AI, { action: 'c2pa.edited', digitalSourceType: FILL })).toBe('ai')
    expect(after(AI, { action: 'c2pa.drawing', digitalSourceType: HUMAN_EDITS })).toBe('includes-ai')
    expect(after(AI, { action: 'c2pa.edited', digitalSourceType: SYNTHETIC })).toBe('includes-ai')
    expect(after(AI, { action: 'c2pa.edited' })).toBe('includes-ai')
  })

  it("doesn't assume an edit or processing step without a source type is non-generative", () => {
    expect(after(CAPTURE, { action: 'c2pa.edited' })).toBe('unknown')
    expect(after(CAPTURE, { action: 'com.fabrikam.stylize' })).toBe('unknown')
    expect(after(CAPTURE, { action: 'c2pa.enhanced' })).toBe('unknown')
    expect(after(CAPTURE, { action: 'c2pa.resized', digitalSourceType: HUMAN_EDITS })).toBe('no-ai')
    expect(after(CAPTURE, { action: 'c2pa.cropped' })).toBe('no-ai')
    expect(after(AI, { action: 'c2pa.resized' })).toBe('ai')
  })

  it('counts a source type declared on c2pa.placed', () => {
    const actions = {
      actions: [
        { action: 'c2pa.created', digitalSourceType: CAPTURE },
        { action: 'c2pa.placed', digitalSourceType: AI, parameters: { ingredients: [{ url: 'self#jumbf=c2pa.assertions/c2pa.ingredient.v3' }] } },
      ],
      allActionsIncluded: true,
    }
    const unsigned = [{ relationship: 'componentOf', label: 'c2pa.ingredient.v3', title: 'raw.jpg' }]
    expect(classifyStore([['m', actions, unsigned, false]])).toBe('includes-ai')
  })

  it("doesn't treat trainedAlgorithmicData as generative", () => {
    const data = 'http://c2pa.org/digitalsourcetype/trainedAlgorithmicData'
    expect(single({ actions: [{ action: 'c2pa.created', digitalSourceType: data }], allActionsIncluded: true })).toBe('unknown')
  })

  it('treats a missing allActionsIncluded as a possibly incomplete history', () => {
    expect(single({ actions: [{ action: 'c2pa.created', digitalSourceType: CAPTURE }] })).toBe('unknown')
  })
})

describe('classifyAi input shapes', () => {
  it("doesn't mistake every manifest for an update manifest when hard bindings are left out", () => {
    // c2pa-rs Reader::json() omits c2pa.hash.* assertions.
    const a03 = loadFixture('a03_ai_then_cropped.json')
    for (const entry of Object.values(a03.manifestStore!.manifests)) {
      entry.assertions = Object.fromEntries(Object.entries(entry.assertions!).filter(([k]) => !k.startsWith('c2pa.hash.')))
    }
    expect(classifyAi(a03).verdict).toBe('ai')
  })

  const a01 = loadFixture('a01_text_to_image.json')
  const store = a01.manifestStore!
  const entry = store.manifests[store.activeManifest]

  it('accepts c2pa-rs Reader JSON (snake_case, assertions array)', () => {
    const readerJson = {
      active_manifest: store.activeManifest,
      manifests: {
        [store.activeManifest]: {
          assertions: Object.entries(entry.assertions!).map(([label, data]) => ({ label, data })),
        },
      },
    }
    expect(classifyAi(readerJson as never).verdict).toBe('ai')
  })

  it('accepts Maps for manifests and assertions', () => {
    const outcome = {
      ...a01,
      manifestStore: {
        ...store,
        manifests: new Map([[store.activeManifest, { ...entry, assertions: new Map(Object.entries(entry.assertions!)) }]]),
      },
    }
    expect(classifyAi(outcome as never).verdict).toBe('ai')
  })

  it('returns unknown for an undefined outcome', () => {
    expect(classifyAi(undefined).verdict).toBe('unknown')
  })

  it('classifies a non-active manifest by label', () => {
    const a03 = loadFixture('a03_ai_then_cropped.json')
    const parent = a03.manifestStore!.manifests[a03.manifestStore!.activeManifest].ingredients![0].active_manifest!
    expect(classifyAi(a03, parent)).toEqual({ verdict: 'ai', reason: 'created as trainedAlgorithmicMedia' })
  })

  it("reports a failed ingredient's validation when classifying it by label", () => {
    const u09 = loadFixture('u09_edited_from_tampered_parent.json')
    const parent = u09.manifestStore!.manifests[u09.manifestStore!.activeManifest].ingredients![0].active_manifest!
    expect(classifyAi(u09, parent).verdict).toBe('unknown')
  })
})

describe('AiDisclaimer', () => {
  const cases: [string, AiVerdict, string][] = [
    ['a01_text_to_image.json', 'ai', 'AI-generated'],
    ['i01_generative_fill.json', 'includes-ai', 'Includes AI'],
    ['n01_camera_capture.json', 'no-ai', 'No AI'],
    ['u01_no_manifest.json', 'unknown', 'AI use unknown'],
  ]

  it.each(cases)('renders a badge for %s', (fixture, verdict, label) => {
    const { container } = render(<AiDisclaimer manifest={loadFixture(fixture)} />)
    expect(screen.getByText(label)).toBeInTheDocument()
    expect(container.querySelector(`[data-verdict="${verdict}"]`)).not.toBeNull()
  })

  it('shows the description and reasoning at level 2', () => {
    render(<AiDisclaimer manifest={loadFixture('a03_ai_then_cropped.json')} level={2} />)
    expect(screen.getByText('This content was generated by an AI model.')).toBeInTheDocument()
    expect(screen.getByText(/opened parent: ingredient 'a01_text_to_image.jpg'/)).toBeInTheDocument()
  })

  it('classifies the entry it is given rather than the active manifest', () => {
    const i02 = loadFixture('i02_ai_element_placed.json')
    const store = i02.manifestStore!
    const component = store.manifests[store.activeManifest].ingredients!.find((i) => i.relationship === 'componentOf')!
    const entry = store.manifests[component.active_manifest!]
    render(<AiDisclaimer manifest={i02} entry={entry} />)
    expect(screen.getByText('AI-generated')).toBeInTheDocument()
  })

  it('describes the manifest history, active manifest last', () => {
    const a03 = loadFixture('a03_ai_then_cropped.json')
    const store = a03.manifestStore!
    const entries: ManifestEntry[] = Object.values(store.manifests).sort((a) => (a.label === store.activeManifest ? 1 : -1))
    expect(AiDisclaimer.describe?.(entries)).toBe('This content was generated by an AI model.')
    expect(AiDisclaimer.describe?.([])).toBeUndefined()
  })
})
