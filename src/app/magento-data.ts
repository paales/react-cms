/**
 * GraphCommerce Magento 2 API data source: schema cache and query executor.
 */

import { fetchSchema, type SchemaGraph } from "../lib/schema.ts";

export const MAGENTO_ENDPOINT = "https://graphcommerce.vercel.app/api/graphql";

let schemaPromise: Promise<SchemaGraph> | undefined;

export function getSchema(): Promise<SchemaGraph> {
	schemaPromise ??= fetchSchema(MAGENTO_ENDPOINT);
	return schemaPromise;
}

export async function execute<T>(query: string): Promise<T> {
	const response = await fetch(MAGENTO_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ query }),
	});

	if (!response.ok) {
		throw new Error(`GraphQL fetch failed: ${response.status}`);
	}

	const json = (await response.json()) as {
		data: T;
		errors?: Array<{ message: string }>;
	};

	if (json.errors?.length) {
		throw new Error(
			`GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`,
		);
	}

	return json.data;
}
