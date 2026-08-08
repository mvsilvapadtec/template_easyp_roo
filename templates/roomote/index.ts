// Roomote (https://github.com/RooCodeInc/Roomote) Easypanel template.
//
// Mirrors the topology maintained by the Roomote team for Coolify
// (deploy/coolify/docker-compose.yaml in the Roomote repo), adapted to
// Easypanel's per-service schema:
// - web/api/controller/bullmq/db-migrate all run the same `roomote-app`
//   image; the image's fixed ENTRYPOINT dispatches on a single CLI word
//   ("web", "api", "controller", "bullmq", "db-migrate"), so `deploy.command`
//   must stay exactly one of those words -- it cannot shell-chain migrations
//   in front of the main process.
// - Because Easypanel's app schema has no `depends_on`/one-shot-job concept,
//   database migrations run as their own persistent service
//   (`<name>-migrate`). Drizzle's migrator takes a Postgres advisory lock,
//   so it is safe for that service to restart and re-run alongside the
//   other services booting concurrently on first deploy.
// - Only the `<name>-docker-proxy` service (tecnativa/docker-socket-proxy)
//   mounts the real host socket; controller/bullmq reach it over the
//   project network via DOCKER_HOST, never mounting the socket themselves.
// - MinIO gets its own public domain: Docker sandbox workers only join the
//   API's (and optional preview-proxy's) per-task network, not the
//   datastore network, so presigned artifact URLs must be publicly
//   reachable (see S3_PRESIGN_ENDPOINT below).
import { Output, randomPassword, randomString, Services } from "~templates-utils";
import { Input } from "./meta";

