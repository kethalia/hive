import { createContext, useContext } from "react";

export const DockVerticalContext = createContext(false);
const horizontal = {
  vertical: false,
  size: "width",
  start: "left",
  end: "right",
  scroll: "scrollLeft",
  client: "clientWidth",
  total: "scrollWidth",
  scrollTo: "left",
  translate: "translateX",
} as const;
const vertical = {
  vertical: true,
  size: "height",
  start: "top",
  end: "bottom",
  scroll: "scrollTop",
  client: "clientHeight",
  total: "scrollHeight",
  scrollTo: "top",
  translate: "translateY",
} as const;
export function useDockAxis() {
  return useContext(DockVerticalContext) ? vertical : horizontal;
}
