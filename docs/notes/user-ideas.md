- [ ] Reiterate: Redirects / status codes and rewrites as a router iterator. Ideally we should be able to handle URL rewrites where pretty URL's will be rewritten into internal routing URL's etc. The current route matcher should have an ergnomic to do an internal rewrite.

- [ ] A <Frame /> is the encapsulated page with it's own URL, what if nothing matches, shoudl a frame automatically be a route matcher as well that can iterate, interally rewrite, redirect or be a 404?

- [ ] What happens when client side context changes frequently, like multiple times a second, a new request doesn't make sense, should the server accepts streams of updates, like how a mouse cursor moves, it isn't much data, but it does become complicated how the streaming back should happen at the other side and I feel like the currently streaming chat doesn't properly handle the real streaming case properly. Since the response is multipart, can't we restart the stream when we're done with a new payload and split up the stream as separate updates? That would allow us to reallly stream, but what would happen op the server, how would the server know go to 'go again' instead of finishing the request? What is the server side event emitter or the event source that is streamed to completion? How woudl that event stream re-stream once it has reached the end? So the idea basically would be to split the stream on a special marker and split the stream on the client and do setPayload with each individual stream. Streaming to the server feels odd, we are streaming RSC down, but state up, maybe that is correct but does feel asymmetric?

- [ ] In a multiplayer game what is actually send to the server and what state is returned, the DOM can be thought of the positions of other entities in a game, streamed over the network. Client components are the local bit. This loop is quick and streaming both directions simultaneously we should dig into multiple streams happening at the same time.

- [ ] Migrate to a more classic monorepo setup with a packages and examples directory. Have a better usage guide for /client and /server exports so that they dont conflict. Should each package have both exports?

- [ ] InfiniteScroll: The current example in the frontend is highly incomplete and doesn't allow scrolling back, restoring state on refresh, not tested that scroll positions restore, doesn't reserve space further below the fold, doesn't accept async iterators as a streaming primitive, can't handle grid items etc.

- [ ] Make sure the ViewTransitions are properly documented.

- [ ] MediaQuery / LazyHydrate: Should render the DOM fully on the server but doesn't but it is stale. This is a primitive to strongly reduce the TBT on initial render while keeping SEO indexability for 'dumb' components working. Maybe this is the react Activity component but forced to be visible? Might that be possible? Activity renders on a very low priority. Worth discussing if this makes sense in a modern situation.

- [ ] So the CMS is a template builder that allows us to fix the strings of the templates and confiure the layout. However we also need to render those templates for the content, right? So is a sitemap created and how is the CMS section working here. Building a sitemap builds the available routes? Not completely because certain information might be private and completely arbitrary. But we do define routes with the match props and these props and it's vary options to render the variants of these sections.

- [ ] So the page template editor ALSO can be the content of a wysiwyg editor, we don't want to build a wysiwyg editor, but there is overlap. In Shopify for example you quickly need to create separate blog templates to do something special because the wysiwyg editor doesn't give you enough leverage. Sooo, the block editor should be able to do recursive block editors? Where a template nests in another template?

- [ ] Enable React.StrictMode always? Or why not?
