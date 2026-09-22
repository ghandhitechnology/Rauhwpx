# Application E2E tests

Run `npm run e2e:list` to discover regression scripts. Use the relevant
`npm run e2e:<name>` command in `package.json`, or run a listed file with Node.
Read its header for browser, server, fixture, and provider requirements. These
scripts are selected explicitly; the default Node tests do not run them.

`npm run e2e:check` checks that package commands and GitHub workflow references
point to existing scripts. The filesystem and executable commands are the
inventory; adding a test does not require editing a second table.

Name regression scripts `*.test.mjs` and make assertion failures exit nonzero.
Helpers, render reports, and benchmark runners are not regression coverage
merely because they execute.

For fixture setup and development prerequisites, see [CONTRIBUTING](../../../CONTRIBUTING.md).
