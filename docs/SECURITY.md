# Security

For an overview, see the [README](../README.md).

## Reporting a vulnerability

Please report security problems privately through [GitHub's private vulnerability reporting](https://github.com/ruridev/docket/security/advisories/new), not in a public issue.

## What docket protects

- **docket runs registered commands with your user's permissions.** Do not register a command you do not trust.
- The page and the API listen on `127.0.0.1` only, so they cannot be reached from another device.
- Because the API can run commands, it checks the `Host` header, the `Origin` header and a custom `X-Docket-Portal` header to reject requests from other web pages. docket itself cannot be embedded in another page.
- The API needs the signed-in session and its API token (see [Signing in](usage.md#signing-in)). A program running as your user can still read `data/`, so this is no defense against malware on your account. Don't run docket on a PC you share with other people. `data/` is created with mode 0700 and its files with 0600 (owner only); on Windows it gets an access list for your user only (`icacls`).
- The page loads scripts only from docket itself (`Content-Security-Policy`).
- To show each tool's status and icon, docket requests every registered address, remote ones too, and the page loads their icons.
- **Stop** for a tool docket did not start ends the local process listening on its port, and only for `localhost`, `127.0.0.1` or `[::1]` addresses.
- Start commands that docket suggests (from a running process or `package.json`) are offered only in plain forms such as `npm run dev` or `node server.js`; anything else is left for you to type.
