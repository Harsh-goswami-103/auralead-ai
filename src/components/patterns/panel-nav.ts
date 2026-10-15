/**
 * Panel navigation (06-design §11.2). Plan §12: a section appears here only when its page exists,
 * so no nav item ever leads to a placeholder. Each task that lands a panel page appends its item
 * (with `primary: true` for the at most four sections in the mobile bottom tab bar).
 */
import { Building2, FileText, Gauge, LayoutDashboard, Tags, type LucideIcon } from 'lucide-react';

export type PanelKey = 'user' | 'employee' | 'admin';

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shown in the bottom tab bar below 1024px (max four; the rest go to "More"). */
  primary?: boolean;
  /** `exact` for a panel home, so it is not marked active on every sub-page. */
  match: 'exact' | 'prefix';
};

export type PanelDefinition = { key: PanelKey; title: string; home: string; items: NavItem[] };

export const PANELS: Readonly<Record<PanelKey, PanelDefinition>> = {
  user: {
    key: 'user',
    title: 'Client panel',
    home: '/dashboard/user',
    items: [
      { href: '/dashboard/user', label: 'Command center', icon: LayoutDashboard, primary: true, match: 'exact' },
      { href: '/dashboard/user/pricing', label: 'Pricing', icon: Tags, primary: true, match: 'prefix' },
      { href: '/dashboard/user/quotations', label: 'Quotations', icon: FileText, primary: true, match: 'prefix' },
    ],
  },
  employee: {
    key: 'employee',
    title: 'Operator panel',
    home: '/dashboard/employee',
    items: [{ href: '/dashboard/employee', label: 'Assignments', icon: Building2, primary: true, match: 'exact' }],
  },
  admin: {
    key: 'admin',
    title: 'Platform admin',
    home: '/dashboard/admin',
    items: [{ href: '/dashboard/admin', label: 'Global metrics', icon: Gauge, primary: true, match: 'exact' }],
  },
};

export const MAX_PRIMARY_TABS = 4;

export function isActive(item: Pick<NavItem, 'href' | 'match'>, pathname: string | null): boolean {
  if (!pathname) return false;
  if (item.match === 'exact') return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function primaryTabs(panel: PanelDefinition): NavItem[] {
  return panel.items.filter((i) => i.primary).slice(0, MAX_PRIMARY_TABS);
}
