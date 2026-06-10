import { Component, type ReactNode } from 'react'

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="crash">
          <h2>Something broke in the UI</h2>
          <pre>{this.state.error.stack ?? String(this.state.error)}</pre>
          <p>Your Claude sessions are still running — reload to re-attach.</p>
          <button className="btn primary" onClick={() => window.location.reload()}>
            Reload UI
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
