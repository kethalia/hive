import { cn } from "@/lib/utils";

export function HiveMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "grid size-9 shrink-0 place-items-center border border-primary/40 bg-primary/10 font-mono text-sm text-primary",
        className,
      )}
      aria-hidden="true"
    >
      H_
    </span>
  );
}

export function HiveLogo({
  className,
  wordmarkClassName,
}: {
  className?: string;
  wordmarkClassName?: string;
}) {
  return (
    <span className={cn("flex items-center gap-3", className)}>
      <HiveMark />
      <span className={cn("font-medium tracking-[0.18em]", wordmarkClassName)}>HIVE</span>
    </span>
  );
}
