"use client"

/**
 * shadcn `sonner` output (CLI 4.21.5), adapted: the generated file reads the theme from
 * next-themes, which is not a dependency here. Panels have one dark theme (plan §10), so the
 * theme is fixed. Toasts are polite live regions (06-design §11.11).
 */
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4 text-success" aria-hidden="true" />,
        info: <InfoIcon className="size-4 text-info" aria-hidden="true" />,
        warning: <TriangleAlertIcon className="size-4 text-warning" aria-hidden="true" />,
        error: <OctagonXIcon className="size-4 text-danger" aria-hidden="true" />,
        loading: <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
