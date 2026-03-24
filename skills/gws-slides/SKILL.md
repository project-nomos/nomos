---
name: gws-slides
version: 1.0.0
description: "Google Slides: Read and write presentations."
metadata:
  openclaw:
    category: "productivity"
    requires:
      bins: ["gws"]
    cliHelp: "gws slides --help"
---

# slides (v1)

> **PREREQUISITE:** Read `../gws-shared/SKILL.md` for auth, global flags, and security rules. If missing, run `gws generate-skills` to create it.

```bash
gws slides <resource> <method> [flags]
```

## API Resources

### presentations

- `batchUpdate` — Applies one or more updates to the presentation. Each request is validated before being applied.
- `create` — Creates a blank presentation using the title given in the request.
- `get` — Gets the latest version of the specified presentation.
- `pages` — Operations on the 'pages' resource

## Discovering Commands

Before calling any API method, inspect it:

```bash
# Browse resources and methods
gws slides --help

# Inspect a method's required params, types, and defaults
gws schema slides.<resource>.<method>
```

Use `gws schema` output to build your `--params` and `--json` flags.
