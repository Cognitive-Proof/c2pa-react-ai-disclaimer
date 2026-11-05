import type { PluginC2PA } from 'c2pa-react-component-types'
import { classifyAi, classifyAiEntries, type AiVerdict } from './classifyAi'
import { AI_VERDICT_COPY } from './verdictCopy'
import './aiDisclaimer.css'

function VerdictIcon({ verdict }: { verdict: AiVerdict }) {
  const common = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true }
  switch (verdict) {
    case 'ai':
    case 'includes-ai':
      // Sparkle
      return (
        <svg {...common}>
          <path d="M8 1.5l1.6 4.9 4.9 1.6-4.9 1.6L8 14.5l-1.6-4.9L1.5 8l4.9-1.6z" fill="currentColor" />
        </svg>
      )
    case 'no-ai':
      return (
        <svg {...common}>
          <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    default:
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6.3 6.2a1.8 1.8 0 113 1.4c-.6.4-1.3.8-1.3 1.6M8 11.3v.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )
  }
}

/**
 * Shows whether AI was used to make the content. Inside C2paManifest it is rendered
 * once per manifest row (with `entry`); on its own it classifies the active manifest.
 * Level 1 is a badge; level 2 and up add a sentence and the provenance reasoning.
 */
export const AiDisclaimer: PluginC2PA = ({ manifest, entry, level = 1, className }) => {
  const { verdict, reason } = classifyAi(manifest, entry?.label ?? entry?.id)
  const copy = AI_VERDICT_COPY[verdict]
  const classes = ['c2pa-ai-disclaimer', `c2pa-ai-disclaimer--${verdict}`, className].filter(Boolean).join(' ')

  if (level <= 1) {
    return (
      <span className={classes} data-verdict={verdict} title={copy.description}>
        <span className="c2pa-ai-disclaimer-badge">
          <VerdictIcon verdict={verdict} />
          {copy.label}
        </span>
      </span>
    )
  }

  return (
    <div className={classes} data-verdict={verdict}>
      <span className="c2pa-ai-disclaimer-badge">
        <VerdictIcon verdict={verdict} />
        {copy.label}
      </span>
      <p className="c2pa-ai-disclaimer-description">{copy.description}</p>
      <details className="c2pa-ai-disclaimer-details">
        <summary>How we know</summary>
        <ul>
          {reason.split('; ').map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
      </details>
    </div>
  )
}

AiDisclaimer.knownAssertions = []
AiDisclaimer.describe = (entries) => {
  if (entries.length === 0) return undefined
  return AI_VERDICT_COPY[classifyAiEntries(entries).verdict].description
}

export default AiDisclaimer
