"use client"

import React from "react"

export function GlobalErrorBoundary(props: { children?: React.ReactNode }) {
  return <ErrorBoundary errorComponent={DefaultGlobalErrorPage}>{props.children}</ErrorBoundary>
}

class ErrorBoundary extends React.Component<{
  children?: React.ReactNode
  errorComponent: React.FC<{ error: Error; reset: () => void }>
}> {
  state: { error?: Error } = {}

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  reset = () => {
    this.setState({ error: null })
  }

  render() {
    const error = this.state.error
    if (error) {
      return <this.props.errorComponent error={error} reset={this.reset} />
    }
    return this.props.children
  }
}

function DefaultGlobalErrorPage(props: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <head>
        <title>Error</title>
      </head>
      <body style={{ padding: "2rem", fontFamily: "system-ui" }}>
        <h1>Something went wrong</h1>
        <pre>{import.meta.env.DEV ? props.error.message : "(Unknown)"}</pre>
        <button type="button" onClick={() => React.startTransition(() => props.reset())}>
          Reset
        </button>
      </body>
    </html>
  )
}
