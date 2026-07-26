import { useTheme, type Theme } from "../contexts/ThemeContext";
import { useState, useRef, useEffect } from "react";

const THEMES: { key: Theme; label: string; colors: string[] }[] = [
  { key: "light", label: "Light", colors: ["#f3f4f7", "#2563eb", "#e3e6ec"] },
  { key: "dark", label: "Dark", colors: ["#0a0a0f", "#4d8fff", "#262632"] },
  { key: "flat", label: "Flat", colors: ["#f8f9fa", "#1a73e8", "#e8eaed"] },
  { key: "neon", label: "Neon", colors: ["#0a0a0a", "#00ff88", "#1a1a2e"] },
  { key: "material", label: "Material", colors: ["#fafafa", "#6200ee", "#e0e0e0"] },
  { key: "illustrated", label: "Illustrated", colors: ["#fff8f0", "#f59e0b", "#fde68a"] },
];

export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const current = THEMES.find((t) => t.key === theme) ?? THEMES[0];

  return (
    <div className="theme-switcher" ref={ref}>
      <button
        className="btn btn--ghost btn--sm theme-switcher__toggle"
        onClick={() => setOpen(!open)}
        title={`Theme: ${current.label}`}
      >
        <span className="theme-switcher__dots">
          {current.colors.map((c, i) => (
            <span key={i} className="theme-switcher__dot" style={{ background: c }} />
          ))}
        </span>
      </button>
      {open && (
        <div className="theme-switcher__menu">
          {THEMES.map((t) => (
            <button
              key={t.key}
              className={`theme-switcher__option${t.key === theme ? " theme-switcher__option--active" : ""}`}
              onClick={() => { setTheme(t.key); setOpen(false); }}
            >
              <span className="theme-switcher__dots">
                {t.colors.map((c, i) => (
                  <span key={i} className="theme-switcher__dot" style={{ background: c }} />
                ))}
              </span>
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
