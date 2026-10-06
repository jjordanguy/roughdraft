# Mixed fixture

Text {==one==}{>>Inline attr root<<}{id="c1" by="user" at="2026-10-03T12:00:00.000Z"} and {==two==}{>>Compact root<<}{#c2}.

---
comments:
  c2:
    by: user
    at: "2026-10-03T12:01:00.000Z"
  c3:
    body: Reply to compact root
    by: AI
    at: "2026-10-03T12:02:00.000Z"
    re: c2
  c4:
    body: Reply to inline root
    by: AI
    at: "2026-10-03T12:03:00.000Z"
    re: c1
