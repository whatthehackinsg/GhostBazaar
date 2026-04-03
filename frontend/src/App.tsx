import { useMousePosition } from "./hooks/useMousePosition"
import { useHash } from "./hooks/useHash"
import { CustomCursor } from "./components/CustomCursor"
import { ThemeToggle } from "./components/ThemeToggle"
import { WalletBar } from "./components/WalletBar"
import { WalletProvider } from "./context/WalletContext"
import { LandingPage } from "./pages/LandingPage"
import { DashboardPage } from "./pages/DashboardPage"
import { AdminPage } from "./pages/AdminPage"

/**
 * Root app — hash-based routing.
 * CustomCursor lives here so it persists across page switches.
 *
 * Routes:
 *   /              Landing page (public)
 *   #/dashboard    Live dashboard (public)
 *   #/admin        Admin panel (hidden, no public links)
 */
export function App() {
  return (
    <WalletProvider>
      <AppShell />
    </WalletProvider>
  )
}

function AppShell() {
  const mouse = useMousePosition()
  const hash = useHash()

  const page = hash === "#/dashboard" ? "dashboard"
    : hash === "#/admin" ? "admin"
    : "landing"

  const navigate = (h: string) => {
    location.hash = h
    window.scrollTo(0, 0)
  }

  const renderPage = () => {
    switch (page) {
      case "dashboard":
        return <DashboardPage onBack={() => navigate("")} />
      case "admin":
        return <AdminPage onBack={() => navigate("")} />
      default:
        return <LandingPage mouse={mouse} onNavigate={navigate} />
    }
  }

  return (
    <>
      <WalletBar />
      <CustomCursor mouse={mouse} />
      <ThemeToggle />
      {renderPage()}
    </>
  )
}
