# Simulation context — payment-test

Generated 2026-10-30 from local contract mocks. No real payments or messages.

## Purpose

Runs the actual payment demo HTTP service against Toss (`api.tosspayments.com`)
and Mattermost incoming-webhook stand-ins. Contract fields and modeled failure
triggers are in `postman/mocks/`; the local API contract is in
`backend/payment-test/CONTRACT.md`.

## Execution

From the repository root, start in one terminal:

```sh
postman simulation run postman/simulations/payment-test/payment-test.sim.yaml --port 4598 --output ndjson --no-history
```

In another terminal:

```sh
node postman/simulations/payment-test/verify.mjs
```

The verifier starts a real temporary HTTP service, sends fixture creation,
notification, approval and result-inquiry requests, and cleans up its own data.
Expected output: three verified flows (`ok`, `uncertain`, `reject`). Inspect
simulation `request` events for both route keys, then stop that simulation with
Ctrl+C. Do not use process-wide kill commands. Optional Chrome verification:
`node backend/payment-test/test/browser.mjs` (module/executable configuration in
the deployment README).

## Assumptions

- 2026-10-30: path routing uses only loopback upstream URLs. Unmodeled routes in
  each mock return 501; the verifier does not call the real providers. Native
  HTTP tests separately exercise timeouts, malformed responses and restart.
- 2026-10-30: mock state is process-local and resets on restart. Restart after
  handler edits. It models only consumed Payment fields, not full card/PG rules.
- 2026-10-30: ports 4598 (simulation) and 4599 (optional browser) must be free.
  No application database is required; all names, keys and payment IDs are fake.
- 2026-10-30: official Toss/Mattermost documentation supplied the contract.
  Postman catalog search returned no applicable provider contract; the CLI was
  signed out, so a workspace-owned published mock could not be checked.
- 2026-10-30: the browser verifier replaces the Toss SDK. A separate manual check
  loaded the real SDK with a public documentation client key and corrected a
  style-attribute CSP violation. This does not establish real authentication or
  approval, which still needs the deployed HTTPS flow.

## Observations

<!-- begin:observations -->
2026-10-30: both members served actual application HTTP traffic. Toss served
normal approval, an uncertain 500 followed by a successful GET inquiry, and a
card rejection. Mattermost served one formatted message; the duplicate attempt
was blocked before the provider. Browser callback reload did not repeat approval.
<!-- end:observations -->

## What didn't work

- 2026-10-30: initial `pm.state` startup failed with local dataset permissions.
  The local mocks now use process-local state and the simulation runs normally.
- 2026-10-30: Windows restricted-shell loopback requests failed before reaching
  the server. Running the local network tests with the authorized environment
  succeeded; isolated Linux Docker checks also passed.
