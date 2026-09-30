export type AppEnv = {
  Bindings: {
    DB: D1Database;
    ASSETS: Fetcher;
    MEDIA_MODE: 'external' | 'r2';
    ALLOWED_ORIGINS: string;
    TURNSTILE_SECRET_KEY: string;
    ACCESS_TEAM_DOMAIN: string;
    ACCESS_AUD: string;
    GITHUB_APP_ID: string;
    GITHUB_PRIVATE_KEY: string;
    GITHUB_INSTALLATION_ID: string;
    GITHUB_REPOSITORY: string;
    GITHUB_WEBHOOK_SECRET: string;
    DEPLOY_WEBHOOK_SECRET: string;
    IMAGES?: R2Bucket;
  };
  Variables: { reviewer: string };
};
