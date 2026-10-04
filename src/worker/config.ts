import type { AppEnv } from './types.js';

export function liveContent(env: AppEnv['Bindings']) { return env.CONTENT_MODE === 'live'; }

export function publicationEnabled(env: AppEnv['Bindings']): boolean {
  return env.PUBLICATION_ENABLED === 'true';
}

export function legacySubmissionWritesEnabled(env: AppEnv['Bindings']): boolean {
  return env.LEGACY_SUBMISSIONS_ENABLED === 'true';
}

/**
 * Configuration needed by a public submission or private review service.
 * Static assets deliberately do not use this check and remain available when
 * a secret or the D1 binding has not been configured yet.
 */
export function missingSubmissionConfig(env: AppEnv['Bindings']): string[] {
  const missing = missingDatabaseConfig(env);
  if (!env.TURNSTILE_SECRET_KEY?.trim()) missing.push('TURNSTILE_SECRET_KEY');
  if (!env.TURNSTILE_HOSTNAME?.trim()) missing.push('TURNSTILE_HOSTNAME');
  if (env.MEDIA_MODE === 'r2' && !env.IMAGES) missing.push('IMAGES');
  return missing;
}

export function missingDatabaseConfig(env: AppEnv['Bindings']): string[] {
  return env.DB ? [] : ['DB'];
}

export function missingReviewConfig(env: AppEnv['Bindings']): string[] {
  const missing = missingSubmissionConfig(env);
  const hasAuth = Boolean(env.OIDC_CLIENT_ID?.trim() && env.OIDC_CLIENT_SECRET?.trim() && env.OIDC_REDIRECT_URI?.trim());
  const hasAccess = Boolean(env.ACCESS_TEAM_DOMAIN?.trim() && env.ACCESS_AUD?.trim() && env.ACCESS_REVIEWER_EMAIL?.trim());
  if (!hasAuth && !hasAccess) missing.push('ADMIN_AUTH');
  return missing;
}

export function missingDeploymentConfig(env: AppEnv['Bindings']): string[] {
  const missing = missingReviewConfig(env);
  if (liveContent(env)) return missing;
  if (!env.GITHUB_REPOSITORY?.trim()) missing.push('GITHUB_REPOSITORY');
  if (!env.GITHUB_APP_ID?.trim()) missing.push('GITHUB_APP_ID');
  if (!env.GITHUB_PRIVATE_KEY?.trim()) missing.push('GITHUB_PRIVATE_KEY');
  if (!env.GITHUB_INSTALLATION_ID?.trim()) missing.push('GITHUB_INSTALLATION_ID');
  if (!env.GITHUB_WEBHOOK_SECRET?.trim()) missing.push('GITHUB_WEBHOOK_SECRET');
  if (!env.DEPLOY_WEBHOOK_SECRET?.trim()) missing.push('DEPLOY_WEBHOOK_SECRET');
  return missing;
}
