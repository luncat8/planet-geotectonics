# vendor/jpeg-js

`decoder.js` is the JPEG baseline decoder from **jpeg-js 0.4.4**
(`https://github.com/eugeneware/jpeg-js`, Apache-2.0, `LICENSE`), copied verbatim from the
npm package's `lib/decoder.js` — MD5 `03d367b0053de962384f06f9007e23b9`. Only the decoder is
kept; the encoder is unused.

It is vendored because `tools/earth/paleo_extract.js` decodes the PALEOMAP 1° textures and the
project has no build step and no internet links: the bake pipeline must run offline from a
clean checkout. Nothing in `js/` (the page) loads it — it is a build-time dependency of one
tool.