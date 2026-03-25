# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do NOT open a public issue.**
2. Email the maintainers or use [GitHub's private vulnerability reporting](https://github.com/project-nomos/nomos/security/advisories/new).
3. Include a description of the vulnerability, steps to reproduce, and any potential impact.
4. You will receive an acknowledgment within 48 hours.

We will work with you to understand and address the issue before any public disclosure.

## Security Considerations

- **Secrets at rest**: Integration secrets are encrypted with AES-256-GCM via `ENCRYPTION_KEY`
- **Database**: Always use parameterized queries (tagged template literals via `postgres` library)
- **Permissions**: Tool execution is gated by the SDK's permission system
- **Environment**: Never commit `.env` files — use `.env.example` as a reference
