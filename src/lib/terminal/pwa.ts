import * as React from "react";

export function isPwaStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(display-mode: standalone)").matches;
}

export function usePwaStandalone() {
  const [isStandalone, setIsStandalone] = React.useState<boolean | undefined>(
    undefined,
  );

  React.useEffect(() => {
    const mql = window.matchMedia("(display-mode: standalone)");
    const onChange = () => {
      setIsStandalone(mql.matches);
    };
    mql.addEventListener("change", onChange);
    setIsStandalone(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return !!isStandalone;
}
