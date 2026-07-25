import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageSoarca } from "./package.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.env.TARGET_PLATFORM ?? process.platform;
const soarcaVersion = process.env.SOARCA_VERSION ?? "1.1.0";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

async function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve loopback port.")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function extractArchive(artifact, destination) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });

  if (artifact.endsWith(".zip")) {
    run("powershell", [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `Expand-Archive -Path ${JSON.stringify(artifact)} -DestinationPath ${JSON.stringify(destination)} -Force`,
    ]);
    return;
  }

  run("tar", ["-xzf", artifact, "-C", destination]);
}

async function waitForText(url, expected, timeoutMs = 30_000) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      const body = await response.text();
      if (response.status === 200 && body.includes(expected)) {
        return body;
      }
      lastError = new Error(`Unexpected response from ${url}: ${response.status} ${body.slice(0, 200)}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }

  throw lastError ?? new Error(`Timed out waiting for ${url}.`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("close", resolve)),
    sleep(10_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }),
  ]);
}

const serviceManifest = JSON.parse(await readFile(path.join(repoRoot, "service.json"), "utf8"));

async function readManifest(relativePath) {
  return JSON.parse(await readFile(path.join(repoRoot, relativePath), "utf8"));
}

function assertCanonicalHealthchecks(manifest, relativePath) {
  if (manifest.healthcheck !== undefined) {
    throw new Error(`${relativePath} still contains singular healthcheck.`);
  }

  if (manifest.healthchecks === undefined) {
    return;
  }

  if (!Array.isArray(manifest.healthchecks) || manifest.healthchecks.length === 0) {
    throw new Error(`${relativePath} healthchecks must be a non-empty array when declared.`);
  }

  const ids = new Set();
  for (const check of manifest.healthchecks) {
    if (!check?.id || ids.has(check.id)) {
      throw new Error(`${relativePath} healthchecks must have stable unique ids: ${JSON.stringify(manifest.healthchecks)}`);
    }
    ids.add(check.id);
  }
}

const checkedManifestPaths = [
  "service.json",
  "services/@localcert/service.json",
  "services/@nginx/service.json",
  "services/@node/service.json",
  "services/@serviceadmin/service.json",
  "services/@traefik/service.json",
  "services/echo-service/service.json",
];

for (const manifestPath of checkedManifestPaths) {
  assertCanonicalHealthchecks(await readManifest(manifestPath), manifestPath);
}

if (serviceManifest.id !== "soarca" || serviceManifest.version !== soarcaVersion) {
  throw new Error(`Unexpected service manifest identity: ${JSON.stringify({ id: serviceManifest.id, version: serviceManifest.version })}`);
}

if (
  !Array.isArray(serviceManifest.healthchecks) ||
  serviceManifest.healthchecks.length !== 1 ||
  serviceManifest.healthchecks[0]?.id !== "http-health" ||
  serviceManifest.healthchecks[0]?.type !== "http" ||
  serviceManifest.healthchecks[0]?.url !== "${endpoint.health.url}"
) {
  throw new Error(`SOARCA service.json healthchecks drifted: ${JSON.stringify(serviceManifest.healthchecks)}`);
}

if (serviceManifest.ports !== undefined || serviceManifest.portmapping !== undefined || serviceManifest.urls !== undefined) {
  throw new Error("SOARCA service.json still contains legacy ports, portmapping, or urls fields.");
}

const endpointsById = new Map((serviceManifest.endpoints ?? []).map((endpoint) => [endpoint.id, endpoint]));
if (
  endpointsById.get("api")?.kind !== "network" ||
  endpointsById.get("api")?.port?.default !== 8080 ||
  endpointsById.get("api")?.port?.strategy !== "preferred" ||
  endpointsById.get("api_url")?.url !== "http://127.0.0.1:${endpoint.api.port}" ||
  endpointsById.get("swagger")?.url !== "http://127.0.0.1:${endpoint.api.port}/swagger/index.html" ||
  endpointsById.get("health")?.url !== "http://127.0.0.1:${endpoint.api.port}/status/ping"
) {
  throw new Error(`SOARCA service.json endpoints drifted: ${JSON.stringify(serviceManifest.endpoints)}`);
}

for (const key of ["SOARCA_URL", "SOARCA_PORT", "SOARCA_SWAGGER_URL"]) {
  if (!serviceManifest.globalenv?.[key]) {
    throw new Error(`SOARCA service.json is missing globalenv ${key}.`);
  }
}

const artifact = await packageSoarca(platform, soarcaVersion);
const verifyRoot = path.join(repoRoot, "output", "verify", soarcaVersion, platform);
const serviceRoot = path.join(verifyRoot, "service");
const extractRoot = path.join(serviceRoot, ".state", "extracted", "current");
const port = await reserveLoopbackPort();

await rm(verifyRoot, { recursive: true, force: true });
await mkdir(extractRoot, { recursive: true });
await extractArchive(artifact, extractRoot);

const metadata = JSON.parse(await readFile(path.join(extractRoot, "SERVICE-LASSO-PACKAGE.json"), "utf8"));
if (
  metadata.serviceId !== "soarca" ||
  metadata.upstream?.version !== soarcaVersion ||
  metadata.packagedBy !== "service-lasso/lasso-soarca" ||
  metadata.platform !== platform
) {
  throw new Error(`Unexpected package metadata: ${JSON.stringify(metadata)}`);
}

const binary = path.join(extractRoot, platform === "win32" ? "SOARCA.exe" : "SOARCA");
const child = spawn(binary, [], {
  cwd: extractRoot,
  env: {
    ...process.env,
    PORT: String(port),
    GIN_MODE: "release",
    SOARCA_ALLOWED_ORIGINS: "*",
    DATABASE: "false",
    ENABLE_TLS: "false",
    ENABLE_FINS: "false",
    AUTH_ENABLED: "false",
    LOG_GLOBAL_LEVEL: "info",
    LOG_MODE: "production",
    LOG_FORMAT: "json",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let stdout = "";
let stderr = "";
child.stdout?.on("data", (chunk) => {
  stdout += chunk.toString();
});
child.stderr?.on("data", (chunk) => {
  stderr += chunk.toString();
});

try {
  await waitForText(`http://127.0.0.1:${port}/status/ping`, "pong");
  await waitForText(`http://127.0.0.1:${port}/swagger/doc.json`, "SOARCA API");
  console.log("[lasso-soarca] verification passed");
} catch (error) {
  console.error("[lasso-soarca] stdout:");
  console.error(stdout);
  console.error("[lasso-soarca] stderr:");
  console.error(stderr);
  throw error;
} finally {
  await stopChild(child);
}
