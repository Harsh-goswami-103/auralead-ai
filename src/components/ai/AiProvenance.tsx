/**
 * Who wrote a piece of AI-task output (a draft, an automated chat reply, template copy, a handoff
 * summary), as a small chip (ADR-18, ADR-66 truthful UI; lead-gen B2). The label comes from the
 * shared vocabulary (`generatorInfo` in src/lib/schemas/lead-console.ts):
 * - Only a real model provider (kind 'ai': anthropic, openai) is AI: a violet "AI prepared" chip
 *   with a sparkle icon, naming the provider (and the model, when given) in its title. The violet
 *   --ai token is legal only under src/components/ai/** (lint rule AI_TOKEN).
 * - Everything else is the neutral GeneratorChip: "Local template" for the local deterministic
 *   generator, "Automatic reply" for the reply guard, "System text", an unknown label as itself;
 *   a person's own text and "not generated" render nothing.
 * Server-safe.
 */
import { Sparkles } from 'lucide-react';
import { GeneratorChip } from '@/components/leads/GeneratorChip';
import { cn } from '@/components/ui/cn';
import { generatorInfo } from '@/lib/schemas/lead-console';

export function AiProvenance({ generatorLabel, modelId, className }: { generatorLabel: string | null | undefined; modelId?: string | null; className?: string }) {
  const info = generatorInfo(generatorLabel);
  if (info.kind !== 'ai') return <GeneratorChip generatorLabel={generatorLabel ?? null} className={className} />;
  return (
    <span
      data-generator="ai"
      title={modelId ? `${info.label}, ${modelId}` : info.label}
      className={cn('inline-flex w-fit shrink-0 items-center gap-1 rounded-full border border-ai/40 bg-ai/10 px-2 py-0.5 text-xs whitespace-nowrap text-ai', className)}
    >
      <Sparkles aria-hidden="true" className="size-3 shrink-0" />
      {info.short}
    </span>
  );
}
