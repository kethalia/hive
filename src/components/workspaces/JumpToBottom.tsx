"use client";

import { Button } from "@/components/ui/button";
import { ArrowDown } from "lucide-react";

interface JumpToBottomProps {
  visible: boolean;
  onClick: () => void;
}

export function JumpToBottom({ visible, onClick }: JumpToBottomProps) {
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={onClick}
      className={`absolute bottom-4 right-4 z-10 gap-1 shadow-lg transition-opacity duration-200 ${
        visible ? "opacity-100" : "pointer-events-none opacity-0"
      }`}
      aria-label="Jump to bottom"
    >
      <ArrowDown className="h-4 w-4" />
      Jump to bottom
    </Button>
  );
}
