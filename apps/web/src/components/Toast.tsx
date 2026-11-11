import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { cn } from "../lib/utils";

type ToastKind = "success" | "error" | "info";

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastContextValue {
  toast: (message: string, kind?: ToastKind) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);
let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const remove = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, kind: ToastKind = "info") => {
      const id = nextId++;
      setItems((current) => [...current.slice(-3), { id, kind, message }]);
      window.setTimeout(() => remove(id), 4500);
    },
    [remove],
  );

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[100] flex flex-col items-center gap-2 px-4 sm:bottom-8 sm:items-end">
        {items.map((item) => (
          <div
            key={item.id}
            className={cn(
              "pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-2xl backdrop-blur-xl animate-vault-rise",
              item.kind === "error" && "border-red-500/25 bg-red-950/80 text-red-100",
              item.kind === "success" && "border-emerald-500/25 bg-emerald-950/80 text-emerald-100",
              item.kind === "info" && "border-white/10 bg-ink-800/90 text-ink-100",
            )}
          >
            {item.kind === "success" ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-400" />
            ) : item.kind === "error" ? (
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-red-400" />
            ) : (
              <Info className="mt-0.5 size-4 shrink-0 text-aqua-400" />
            )}
            <span className="flex-1 leading-relaxed">{item.message}</span>
            <button
              onClick={() => remove(item.id)}
              className="rounded p-0.5 text-white/40 transition hover:text-white"
              aria-label="关闭提示"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside ToastProvider");
  return context;
}
