#!/usr/bin/env node
// Standalone generator for the Roomote Easypanel template.
//
// This reimplements templates/roomote/index.ts with zero dependencies (no
// Node.js, zod, or the easypanel-io/templates monorepo needed beyond a
// plain `node` binary), so you can produce a ready-to-paste "Create from
// Schema" JSON payload without cloning Easypanel's template playground.
//
// IMPORTANT: run this yourself and keep the output private -- it contains
// freshly generated passwords and keys. Never commit its output to git.
// Every run produces different secrets, by design.
//
// Usage:
//   node scripts/generate-schema.mjs > roomote.easypanel.json
//   node scripts/generate-schema.mjs \
//     --name my-roomote \
//     --image ghcr.io/roocodeinc/roomote-app:main \
//     --license-key "" > roomote.easypanel.json
//
// Keep this file's generate() logic in sync with templates/roomote/index.ts.

import crypto from 'node:crypto';

function randomString(length = 10) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[crypto.randomInt(chars.length)];
  }
  return result;
}

const randomPassword = () => randomString(20);

function parseArgs(argv) {
  const input = {
    appServiceName: 'roomote',
    appServiceImage: 'ghcr.io/roocodeinc/roomote-app:main',
    licenseKey: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--name') input.appServiceName = argv[++i];
    else if (arg === '--image') input.appServiceImage = argv[++i];
    else if (arg === '--license-key') input.licenseKey = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      printHelp();
      process.exit(1);
    }
  }
  if (!/^[a-z0-9-_]+$/.test(input.appServiceName)) {
    console.error(
      'Invalid --name. Use lowercase letters (a-z), digits (0-9), dash (-), underscore (_).'
    );
    process.exit(1);
  }
  return input;
}

function printHelp() {
  console.error(
    [
      'Usage: node scripts/generate-schema.mjs [options] > roomote.easypanel.json',
      '',
      'Options:',
      '  --name <name>          App service name prefix (default: roomote)',
      '  --image <image>        roomote-app image (default: ghcr.io/roocodeinc/roomote-app:main)',
      '  --license-key <key>    Roomote license key, only needed past 10 users',
      '  -h, --help              Show this help',
    ].join('\n')
  );
}

function generate(input) {
  const services = [];

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

  const priv = (svc) => `$(PROJECT_NAME)_${svc}`;
  const pub = (svc) => `$(PROJECT_NAME)-${svc}.$(EASYPANEL_HOST)`;

  const databasePassword = randomPassword();
  const redisPassword = randomPassword();
  const minioPassword = randomPassword();
  const encryptionKey = randomString(64);
  const artifactSigningKey = randomString(64);
  const dashboardPassword = randomPassword();
  const setupToken = randomString(32);
  const discordGatewaySecret = randomPassword();

  const sharedEnv = [
    `R_APP_ENV=production`,
    `ROOMOTE_DOCKER_LOAD_ENV_FILE=false`,
    `R_AUTO_GENERATE_KEYS=true`,
    `ENCRYPTION_KEY=${encryptionKey}`,
    `R_DISCORD_GATEWAY_SECRET=${discordGatewaySecret}`,
    `ARTIFACT_SIGNING_KEY=${artifactSigningKey}`,
    `DASHBOARD_PASSWORD=${dashboardPassword}`,
    `SETUP_TOKEN=${setupToken}`,
    `R_LICENSE_KEY=${input.licenseKey ?? ''}`,
    `S3_ACCESS_KEY_ID=roomote`,
    `S3_SECRET_ACCESS_KEY=${minioPassword}`,
    `S3_REGION=us-east-1`,
    `S3_BUCKET_ARTIFACTS=roomote-artifacts`,
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
    type: 'app',
    data: {
      serviceName: webName,
      source: { type: 'image', image },
      deploy: { command: 'web' },
      env: [...sharedEnv, `PORT=3000`].join('\n'),
      domains: [{ host: '$(EASYPANEL_DOMAIN)', port: 3000 }],
    },
  });

  services.push({
    type: 'app',
    data: {
      serviceName: apiName,
      source: { type: 'image', image },
      deploy: { command: 'api' },
      env: [...sharedEnv, `PORT=3001`].join('\n'),
      domains: [{ host: '$(EASYPANEL_DOMAIN)', port: 3001 }],
    },
  });

  services.push({
    type: 'app',
    data: {
      serviceName: controllerName,
      source: { type: 'image', image },
      deploy: { command: 'controller' },
      env: [
        ...sharedEnv,
        `DOCKER_HOST=tcp://${priv(dockerProxyName)}:2375`,
        `DOCKER_WORKER_RELEASE_PATH=/roomote/releases/worker-current.tar.gz`,
        `DOCKER_WORKER_NETWORK=$(PROJECT_NAME)`,
        `DOCKER_WORKER_ALLOW_UNBOUNDED_DISK=false`,
      ].join('\n'),
    },
  });

  services.push({
    type: 'app',
    data: {
      serviceName: bullmqName,
      source: { type: 'image', image },
      deploy: { command: 'bullmq' },
      env: [
        ...sharedEnv,
        `PORT=3002`,
        `DOCKER_HOST=tcp://${priv(dockerProxyName)}:2375`,
        `DOCKER_WORKER_RELEASE_PATH=/roomote/releases/worker-current.tar.gz`,
      ].join('\n'),
    },
  });

  services.push({
    type: 'app',
    data: {
      serviceName: migrateName,
      source: { type: 'image', image },
      deploy: { command: 'db-migrate' },
      env: sharedEnv.join('\n'),
    },
  });

  services.push({
    type: 'app',
    data: {
      serviceName: minioName,
      source: { type: 'image', image: 'minio/minio:RELEASE.2025-09-07T16-13-09Z' },
      deploy: { command: 'server /data --console-address :9001' },
      env: [`MINIO_ROOT_USER=roomote`, `MINIO_ROOT_PASSWORD=${minioPassword}`].join(
        '\n'
      ),
      domains: [{ host: '$(EASYPANEL_DOMAIN)', port: 9000 }],
      mounts: [{ type: 'volume', name: 'data', mountPath: '/data' }],
    },
  });

  services.push({
    type: 'app',
    data: {
      serviceName: dockerProxyName,
      source: {
        type: 'image',
        image: 'ghcr.io/tecnativa/docker-socket-proxy:v0.4.2',
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
      ].join('\n'),
      mounts: [
        {
          type: 'bind',
          hostPath: '/var/run/docker.sock',
          mountPath: '/var/run/docker.sock',
        },
      ],
    },
  });

  services.push({
    type: 'postgres',
    data: { serviceName: dbName, password: databasePassword },
  });

  services.push({
    type: 'redis',
    data: { serviceName: redisName, password: redisPassword },
  });

  return { services };
}

const input = parseArgs(process.argv.slice(2));
const output = generate(input);
process.stdout.write(JSON.stringify(output, null, 2) + '\n');

if (process.stdout.isTTY) {
  console.error(
    '\nNote: this JSON contains freshly generated secrets. Paste it directly into Easypanel and do not commit it.'
  );
}
