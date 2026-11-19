/** Absolute wall-clock countdown adapted from Creative Studio's expiry-countdown.tsx. */
export function AccountChallengeExpiry({
  expiresAt,
  remaining,
}: {
  expiresAt: number;
  remaining: number;
}) {
  const minutes = Math.floor(remaining / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (remaining % 60).toString().padStart(2, "0");
  const date = new Date(expiresAt);
  const dateTime = Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  return (
    <p className="text-sm text-muted-foreground">
      <time role="timer" aria-live="off" dateTime={dateTime} className="tabular-nums">
        {remaining > 0 ? `Expires in ${minutes}:${seconds}` : "Code expired"}
      </time>
      <span className="sr-only" role="status">
        {remaining === 0 ? "The sign-in code has expired." : ""}
      </span>
    </p>
  );
}
