/**
 * Job handler registry. The worker builds one with `buildJobRegistry()`; tasks that add a job type
 * (T10 pipeline.advance, T11 ingest.process, ...) register its definition in `JOB_DEFINITIONS`.
 * A claimed job whose type is not registered goes DEAD with UNKNOWN_JOB_TYPE (never silently
 * dropped or retried).
 */
import type { JobDefinition } from './types';

export class JobRegistry {
  readonly #defs = new Map<string, JobDefinition>();

  register(def: JobDefinition): this {
    if (!/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9-]+)+$/.test(def.type)) throw new Error(`invalid job type name: ${def.type}`);
    if (this.#defs.has(def.type)) throw new Error(`job type already registered: ${def.type}`);
    if (def.payloadVersions.length === 0 || !def.payloadVersions.every((v) => Number.isInteger(v) && v > 0)) {
      throw new Error(`job type ${def.type}: payloadVersions must be positive integers`);
    }
    this.#defs.set(def.type, def);
    return this;
  }

  get(type: string): JobDefinition | undefined {
    return this.#defs.get(type);
  }

  types(): string[] {
    return [...this.#defs.keys()].sort();
  }
}

/** Production job definitions, appended by the tasks that own each handler. */
export const JOB_DEFINITIONS: readonly JobDefinition[] = [];

export function buildJobRegistry(defs: readonly JobDefinition[] = JOB_DEFINITIONS): JobRegistry {
  const registry = new JobRegistry();
  for (const def of defs) registry.register(def);
  return registry;
}
