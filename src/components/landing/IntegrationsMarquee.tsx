/**
 * The sources, channels and AI providers AuraLead is built around, as a slow marquee of name
 * chips (plan T30, spec §0.1): real integration names in text with a lucide icon, no logos and no
 * customer names. Sources and channels wear their shared category colors (source-style.ts, the
 * same tint and icon hue as every SourceChip in the app); PDF quotations take the action hue and
 * the AI providers stay neutral (the violet ai token belongs to src/components/ai only). The
 * first track is the readable copy; the Marquee's second track is an inert, aria-hidden
 * duplicate. Under reduced motion it is one static, wrapped row. Server-safe.
 */
import { Bot, ClipboardList, Cpu, FileText, Sparkles, type LucideIcon } from 'lucide-react';
import { sourceStyle } from '@/components/patterns/source-style';
import { cn } from '@/components/ui/cn';
import { Marquee } from '@/components/visual/Marquee';

type Integration = { name: string; icon: LucideIcon; chip: string; tint: string };

const fromSource = (source: string, name?: string, icon?: LucideIcon): Integration => {
  const style = sourceStyle(source);
  return { name: name ?? style.label, icon: icon ?? style.icon, chip: style.chipClass, tint: style.iconClass };
};
const NEUTRAL = 'border-border-strong bg-bg-2/80 text-fg-1';

const INTEGRATIONS: readonly Integration[] = [
  fromSource('sheets'),
  fromSource('sheets', 'Google Forms via Sheets', ClipboardList),
  fromSource('meta'),
  fromSource('maps'),
  fromSource('WHATSAPP_INBOUND', 'WhatsApp Cloud API'),
  fromSource('EMAIL_INBOUND'),
  { name: 'PDF quotations', icon: FileText, chip: 'border-aura/35 bg-aura/10 text-fg-1', tint: 'text-aura' },
  { name: 'Anthropic', icon: Sparkles, chip: NEUTRAL, tint: 'text-fg-2' },
  { name: 'OpenAI', icon: Bot, chip: NEUTRAL, tint: 'text-fg-2' },
  { name: 'Local deterministic generator', icon: Cpu, chip: NEUTRAL, tint: 'text-fg-2' },
];

export function IntegrationsMarquee() {
  return (
    <section aria-labelledby="integrations-title" data-landing-section="integrations" className="relative border-y border-border-subtle bg-bg-1/50 py-8">
      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-5 px-4 sm:px-6 lg:px-8">
        <h2 id="integrations-title" className="text-center text-xs font-semibold tracking-[0.16em] text-balance text-fg-2 uppercase">
          Sources, channels and AI providers it is built around
        </h2>
        <Marquee duration={48} gap="0.75rem">
          {INTEGRATIONS.map((item) => {
            const Icon = item.icon;
            return (
              <span key={item.name} className={cn('flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm font-medium whitespace-nowrap', item.chip)}>
                <Icon aria-hidden="true" className={cn('size-4 shrink-0', item.tint)} />
                {item.name}
              </span>
            );
          })}
        </Marquee>
      </div>
    </section>
  );
}
