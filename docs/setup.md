# Setup

How to install and run docket. For an overview, see the [README](../README.md).

## Requirements

- Node.js 22 or later
- Windows or macOS (Linux may work with `lsof` installed, but is not tested)

## First run

1. Clone the repository and start docket:

   ```bash
   git clone https://github.com/ruridev/docket.git
   cd docket
   npm start
   ```

   There are no dependencies, so there is no `npm install`.

2. Open http://localhost:4600 and create your account (see [Signing in](usage.md#signing-in)).
3. Press **Add service**. docket lists the web servers it finds on your PC; pick one, or enter a name and an address.
4. To start and stop the tool from docket, also give it a folder and a start command. docket suggests commands from `package.json` scripts or a Python entry file.

| Option | Default | |
| --- | --- | --- |
| `--port=<n>` or `DOCKET_PORTAL_PORT` | `4600` | Port to listen on |
| `DOCKET_PORTAL_DATA` | `./data` | Where services, state and logs are stored |

To update, stop docket, run `git pull` and start it again. Your services are in `data/`, which git does not track.

## Troubleshooting

**A tool shows "Not responding".** Its server is not running, or it is on a different port than the registered address. Start it from docket, or fix the address.

**A tool does not show inside docket.** It refuses to be embedded. Open it in a new tab.

**Port 4600 is already in use.** Start docket with `npm start -- --port=4700`.

**A server exits right after starting.** Check that the command works in a terminal from the same folder. The full output is in `data/logs/<id>.log`.

**Starting over.** Stop the servers docket started, stop docket, then delete `data/`. If you delete `data/` first, docket can no longer stop those servers.
