- <MediaQuery></MediaQuery>
- <LazyHydrate></LazyHydrate>
- <ViewTransition>
- <InfiniteScroll />

- Redirects
- Status codes
- Server Timing API
- If the Partial is the fundamental building block of the application, should (fake) 'Status Codes' and 'Redirects' also apply to Partials? A redirect would mean a state-change of the client.
- Implement a Partial debugging component to get a great debugging experience. Ideally this would function as an overlay like how the 'css grid' chrome inspector overlay works for example. Not affect the layouting of the page layout. css position-anchor?
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

- The refetch policy of a Partial and how it should fall back should depend on the Partial and not the caller I think. By default everything should resolve synchronously without any additional configuration.

- Question, not a discredit: I'm unclear why we are still using stripPartials and statically walking the children tree, this doesn't scale and needs to be abolished if possible. Its ok for now, but It remains unclear what subtle bugs this is causing, because how do opaque children work, we need those as well? If we've got Dynamic Partial holes, why can't all Partials by dynamic, what is the tradeoff?

- Is the cache global or route specific, what if exactly the same Partial is used on multiple locations, will that work?

- I read something about a Route cache for the partial templates, we don't strictly have routes in the framework, so what consists as a route?

- As for defer; I see a future where `const consent = async getLocalStorage('consent')` would work. It would immediatly bail the render of the component and show the fallback of the component and move effectively set the component in defer mode from there-on. const {x,y} = getMousePosition(), ahhaha, that would be insane, streaming all the mouse positions to the server and continiously return the newly updated component. Oh that brings in a cute research would websockets with a continuous stream back work, effectively making multiplayer possible.

- Should we do getPartial().header('x') would that be a better equivalent of usePartial()?

- Later: GraphQL @defer support in combination with Suspense.
- Later: GraphQL response cache and query caching. Add a product to the cart and dont need to refetch the cart because the same normalized cache is shared between the two requests, creating a faster roundtrip.
