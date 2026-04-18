Server utility components:

```tsx
<Suspense fallback={<LoadingComponent />}>
  <RealComponent />
</Suspense>
```

```tsx
<Partial id="somePartial">
    <Component />>
</Partial>
```

```tsx
<Cache ttl={1000}>
  <PartialComponent />
</Cache>
```

Client utility components, maybe this now replaced by Activity.

```tsx
<MediaQuery></MediaQuery>
<LazyHydrate></LazyHydrate>
<ViewTransition><Partial/></ViewTransition>?
```

GraphQL @defer support in combination with Suspense.
GraphQL response cache and query caching. Add a product to the cart and dont need to refetch the cart because the same normalized cache is shared between the two requests, creating a faster roundtrip.

```tsx
<InfiniteScroll />
```

- Redirects
- Status codes
- Server Timing API
- If the Partial is the fundamental building block of the application, should (fake) 'Status Codes' and 'Redirects' also apply to Partials? A redirect would mean a state-change of the client.

- Implement a Boundary component to better test everything.

- Global loading state and loading bubbling ideally, if there is something already possible from React it'sself that is fine as well, just create a demo.

- State storage locations
  - Request (URL, Cookie, Headers. etc.)
  - Extended Redis session storage
  - Browser state locations + a deferred Partial
    - SessionStorage / LocalStorage / IndexedDB /
    - IntersectionObserver / ResizeObserver (Fragment refs)

- Remote rendered: Should an instsance of the framework be able to just output RSC and let a second instance of the RSC pick that up. That means that we'd effectively get server side iframes?
  - Evaluate of building a ServiceWorker compatible renderer makes sense here as well.
  - Allow defining security semantics to implement this.
