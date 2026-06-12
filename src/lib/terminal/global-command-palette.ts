import type { CommandPaletteAction } from "@/components/terminal/CommandPalette";

export interface GlobalCommandPaletteSource {
  id: string;
  tabs?: Array<{ id: string; sessionName: string }>;
  onSelectTab?: (tabId: string) => void;
  onCreateSession?: () => void;
  actions?: CommandPaletteAction[];
  searchValue?: string;
  onSearchValueChange?: (value: string) => void;
  searchPlaceholder?: string;
  emptyText?: string;
  groupHeading?: string;
}

type Listener = () => void;

const sources = new Map<string, GlobalCommandPaletteSource>();
const listeners = new Set<Listener>();

function notifyListeners() {
  for (const listener of listeners) {
    listener();
  }
}

export function registerGlobalCommandPaletteSource(source: GlobalCommandPaletteSource): () => void {
  sources.set(source.id, source);
  notifyListeners();

  return () => {
    const current = sources.get(source.id);
    if (current === source) {
      sources.delete(source.id);
      notifyListeners();
    }
  };
}

export function subscribeGlobalCommandPaletteSources(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getGlobalCommandPaletteSources(): GlobalCommandPaletteSource[] {
  return [...sources.values()];
}
