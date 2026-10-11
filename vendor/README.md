# vendor

Two libraries the page's chat needs, kept with the site so that a conversation does not
hang on another address. Both are the files their authors published on npm, byte for byte.

| File | From | Version | License | sha256 |
|---|---|---|---|---|
| `elevenlabs-client-1.27.0.js` | npm `@elevenlabs/client`, `dist/lib.iife.js` | 1.27.0 | MIT | `f69a845935c3788ea46a73b09ead74640dfba5be135f225eac719df3a320c9cd` |
| `libsamplerate-2.1.2.worklet.js` | npm `@alexanderolsen/libsamplerate-js`, `dist/libsamplerate.worklet.js` | 2.1.2 | MIT | `ca6e162f194d3ee5a2d2cd3c3b49641d31e56845aeae507feca1cdf8aa8116cb` |

The license texts are beside them: `elevenlabs-client-LICENSE.txt` and
`libsamplerate-js-LICENSE.md`.

- The first is ElevenLabs' client library. The page starts every conversation with it.
- The second changes the rate of sound. The first loads it on an iPhone, an iPad and in
  Safari on a Mac.

To move to a newer version: put the new file here under its own name, change the two names
in `index.html`, and run every check in `test/` to zero failures first.
