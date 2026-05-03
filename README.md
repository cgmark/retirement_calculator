# Retirement Calculator

This project currently runs as a single HTML file: `retirement.html`.

## Local Tooling

- `npm test` - run unit tests for extracted core logic helpers
- `npm run build:single` - produce `dist/retirement.single.html`

## Why this setup exists

The repo is being migrated toward a modular/testable structure while preserving single-file deployment.

Current extracted modules:

- `src/core/tax.js`
- `src/core/rrif.js`
- `src/core/random.js`

These mirror logic used in `retirement.html` and are covered by tests. The runtime HTML is intentionally unchanged during this first step to reduce risk.
