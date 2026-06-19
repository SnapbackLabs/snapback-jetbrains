# JetBrains IDEs

A Snapback integration (`com.focus.jetbrains`). Reopens your IntelliJ/WebStorm/PyCharm projects on restore.

## Build

```bash
npm install
npm run build   # bundles src/ into dist/integration.mjs
```

## Publish

Snapback's registry ingests the bundle from a GitHub Release. Tag a version and CI builds `integration.mjs` and attaches it to the release:

```bash
git tag v1.0.0 && git push origin v1.0.0
```

Built on the [Snapback Integration SDK](https://www.npmjs.com/package/@lockethq/snapback-sdk).
