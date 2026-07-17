export interface Env {
  DB: D1Database;
  BACKUPS: R2Bucket;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string; // set via wrangler secret

  // R2 S3 credentials for presigned URLs — set via wrangler secret
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  CLOUDFLARE_ACCOUNT_ID: string;
}

export interface User {
  id: number;
  github_id: number;
  github_login: string;
  avatar_url: string | null;
  user_secret: string;
  created_at: string;
  updated_at: string;
}

export interface Backup {
  id: string;
  user_id: number;
  r2_key: string;
  size_bytes: number;
  checksum: string;
  device_name: string | null;
  app_version: string | null;
  created_at: string;
}

export interface AuthContext {
  user: User;
  token: string;
}
