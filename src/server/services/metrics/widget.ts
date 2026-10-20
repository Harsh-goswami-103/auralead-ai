/**
 * Shared shape of the DB-derived metrics (T25, plan §10 "metrics show As of time", 06-design §11.3
 * "Command center KPIs: per-tile error with retry; other tiles still render").
 *
 *  - Every widget has a `MetricDefinition`: a stable id, the label people read and the definition
 *    string that says exactly what is counted (shown next to the number, never hidden).
 *  - `settleWidget` runs one widget's aggregate and turns a failure into `{ ok: false, reference }`
 *    (the request's correlation id), so one failed query marks one tile instead of failing the
 *    whole dashboard. The error goes to the caller's `onError` for logging; it is never shown.
 *  - Money is `{ paise: bigint, count }`: the persisted totals summed in SQL (BigInt paise, never a
 *    float), with the number of quotes behind the sum.
 */
export type MetricDefinition = {
  readonly id: string;
  readonly label: string;
  readonly definition: string;
};

export type WidgetOutcome<T> = { ok: true; value: T } | { ok: false; reference: string };

export type WidgetErrorHandler = (widgetId: string, error: unknown) => void;

export type MoneyMetric = { paise: bigint; count: number };

export const DAY_MS = 86_400_000;
/** The look-back of "new" and "recent" counts. */
export const RECENT_DAYS = 7;

export function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

export async function settleWidget<T>(ctx: { correlationId: string }, def: Pick<MetricDefinition, 'id'>, run: () => Promise<T>, onError?: WidgetErrorHandler): Promise<WidgetOutcome<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    onError?.(def.id, error);
    return { ok: false, reference: ctx.correlationId };
  }
}

/** `_sum` and `_count` of an aggregate over QuoteVersion.totalPaise as a MoneyMetric. */
export function moneyOf(agg: { _sum: { totalPaise: bigint | null }; _count: { _all: number } | number }): MoneyMetric {
  const count = typeof agg._count === 'number' ? agg._count : agg._count._all;
  return { paise: agg._sum.totalPaise ?? 0n, count };
}
