/**
 * POST /api/app/media (ADR-123, slice F4): uploads a PDF brochure to the workspace's media library
 * for a template's document header, as `{workspaceSlug, fileName, contentType, dataBase64}`. The
 * JSON body is capped at the base64 size of 5 MB plus the envelope (413 above it), the decoded file
 * at 5 MB (413); the type must be application/pdf, the name `.pdf` and the bytes start with `%PDF-`
 * (422 otherwise). Stored under STORAGE_DIR/media/<workspace>/<id>.pdf. Nothing is sent to a
 * provider here. Roles USER and EMPLOYEE, `templates.manage` in the `workspaceSlug` workspace
 * (checked in the service); CSRF.
 */
import { MEDIA_UPLOAD_MAX_BODY_BYTES, MediaUploadBody } from '@/lib/schemas/templates';
import { uploadMediaAsset } from '@/server/services/integrations/media-assets';
import { withRoute } from '../../_lib/with-route';
import { studioContext } from '../templates/_lib/deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: MediaUploadBody, maxBodyBytes: MEDIA_UPLOAD_MAX_BODY_BYTES }, async ({ ctx, session, runtime, body }) => {
  const target = await studioContext({ ctx, session, runtime }, body.workspaceSlug);
  return { asset: await uploadMediaAsset(target, body, { storageDir: runtime.config.paths.storageDir }) };
});
