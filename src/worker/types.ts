export type AppEnv = {
  Bindings: {
    DB: D1Database;
    ASSETS: Fetcher;
    MEDIA_MODE: 'external' | 'r2';
    ALLOWED_ORIGINS: string;
    PUBLICATION_ENABLED?: string;
    LEGACY_SUBMISSIONS_ENABLED?: string;
    PUBLIC_TURNSTILE_SITE_KEY?: string;
    TURNSTILE_SECRET_KEY: string;
    TURNSTILE_HOSTNAME: string;
    ACCESS_TEAM_DOMAIN: string;
    ACCESS_AUD: string;
    ACCESS_REVIEWER_EMAIL: string;
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