export function generate(input: Input): Output {
  const services: Services = [];

  const appName = input.appServiceName;
  const image = input.appServiceImage;

  const webName = `${appName}-web`;
  const apiName = `${appName}-api`;
  const controllerName = `${appName}-controller`;
  const bullmqName = `${appName}-bullmq`;
  const migrateName = `${appName}-migrate`;
  const minioName = `${appName}-minio`;
  const dockerProxyName = `${appName}-docker-proxy`;
  const dbName = `${appName}-db`;
  const redisName = `${appName}-redis`;

  // Internal (project-network) hostname for another service in this project.
  const priv = (svc: string) => `$(PROJECT_NAME)_${svc}`;
  // Public hostname Easypanel assigns when a service declares
  // `domains: [{ host: "$(EASYPANEL_DOMAIN)" }]` -- reconstructed here so
  // sibling services can reference each other's public origin.
  const pub = (svc: string) => `$(PROJECT_NAME)-${svc}.$(EASYPANEL_HOST)`;

  const databasePassword = randomPassword();
  const redisPassword = randomPassword();
  const minioPassword = randomPassword();
  const encryptionKey = randomString(64);
  const artifactSigningKey = randomString(64);
  const dashboardPassword = randomPassword();
  const setupToken = randomString(32);
  const discordGatewaySecret = randomPassword();

  // Shared by web, api, controller, bullmq, and the migrate service.
  const sharedEnv = [
    `R_APP_ENV=production`,
    `ROOMOTE_DOCKER_LOAD_ENV_FILE=false`,
    // Generates and persists the JOB_AUTH_*/PREVIEW_AUTH_* P-256 keypairs at
    // first boot instead of requiring an openssl provisioning step.
    `R_AUTO_GENERATE_KEYS=true`,
    `ENCRYPTION_KEY=${encryptionKey}`,
    // Must be identical on api and bullmq for Discord forwarding to work.
    `R_DISCORD_GATEWAY_SECRET=${discordGatewaySecret}`,
    `ARTIFACT_SIGNING_KEY=${artifactSigningKey}`,
    `DASHBOARD_PASSWORD=${dashboardPassword}`,
    `SETUP_TOKEN=${setupToken}`,
    `R_LICENSE_KEY=${input.licenseKey ?? ""}`,
    `S3_ACCESS_KEY_ID=roomote`,
    `S3_SECRET_ACCESS_KEY=${minioPassword}`,
    `S3_REGION=us-east-1`,
    `S3_BUCKET_ARTIFACTS=roomote-artifacts`,
    // MinIO does not auto-create buckets; the api service creates it at boot.
    `S3_AUTO_CREATE_BUCKET=true`,
    `S3_ENDPOINT=http://${priv(minioName)}:9000`,
    `S3_PRESIGN_ENDPOINT=https://${pub(minioName)}`,
    `DEFAULT_COMPUTE_PROVIDER=docker`,
    `DATABASE_URL=postgres://postgres:${databasePassword}@${priv(dbName)}:5432/$(PROJECT_NAME)`,
    `REDIS_URL=redis://default:${redisPassword}@${priv(redisName)}:6379`,
    `R_APP_URL=https://${pub(webName)}`,
    `R_PUBLIC_URL=https://${pub(webName)}`,
    `TRPC_URL=https://${pub(apiName)}`,
  ];

  services.push({
    type: "app",
    data: {
      serviceName: webName,
      source: { type: "image", image },
      deploy: { command: "web" },
      env: [...sharedEnv, `PORT=3000`].join("\n"),
      domains: [{ host: "$(EASYPANEL_DOMAIN)", port: 3000 }],
    },
  });

  services.push({
    type: "app",
    data: {
      serviceName: apiName,
      source: { type: "image", image },
      deploy: { command: "api" },
      env: [...sharedEnv, `PORT=3001`].join("\n"),
      // Public: GitHub webhooks and task workers call this origin directly.
      domains: [{ host: "$(EASYPANEL_DOMAIN)", port: 3001 }],
    },
  });

  services.push({
    type: "app",
    data: {
      serviceName: controllerName,
      source: { type: "image", image },
      deploy: { command: "controller" },
      env: [
        ...sharedEnv,
        `DOCKER_HOST=tcp://${priv(dockerProxyName)}:2375`,
        `DOCKER_WORKER_RELEASE_PATH=/roomote/releases/worker-current.tar.gz`,
        // Verify this matches the project's actual Docker network name
        // (`docker network ls` on the server) -- see the README.
        `DOCKER_WORKER_NETWORK=$(PROJECT_NAME)`,
        `DOCKER_WORKER_ALLOW_UNBOUNDED_DISK=false`,
      ].join("\n"),
    },
  });

  services.push({
    type: "app",
    data: {
      serviceName: bullmqName,
      source: { type: "image", image },
      deploy: { command: "bullmq" },
      env: [
        ...sharedEnv,
        `PORT=3002`,
        `DOCKER_HOST=tcp://${priv(dockerProxyName)}:2375`,
        `DOCKER_WORKER_RELEASE_PATH=/roomote/releases/worker-current.tar.gz`,
      ].join("\n"),
    },
  });

  services.push({
    type: "app",
    data: {
      serviceName: migrateName,
      source: { type: "image", image },
      deploy: { command: "db-migrate" },
      env: sharedEnv.join("\n"),
    },
  });

  services.push({
    type: "app",
    data: {
      serviceName: minioName,
      source: {
        type: "image",
        image: "minio/minio:RELEASE.2025-09-07T16-13-09Z",
      },
      deploy: { command: "server /data --console-address :9001" },
      env: [`MINIO_ROOT_USER=roomote`, `MINIO_ROOT_PASSWORD=${minioPassword}`].join(
        "\n"
      ),
      // Public: presigned artifact URLs must be reachable by task workers
      // and browsers without joining the datastore network.
      domains: [{ host: "$(EASYPANEL_DOMAIN)", port: 9000 }],
      mounts: [{ type: "volume", name: "data", mountPath: "/data" }],
    },
  });

  services.push({
    type: "app",
    data: {
      serviceName: dockerProxyName,
      source: {
        type: "image",
        image: "ghcr.io/tecnativa/docker-socket-proxy:v0.4.2",
      },
      env: [
        `CONTAINERS=1`,
        `ALLOW_START=1`,
        `EXEC=1`,
        `IMAGES=1`,
        `NETWORKS=1`,
        `VOLUMES=1`,
        `POST=1`,
        `EVENTS=0`,
      ].join("\n"),
      mounts: [
        {
          type: "bind",
          hostPath: "/var/run/docker.sock",
          mountPath: "/var/run/docker.sock",
        },
      ],
    },
  });

  services.push({
    type: "postgres",
    data: { serviceName: dbName, password: databasePassword },
  });

  services.push({
    type: "redis",
    data: { serviceName: redisName, password: redisPassword },
  });

  return { services };
}
