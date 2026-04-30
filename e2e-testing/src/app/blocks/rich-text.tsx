import { ReactCms, type RenderArgs } from "@react-cms/framework"

export const RichTextBlock = ReactCms.partial(
  function RichTextRender({ body }: { body: string } & RenderArgs) {
    return (
      <div
        className="mb-3 rounded-lg border bg-card p-5 text-sm leading-relaxed"
        data-testid="composed-rich-text"
      >
        {body || <span className="text-muted-foreground italic">Empty rich-text block</span>}
      </div>
    )
  },
  {
    type: "rich-text",
    tags: [".demo-block", ".composed-rich-text"],
    vary: ({ cms }) => ({ body: cms.richText("body") }),
  },
)
