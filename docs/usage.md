# Using docket

For setup, see [Setup](setup.md).

## Signing in

The first time you open docket, it asks you to create an account: a name and a password of 8 characters or more. There is one account and no email, because nothing is ever sent out and the account only guards this app on this PC. From then on every API call needs the signed-in session.

- Creating the account needs a setup code. While there is no account, the server prints a link with the code when it starts (`Create the account: http://localhost:4600/?setup=...`), and the code is also in `data/setup-code` (readable by your user only). Opening the link fills in the code; the code is removed once the account exists.
- The account is kept in `data/auth.json` (0600): a scrypt hash of the password and the secret that signs the session cookie. A session lasts 30 days and survives restarts.
- Browsers send `localhost` cookies to every port, so the cookie alone is not a session: signing in also gives the page an API token, kept in this browser's storage for this address only and sent with every API call. Another browser or a cleared storage asks you to sign in again.
- **Sign out** ends every session of this account, in every browser.
- Forgot the password? Run `node server/index.js --reset-password` in this folder. It removes only the account and prints a new setup code; your data stays.

## How it works

### Finding running servers

docket reads the listening ports from the OS (`netstat` on Windows, `lsof` on macOS) and sends an HTTP request only to those ports. For a server it finds, it reads the process's working folder and command line to fill in the form. On Windows, `server/procinfo.ps1` reads the working folder without admin rights.

### Starting a server

- docket runs the command in its folder **as is**. It never changes the port, because each tool chooses its port in its own way, and moving it can break data folders, browser storage or callback URLs. To use another port, put it in the command, for example `npm run dev -- --port 5174`.
- Before starting, docket checks the port. If another service docket started holds it, you can stop that one and start this one. If any other program holds it, docket shows its name and PID and leaves it alone.
- After starting, docket checks which ports the process actually opened, and offers to fix the address if it is different.
- If the process exits before its port opens, docket shows the exit code and the end of its output.

### Stopping a server

- A server docket started is stopped by its PID. Those keep running when docket itself stops, and the next docket picks them up again by PID and process start time; a PID that now belongs to another process (after a reboot) is forgotten, never stopped.
- A server started some other way is stopped through its port: for a `docker compose up` command, docket runs `docker compose stop` in the service's folder; otherwise it stops the local process listening on the service's port. Port forwarders (such as ssh and Docker) and docket itself are never stopped this way, because stopping them would not stop the service, or would stop too much.

### Opening a tool

A tool opens in a sandboxed iframe below the header (it cannot navigate the docket page away). Tools that refuse to be embedded (`X-Frame-Options` or CSP `frame-ancestors`) open in a new tab instead.

## Data

| Path | Contents |
| --- | --- |
| `data/auth.json` | The sign-in account (password hash and session secret) |
| `data/services.json` | Registered services |
| `data/state.json` | PID and state of each server docket started |
| `data/logs/<id>.log` | Output of a server docket started, rewritten on each start |

Theme and language are saved in the browser only.
