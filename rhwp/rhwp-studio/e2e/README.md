# Application E2E tests

Run `npm run e2e:list` to discover regression scripts. Use the relevant
`npm run e2e:<name>` command in `package.json`, or run a listed file with Node.
Read its header for browser, server, fixture, and provider requirements. These
scripts are selected explicitly; the default Node tests do not run them.

`npm run e2e:check` checks that package commands and GitHub workflow references
point to existing scripts. The filesystem and executable commands are the
inventory; adding a test does not require editing a second table.

Name regression scripts `*.test.mjs` and make assertion failures exit nonzero.
Name manual investigations `probe-*.mjs` or `debug-*.mjs`. Helpers, render reports,
and benchmark runners are not regression coverage merely because they execute.

Retained investigations include `probe-body-outside-click-fallback.mjs` for body
hit testing, `probe-grid-mode-click-coord.mjs` for grid coordinates, and
`probe-issue-595.mjs` for screenshots and coordinate inspection. Their results
require human interpretation and they are not CI gates.

For fixture setup and development prerequisites, see [CONTRIBUTING](../../../CONTRIBUTING.md).
