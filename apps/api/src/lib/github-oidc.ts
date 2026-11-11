import { createRemoteJWKSet, jwtVerify } from 'jose';

/**
 * Lets the GitHub Actions reminders workflow call the cron endpoint with no shared secret: the job
 * asks GitHub for a signed OIDC token and we check it was issued to this repo's reminders
 * workflow on main. A fork's token names its own repository, so it is rejected.
 */
const ISSUER = 'https://token.actions.githubusercontent.com';
export const REMINDERS_AUDIENCE = 'agenda-reminders';
const REPO = process.env.GITHUB_REPOSITORY_ALLOWED ?? 'ljorchavez/agenda';
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks`));

export async function isRemindersWorkflow(authorization: string | undefined): Promise<boolean> {
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
  // OIDC tokens are JWTs (three parts); anything else isn't ours to check.
  if (!token || token.split('.').length !== 3) return false;
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER, audience: REMINDERS_AUDIENCE });
    return (
      payload.repository === REPO &&
      payload.ref === 'refs/heads/main' &&
      String(payload.job_workflow_ref ?? '').startsWith(`${REPO}/.github/workflows/reminders.yml@`)
    );
  } catch {
    return false;
  }
}
