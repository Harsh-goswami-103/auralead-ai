/**
 * Boots the web runtime exactly as a route handler does (`getRuntime()`: single env loader on
 * `<cwd>/.env`, config validation, boot checks, Prisma client) and serves one real request to
 * GET /api/health. Prints one line `RESULT <json>`: { databaseUrl, mode, healthStatus, health }.
 */
import { GET } from '@/app/api/health/route';
import { getRuntime } from '@/server/boot';

const runtime = getRuntime();
const res = await GET(new Request(`${runtime.config.appOrigin}/api/health`), { params: Promise.resolve({}) });
console.log(
  `RESULT ${JSON.stringify({
    databaseUrl: runtime.config.paths.databaseUrl,
    mode: runtime.config.mode,
    healthStatus: res.status,
    health: (await res.json()) as unknown,
  })}`,
);
await runtime.prisma.$disconnect();
