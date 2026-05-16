"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Icon } from "./icon.tsx"

/**
 * BlockPicker dropdown for the editor's slot `+ Add block` row.
 *
 * The surrounding chrome is client-rendered, so the popover uses
 * plain React state — no portal library, search + keyboard nav land
 * directly in the dropdown.
 *
 * Each menu item is a `<form>` whose action is a bound server action
 * — the bind goes through RSC's serialization layer unchanged so the
 * submit fires the right `addBlockToSlot(parent, slot, type)`.
 */

interface AddBlockOption {
  type: string
  /** Friendly name (falls back to `type`). */
  displayName?: string
  /** Labels from the spec catalog — used to bucket into Layout/Content/Commerce. */
  labels?: ReadonlyArray<string>
  action: () => Promise<unknown>
}

/**
 * Bucket a block type into the three palette categories using label
 * heuristics. Anything that doesn't match falls into "Blocks".
 */
function bucketFor(opt: AddBlockOption): string {
  const t = opt.type
  const labels = opt.labels ?? []
  const has = (frag: string) => labels.some((x) => x.includes(frag))
  if (has("group") || has("section") || has("layout") || /^group$/.test(t)) return "Layout"
  if (
    has("commerce") ||
    has("product") ||
    has("cart") ||
    /product|cart|collection/.test(t)
  )
    return "Commerce"
  if (has("page-block") || has("content") || /text|hero|heading|image|button|rich/.test(t))
    return "Content"
  return "Blocks"
}

export function CmsEditAddBlock({
  parentCmsId,
  slotName,
  options,
}: {
  parentCmsId: string
  slotName: string
  options: ReadonlyArray<AddBlockOption>
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")
  const [activeIdx, setActiveIdx] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [open])

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return options
    return options.filter((o) => {
      const haystack = `${o.type} ${o.displayName ?? ""}`.toLowerCase()
      return haystack.includes(needle)
    })
  }, [q, options])

  // Bucket filtered options into Layout / Content / Commerce / Blocks
  // sections.
  const sections = useMemo(() => {
    const order = ["Layout", "Content", "Commerce", "Blocks"]
    const buckets: Record<string, AddBlockOption[]> = {}
    for (const opt of filtered) {
      const b = bucketFor(opt)
      ;(buckets[b] ??= []).push(opt)
    }
    return order
      .filter((name) => buckets[name]?.length)
      .map((name) => ({ label: name, items: buckets[name] }))
  }, [filtered])

  if (options.length === 0) return null

  function commit(option: AddBlockOption) {
    setOpen(false)
    setQ("")
    void option.action()
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false)
      return
    }
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActiveIdx((i) => Math.min(i + 1, filtered.length - 1))
      return
    }
    if (e.key === "ArrowUp") {
      e.preventDefault()
      setActiveIdx((i) => Math.max(i - 1, 0))
      return
    }
    if (e.key === "Enter") {
      const opt = filtered[activeIdx]
      if (opt) {
        e.preventDefault()
        commit(opt)
      }
    }
  }

  return (
    <div ref={ref} style={{ position: "relative", flex: 1 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="cms-tree-add-row"
        style={{ width: "100%", border: 0, background: "transparent", textAlign: "left", cursor: "pointer" }}
        data-testid={`cms-edit-slot-add-trigger-${parentCmsId}-${slotName}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span style={{ width: 14 }} />
        <Icon name="plus" size={12} strokeWidth={2.2} />
        <span>Add block</span>
      </button>
      {open && (
        <div className="cms-blockpicker" role="menu">
          <div className="cms-blockpicker-search">
            <Icon name="search" size={13} />
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => {
                setQ(e.target.value)
                setActiveIdx(0)
              }}
              onKeyDown={onKeyDown}
              placeholder="Find a block…"
              style={{
                flex: 1,
                border: 0,
                outline: "none",
                background: "transparent",
                fontSize: 13,
                color: "var(--cms-ink)",
              }}
            />
            <span
              style={{
                fontSize: 11,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                color: "var(--cms-ink-3)",
                padding: "1px 5px",
                border: "1px solid rgba(0,0,0,0.10)",
                borderRadius: 3,
              }}
            >
              ⌘K
            </span>
          </div>
          <div className="cms-blockpicker-list">
            {(() => {
              let flatIdx = 0
              return sections.map((sec) => {
                if (sec.items.length === 0) return null
                return (
                  <div key={sec.label}>
                    <div className="cms-blockpicker-section">{sec.label}</div>
                    {sec.items.map((opt) => {
                      const myIdx = flatIdx++
                      return (
                        <form
                          key={opt.type}
                          action={opt.action as unknown as (formData: FormData) => void}
                          className="contents"
                        >
                          <button
                            type="submit"
                            onMouseEnter={() => setActiveIdx(myIdx)}
                            className="cms-blockpicker-item"
                            data-active={myIdx === activeIdx || undefined}
                            data-testid={`cms-edit-slot-add-${parentCmsId}-${slotName}-${opt.type}`}
                            role="menuitem"
                          >
                            <span className="cms-blockpicker-item-icon">
                              <Icon name={iconForType(opt.type)} size={14} />
                            </span>
                            <span className="cms-blockpicker-item-text">
                              <span className="name">
                                {opt.displayName ?? opt.type}
                              </span>
                              <span className="desc">{describeType(opt.type)}</span>
                            </span>
                          </button>
                        </form>
                      )
                    })}
                  </div>
                )
              })
            })()}
            {filtered.length === 0 && (
              <div style={{ padding: 12, fontSize: 12, color: "var(--cms-ink-3)" }}>
                No blocks match.
              </div>
            )}
          </div>
          <div className="cms-blockpicker-footer">
            <span>↑↓ navigate</span>
            <span>·</span>
            <span>↵ insert</span>
            <span>·</span>
            <span>esc close</span>
          </div>
        </div>
      )}
    </div>
  )
}

function describeType(type: string): string {
  // Best-effort short summary derived from the type name. The catalog
  // doesn't carry a description field yet — when it does, descriptions
  // should come from there.
  if (/hero|banner/.test(type)) return "Headline + media"
  if (/^group$/.test(type)) return "Flexible layout container"
  if (/^section$/.test(type)) return "Full-width container"
  if (/grid|cols|column/.test(type)) return "2–6 columns"
  if (/heading|title/.test(type)) return "H1–H6 text"
  if (/rich-?text/.test(type)) return "Rich text block"
  if (/^text$/.test(type)) return "Plain text"
  if (/image|media/.test(type)) return "Single image with caption"
  if (/button|cta/.test(type)) return "Call to action"
  if (/quote/.test(type)) return "Pull-quote"
  if (/cart/.test(type)) return "Cart drawer"
  if (/product/.test(type)) return "Single product"
  if (/page-(root|composed)/.test(type)) return "Page wrapper"
  if (/page-(greeting|hero|slug|multi)/.test(type)) return "Page template"
  if (/nav-?(link|root)/.test(type)) return "Navigation"
  return "Block"
}

function iconForType(type: string): string {
  if (/hero|banner|page-hero/.test(type)) return "star"
  if (/nav|link|menu/.test(type)) return "nav"
  if (/text|rich/.test(type)) return "text"
  if (/heading|title/.test(type)) return "heading"
  if (/image|media/.test(type)) return "image"
  if (/button|cta/.test(type)) return "button"
  if (/grid|cols|column/.test(type)) return "cols"
  if (/page|root/.test(type)) return "page"
  if (/cart|product/.test(type)) return "cart"
  if (/group|section/.test(type)) return "section"
  return "block"
}
