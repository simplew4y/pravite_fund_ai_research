import type { HTMLAttributes, ReactNode } from "react";

/** Small uppercase technical label used for meta rows in the wireframes. */
export function MonoLabel({
  children,
  className,
  ...rest
}: { children: ReactNode } & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={["mono-label", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </span>
  );
}
