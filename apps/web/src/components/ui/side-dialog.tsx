/**
 * The dialog API, opening from the right instead of the middle.
 *
 * A form or a set of details is something you work through while the page it
 * belongs to stays visible behind it; a panel at the edge keeps that context,
 * where a box in the middle covers it. Confirmations are the exception and
 * still use `dialog`: "delete this?" is a stop sign, and a stop sign belongs
 * in the way.
 *
 * The names match `@/components/ui/dialog` exactly, so moving a dialog to the
 * side is a one-line change to its import and nothing else.
 */
export {
  Sheet as Dialog,
  SheetBackdrop as DialogBackdrop,
  SheetBackdrop as DialogOverlay,
  SheetClose as DialogClose,
  SheetContent as DialogContent,
  SheetDescription as DialogDescription,
  SheetFooter as DialogFooter,
  SheetHeader as DialogHeader,
  SheetPanel as DialogPanel,
  SheetPopup as DialogPopup,
  SheetPortal as DialogPortal,
  SheetTitle as DialogTitle,
  SheetTrigger as DialogTrigger,
} from "@/components/ui/sheet";
