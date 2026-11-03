import { useRef } from 'react';

type Props = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
};

/** Half-width search input with an in-field clear × when non-empty. */
export function SearchClearInput({ value, onChange, placeholder = '搜索 tick', className }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className={`search-field${className ? ` ${className}` : ''}`}>
      <input
        ref={inputRef}
        className="search-input"
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value ? (
        <button
          type="button"
          className="search-clear"
          aria-label="清除"
          title="清除"
          onClick={() => {
            onChange('');
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}
