---
name: Something broke
about: A command failed, a clip is wrong, or setup did not get through
---

**What I ran**

```
pnpm ...
```

**What happened** (the last lines of output, pasted as text)

```
```

**`pnpm check` output** (it prints no IDs or keys)

```
```

**If a render failed:** the matching entry from `state/failures.json`, and the
`console.log` from that attempt's folder under `state/render/`.

**If a FACEIT download failed:** the message, and the screenshot it names in
`state/browser-failures/` (check it for anything you do not want public first).
