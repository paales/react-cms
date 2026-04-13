"use client";

export function CartBadge({ quantity = 0 }: { quantity?: number | string }) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.5rem",
        padding: "0.4rem 0.8rem",
        background: "#1a1a2e",
        border: "1px solid #2d3748",
        borderRadius: 8,
        fontSize: "0.9rem",
      }}
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="9" cy="21" r="1" />
        <circle cx="20" cy="21" r="1" />
        <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
      </svg>
      <span
        style={{
          minWidth: 18,
          textAlign: "center",
          fontWeight: 600,
        }}
      >
        {quantity}
      </span>
    </div>
  );
}
