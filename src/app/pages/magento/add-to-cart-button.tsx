"use client";

import { useTransition } from "react";
import { addToCart } from "./cart-actions.ts";

export function AddToCartButton({ sku }: { sku: string }) {
	const [isPending, startTransition] = useTransition();

	function handleClick() {
		startTransition(async () => {
			await addToCart(sku, 1);
		});
	}

	return (
		<button
			type="button"
			onClick={handleClick}
			disabled={isPending}
			style={{
				background: "#48bb78",
				color: "#1a1a2e",
				border: "none",
				padding: "0.5rem 1rem",
				borderRadius: 6,
				cursor: isPending ? "wait" : "pointer",
				fontWeight: 600,
				fontSize: "0.85rem",
			}}
		>
			{isPending ? "Adding..." : "Add to Cart"}
		</button>
	);
}
