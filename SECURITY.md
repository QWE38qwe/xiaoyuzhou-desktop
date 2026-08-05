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

API Keys used by the extension are stored by the Native Host in macOS Keychain. They must never be written to extension storage, logs, project files, or committed to the repository.
