import { notFound } from 'next/navigation';
import { AuthError, type AuthContext } from '../../lib/auth/context.ts';
import { resolvePortalStudent, type PortalStudent } from '../../lib/portal/service.ts';

/**
 * Resolve the pupil a portal page is about, for use inside a page component.
 *
 * `resolvePortalStudent` throws `AuthError(404)` when the requested id is not
 * one the viewer is linked to. That is exactly right for an API route, where
 * the error handler turns it into a JSON 404 — but a React Server Component
 * has no such handler, so the throw surfaces as a 500 and the page looks
 * broken rather than absent.
 *
 * This adapter converts that one case into Next's own `notFound()`, which
 * renders the 404 page with a 404 status. Any other error is re-thrown
 * untouched: a genuine fault must not be disguised as a missing record.
 */
export async function resolvePortalStudentPage(
  ctx: AuthContext,
  requestedId?: string | null,
): Promise<PortalStudent> {
  try {
    return await resolvePortalStudent(ctx, requestedId);
  } catch (error) {
    if (error instanceof AuthError && error.status === 404) notFound();
    throw error;
  }
}
