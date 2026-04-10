# Changelog

## 0.10.0

### Patch workflow validation

- Re-export now runs the same patch lint gate as export and export-all before writing patch files or manifest metadata.
- `re-export --skip-lint` now downgrades lint errors to warnings consistently, while default re-export blocks on lint errors and keeps artifacts unchanged.
- Raw CSS colors introduced by a patch are now patch lint errors, matching Furnace validation, without blocking on unrelated pre-existing upstream raw colors.
- Furnace accessibility validation now warns about missing ARIA roles only for generic interactive markup, so native semantic elements are not pushed toward redundant ARIA.

### General improvements

- getPackageRoot up to this point expected hardcoded `@hominis/fireforge`, was changed to just the package name for potential forks and more flexibility when changing project name.
- Some test generators were derived from early Hominis Browser fork additions, the references to Hominis have been replaced with generic naming.

### Build and Git reliability

- Build preflight now fails clearly when multiple build artifact directories make the target ambiguous.
- Git diff and status helpers now surface command failures instead of silently treating failed commands as empty output.
- Stale lock cleanup now distinguishes disappearance races from real cleanup failures.

### Packaging

- Package metadata and smoke tests now use version `0.10.0`.
- npm install instructions use the scoped `@hominis/fireforge` package name.
- Packaging and full Firefox integration helpers now handle platform-specific npm and mozconfig names more consistently.

## 0.9.0

### npm release

- Package is now installable via `npm install @hominis/fireforge` or `npm install -g @hominis/fireforge`.
