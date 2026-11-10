# docket

docket is one page for the web tools you run on your own PC. Register a local web app once, then open it, start it and stop it from the same place, instead of keeping a terminal and a browser tab open for each one.

- **Open** any registered tool inside the page, and switch between tools from the header.
- **Start and stop** a tool's server from the page. docket runs your own command in your own folder, unchanged.
- **Find** the web servers already running on your PC, and fill in their folder and start command for you.
- **Watch ports**: see what is running, what is not responding, and which program holds a port before you start something on it.

It works with any local web app, such as [docket-gits](https://github.com/ruridev/docket-gits), [docket-jobs](https://github.com/ruridev/docket-jobs), a Vite dev server or a Python app.

## Requirements

- Node.js 20 or later
- Windows or macOS

## Getting started

1. Clone the repository and start docket:

   ```bash
   git clone https://github.com/ruridev/docket.git
   cd docket
   npm start
   ```

   There are no dependencies, so there is no `npm install`.

2. Open http://localhost:4600.
3. Press **Add service**. docket lists the web servers it finds on your PC; pick one, or enter a name and an address.
4. To start and stop the tool from docket, also give it a folder and a start command. docket suggests commands from `package.json` scripts or a Python entry file.

| Option | Default | |
| --- | --- | --- |
| `--port=<n>` or `DOCKET_PORTAL_PORT` | `4600` | Port to listen on |
| `DOCKET_PORTAL_DATA` | `./data` | Where services, state and logs are stored |

To update, stop docket, run `git pull` and start it again. Your services are in `data/`, which git does not track.

## How it works

### Finding running servers

docket reads the listening ports from the OS (`netstat` on Windows, `lsof` on macOS) and sends an HTTP request only to those ports. For a server it finds, it reads the process's working folder and command line to fill in the form. On Windows, `server/procinfo.ps1` reads the working folder without admin rights.

### Starting a server

- docket runs the command in its folder **as is**. It never changes the port, because each tool chooses its port in its own way, and moving it can break data folders, browser storage or callback URLs. To use another port, put it in the command, for example `npm run dev -- --port 5174`.
- Before starting, docket checks the port. If another service docket started holds it, you can stop that one and start this one. If any other program holds it, docket shows its name and PID and leaves it alone.
- After starting, docket checks which ports the process actually opened, and offers to fix the address if it is different.
- If the process exits before its port opens, docket shows the exit code and the end of its output.

### Stopping a server

docket stops only the servers it started. Those keep running when docket itself stops, and the next docket picks them up again by PID and process start time; a PID that now belongs to another process (after a reboot) is forgotten, never stopped.

### Opening a tool

A tool opens in a sandboxed iframe below the header (it cannot navigate the docket page away). Tools that refuse to be embedded (`X-Frame-Options` or CSP `frame-ancestors`) open in a new tab instead.

## Data

| Path | Contents |
| --- | --- |
| `data/services.json` | Registered services |
| `data/state.json` | PID and state of each server docket started |
| `data/logs/<id>.log` | Output of a server docket started, rewritten on each start |

Theme and language are saved in the browser only.

## Security

- **docket runs registered commands with your user's permissions.** Do not register a command you do not trust.
- The page and the API listen on `127.0.0.1` only, so they cannot be reached from another device.
- Because the API can run commands, it checks the `Host` header, the `Origin` header and a custom `X-Docket-Portal` header to reject requests from other web pages. docket itself cannot be embedded in another page.
- The API has no password or token: any program on this PC that can reach `127.0.0.1` (a container, for example) can use it. Don't run docket on a PC you share with other people. `data/` is created with mode 0700 and its files with 0600 (owner only).
- Start commands that docket suggests (from a running process or `package.json`) are offered only in plain forms such as `npm run dev` or `node server.js`; anything else is left for you to type.

## Troubleshooting

**A tool shows "Not responding".** Its server is not running, or it is on a different port than the registered address. Start it from docket, or fix the address.

**A tool does not show inside docket.** It refuses to be embedded. Open it in a new tab.

**Port 4600 is already in use.** Start docket with `npm start -- --port=4700`.

**A server exits right after starting.** Check that the command works in a terminal from the same folder. The full output is in `data/logs/<id>.log`.

**Starting over.** Stop the servers docket started, stop docket, then delete `data/`. If you delete `data/` first, docket can no longer stop those servers.

## Development

```bash
npm test
```

## License

[MIT](LICENSE)
