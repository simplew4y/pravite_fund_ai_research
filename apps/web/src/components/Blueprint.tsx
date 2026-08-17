import type { HTMLAttributes, ReactNode } from "react";

/** Industry DS blueprint frame: square corners + the four "+" registration marks. */
export function Blueprint({
  children,
  className,
  ...rest
}: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={["blueprint", className].filter(Boolean).join(" ")} {...rest}>
      <i className="corner tl" />
      <i className="corner tr" />
      <i className="corner bl" />
      <i className="corner br" />
      {children}
    </div>
  );
}
