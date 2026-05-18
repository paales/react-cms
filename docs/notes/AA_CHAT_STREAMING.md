# Hi — I'm a streaming message.

Every character you're watching land right now travels from a server component, through React's Flight stream, and into your browser as a separate chunk reveal. No polling. No websocket. One HTTP response that trickles.

The trick is a server-side segment loop. Each rendered message snapshots the current chunks synchronously and ends with a single Suspense boundary whose child — a tiny sentinel called `<ChunkSlot>` — awaits the next chunk and calls `markConnectionLive()` to tell the framework "I'm not done yet." When the producer appends a chunk, it fires `refreshSelector` on this message's label. The segment driver, woken by that bump, closes the current Flight document, emits a `next` marker on the wire, and re-renders the message with the new chunk now in the list and a fresh `<ChunkSlot>` waiting for the one after that.

The client peels each segment off the response and calls `setPayload` once per segment. React reconciles the same tree in place; the partial-cache layer keeps the rest of the page identity-stable while the chat partial commits fresh bytes. Because the connection stays open across segments, the cost per chunk is one Flight document plus a marker — no extra TCP, no header overhead, no roundtrip.

When the log signals done, `<ChunkMessage>` renders a "stream complete" tail synchronously and stops calling `markConnectionLive`. The segment driver closes the connection cleanly. A torn close (proxy timeout, tab background) surfaces on the client as a recoverable Suspense error — the client treats that as "reopen the connection." Bookmarks and full reloads pick the log up wherever the producer is.

A couple of lessons fell out of the build. Server-side `getServerNavigation().reload({selector})` looks like its client-side twin on purpose — same vocabulary (`name?key=val`), same scope semantics. Inside a server action it runs under `runInvalidationTransaction` so a throw discards the queued bumps; outside an action (the producer case) the bump applies immediately. And the framing on the wire — `\xFF[parton:tag:length]\n<body>` — generalises trivially: one UTF-8-invalid lead byte (`\xFF` cannot occur inside Flight JSON) plus a readable ASCII bracketed header that shows up legibly in tcpdump / curl. Today the framework uses `fp`, `url`, and `next`; reserving a new tag is one line in the marker module.

That's the demo. You can close this any time; the reset button wipes all the server-side logs and URL params in one shot.
