# c2pa-react-ai-disclaimer

React plugin for [`c2pa-react-component`](https://github.com/matthewrappard/c2pa-react-component) that shows whether AI was used to make a piece of content, based on its C2PA provenance.

It gives one of four answers:

| Verdict | Badge | Meaning |
|---|---|---|
| `ai` | AI-generated | The content as a whole came from a trained model. |
| `includes-ai` | Includes AI | Part of the content came from a trained model. |
| `no-ai` | No AI | Captured or made by people, with only non-generative edits. |
| `unknown` | AI use unknown | The provenance can't settle it either way. |

## Installation

```bash
npm install c2pa-react-ai-disclaimer c2pa-react-component
```

Import the stylesheet once:

```ts
import "c2pa-react-ai-disclaimer/style.css";
```

## Usage With c2pa-react-component

```tsx
import { C2paManifest } from "c2pa-react-component";
import { AiDisclaimer } from "c2pa-react-ai-disclaimer";
import "c2pa-react-ai-disclaimer/style.css";

<C2paManifest manifest={outcome} plugin={[AiDisclaimer]} />
```

At level 2, `C2paManifest` renders the plugin in every manifest row, so each step in the history gets its own badge.

## Direct Usage

```tsx
<AiDisclaimer manifest={outcome} level={1} /> // badge
<AiDisclaimer manifest={outcome} level={2} /> // badge, sentence, and "How we know"
```

The classifier is also exported if you need the verdict without the UI:

```ts
import { classifyAi } from "c2pa-react-ai-disclaimer";

classifyAi(outcome);
// { verdict: "ai", reason: "opened parent: ingredient 'a01_text_to_image.jpg' -> created as trainedAlgorithmicMedia" }
```

`classifyAi` accepts a `VerificationOutcome`, this library's `ManifestStore`, or raw c2pa-rs `Reader` JSON (snake_case, assertions as an array). It also handles `Map`s for manifests and assertions. Pass a manifest label as the second argument to classify that manifest instead of the active one.

`AI_VERDICT_COPY` holds the badge labels and sentences.

## How It Decides

This is a port of the reference classifier in [c2pa-ai-examples](../c2pa-ai-examples) (`src/classify.rs`). The four categories are an application policy, not something the C2PA specification prescribes. It's about *generative* AI, following the IPTC split: `computationalCapture` and `digitalCreation` count as no AI.

1. No readable manifest, or a validation failure in the active manifest → **unknown**.
2. Actions are read as a consumer must see them: the `*` template, then same-named templates, then the action's own fields, then each `related` action merged onto its primary.
3. The origin comes from the `digitalSourceType` on `c2pa.created`, or from the parent ingredient on `c2pa.opened`, classified recursively. An update manifest can't change the content, so it takes its parent's verdict. An ingredient without a manifest can still declare a source type, or the `c2pa.placed` action that placed it can.
4. **ai** needs an AI origin (or an `empty` origin built only from AI components), all current components AI, a complete history, and no later change that may have added other content. Cropping or a generative edit keeps it AI; a human drawing, `compositeSynthetic`, or an edit with no source type doesn't.
5. Otherwise, AI anywhere in the origin, the actions or the current components → **includes-ai**. Components removed by `c2pa.deleted` don't count.
6. Otherwise, anything uncertain → **unknown**:
   - an unknown origin or an unclear source type (`virtualRecording`, `screenCapture`, `algorithmicallyEnhanced`, `trainedAlgorithmicData`, …)
   - an edit, a processing step (resizing, enhancing) or an unrecognised action with no source type
   - a redacted ingredient or actions assertion
   - a `c2pa.ai-disclosure` with no source type that declares AI use
   - a history that may be incomplete (no `c2pa.actions.v2` with `allActionsIncluded: true`)
7. Anything else → **no-ai**.

Source types must be full IPTC or C2PA URIs. The classifier ignores `signingCredential.untrusted`. Trust comes from the reader's trust list and says nothing about whether AI was used.

An update manifest is one with no hard-binding (`c2pa.hash.*`) assertion. c2pa-rs `Reader::json()` leaves those assertions out, so the classifier only looks for them when some manifest in the store has one. Otherwise it reads an update manifest's `c2pa.opened` action like any other, which gives the same verdict for manifests the c2pa-rs `Builder` writes.

## Test Fixtures

`examples/` holds the 77 test files from `c2pa-ai-examples`, converted to `VerificationOutcome` JSON. `examples/labels.json` gives each one's expected verdict. The tests check both the verdict and the reason against the reference classifier, word for word.

Where `labels.json` records a `knownSdkIssue` (a validation code c2pa-rs reports in error, such as `assertion.action.malformed` on a07), the tests check that the file gets the expected verdict once that code is set aside everywhere in the store. When the fixture's reader reports the code, they also check that the file gets the SDK's verdict as-is.

The fixture script also keeps each manifest's `redactions` and its hard-binding assertion labels (from `c2patool --detailed`), and copies ingredients' own `digitalSourceType`, which `c2patool` 0.27 leaves out. To regenerate them, run this with `c2patool` on your PATH and the examples repo checked out next to this one:

```bash
npm run fixtures
```

To use a different reader, set `C2PATOOL` to any program that takes c2patool's `[--settings FILE] ASSET [--detailed]` arguments and prints c2pa-rs `Reader` JSON. That way you can check fixtures against an unreleased c2pa-rs fix.

The committed fixtures were read with c2pa-rs `fix/action-template-source-type` (`01825ede`), which fixes the a07 template bug. Fixtures regenerated with a released `c2patool` will show that bug again; the tests pass either way.

## Local Development

```bash
npm install
npm run dev    # playground showing every fixture
npm test
npm run lint
npm run build
```

Shared prop types come from [`c2pa-react-component-types`](https://www.npmjs.com/package/c2pa-react-component-types) on npm. To try unreleased type changes, link the sibling repo with `yalc add c2pa-react-component-types`, and switch back to the npm version before releasing.

## License

MIT
