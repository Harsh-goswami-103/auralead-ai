/**
 * Lead source category styles (design spec §6): ONE mapping so a source has the same label, icon
 * and color wherever it appears (lead tables, inbox, simulator, charts). Colors follow the chart
 * palette order so chips match legends: Google Sheets = zest (chart-2), Meta Lead Ads = volt
 * (chart-4), Maps extension = aura (chart-1), WhatsApp = flare (chart-3), Email = ice (neutral,
 * kept off the info status hue), Manual and anything unknown = chart-other. The palette has four
 * category hues, so the two lead-gen sources share the hue of their family and differ by label
 * and icon: Google Places = aura like the Maps extension (both Maps listings), File import = zest
 * like Google Sheets (both spreadsheets). Color is never the only signal: every use renders the
 * icon or dot together with the text label. Accepts LeadSource values and the DEMO simulator keys
 * (sheets, meta, gmaps; `maps` is accepted as an alias).
 */
import type { LucideIcon } from 'lucide-react';
import { FileSpreadsheet, FileUp, Mail, MapPin, MapPinned, Megaphone, MessageCircle, PenLine } from 'lucide-react';
import type { LeadSource } from '@/lib/domain/enums';
import type { SimulationSource } from '@/lib/schemas/webhooks';

export type SourceStyle = {
  /** Short human label, identical to the labels the lead pages already show. */
  label: string;
  icon: LucideIcon;
  /** Classes for the small colored dot (bright -hi step: >= 3:1 on every surface). */
  dotClass: string;
  /** Classes for a category chip: 12% tint, 35% border, text-1 label (text stays neutral). */
  chipClass: string;
  /** Text color class for the icon only (never for text). */
  iconClass: string;
};

export type SourceKey = LeadSource | SimulationSource | 'maps';

const SHEETS: SourceStyle = {
  label: 'Google Sheets',
  icon: FileSpreadsheet,
  dotClass: 'bg-chart-2-hi',
  chipClass: 'border-chart-2-hi/35 bg-chart-2/12 text-fg-1',
  iconClass: 'text-chart-2-hi',
};
const META: SourceStyle = {
  label: 'Meta Lead Ads',
  icon: Megaphone,
  dotClass: 'bg-chart-4-hi',
  chipClass: 'border-chart-4-hi/35 bg-chart-4/12 text-fg-1',
  iconClass: 'text-chart-4-hi',
};
const MAPS: SourceStyle = {
  label: 'Maps extension',
  icon: MapPin,
  dotClass: 'bg-chart-1-hi',
  chipClass: 'border-chart-1-hi/35 bg-chart-1/12 text-fg-1',
  iconClass: 'text-chart-1-hi',
};
const WHATSAPP: SourceStyle = {
  label: 'WhatsApp',
  icon: MessageCircle,
  dotClass: 'bg-chart-3-hi',
  chipClass: 'border-chart-3-hi/35 bg-chart-3/12 text-fg-1',
  iconClass: 'text-chart-3-hi',
};
const EMAIL: SourceStyle = {
  label: 'Email',
  icon: Mail,
  dotClass: 'bg-ice',
  chipClass: 'border-ice/30 bg-ice/8 text-fg-1',
  iconClass: 'text-ice',
};
const PLACES: SourceStyle = {
  label: 'Google Places',
  icon: MapPinned,
  dotClass: 'bg-chart-1-hi',
  chipClass: 'border-chart-1-hi/35 bg-chart-1/12 text-fg-1',
  iconClass: 'text-chart-1-hi',
};
const FILE_IMPORT: SourceStyle = {
  label: 'File import',
  icon: FileUp,
  dotClass: 'bg-chart-2-hi',
  chipClass: 'border-chart-2-hi/35 bg-chart-2/12 text-fg-1',
  iconClass: 'text-chart-2-hi',
};
const MANUAL: SourceStyle = {
  label: 'Manual',
  icon: PenLine,
  dotClass: 'bg-chart-other',
  chipClass: 'border-chart-other/45 bg-chart-other/12 text-fg-1',
  iconClass: 'text-fg-2',
};

export const SOURCE_STYLES: Readonly<Record<SourceKey, SourceStyle>> = {
  GOOGLE_SHEETS: SHEETS,
  META_ADS: META,
  GMAPS_EXTENSION: MAPS,
  WHATSAPP_INBOUND: WHATSAPP,
  EMAIL_INBOUND: EMAIL,
  MANUAL,
  GOOGLE_PLACES: PLACES,
  FILE_IMPORT,
  sheets: SHEETS,
  meta: META,
  gmaps: MAPS,
  maps: MAPS,
};

/** Style for any source string; unknown values keep their own text with the neutral style. */
export function sourceStyle(source: string): SourceStyle {
  if (Object.hasOwn(SOURCE_STYLES, source)) return SOURCE_STYLES[source as SourceKey];
  return { ...MANUAL, label: source };
}
