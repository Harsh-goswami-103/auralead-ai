/**
 * Badge (shadcn new-york, restyled for "Aurora", design spec §5): tone text on the tone at 12% with
 * a 35% tone border, like StatusBadge. Status meaning still needs an icon and a text label (spec
 * §0.2); use patterns/StatusBadge for statuses. Focus is the global aura outline; no dark: variants.
 */
import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/components/ui/cn"
import { Slot } from "radix-ui"

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-[color,background-color,border-color] duration-fast aria-invalid:border-danger [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "border-cyan/35 bg-cyan/12 text-cyan [a&]:hover:bg-cyan/20",
        secondary: "border-border-strong bg-bg-3 text-fg-1 [a&]:hover:border-fg-3",
        destructive: "border-danger/35 bg-danger/12 text-danger [a&]:hover:bg-danger/20",
        outline: "border-border-strong text-fg-1 [a&]:hover:bg-bg-3",
        ghost: "text-fg-1 [a&]:hover:bg-bg-3",
        link: "text-cyan underline-offset-4 [a&]:hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
