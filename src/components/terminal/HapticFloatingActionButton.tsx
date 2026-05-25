"use client";

import { triggerHapticFeedback } from "@/lib/device/haptics";
import { FloatingActionButton } from "@/components/terminal/FloatingActionButton";

export function HapticFloatingActionButton() {
  return <FloatingActionButton onHapticFeedback={triggerHapticFeedback} />;
}
