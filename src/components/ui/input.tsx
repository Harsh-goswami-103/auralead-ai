/**
 * Input (shadcn new-york, restyled for "Aurora", design spec §5): the shared field surface (solid
 * bg-2, solid input border, 16px text below md, aura focus outline, danger border when
 * aria-invalid). No dark: variants, so a caller's background override wins.
 */
import * as React from "react"
import { cn } from "@/components/ui/cn"
import { fieldSurface } from "@/components/ui/field"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        fieldSurface,
        "h-9 px-3 py-1 selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-fg-1",
        className
      )}
      {...props}
    />
  )
}

export { Input }
