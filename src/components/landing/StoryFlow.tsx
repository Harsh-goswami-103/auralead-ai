/**
 * The lead-gen flow at the top of "How it works" (ADR-126): Find, Chat, Hand over, Quote. Four
 * numbered steps, each saying in one or two sentences what the product really does there:
 * a Google Places search (or an Excel/CSV list) finds the businesses, the WhatsApp-style inbox
 * opens with an approved template and answers service questions inside the 24-hour window, a
 * converted lead is handed to the client with a note and a summary, and the client prices it from
 * the versioned price list. No figures, no customers. The same copy in DEMO and LIVE (no mode
 * wording). Server-safe; the reveal is a client island.
 */
import { FileText, Handshake, MapPinned, MessageCircle, type LucideIcon } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import { Stagger, StaggerItem } from '@/components/visual/Reveal';

type FlowStep = { key: string; title: string; icon: LucideIcon; text: string; tint: string; hairline: string };

export const LEAD_FLOW: readonly FlowStep[] = [
  {
    key: 'find',
    title: 'Find',
    icon: MapPinned,
    text: 'Search Google Places by keyword and city, keep the businesses with no website listed, and import them as leads or download Excel. Lists you already hold come in from Excel or CSV.',
    tint: 'border-aura/30 bg-aura/12 text-aura',
    hairline: 'bg-aura',
  },
  {
    key: 'chat',
    title: 'Chat',
    icon: MessageCircle,
    text: 'A WhatsApp-style inbox. An approved template opens the conversation, automatic replies answer service questions inside the 24-hour window, and prices, complaints or a request for a person go to your team.',
    tint: 'border-flare/30 bg-flare/10 text-flare',
    hairline: 'bg-flare',
  },
  {
    key: 'handover',
    title: 'Hand over',
    icon: Handshake,
    text: 'Pass a converted lead to the client with a note and a summary of the chat. Automatic replies stop, and the client carries the conversation on.',
    tint: 'border-zest/30 bg-zest/10 text-zest',
    hairline: 'bg-zest',
  },
  {
    key: 'quote',
    title: 'Quote',
    icon: FileText,
    text: 'The client prices the work from the versioned price list and sends a real PDF with a link the customer accepts.',
    tint: 'border-volt-hi/35 bg-volt/14 text-volt-hi',
    hairline: 'bg-volt-hi',
  },
];

export function StoryFlow() {
  return (
    <div data-landing-flow="" className="flex flex-col gap-4">
      <p className="text-sm font-medium text-fg-1">From a Maps search to a signed quote, in four steps</p>
      <Stagger as="ol" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {LEAD_FLOW.map((step, index) => {
          const Icon = step.icon;
          return (
            <StaggerItem key={step.key} as="li" inView className="relative flex min-w-0 flex-col gap-3 overflow-hidden rounded-xl border border-border-subtle bg-bg-1/80 p-5">
              <span aria-hidden="true" className={cn('pointer-events-none absolute inset-x-0 top-0 h-0.5 opacity-80', step.hairline)} />
              <div className="flex items-center justify-between">
                <span aria-hidden="true" className={cn('grid size-10 place-items-center rounded-xl border', step.tint)}>
                  <Icon className="size-5" />
                </span>
                <span aria-hidden="true" className="font-mono text-xs text-fg-3 tabular">
                  {String(index + 1).padStart(2, '0')}
                </span>
              </div>
              <h3 className="font-display text-lg font-semibold text-fg-1">{step.title}</h3>
              <p className="text-sm text-fg-2">{step.text}</p>
            </StaggerItem>
          );
        })}
      </Stagger>
    </div>
  );
}
