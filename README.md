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

This is a port of the reference classifier in [c2pa-ai-examples](../c2pa-ai-examples) (`src/classify.rs`). The four categories are an application policy, not something the C2PA specification prescribes. It walks the ingredient history:

1. No readable manifest, or a validation failure in the active manifest → **unknown**.
2. Action templates are merged into each action first: the `*` template, then same-named templates, then the action's own fields.
3. The origin comes from the `digitalSourceType` on `c2pa.created`, or from the parent ingredient on `c2pa.opened`, classified recursively. An update manifest with no actions inherits its parent. An ingredient without a manifest can still declare its own source type.
4. An AI origin whose current components are all AI, or an `empty` origin built only from AI components → **ai**.
5. Otherwise, an AI origin, an AI action, an AI component, or a `c2pa.ai-disclosure` assertion → **includes-ai**. Components removed by `c2pa.deleted` don't count.
6. Otherwise, an unknown origin, an unclear source type (`compositeSynthetic`, `algorithmicallyEnhanced`, `screenCapture`, `virtualRecording`, …), an unknown component, or a history that may be incomplete (no `c2pa.actions.v2` with `allActionsIncluded: true`) → **unknown**.
7. Anything else → **no-ai**.

Source types must be full IPTC or C2PA URIs. The classifier ignores `signingCredential.untrusted`. Trust comes from the reader's trust list and says nothing about whether AI was used.

## Test Fixtures

`examples/` holds the 36 test files from `c2pa-ai-examples`, converted to `VerificationOutcome` JSON. `examples/labels.json` gives each one's expected verdict. The tests check both the verdict and the reason against the reference classifier, word for word.

Where `labels.json` records a `knownSdkIssue` (a validation code c2pa-rs reports in error, such as `assertion.action.malformed` on a07), the tests check that the file gets the SDK's verdict as-is, and the expected verdict once that code is set aside.

To regenerate them, run this with `c2patool` on your PATH and the examples repo checked out next to this one:

```bash
npm run fixtures
```

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
