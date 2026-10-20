/**
 * Who wrote a message or draft, as a small chip (truthful UI, employee report bug 4): "AI prepared"
 * only for real model providers (anthropic, openai); the local template, the reply guard and system
 * texts say what they are; a person's own text and "not generated" show no chip. The label comes
 * from the shared vocabulary in src/lib/schemas/lead-console.ts. The violet AI token is reserved for
 * src/components/ai/**, so this chip stays neutral and the icon tells the kinds apart.
 * Server-safe.
 */
import { Bot, CircleHelp, Cog, Sparkles, Wand2, type LucideIcon } from 'lucide-react';
import { generatorInfo, type GeneratorKind } from '@/lib/schemas/lead-console';
import { cn } from '@/components/ui/cn';

const ICONS: Readonly<Partial<Record<GeneratorKind, LucideIcon>>> = {
  ai: Sparkles,
  template: Wand2,
  automatic: Bot,
  system: Cog,
  other: CircleHelp,
};

export function GeneratorChip({ generatorLabel, className }: { generatorLabel: string | null; className?: string }) {
  const info = generatorInfo(generatorLabel);
  const Icon = ICONS[info.kind];
  if (!Icon) return null;
  return (
    <span
      data-generator={info.kind}
      className={cn('inline-flex w-fit shrink-0 items-center gap-1 rounded-full border border-border-strong bg-bg-2 px-2 py-0.5 text-xs whitespace-nowrap text-fg-2', className)}
    >
      <Icon aria-hidden="true" className="size-3 shrink-0" />
      {info.short}
    </span>
  );
}
