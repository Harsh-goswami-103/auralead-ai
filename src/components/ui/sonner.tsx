"use client"

/**
 * shadcn `sonner` output (CLI 4.21.5), adapted: the generated file reads the theme from
 * next-themes, which is not a dependency here. Panels have one dark theme (plan §10), so the
 * theme is fixed. Toasts are polite live regions (06-design §11.11).
 *
 * "Aurora" skin (design spec §5): bg-2 toasts with a strong border, a 2px tone bar on the leading
 * edge plus the status icon (never color alone), Inter instead of Sonner's system font, and a
 * bottom offset that clears the mobile tab bar (--toast-offset-bottom: 72px + safe area below lg,
 * 24px above). Sonner's own CSS is unlayered, so the bar and description color use `!`.
 * The defaults live here so the Toaster mount in patterns/Providers needs no props for them.
 */
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

const OFFSET = { bottom: "var(--toast-offset-bottom)" }

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      offset={OFFSET}
      mobileOffset={OFFSET}
      icons={{
        success: <CircleCheckIcon className="size-4 text-success" aria-hidden="true" />,
        info: <InfoIcon className="size-4 text-info" aria-hidden="true" />,
        warning: <TriangleAlertIcon className="size-4 text-warning" aria-hidden="true" />,
        error: <OctagonXIcon className="size-4 text-danger" aria-hidden="true" />,
        loading: <Loader2Icon className="size-4 text-fg-2 motion-safe:animate-spin" aria-hidden="true" />,
      }}
      toastOptions={{
        classNames: {
          toast:
            "shadow-[inset_2px_0_0_var(--toast-tone,var(--border-strong)),0_16px_48px_-12px_rgb(0_0_0/0.6)]!",
          description: "text-fg-2!",
          success: "[--toast-tone:var(--success)]",
          error: "[--toast-tone:var(--danger)]",
          warning: "[--toast-tone:var(--warning)]",
          info: "[--toast-tone:var(--info)]",
        },
      }}
      style={
        {
          "--normal-bg": "var(--bg-2)",
          "--normal-text": "var(--text-1)",
          "--normal-border": "var(--border-strong)",
          "--border-radius": "var(--r-lg)",
          fontFamily: "var(--font-inter), ui-sans-serif, system-ui, sans-serif",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
