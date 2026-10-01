import type { AppEnv } from './types.js';

export function publicationEnabled(env: AppEnv['Bindings']): boolean {
  return env.PUBLICATION_ENABLED === 'true';
}

/**
 * Configuration needed by a public submission or private review service.
 * Static assets deliberately do not use this check and remain available when
 * a secret or the D1 binding has not been configured yet.
 */
export function missingSubmissionConfig(env: AppEnv['Bindings']): string[] {
  const missing = missingDatabaseConfig(env);
  if (!env.TURNSTILE_SECRET_KEY?.trim()) missing.push('TURNSTILE_SECRET_KEY');
  return missing;
}

export function missingDatabaseConfig(env: AppEnv['Bindings']): string[] {
  return env.DB ? [] : ['DB'];
}

export function missingReviewConfig(env: AppEnv['Bindings']): string[] {
  const missing = missingSubmissionConfig(env);
  if (!env.ACCESS_TEAM_DOMAIN?.trim()) missing.push('ACCESS_TEAM_DOMAIN');
  if (!env.ACCESS_AUD?.trim()) missing.push('ACCESS_AUD');
  return missing;
}

export function missingDeploymentConfig(env: AppEnv['Bindings']): string[] {
  const missing = missingReviewConfig(env);
  if (!env.GITHUB_REPOSITORY?.trim()) missing.push('GITHUB_REPOSITORY');
  if (!env.GITHUB_APP_ID?.trim()) missing.push('GITHUB_APP_ID');
  if (!env.GITHUB_PRIVATE_KEY?.trim()) missing.push('GITHUB_PRIVATE_KEY');
  if (!env.GITHUB_INSTALLATION_ID?.trim()) missing.push('GITHUB_INSTALLATION_ID');
  if (!env.GITHUB_WEBHOOK_SECRET?.trim()) missing.push('GITHUB_WEBHOOK_SECRET');
  if (!env.DEPLOY_WEBHOOK_SECRET?.trim()) missing.push('DEPLOY_WEBHOOK_SECRET');
  return missing;
}
