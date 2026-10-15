/**
 * Class-name merger for shadcn components (components.json `aliases.utils`). The shadcn 4.21.5
 * CLI emits `import { cn } from "cn"` and adds an unpinned `cn` package; T08 rewrites those
 * imports to this module, built on the pinned clsx 2.1.1 and tailwind-merge 3.7.0 (ADR-49).
 */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
