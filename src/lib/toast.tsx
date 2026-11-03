import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type ToastKind = 'error' | 'success' | 'info';

export type ToastItem = {
  id: string;
  message: string;
  kind: ToastKind;
};

type ToastApi = {
  push: (message: string, kind?: ToastKind) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
  dismiss: (id: string) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

const DURATION_MS = 5000;

function newId() {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((message: string, kind: ToastKind = 'info') => {
    const text = String(message || '').trim();
    if (!text) return;
    const id = newId();
    setItems((prev) => [...prev, { id, message: text, kind }]);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      push,
      success: (m) => push(m, 'success'),
      error: (m) => push(m, 'error'),
      info: (m) => push(m, 'info'),
      dismiss,
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport items={items} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return ctx;
}

/** Safe optional toast (for modules that may render outside provider in tests). */
export function useToastOptional(): ToastApi | null {
  return useContext(ToastContext);
}

function ToastViewport({
  items,
  onDismiss,
}: {
  items: ToastItem[];
  onDismiss: (id: string) => void;
}) {
  return (
    <div className="toast-viewport" aria-live="polite" aria-relevant="additions">
      {items.map((t) => (
        <ToastCard key={t.id} item={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastCard({
  item,
  onDismiss,
}: {
  item: ToastItem;
  onDismiss: (id: string) => void;
}) {
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState(1); // 1 → 0
  const remainingRef = useRef(DURATION_MS);
  const lastTsRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const tick = (ts: number) => {
      if (lastTsRef.current == null) lastTsRef.current = ts;
      if (!paused) {
        const delta = ts - lastTsRef.current;
        remainingRef.current = Math.max(0, remainingRef.current - delta);
        setProgress(remainingRef.current / DURATION_MS);
        if (remainingRef.current <= 0) {
          onDismiss(item.id);
          return;
        }
      }
      lastTsRef.current = ts;
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [paused, item.id, onDismiss]);

  const pause = () => setPaused(true);
  const resume = () => {
    lastTsRef.current = null;
    setPaused(false);
  };

  return (
    <div
      className={`toast toast-${item.kind}`}
      role="status"
      onMouseEnter={pause}
      onMouseLeave={resume}
      onTouchStart={pause}
      onTouchEnd={resume}
      onTouchCancel={resume}
    >
      <div className="toast-body">
        <div className="toast-text">{item.message}</div>
        <button
          type="button"
          className="toast-close"
          aria-label="关闭"
          onClick={() => onDismiss(item.id)}
        >
          ×
        </button>
      </div>
      <div className="toast-progress" aria-hidden>
        <div className="toast-progress-bar" style={{ transform: `scaleX(${progress})` }} />
      </div>
    </div>
  );
}
