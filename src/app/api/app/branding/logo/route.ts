/**
 * /api/app/branding/logo (T27, P7).
 *  - GET serves the caller's own workspace logo: the stored re-encoded WebP, checked against the
 *    hash in its file name, with a fixed `image/webp` type, `nosniff`, an inline disposition and a
 *    CSP that lets the bytes do nothing but render. Any member may read it; 404 LOGO_NOT_SET when
 *    there is none.
 *  - POST uploads a new logo as `{contentType, fileName?, dataBase64}`. Owner only
 *    (`pricing.override`). The JSON body is capped at the base64 size of 1 MB (413 above it) and
 *    the decoded file at 1 MB (413); the type, name, magic bytes and decoded format must agree
 *    (422 otherwise), and the image is re-encoded to WebP without metadata before it is stored.
 */
import { LOGO_UPLOAD_MAX_BODY_BYTES, LogoUploadBody } from '@/lib/schemas/branding';
import { readLogo, serializeBranding, uploadLogo } from '@/server/services/pricing/branding';
import { withRoute } from '../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withRoute({ auth: 'session', roles: ['USER'] }, async ({ ctx, runtime: rt }) => {
  const logo = await readLogo(ctx, { storageDir: rt.config.paths.storageDir });
  return new Response(new Uint8Array(logo.bytes), {
    status: 200,
    headers: {
      'content-type': 'image/webp',
      'content-length': String(logo.bytes.length),
      'x-content-type-options': 'nosniff',
      'content-disposition': 'inline; filename="logo.webp"',
      'content-security-policy': "default-src 'none'; sandbox",
      etag: `"${logo.sha256}"`,
    },
  });
});

export const POST = withRoute(
  { auth: 'session', roles: ['USER'], body: LogoUploadBody, capability: 'pricing.override', maxBodyBytes: LOGO_UPLOAD_MAX_BODY_BYTES },
  async ({ ctx, body, runtime: rt }) => ({ branding: serializeBranding(await uploadLogo(ctx, body, { storageDir: rt.config.paths.storageDir })) }),
);
