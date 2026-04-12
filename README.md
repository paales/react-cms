# GraphCommerce CMS: a research project into figuring out how to solve the CMS issue with GraphCommerce.

We've got Hygraph integrated with GraphCommerce, however it seems the setup is limited and complex. The whole frontend project seems complex and doing even the simples thing seems complex. Complexity is sometimes required, but other times we just want to do simple things.

## Shopify's theme editor

Visual page builder experience.

1. The Block (or Section) is the Component that Shopify defines, where the HTML/CSS/JS gets defined and rendered + Schema
2. The schema of a Block is created with a simple JSON file.
   - The schema defines fields etc.
   - Children: The schema defines what blocks are allowed as children and can allow everything or a limited scope.
   - Data requirements: Blocks can define fields
3. When creating a new Block or changing the Schema it is uploaded and immediately reflected in the Editor. This means that the online UI is generated based on the local UI.
   - This creates a creative iteration where schema changes are cheap and easy.
4. Block can render children and pass props down to child components. Children are therefor not passeed as React's {children} but rendered as <Children {...props} />
5. Data loading happens by accessing a data store and is accessed by an array access mechanism and the templates are not concerned with loading states. The templates do not concern about loading states or awaiting data, everything is synchronous. Asynchronous requests aren't even possible, so performance footguns don't seem to be possible. The liquid render engine seems fast enough that it renders on the fly with a light caching layer on top.
6. Each schema can define a list of presets which is the only selectable building block in the editor. This preset does not only select
7. The used configurations for on this theme is stored with the code, the configuration and values that are in the theme are therefor stored with the editor.

## Shopify Liquid template system

Although the internals of Shopify Liquid are not public, it gives one very data loading primitive that is completely synchronous and transparent. It very intentionally limits any custom data loading and the whole 'graph' needs to be traverseable from the root. So you can't reall do any queries and each route has predefined root queries that are used to build the page. In the theme editor on the json level you are able to define new roots. The actual values queried are not defined in like a query document but are 'just' loaded on the fly. It seems Shopify does some compiling and flow analysis to load all the data for the page. I don't like the absolute synchronous nature of the approach as this creates a chasm in functionality between server rendered data and client rendered data. The BIG advantage is that you can't break it, you can't cause an insane waterfall, dependent data loading etc.
