# Releasing

Maestro versions follow [Semantic Versioning](https://semver.org/) with the
**pre-1.0 (0.x) convention**. While the major version is `0`, the public surface
is still considered unstable, so the bump rules are shifted down one level from
the post-1.0 rules:

| Change | Bump | Example | Command |
|---|---|---|---|
| Breaking change (incompatible behavior/API change) | **minor** | `0.1.14 → 0.2.0` | `npm run release:minor` |
| New feature **or** bug fix (backwards-compatible) | **patch** | `0.1.14 → 0.1.15` | `npm run release:patch` |
| Declare the project stable (first 1.0) | **major** | `0.1.14 → 1.0.0` | `npm run release:major` |

While in `0.x`, features and fixes are both **patch** bumps and only a breaking
change earns a **minor** bump. A `major` bump is reserved for the deliberate
`1.0.0` declaration — don't use it for ordinary breaking changes before then.

> **After 1.0** the standard SemVer rules apply: bug fix → patch, new feature →
> minor, breaking change → major. Update this table when that day comes.

## Cutting a release

From a clean working tree on the branch you release from (usually `main`):

```bash
npm run release:patch   # or release:minor / release:major
```

Each script:

1. bumps the `version` in `package.json` **and** `package-lock.json`,
2. creates a `Release vX.Y.Z` commit,
3. creates a matching `vX.Y.Z` git tag,
4. pushes the commit and tag (`git push --follow-tags`).

`npm version` refuses to run if the working tree is dirty, so commit or stash
your changes first.

## What the tag triggers

Pushing a `v*` tag fires [`.github/workflows/release.yml`](.github/workflows/release.yml),
which builds the Windows and macOS packages and attaches them to a GitHub
Release for that tag. No manual upload step is needed.
