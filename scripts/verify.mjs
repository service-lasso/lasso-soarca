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
if (serviceManifest.id !== "soarca" || serviceManifest.version !== soarcaVersion) {
  throw new Error(`Unexpected service manifest identity: ${JSON.stringify({ id: serviceManifest.id, version: serviceManifest.version })}`);
}

if (
  serviceManifest.healthcheck?.type !== "http" ||
  serviceManifest.healthcheck.url !== "${SOARCA_URL}/status/ping" ||
  serviceManifest.ports?.service !== 8080
) {
  throw new Error(`SOARCA service.json health/ports drifted: ${JSON.stringify(serviceManifest.healthcheck)}`);
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
