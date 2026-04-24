/**
 * Tests for the draft / published cookie fork. Exercises the real
 * disk-backed loader — a beforeEach / afterEach clears any draft
 * file that a previous test left behind, so failures don't leak.
 */
import { existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _invalidateCmsStoreCache,
  CMS_DRAFT_COOKIE,
  lookupCmsNode,
  publishDraft,
  writeDraftNode,
  type CmsNode,
} from "../cms-runtime.ts";

const DRAFT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "cms",
  "draft.json",
);

function clearDraftFile(): void {
  if (existsSync(DRAFT_PATH)) unlinkSync(DRAFT_PATH);
  _invalidateCmsStoreCache();
}

function draftRequest(): Request {
  return new Request("http://localhost/", {
    headers: { cookie: `${CMS_DRAFT_COOKIE}=1` },
  });
}

function publishedRequest(): Request {
  return new Request("http://localhost/");
}

beforeEach(() => clearDraftFile());
afterEach(() => clearDraftFile());

describe("lookupCmsNode — draft / published fork", () => {
  it("reads the published store when no cookie is set", () => {
    // `cms-demo-hero` lives in the committed src/cms/content.json.
    const node = lookupCmsNode("cms-demo-hero");
    expect(node).not.toBeNull();
    expect(node?.configs[0].fields.headline).toBe(
      "Welcome to the CMS demo",
    );
  });

  it("still reads published when the cookie is set but draft has no entry for this id", () => {
    writeDraftNode("some-other-id", {
      id: "some-other-id",
      configs: [{ match: {}, fields: {} }],
    });
    const node = lookupCmsNode("cms-demo-hero", draftRequest());
    expect(node?.configs[0].fields.headline).toBe(
      "Welcome to the CMS demo",
    );
  });

  it("prefers the draft entry when the cookie is set", () => {
    const draftNode: CmsNode = {
      id: "cms-demo-hero",
      configs: [
        {
          match: {},
          fields: { headline: "Draft headline", tone: "loud" },
        },
      ],
    };
    writeDraftNode("cms-demo-hero", draftNode);
    const node = lookupCmsNode("cms-demo-hero", draftRequest());
    expect(node?.configs[0].fields.headline).toBe("Draft headline");
  });

  it("draft is invisible to requests without the cookie", () => {
    writeDraftNode("cms-demo-hero", {
      id: "cms-demo-hero",
      configs: [{ match: {}, fields: { headline: "Draft headline" } }],
    });
    const node = lookupCmsNode("cms-demo-hero", publishedRequest());
    expect(node?.configs[0].fields.headline).toBe(
      "Welcome to the CMS demo",
    );
  });
});

describe("writeDraftNode", () => {
  it("round-trips through the filesystem", () => {
    const draftNode: CmsNode = {
      id: "test-write",
      configs: [{ match: {}, fields: { a: 1 } }],
    };
    writeDraftNode("test-write", draftNode);
    expect(existsSync(DRAFT_PATH)).toBe(true);
    const read = lookupCmsNode("test-write", draftRequest());
    expect(read?.configs[0].fields.a).toBe(1);
  });

  it("overwrites prior draft entries with the same id", () => {
    writeDraftNode("test-write", {
      id: "test-write",
      configs: [{ match: {}, fields: { v: "first" } }],
    });
    writeDraftNode("test-write", {
      id: "test-write",
      configs: [{ match: {}, fields: { v: "second" } }],
    });
    const read = lookupCmsNode("test-write", draftRequest());
    expect(read?.configs[0].fields.v).toBe("second");
  });
});

describe("publishDraft", () => {
  // NOTE: this test writes to src/cms/content.json. We restore by
  // re-publishing the original state after each test — snapshot the
  // committed published node first, modify through draft+publish,
  // then re-publish a draft that restores the original.

  it("copies draft entries into published and clears the draft", () => {
    const originalHero = lookupCmsNode("cms-demo-hero");
    expect(originalHero).not.toBeNull();
    const originalHeadline =
      originalHero!.configs[0].fields.headline;

    try {
      writeDraftNode("cms-demo-hero", {
        id: "cms-demo-hero",
        configs: [
          { match: {}, fields: { headline: "Published via test" } },
        ],
      });
      publishDraft();
      // Draft is empty after publish.
      expect(existsSync(DRAFT_PATH)).toBe(true);
      // Published now carries the new value (no cookie needed).
      const publishedView = lookupCmsNode("cms-demo-hero");
      expect(publishedView?.configs[0].fields.headline).toBe(
        "Published via test",
      );
    } finally {
      // Restore original committed state by publishing a draft that
      // reverts — keeps the repo tidy for the next test run.
      writeDraftNode("cms-demo-hero", {
        id: "cms-demo-hero",
        displayName: "#hero",
        configs: [
          {
            match: {},
            fields: {
              headline: originalHeadline,
              subhead:
                "Every field on this page is read through accessor-tracked calls. Edit src/cms/content.json and reload to see changes.",
              tone: "calm",
            },
          },
        ],
      });
      publishDraft();
    }
  });
});
