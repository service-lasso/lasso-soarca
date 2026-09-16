# lasso-soarca

`lasso-soarca` packages SOARCA as a Service Lasso managed service.

SOARCA is an app-owned CACAO orchestration service. It is disabled by default because playbooks, credentials, integrations, database choices, and execution policy belong to the consuming app.

For the canonical app-owned integration workflow, see [Add OpenObserve or
SOARCA to an app](https://service-lasso.github.io/service-lasso/components/app-owned-service-workflows).
This repository retains the
release package, manifest, endpoint, and verification contract below.

## Service Contract

- Service ID: `soarca`
- Upstream version: `1.1.0`
- Canonical network endpoint: `api` on default HTTP port `8080`
- Health endpoint: `health` -> `GET http://127.0.0.1:${endpoint.api.port}/status/ping`
- Swagger endpoint: `swagger` -> `http://127.0.0.1:${endpoint.api.port}/swagger/index.html`
- First package platforms: Windows x64, Linux x64, macOS arm64

## Release Artifacts

Pushes to `main` create a GitHub release named with the Service Lasso version pattern:

```text
yyyy.m.d-<shortsha>
```

The release contains:

- `lasso-soarca-1.1.0-win32.zip`
- `lasso-soarca-1.1.0-linux.tar.gz`
- `lasso-soarca-1.1.0-darwin.tar.gz`
- `service.json`
- `SHA256SUMS.txt`

## Local Validation

```powershell
npm test
```

The verifier downloads the upstream SOARCA release asset for the current platform, repackages it, starts SOARCA on a temporary port, checks `/status/ping`, checks Swagger JSON, and stops the process.

## CACAO Roaster Pairing

CACAO Roaster is the app-owned web authoring surface. SOARCA is the execution
API. Follow the canonical Core guide above for the consuming-app inventory and
`SOARCA_URL` pairing flow.

## Sources

- Upstream release: https://github.com/COSSAS/SOARCA/releases/tag/1.1.0
- Upstream docs: https://cossas.github.io/SOARCA/
