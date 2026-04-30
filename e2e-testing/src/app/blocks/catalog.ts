/**
 * App-level block catalog.
 *
 * Each `ReactCms.partial(...)` call self-registers its spec at module
 * load time. This file just imports each block module for its
 * side effect; no `registerBlock` call needed.
 */

import "./hero.tsx"
import "./rich-text.tsx"
import "./page-root.tsx"
import "./nav-root.tsx"
import "./nav-link.tsx"
import "./page-hero.tsx"
import "./page-slug-nav.tsx"
import "./page-greeting.tsx"
import "./page-composed.tsx"
import "./page-multi-slot.tsx"
import "./group.tsx"
import "./product-card.tsx"
