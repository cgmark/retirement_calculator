# Retirement Calculator

This project currently runs as a single HTML file: `retirement.html`.

## Quick Start

- `make run` - start local dev server at `http://127.0.0.1:8080/retirement.html`
- `make test` - run unit tests
- `make build` - build `dist/retirement.single.html`
- `make licenses` - regenerate `THIRD_PARTY_LICENSES.txt`

## Local Tooling

- `npm test` - run unit tests for extracted core logic helpers
- `npm run build:single` - produce `dist/retirement.single.html`
- `npm run licenses` - generate `THIRD_PARTY_LICENSES.txt` for production deps

## Why this setup exists

The repo is being migrated toward a modular/testable structure while preserving single-file deployment.

Current extracted modules:

- `src/core/tax.js`
- `src/core/rrif.js`
- `src/core/random.js`

These mirror logic used in `retirement.html` and are covered by tests. The runtime HTML is intentionally unchanged during this first step to reduce risk.

## Third-party licensing

The built single-file app bundles third-party code (for example, Chart.js under MIT).
Run `npm run licenses` to regenerate `THIRD_PARTY_LICENSES.txt` with current production dependency license metadata.
