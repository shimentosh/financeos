import * as React from "react";

// Matches the `md` breakpoint the layouts branch on, so a component asking the
// hook and a sibling using `md:` classes never disagree about which one is in
// effect.
const MOBILE_BREAKPOINT = 768;
const TABLET_BREAKPOINT = 1024;

function useMediaQuery(query: string) {
  // `undefined` until the first effect, so nothing branches on a guessed value
  // during the server-less first paint; callers read it as false.
  const [matches, setMatches] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent | MediaQueryList) => {
      setMatches(event.matches);
    };
    mql.addEventListener("change", onChange);
    onChange(mql);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return !!matches;
}

export function useIsMobile() {
  return useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
}

// Between `md` and `lg`: wide enough for two panes, too narrow for the task
// page's three.
export function useIsTablet() {
  return useMediaQuery(`(min-width: ${MOBILE_BREAKPOINT}px) and (max-width: ${TABLET_BREAKPOINT - 1}px)`);
}

// Everything at or below `lg`, which is where the task page collapses its
// properties rail and the board loses room for more than one column.
export function useIsCompact() {
  return useMediaQuery(`(max-width: ${TABLET_BREAKPOINT - 1}px)`);
}

// A finger rather than a mouse. Not the same question as "is the window
// narrow": a tablet in landscape is wide and still has no hover, and a narrow
// desktop window has hover. Anything that depends on a control being
// *reachable* -- a hover-only reveal, a drag handle, a tooltip -- asks this;
// anything about how much room there is asks useIsMobile.
export function useIsTouch() {
  return useMediaQuery("(hover: none) and (pointer: coarse)");
}

export function useIsLandscape() {
  return useMediaQuery("(orientation: landscape)");
}

export function usePrefersReducedMotion() {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}

export { MOBILE_BREAKPOINT, TABLET_BREAKPOINT, useMediaQuery };
