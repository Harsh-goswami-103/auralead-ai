/**
 * Textarea (design spec §4-§5): the shared field surface of Input, for multi-line text such as
 * reasons, notes and message drafts. Forwards every textarea prop, ref included (React 19).
 */
import * as React from "react"
import { cn } from "@/components/ui/cn"
import { fieldSurface } from "@/components/ui/field"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(fieldSurface, "min-h-20 px-3 py-2", className)}
      {...props}
    />
  )
}

export { Textarea }
