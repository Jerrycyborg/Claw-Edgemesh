/**
 * Validates that a secret is provided in production environments.
 * Falls back to a development default only in non-production.
 * 
 * @param secretName - Name of the secret for error messages
 * @param envVar - Value from environment variable (may be undefined)
 * @param devDefault - Development fallback value
 * @returns The secret value (either from env or dev default)
 * @throws Error if secret is missing in production
 */
export function requireSecretInProduction(
  secretName: string,
  envVar: string | undefined,
  devDefault: string
): string {
  if (!envVar && process.env.NODE_ENV === 'production') {
    throw new Error(
      `${secretName} must be set in production. ` +
      `Set the environment variable or NODE_ENV to non-production for development.`
    );
  }
  return envVar ?? devDefault;
}
