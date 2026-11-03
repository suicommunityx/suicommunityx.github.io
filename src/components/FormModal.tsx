import { useEffect, type ReactNode } from 'react';

type Props = {
  open: boolean;
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  busy?: boolean;
  onClose: () => void;
  wide?: boolean;
};

/** Polished sheet modal — Esc / backdrop closes when not busy. */
export function FormModal({
  open,
  title,
  subtitle,
  children,
  footer,
  busy,
  onClose,
  wide,
}: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, busy, onClose]);

  if (!open) return null;

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="form-modal-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className={`modal form-modal${wide ? ' form-modal-wide' : ''}`}>
        <div className="form-modal-head">
          <div className="form-modal-titles">
            <h3 id="form-modal-title">{title}</h3>
            {subtitle ? <p className="form-modal-sub">{subtitle}</p> : null}
          </div>
          <button
            type="button"
            className="wallet-modal-close"
            aria-label="关闭"
            disabled={busy}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="form-modal-body">{children}</div>
        {footer ? <div className="form-modal-footer">{footer}</div> : null}
      </div>
    </div>
  );
}
