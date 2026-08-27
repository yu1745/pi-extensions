# Shadowed extensions

Code here is **kept in the repo but NOT activated** — pi does not load it.

## Why shadowed?

- `web-reader-local/` — local (linkedom-based) HTML→Markdown reader. Feature-complete
  and passing its 25-URL benchmark (`bench-all.mjs`), but temporarily disabled while
  the built-in `web_reader` / `web_reader_spa` tools are evaluated side by side.
  Re-enable when ready by moving it back to `extensions/` and adding
  `"extensions/web-reader-local/index.ts"` to the `pi.extensions` array in `package.json`.

## How shadowing works

pi resolves a git package's extensions **only** through the `pi.extensions` array of its
root `package.json`. Files outside that list (and outside any package manifest) are never
imported. Keeping this folder at the repo top level — not under `extensions/` — plus the
missing manifest entry means there is no discovery path that can pick it up.

## Type checking

`tsconfig.json` includes this directory so `tsc --noEmit` still validates the code:

```sh
npm run typecheck   # or: ./node_modules/.bin/tsc --noEmit
```
