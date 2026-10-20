/**
 * Skeleton (design spec §5): a bg-2 block with a shimmer sweep tinted 6% toward the panel hue.
 * Only for data that is genuinely loading (truthful motion). Under reduced motion the sweep stays
 * parked off the edge, so the block is a static bg-2 shape.
 */
import { cn } from "@/components/ui/cn"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "rounded-md bg-bg-2 bg-[linear-gradient(100deg,transparent_30%,color-mix(in_oklab,var(--panel-hue)_6%,var(--bg-3))_50%,transparent_70%)] bg-[length:200%_100%] bg-[position:150%_0] bg-no-repeat motion-safe:animate-shimmer",
        className
      )}
      {...props}
    />
  )
}

export { Skeleton }
