import { Component } from "react"
import type { ReactNode, ErrorInfo } from "react"

interface Props {
  readonly children: ReactNode
}

interface State {
  readonly hasError: boolean
}

/**
 * Catches React render errors and shows a recovery UI
 * instead of a white screen.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ErrorBoundary caught:", error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "100vh",
            fontFamily: "var(--font-mono)",
            fontSize: "0.8rem",
            color: "var(--secondary-color)",
            flexDirection: "column",
            gap: 16,
          }}
        >
          <div style={{ fontSize: "1.2rem", color: "var(--text-color)" }}>
            Something went wrong.
          </div>
          <button
            onClick={() => {
              this.setState({ hasError: false })
              location.hash = ""
              location.reload()
            }}
            style={{
              padding: "8px 20px",
              border: "1px solid var(--hairline)",
              borderRadius: 4,
              background: "transparent",
              fontFamily: "var(--font-mono)",
              fontSize: "0.75rem",
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
