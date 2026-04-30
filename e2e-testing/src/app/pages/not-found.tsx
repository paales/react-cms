import { Card, CardContent } from "@react-cms/copies/components/ui/card"

/**
 * Default 404 page. Rendered by `Root` when a page component throws
 * `notFound()`. Authors can replace this with their own component by
 * intercepting the render path in `Root`.
 */
export function NotFoundPage() {
  return (
    <main data-testid="not-found">
      <title>404 — Not Found</title>
      <Card className="mt-4 p-8 text-center">
        <CardContent className="flex flex-col gap-2">
          <h1 className="text-4xl font-semibold">404</h1>
          <div className="text-sm text-muted-foreground">
            This URL doesn't match any known route.
          </div>
        </CardContent>
      </Card>
    </main>
  )
}
