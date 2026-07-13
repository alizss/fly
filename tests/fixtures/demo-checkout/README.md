# Fixtures

Currently unused — `demo-checkout.spec.js` drives the live local demo checkout
served by `apps/web/server.js` (`/demo/checkout`) rather than a static fixture
page, since that page is already deterministic and version-controlled.

Add a fixture here if a future test needs a page shape the live demo doesn't
cover (e.g. a bundled multi-requirement section, to regression-test the
per-group baggage completeness fix without depending on a live third-party
site).
