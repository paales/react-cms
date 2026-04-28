/**
 * Demo rich-text block — renders a body string as a paragraph.
 * `getRichText` is a plain string in chunk 2a; the structured-value
 * variant comes with the editor.
 */
import { getRichText } from "../../framework/context.ts"

export function RichTextBlock() {
  const body = getRichText("body")
  return (
    <div
      className="mb-3 rounded-lg border bg-card p-5 text-sm leading-relaxed"
      data-testid="composed-rich-text"
    >
      {body || <span className="text-muted-foreground italic">Empty rich-text block</span>}
    </div>
  )
}
