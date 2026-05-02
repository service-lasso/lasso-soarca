# SOARCA Service

`lasso-soarca` provides SOARCA 1.1.0 as a release-backed Service Lasso service.

## Defaults

- `soarca` is disabled by default.
- The service listens on `PORT`, mapped from Service Lasso's negotiated `${SERVICE_PORT}`.
- Readiness uses `GET /status/ping`.
- Swagger is exposed at `/swagger/index.html`.
- Database, FIN/MQTT, TLS, and auth integrations are disabled by default for local development.

## Pairing

Use CACAO Roaster for authoring and SOARCA for execution. CACAO Roaster should consume `SOARCA_URL` from this service's `globalenv`.

## Release Assets

Each GitHub release publishes platform archives, `service.json`, and `SHA256SUMS.txt`.
