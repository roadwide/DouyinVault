import {
  forwardRef,
  useEffect,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { Loader2, X, type LucideIcon } from "lucide-react";
import { cn } from "../lib/utils";

type ButtonVariant = "primary" | "secondary" | "ghost" | "outline" | "danger";
type ButtonSize = "sm" | "md" | "lg" | "icon";

const buttonVariants: Record<ButtonVariant, string> = {
  primary:
    "bg-brand-500 text-white shadow-[0_8px_24px_-10px_rgba(254,44,85,0.7)] hover:bg-brand-400 active:bg-brand-600",
  secondary: "bg-white/[0.07] text-ink-100 hover:bg-white/[0.11] border border-white/[0.06]",
  ghost: "text-ink-300 hover:bg-white/[0.06] hover:text-ink-100",
  outline: "border border-white/[0.12] text-ink-200 hover:border-white/25 hover:bg-white/[0.04]",
  danger: "bg-red-600/90 text-white hover:bg-red-500",
};

const buttonSizes: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs gap-1.5 rounded-lg",
  md: "h-10 px-4 text-sm gap-2 rounded-xl",
  lg: "h-12 px-6 text-sm gap-2 rounded-xl",
  icon: "size-9 rounded-lg",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: LucideIcon;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "secondary", size = "md", loading, icon: Icon, children, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "inline-flex select-none items-center justify-center font-medium transition duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:pointer-events-none disabled:opacity-50",
        buttonVariants[variant],
        buttonSizes[size],
        className,
      )}
      {...props}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : Icon ? <Icon className="size-4" /> : null}
      {children}
    </button>
  );
});

export function Card({
  className,
  children,
  hover = false,
}: {
  className?: string;
  children: ReactNode;
  hover?: boolean;
}) {
  return <div className={cn("panel", hover && "panel-hover", className)}>{children}</div>;
}

type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info" | "brand" | "muted";

const badgeTones: Record<BadgeTone, string> = {
  neutral: "border-white/10 bg-white/[0.05] text-ink-300",
  success: "border-emerald-500/20 bg-emerald-500/10 text-emerald-300",
  warning: "border-amber-500/20 bg-amber-500/10 text-amber-300",
  danger: "border-red-500/20 bg-red-500/10 text-red-300",
  info: "border-sky-500/20 bg-sky-500/10 text-sky-300",
  brand: "border-brand-500/25 bg-brand-500/10 text-brand-400",
  muted: "border-white/[0.06] bg-white/[0.03] text-ink-400",
};

export function Badge({
  children,
  tone = "neutral",
  className,
  dot = false,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
  dot?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-5",
        badgeTones[tone],
        className,
      )}
    >
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        "h-10 w-full rounded-xl border border-white/[0.09] bg-ink-925/80 px-3.5 text-sm text-ink-100 placeholder:text-ink-500 transition focus:border-brand-500/50 focus:bg-ink-900",
        className,
      )}
      {...props}
    />
  );
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...props }, ref) {
    return (
      <select
        ref={ref}
        className={cn(
          "h-10 appearance-none rounded-xl border border-white/[0.09] bg-ink-925/80 px-3.5 pr-9 text-sm text-ink-100 transition focus:border-brand-500/50",
          "bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20fill%3D%22none%22%20stroke%3D%22%239d9da7%22%20stroke-width%3D%221.5%22%3E%3Cpath%20d%3D%22m4%206%204%204%204-4%22%2F%3E%3C%2Fsvg%3E')] bg-[position:right_0.75rem_center] bg-no-repeat",
          className,
        )}
        {...props}
      >
        {children}
      </select>
    );
  },
);

export function Textarea({
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "w-full rounded-xl border border-white/[0.09] bg-ink-925/80 px-3.5 py-2.5 text-sm text-ink-100 placeholder:text-ink-500 transition focus:border-brand-500/50",
        className,
      )}
      {...props}
    />
  );
}

export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label ?? (checked ? "已启用" : "已停用")}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onChange(!checked);
      }}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition duration-200",
        checked
          ? "border-brand-500/50 bg-brand-500/90 shadow-[0_0_18px_-6px_rgba(254,44,85,0.9)]"
          : "border-white/10 bg-ink-700",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <span
        className={cn(
          "inline-block size-4 rounded-full bg-white shadow transition duration-200",
          checked ? "translate-x-[22px]" : "translate-x-[3px]",
        )}
      />
    </button>
  );
}

export function Progress({
  value,
  tone = "brand",
  className,
}: {
  value: number;
  tone?: "brand" | "success" | "warning" | "muted";
  className?: string;
}) {
  const width = Math.max(0, Math.min(100, value));
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-white/[0.07]", className)}>
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-500",
          tone === "brand" && "bg-gradient-to-r from-brand-600 to-brand-400",
          tone === "success" && "bg-emerald-400",
          tone === "warning" && "bg-amber-400",
          tone === "muted" && "bg-ink-500",
        )}
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("size-5 animate-spin text-ink-400", className)} />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton rounded-xl", className)} />;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-16 text-center", className)}>
      <div className="mb-4 flex size-12 items-center justify-center rounded-2xl border border-white/[0.07] bg-white/[0.03]">
        <Icon className="size-5 text-ink-400" />
      </div>
      <h3 className="text-sm font-semibold text-ink-100">{title}</h3>
      {description && <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-ink-400">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = original;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-end justify-center p-0 sm:items-center sm:p-6">
      <button
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
        aria-label="关闭对话框"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "relative z-10 w-full rounded-t-3xl border border-white/[0.09] bg-ink-900 shadow-2xl animate-vault-rise sm:rounded-2xl",
          size === "sm" && "sm:max-w-sm",
          size === "md" && "sm:max-w-lg",
          size === "lg" && "sm:max-w-2xl",
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-white/[0.06] px-5 py-4 sm:px-6">
          <div>
            <h2 className="text-base font-semibold tracking-tight text-ink-50">{title}</h2>
            {description && <p className="mt-1 text-xs leading-relaxed text-ink-400">{description}</p>}
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-ink-500 transition hover:bg-white/[0.06] hover:text-ink-200"
            aria-label="关闭"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="max-h-[70dvh] overflow-y-auto px-5 py-5 sm:px-6">{children}</div>
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-white/[0.06] px-5 py-4 sm:px-6">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink-50 sm:text-[28px]">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-ink-400">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function AlertBanner({
  tone = "warning",
  title,
  children,
  action,
}: {
  tone?: "info" | "warning" | "danger" | "success";
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl border px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between",
        tone === "warning" && "border-amber-500/20 bg-amber-500/[0.07] text-amber-100",
        tone === "danger" && "border-red-500/20 bg-red-500/[0.07] text-red-100",
        tone === "info" && "border-sky-500/20 bg-sky-500/[0.06] text-sky-100",
        tone === "success" && "border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-100",
      )}
    >
      <div>
        <p className="font-medium">{title}</p>
        {children && <div className="mt-0.5 text-xs leading-relaxed opacity-80">{children}</div>}
      </div>
      {action}
    </div>
  );
}
