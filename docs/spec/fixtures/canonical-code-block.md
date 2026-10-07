# Setup

Run the install, then start the server with {==`pnpm dev`==}{#c2}.

```ts {#c1} {#c3}
import { start } from "./server";

const port = 3000;
start({ port });
```

That is all.

---
comments:
  c1:
    body: "Read the port from the environment instead."
    by: user
    at: "2026-10-05T09:00:00.000Z"
    lines: [3, 4]
    quote: "const port = 3000;\nstart({ port });"
  c2:
    body: "Use the dev wrapper here."
    by: user
    at: "2026-10-05T09:01:00.000Z"
  c3:
    body: "Name the module after what it does."
    by: user
    at: "2026-10-05T09:02:00.000Z"
    lines: [1, 1]
    quote: "import { start } from \"./server\";"
  a1:
    body: "Changed both."
    by: AI
    at: "2026-10-05T10:00:00.000Z"
    re: c1
