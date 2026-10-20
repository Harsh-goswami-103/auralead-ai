/**
 * RoleChip: a person's global role as icon + text in the signature hue of the panel they use
 * (client user aura, employee zest, super admin flare). The icon is decorative; the label is the
 * accessible text. `data-role-chip` carries the raw role for tests and tooling. Server-safe.
 */
import { cn } from '@/components/ui/cn';
import type { GlobalRole } from '@/lib/domain/enums';
import { ROLE_STYLES } from './people-vocabulary';

export function RoleChip(props: { role: GlobalRole; className?: string }) {
  const style = ROLE_STYLES[props.role];
  const Icon = style.icon;
  return (
    <span data-role-chip={props.role} className={cn('inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap', style.chip, props.className)}>
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      {style.label}
    </span>
  );
}
