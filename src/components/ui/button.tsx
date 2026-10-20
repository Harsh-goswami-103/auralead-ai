/**
 * Button (shadcn new-york, restyled for "Aurora", design spec §5). The primary fill is the action
 * gradient with ink text (white fails on every bright fill), a one-shot hover sheen and a CSS press
 * scale. Focus is the global 2px solid aura outline with a 2px offset; no ring hides it. There are
 * no dark: variants: html is always dark, so they would beat a caller's overrides. Below lg every
 * size gets an invisible hit area of at least 44px. Glow is not here (lint rule): wrap the one
 * primary CTA per view in visual/GlowFrame.
 */
import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"
import { cn } from "@/components/ui/cn"

/**
 * Invisible hit area of at least 44x44px below lg (spec §0.5), shared by every small control that is
 * not a Button. The element must be positioned (`relative`), or the hit area spans its ancestor.
 */
const touchTarget =
  "max-lg:before:absolute max-lg:before:top-1/2 max-lg:before:left-1/2 max-lg:before:size-full max-lg:before:min-h-11 max-lg:before:min-w-11 max-lg:before:-translate-x-1/2 max-lg:before:-translate-y-1/2"

const buttonVariants = cva(
  `relative inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,scale,filter] duration-fast ease-enter motion-safe:active:scale-[.97] motion-safe:active:duration-instant disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-danger [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 ${touchTarget}`,
  {
    variants: {
      variant: {
        default:
          "bg-action text-primary-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.25)] hover:brightness-110 motion-safe:hover:animate-sheen motion-safe:focus-visible:animate-sheen",
        destructive:
          "bg-danger text-cyan-fg shadow-[inset_0_1px_0_rgb(255_255_255/0.2)] hover:brightness-110",
        outline:
          "border border-border-strong bg-bg-1 text-fg-1 hover:bg-bg-3",
        secondary:
          "border border-border-strong bg-bg-2 text-fg-1 hover:border-panel/45 hover:bg-bg-3",
        ghost: "hover:bg-bg-3 hover:text-fg-1",
        link: "text-cyan underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants, touchTarget }
