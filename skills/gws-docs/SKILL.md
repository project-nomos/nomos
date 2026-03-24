---
name: gws-docs
version: 1.0.0
description: "Read and write Google Docs."
metadata:
  openclaw:
    category: "productivity"
    requires:
      bins: ["gws"]
    cliHelp: "gws docs --help"
---

# docs (v1)

> **PREREQUISITE:** Read `../gws-shared/SKILL.md` for auth, global flags, and security rules. If missing, run `gws generate-skills` to create it.

```bash
gws docs <resource> <method> [flags]
```

## Helper Commands

| Command                                | Description               |
| -------------------------------------- | ------------------------- |
| [`+write`](../gws-docs-write/SKILL.md) | Append text to a document |

## API Resources

### documents

- `batchUpdate` — Applies one or more updates to the document. Each request is validated before being applied.
- `create` — Creates a blank document using the title given in the request.
- `get` — Gets the latest version of the specified document.

## Discovering Commands

Before calling any API method, inspect it:

```bash
# Browse resources and methods
gws docs --help

# Inspect a method's required params, types, and defaults
gws schema docs.<resource>.<method>
```

Use `gws schema` output to build your `--params` and `--json` flags.
