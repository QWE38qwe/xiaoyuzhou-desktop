# Security Policy

## Supported versions

Security fixes are applied to the latest code on the `main` branch.

## Reporting a vulnerability

Please do not include API Keys, access tokens, personal data, or exploit details in a public issue.

Use GitHub Private Vulnerability Reporting for this repository. Include:

- affected version or commit
- reproduction steps
- expected impact
- suggested mitigation, if available

API Keys used by the extension should remain in the Native Host credential file with `0600` permissions and must never be committed to the repository.
