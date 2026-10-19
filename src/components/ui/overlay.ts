/**
 * Shared class strings for the overlay primitives (design spec §2 and §5), so Dialog, AlertDialog,
 * Sheet, DropdownMenu, Popover and Command move and look alike. Enters are slower than exits
 * (320ms emphasized for modals, 220ms for floating surfaces, 150ms for every exit); tw-animate
 * classes keyed on data-state, so Radix still unmounts on close without a Motion exit. Plain
 * module (no "use client") so server and client files can both import it.
 */

/** Blurred bg-0 scrim behind modal surfaces. */
export const overlayBackdrop =
  'fixed inset-0 z-50 bg-bg-0/70 backdrop-blur-sm data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-fast data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-slow';

/** Modal surface: bg-1, strong border, overlay shadow, 2px panel hairline painted on the top edge. */
export const modalSurface =
  'border border-border-strong bg-bg-1 bg-(image:--grad-hairline) bg-[length:100%_2px] bg-top bg-no-repeat text-fg-1 shadow-overlay outline-none';

/** Modal enter/exit timing; pair with the fade/zoom or slide classes of the component. */
export const modalMotion =
  'data-[state=open]:animate-in data-[state=open]:duration-slow data-[state=open]:ease-emphasized data-[state=closed]:animate-out data-[state=closed]:duration-fast data-[state=closed]:ease-exit';

/** Close button of Dialog and Sheet: 36px, a 44px hit area below lg, the global aura focus outline. */
export const overlayCloseButton =
  "absolute top-3 right-3 inline-flex size-9 items-center justify-center rounded-md text-fg-2 transition-colors duration-fast hover:bg-bg-3 hover:text-fg-1 disabled:pointer-events-none max-lg:before:absolute max-lg:before:-inset-1 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

/** Floating surface (menus, popovers): glass-ish bg-2 at 95% with a strong border, 220ms in. */
export const floatingSurface =
  'rounded-lg border border-border-strong bg-bg-2/95 text-fg-1 shadow-overlay backdrop-blur-md data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:duration-base data-[state=open]:ease-enter data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:duration-fast data-[state=closed]:ease-exit';

/** Menu and command rows: keyboard focus shows an inset aura outline (pointer focus does not). */
export const menuItem =
  "relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors duration-fast select-none focus-visible:-outline-offset-2 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";
