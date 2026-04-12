/**
 * Records property access paths during a render pass.
 *
 * The recorder collects paths like ['name'], ['sprites', 'front_default']
 * and merges them into a tree structure for query compilation.
 */

export interface AccessPath {
	/** The field name at this level */
	field: string;
	/** Arguments passed (for parameterized fields) */
	args?: Record<string, unknown>;
	/** Whether this field was accessed as a list (.map, .find, etc.) */
	isList?: boolean;
	/** Nested field accesses */
	children: AccessPath[];
}

export class AccessRecorder {
	private roots: Map<string, AccessPath> = new Map();

	/**
	 * Record a field access path.
	 * Paths are arrays of field names from root to leaf.
	 */
	recordAccess(
		path: string[],
		args?: Record<string, unknown>,
		listIndices?: Set<number>,
	): void {
		if (path.length === 0) return;

		const [first, ...rest] = path;
		let node = this.roots.get(first);
		if (!node) {
			node = { field: first, children: [] };
			this.roots.set(first, node);
		}

		if (listIndices?.has(0)) {
			node.isList = true;
		}

		let current = node;
		for (let i = 0; i < rest.length; i++) {
			const fieldName = rest[i];
			let child = current.children.find((c) => c.field === fieldName);
			if (!child) {
				child = { field: fieldName, children: [] };
				current.children.push(child);
			}
			if (listIndices?.has(i + 1)) {
				child.isList = true;
			}
			current = child;
		}

		// Attach args to the deepest node if this is a parameterized access
		if (args && Object.keys(args).length > 0) {
			current.args = { ...current.args, ...args };
		}
	}

	/**
	 * Get all recorded access paths as a tree.
	 */
	getAccessTree(): AccessPath[] {
		return Array.from(this.roots.values());
	}

	/**
	 * Reset all recorded paths.
	 */
	reset(): void {
		this.roots.clear();
	}
}
