import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export type Theme = "light" | "dark" | "glass" | "material" | "illustrated";

const THEME_CLASS: Record<Theme, string> = {
  light: "",
  dark: "dark-theme",
  glass: "glass-theme",
  material: "material-theme",
  illustrated: "illustrated-theme",
};

const STORAGE_KEY = "dockyard-theme";

function resolveTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && stored in THEME_CLASS) return stored as Theme;
  } catch { /* localStorage unavailable */ }
  if (window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
  return "light";
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  for (const cls of Object.values(THEME_CLASS)) {
    if (cls) root.classList.remove(cls);
  }
  const cls = THEME_CLASS[theme];
  if (cls) root.classList.add(cls);
}

interface ThemeContextValue {
  theme: Theme;
  setTheme: (t: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "light",
  setTheme: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(resolveTheme);

  useEffect(() => {
    applyTheme(theme);
    try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* ok */ }
  }, [theme]);

  const setTheme = useCallback((t: Theme) => setThemeState(t), []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
