import { expect, test, request as apiRequest } from "./fixtures.ts";

test.beforeEach(async ({ baseURL }) => {
  const ctx = await apiRequest.newContext({ baseURL });
  // Clear the draft file so each test gets a clean slate. Caches
  // reset too; Partial registry included.
  await ctx.get("/__test/clear-caches?all=1");
  await ctx.dispose();
});

test.describe("CMS editor — smoke", () => {
  test("tree lists every node in the store", async ({ page }) => {
    await page.goto("/cms-edit");
    await expect(
      page.getByTestId("cms-edit-tree-entry-cms-demo-hero"),
    ).toBeVisible();
    await expect(
      page.getByTestId("cms-edit-tree-entry-cms-demo-greeting"),
    ).toBeVisible();
    await expect(
      page.getByTestId("cms-edit-tree-entry-cms-demo-composed"),
    ).toBeVisible();
    await expect(
      page.getByTestId("cms-edit-tree-entry-composed-hero-1"),
    ).toBeVisible();
    await expect(
      page.getByTestId("cms-edit-tree-entry-composed-text-1"),
    ).toBeVisible();
    await expect(
      page.getByTestId("cms-edit-tree-entry-composed-hero-2"),
    ).toBeVisible();
  });

  test("field pane prompts when nothing is selected", async ({ page }) => {
    await page.goto("/cms-edit");
    await expect(page.getByTestId("cms-edit-field-pane")).toContainText(
      "Select a Partial",
    );
  });

  test("selecting a block-typed entry shows its fields from the catalog", async ({
    page,
  }) => {
    await page.goto("/cms-edit?select=composed-hero-1");
    await expect(
      page.getByTestId("cms-edit-selected-id"),
    ).toContainText("composed-hero-1");
    // Hero block registers headline / subhead / tone via accessor
    // reads; the catalog prerender captures them.
    await expect(
      page.getByTestId("cms-edit-field-input-headline"),
    ).toBeVisible();
    await expect(
      page.getByTestId("cms-edit-field-input-subhead"),
    ).toBeVisible();
    await expect(
      page.getByTestId("cms-edit-field-input-tone"),
    ).toBeVisible();
  });

  test("preview frame renders the demo content inside the editor", async ({
    page,
  }) => {
    await page.goto("/cms-edit");
    const preview = page.getByTestId("cms-edit-preview-pane");
    await expect(preview).toContainText("Welcome to the CMS demo");
  });

  test("tree entry shows block type badge for slot children", async ({
    page,
  }) => {
    await page.goto("/cms-edit");
    const heroEntry = page.getByTestId(
      "cms-edit-tree-entry-composed-hero-1",
    );
    await expect(heroEntry).toContainText("hero");
  });

  test("save writes to draft and the preview picks up the new value", async ({
    page,
  }) => {
    await page.goto("/cms-edit?select=composed-hero-1");

    const preview = page.getByTestId("cms-edit-preview-pane");
    // Baseline: published default content is visible in the preview.
    await expect(preview).toContainText("First hero in the body slot");

    await page
      .getByTestId("cms-edit-field-input-headline")
      .fill("Edited via the editor");
    await page.getByRole("button", { name: "Save to draft" }).click();

    // Preview refetches via invalidate directive and shows the draft.
    await expect(preview).toContainText("Edited via the editor");
    // Tree now marks the edited entry as draft-only? No — it was
    // already in published; the draft write just overrides. Badge
    // doesn't render because `draftOnly` is false in that case.
    // (Adding a separate badge for "has a draft overlay" is future
    // work.)
  });
});
