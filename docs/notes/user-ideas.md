- [ ] Reiterate: Redirects / status codes and rewrites as a router iterator. Ideally we should be able to handle URL rewrites where pretty URL's will be rewritten into internal routing URL's etc. The current route matcher should have an ergnomic to do an internal rewrite.

- [ ] A <Frame /> is the encapsulated page with it's own URL, what if nothing matches, shoudl a frame automatically be a route matcher as well that can iterate, interally rewrite, redirect or be a 404?

- [ ] Migrate to a more classic monorepo setup with a packages and examples directory. Have a better usage guide for /client and /server exports so that they dont conflict. Should each package have both exports?

- [ ] InfiniteScroll: The current example in the frontend is highly incomplete and doesn't allow scrolling back, restoring state on refresh, not tested that scroll positions restore, doesn't reserve space further below the fold, doesn't accept async iterators as a streaming primitive, can't handle grid items etc.

- [ ] Make sure the ViewTransitions are properly documented.

- [ ] MediaQuery / LazyHydrate: Should render the DOM fully on the server but doesn't but it is stale. This is a primitive to strongly reduce the TBT on initial render while keeping SEO indexability for 'dumb' components working. Maybe this is the react Activity component but forced to be visible? Might that be possible? Activity renders on a very low priority. Worth discussing if this makes sense in a modern situation.

- [ ] So the CMS is a template builder that allows us to fix the strings of the templates and confiure the layout. However we also need to render those templates for the content, right? So is a sitemap created and how is the CMS section working here. Building a sitemap builds the available routes? Not completely because certain information might be private and completely arbitrary. But we do define routes with the match props and these props and it's vary options to render the variants of these sections.

- [ ] So the page template editor ALSO can be the content of a wysiwyg editor, we don't want to build a wysiwyg editor, but there is overlap. In Shopify for example you quickly need to create separate blog templates to do something special because the wysiwyg editor doesn't give you enough leverage. Sooo, the block editor should be able to do recursive block editors? Where a template nests in another template?

- [ ] Should gqlCell also get a batch resolver, this is a common prmitive in building resolvers and this situation looks similar, right? Or is this something a graphql server should just efficiently handle?

- [ ] Optimize the streams and connection paradigms with websockets or the new QUIC network channel.

Re: Server context:

- [ ] Should and can we make a new server context API available to the user? The tracing of the parent/child relation is the threading that allows us to do create server context, but does this also mean we can get `const MyContext = createServerContext(null) > <MyContext value={xyz}/> + use(MyContext)?`

- [ ] Does this allow us to know when all children of a parent are completely finished rendering? So we currently have the trailer setup, but we have this because some async child can render and we need to rollup the fp from those as well. Also we need to specify what the schema, cms stuff or cells are used for the invalidation flow to work properly. We break those boundaries at some locations right now and that will bite us. So if we know the call sites, we can construct cells inside the renderer (maybe?), just call cells's value etc. and all influence the the fp correctly. We can even do this through async boundaries etc. We can completely get rid of the constructor architecture and move to a <Parton render={}/> component completely? We had that in an older version but had to abandon because of the lack of a proper server context architecture.
