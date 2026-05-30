import type * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const listCardTextClassName = "text-sm leading-6";
const listCardMetaClassName = "text-xs leading-5 text-muted-foreground";
const listCardActionClassName =
  "inline-flex min-h-11 touch-manipulation items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 text-sm font-medium transition-colors outline-none hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

type ListCardActionProps<TElement extends React.ElementType = "button"> = {
  as?: TElement;
} & Omit<React.ComponentPropsWithoutRef<TElement>, "as">;

function CardStack({ className, role = "list", ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-list-card-slot="stack"
      role={role}
      className={cn(className, "grid gap-3 px-0 pb-4 pb-safe text-sm md:hidden")}
      {...props}
    />
  );
}

function ListCard({ className, role = "listitem", ...props }: React.ComponentProps<"div">) {
  return (
    <Card
      data-list-card-slot="card"
      role={role}
      size="sm"
      className={cn(className, listCardTextClassName)}
      {...props}
    />
  );
}

function ListCardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <CardHeader data-list-card-slot="header" className={cn(className, "gap-2 px-4")} {...props} />
  );
}

function ListCardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <CardTitle
      data-list-card-slot="title"
      className={cn(className, "text-base leading-snug font-semibold")}
      {...props}
    />
  );
}

function ListCardMeta({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-list-card-slot="meta"
      className={cn(className, "flex flex-wrap items-center gap-1.5", listCardMetaClassName)}
      {...props}
    />
  );
}

function ListCardMetaBadge({
  className,
  variant = "secondary",
  ...props
}: React.ComponentProps<typeof Badge>) {
  return (
    <Badge
      data-list-card-slot="meta-badge"
      variant={variant}
      className={cn(className, "min-h-5 text-xs")}
      {...props}
    />
  );
}

function ListCardRows({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <CardContent
      data-list-card-slot="rows"
      className={cn(className, "grid gap-3 px-4", listCardTextClassName)}
      {...props}
    />
  );
}

type ListCardRowProps = React.ComponentProps<"div"> & {
  label?: React.ReactNode;
};

function ListCardRow({ className, label, children, ...props }: ListCardRowProps) {
  return (
    <div
      data-list-card-slot="row"
      className={cn(className, "grid gap-1", listCardTextClassName)}
      {...props}
    >
      {label ? (
        <div data-list-card-slot="row-label" className={listCardMetaClassName}>
          {label}
        </div>
      ) : null}
      <div data-list-card-slot="row-value" className="text-sm leading-6 text-card-foreground">
        {children}
      </div>
    </div>
  );
}

function ListCardActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <CardFooter
      data-list-card-slot="actions"
      className={cn(className, "flex flex-wrap items-center gap-2 p-3")}
      {...props}
    />
  );
}

function ListCardAction<TElement extends React.ElementType = "button">({
  as,
  className,
  ...props
}: ListCardActionProps<TElement>) {
  const Component = as ?? "button";

  return (
    <Component
      data-list-card-slot="action"
      className={cn(className, listCardActionClassName)}
      {...props}
    />
  );
}

export {
  CardStack,
  ListCard,
  ListCardAction,
  ListCardActions,
  ListCardHeader,
  ListCardMeta,
  ListCardMetaBadge,
  ListCardRow,
  ListCardRows,
  ListCardTitle,
  listCardActionClassName,
};
