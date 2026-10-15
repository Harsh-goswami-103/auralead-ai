/**
 * /api/test/clock (A40, 04-tests T5): the shared test clock for E2E window and expiry tests.
 * Exists only in DEMO with AURALEAD_TEST_CONTROL=1 and the right x-test-control-token (checked in
 * constant time); otherwise a plain 404. Writes the TestClock row that the web process and the
 * worker read through DbOffsetClock.
 *   GET  -> { now, offsetMs, frozenAt }
 *   POST exactly one of { frozenAt } | { offsetMs } | { advanceMs } | { reset: true }
 */
import { z } from 'zod';
import { withRoute } from '../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_OFFSET_MS = 10 * 365 * 24 * 3_600_000;
const Body = z.union([
  z.object({ frozenAt: z.iso.datetime({ offset: true }) }).strict(),
  z.object({ offsetMs: z.number().int().min(-MAX_OFFSET_MS).max(MAX_OFFSET_MS) }).strict(),
  z.object({ advanceMs: z.number().int().min(0).max(MAX_OFFSET_MS) }).strict(),
  z.object({ reset: z.literal(true) }).strict(),
]);

type ClockRow = { offsetMs: bigint; frozenAt: Date | null };
const ZERO: ClockRow = { offsetMs: 0n, frozenAt: null };

function view(now: Date, row: ClockRow) {
  return { now: now.toISOString(), offsetMs: Number(row.offsetMs), frozenAt: row.frozenAt?.toISOString() ?? null };
}

export const GET = withRoute({ auth: 'none', testControl: true }, async ({ ctx, runtime }) => {
  const row = (await runtime.prisma.testClock.findUnique({ where: { id: 1 } })) ?? ZERO;
  return view(ctx.clock.now(), row);
});

export const POST = withRoute({ auth: 'none', testControl: true, origin: false, body: Body }, async ({ body, ctx, runtime }) => {
  const shifted = ctx.clock.now();
  const wall = runtime.baseClock.now();
  let next: ClockRow;
  if ('frozenAt' in body) next = { offsetMs: 0n, frozenAt: new Date(body.frozenAt) };
  else if ('offsetMs' in body) next = { offsetMs: BigInt(body.offsetMs), frozenAt: null };
  else if ('advanceMs' in body) {
    const existing = (await runtime.prisma.testClock.findUnique({ where: { id: 1 } })) ?? ZERO;
    next =
      existing.frozenAt !== null
        ? { offsetMs: 0n, frozenAt: new Date(existing.frozenAt.getTime() + body.advanceMs) }
        : { offsetMs: BigInt(shifted.getTime() - wall.getTime() + body.advanceMs), frozenAt: null };
  } else next = ZERO;

  const row = await runtime.prisma.testClock.upsert({ where: { id: 1 }, create: { id: 1, ...next }, update: next });
  const now = row.frozenAt ?? new Date(wall.getTime() + Number(row.offsetMs));
  return view(now, row);
});
