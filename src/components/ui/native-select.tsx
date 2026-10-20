/**
 * NativeSelect (design spec §4-§5): a styled native <select> that keeps the platform picker, form
 * submission and keyboard behavior. Same field surface as Input; appearance-none plus a ChevronDown
 * so every platform draws the same control. Like Input it is 44px tall below lg (spec §0.5).
 * `className` and every other prop (ref included, React 19) go to the <select>; `wrapperClassName`
 * sizes or places the wrapper, which is block-level so the control fills grid and stacked layouts
 * and sizes to content in a flex row.
 */
import * as React from "react"
import { ChevronDownIcon } from "lucide-react"
import { cn } from "@/components/ui/cn"
import { fieldSurface } from "@/components/ui/field"

function NativeSelect({
  className,
  wrapperClassName,
  ...props
}: React.ComponentProps<"select"> & { wrapperClassName?: string }) {
  return (
    <div data-slot="native-select-wrapper" className={cn("relative", wrapperClassName)}>
      <select
        data-slot="native-select"
        className={cn(
          fieldSurface,
          "peer h-9 cursor-pointer max-lg:h-11 appearance-none py-1 pr-9 pl-3 [&_option]:bg-bg-2 [&_option]:text-fg-1",
          className
        )}
        {...props}
      />
      <ChevronDownIcon
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-fg-3 peer-disabled:opacity-50"
      />
    </div>
  )
}

export { NativeSelect }
