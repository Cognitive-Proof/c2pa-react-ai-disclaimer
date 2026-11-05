import { useState } from 'react'
import type { DisclosureLevel, VerificationOutcome } from 'c2pa-react-component-types'
import { AiDisclaimer } from '../components/AiDisclaimer/AiDisclaimer'
import labels from '../../examples/labels.json'

const fixtures = import.meta.glob<VerificationOutcome>('../../examples/[a-z][0-9]*.json', { eager: true, import: 'default' })

const examples = labels.map((l) => ({
  ...l,
  data: fixtures[`../../examples/${l.fixture}`],
}))

const groups = ['ai', 'includes-ai', 'no-ai', 'unknown'] as const

export default function App() {
  const [level, setLevel] = useState<DisclosureLevel>(1)

  return (
    <div style={{ maxWidth: '960px', margin: '2rem auto', fontFamily: 'sans-serif', padding: '0 1rem' }}>
      <h1 style={{ marginBottom: '0.25rem' }}>AI Disclaimer - Dev Playground</h1>
      <p style={{ color: '#64748b', marginTop: 0, marginBottom: '2rem' }}>
        Every test file from c2pa-ai-examples, with its expected label and what the plugin shows.
      </p>

      <div style={{ marginBottom: '2rem', display: 'flex', alignItems: 'center', gap: '12px' }}>
        <label htmlFor="level-select" style={{ fontWeight: 600, fontSize: '14px', color: '#374151' }}>
          Level:
        </label>
        <select
          id="level-select"
          value={level}
          onChange={e => setLevel(Number(e.target.value) as DisclosureLevel)}
          style={{ padding: '6px 12px', fontSize: '14px', borderRadius: '6px', border: '1px solid #d1d5db', background: '#fff' }}
        >
          <option value={1}>1 - Badge</option>
          <option value={2}>2 - Details</option>
        </select>
      </div>

      {groups.map((group) => (
        <section key={group} style={{ marginBottom: '2rem' }}>
          <h2 style={{ fontSize: '13px', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Expected: {group}
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {examples.filter((ex) => ex.expected === group).map((ex) => (
              <div key={ex.fixture} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '16px', alignItems: 'start' }}>
                <div>
                  <div style={{ fontFamily: 'monospace', fontSize: '13px' }}>{ex.file.split('/').pop()}</div>
                  <div style={{ fontSize: '12px', color: '#6b7280' }}>{ex.description}</div>
                </div>
                <AiDisclaimer manifest={ex.data} level={level} />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
