export interface MongoConfig {
  uri: string;
  db: string;
}

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

/** First administrator, created on startup. Null when ADMIN_LOGIN / ADMIN_PASSWORD are not set. */
export interface AdminSeed {
  login: string;
  name: string;
  password: string;
}

export interface Config {
  port: number;
  cookieSecure: boolean;
  maxUploadBytes: number;
  mongo: MongoConfig;
  s3: S3Config;
  admin: AdminSeed | null;
}

const REQUIRED = ['MONGODB_URI', 'S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')} (see .env.example)`);
  }
  return {
    port: Number(env.PORT ?? 3000),
    cookieSecure: env.COOKIE_SECURE === 'true',
    maxUploadBytes: Number(env.MAX_UPLOAD_MB ?? 2048) * 1024 * 1024,
    mongo: { uri: env.MONGODB_URI!, db: env.MONGODB_DB || 'emotion' },
    s3: {
      endpoint: env.S3_ENDPOINT!,
      region: env.S3_REGION || 'us-east-1',
      bucket: env.S3_BUCKET!,
      accessKeyId: env.S3_ACCESS_KEY_ID!,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
      forcePathStyle: env.S3_FORCE_PATH_STYLE !== 'false',
    },
    admin:
      env.ADMIN_LOGIN && env.ADMIN_PASSWORD
        ? { login: env.ADMIN_LOGIN, name: env.ADMIN_NAME || env.ADMIN_LOGIN, password: env.ADMIN_PASSWORD }
        : null,
  };
}
