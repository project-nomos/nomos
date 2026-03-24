---
name: gws-drive
version: 1.0.0
description: "Google Drive: Manage files, folders, and shared drives."
metadata:
  openclaw:
    category: "productivity"
    requires:
      bins: ["gws"]
    cliHelp: "gws drive --help"
---

# drive (v3)

> **PREREQUISITE:** Read `../gws-shared/SKILL.md` for auth, global flags, and security rules. If missing, run `gws generate-skills` to create it.

```bash
gws drive <resource> <method> [flags]
```

## Helper Commands

| Command                                   | Description                           |
| ----------------------------------------- | ------------------------------------- |
| [`+upload`](../gws-drive-upload/SKILL.md) | Upload a file with automatic metadata |

## API Resources

### about

- `get` — Gets information about the user, the user's Drive, and system capabilities. Required: The `fields` parameter must be set.

### files

- `copy` — Creates a copy of a file and applies any requested updates with patch semantics.
- `create` — Creates a file. Supports upload via `--upload` flag. Max file size: 5,120 GB.
- `download` — Downloads the content of a file.
- `export` — Exports a Google Workspace document to the requested MIME type. Limited to 10 MB.
- `get` — Gets a file's metadata or content by ID. Use `alt=media` for content.
- `list` — Lists the user's files. Supports `q` parameter for search queries. Returns all files including trashed by default.
- `update` — Updates a file's metadata, content, or both. Supports patch semantics and upload.
- `watch` — Subscribes to changes to a file.

### drives

- `create` — Creates a shared drive.
- `get` — Gets a shared drive's metadata by ID.
- `list` — Lists the user's shared drives. Supports `q` parameter for search.
- `update` — Updates the metadata for a shared drive.

### permissions

- `create` — Creates a permission for a file or shared drive.
- `delete` — Deletes a permission.
- `get` — Gets a permission by ID.
- `list` — Lists a file's or shared drive's permissions.
- `update` — Updates a permission with patch semantics.

### comments

- `create` — Creates a comment on a file.
- `delete` — Deletes a comment.
- `get` — Gets a comment by ID.
- `list` — Lists a file's comments.

### revisions

- `get` — Gets a revision's metadata or content by ID.
- `list` — Lists a file's revisions.

## Discovering Commands

Before calling any API method, inspect it:

```bash
# Browse resources and methods
gws drive --help

# Inspect a method's required params, types, and defaults
gws schema drive.<resource>.<method>
```

Use `gws schema` output to build your `--params` and `--json` flags.
