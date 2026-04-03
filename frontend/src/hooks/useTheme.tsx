import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react"
import type { ReactNode } from "react"

export type ThemePreference = "light" | "dark" | "system"
export type ResolvedTheme = "light" | "dark"

interface ThemeContextValue {
  readonly themePreference: ThemePreference
  readonly resolvedTheme: ResolvedTheme
  readonly setThemePreference: (next: ThemePreference) => void
}

const STORAGE_KEY = "ghost-bazaar-theme"

const ThemeContext = createContext<ThemeContextValue | null>(null)

function isThemePreference(value: string | null): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system"
}

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

function getInitialPreference(): ThemePreference {
  if (typeof window === "undefined") return "system"

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return isThemePreference(stored) ? stored : "system"
  } catch {
    return "system"
  }
}

export function applyResolvedTheme(theme: ResolvedTheme) {
  if (typeof document === "undefined") return
  const root = document.documentElement
  root.dataset.theme = theme
  root.style.colorScheme = theme
}

export function initializeTheme() {
  if (typeof window === "undefined") return
  const preference = getInitialPreference()
  const resolvedTheme = preference === "system" ? getSystemTheme() : preference
  applyResolvedTheme(resolvedTheme)
}

export function ThemeProvider({ children }: { readonly children: ReactNode }) {
  const [themePreference, setThemePreference] =
    useState<ThemePreference>(getInitialPreference)
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => {
    if (typeof window === "undefined") return "light"
    return getSystemTheme()
  })

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const handleChange = (event: MediaQueryListEvent) => {
      setSystemTheme(event.matches ? "dark" : "light")
    }
    media.addEventListener("change", handleChange)
    return () => media.removeEventListener("change", handleChange)
  }, [])

  const resolvedTheme = themePreference === "system" ? systemTheme : themePreference

  useEffect(() => {
    applyResolvedTheme(resolvedTheme)

    try {
      window.localStorage.setItem(STORAGE_KEY, themePreference)
    } catch {
      // Ignore storage failures and keep the current in-memory preference.
    }
  }, [resolvedTheme, themePreference])

  const value = useMemo<ThemeContextValue>(
    () => ({
      themePreference,
      resolvedTheme,
      setThemePreference,
    }),
    [resolvedTheme, themePreference],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider")
  }
  return context
}
