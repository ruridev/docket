<p align="center"><img src="web/icon.svg" width="96" alt=""></p>

<h1 align="center">docket</h1>

<p align="center">One page for the local web tools you run on your PC.</p>

docket is one page for the web tools you run on your own PC. Register a local web app once, then open it, start it and stop it from the same place, instead of keeping a terminal and a browser tab open for each one.

- **Open** any registered tool inside the page, and switch between tools from the header.
- **Start and stop** a tool's server from the page. docket runs your own command in your own folder, unchanged.
- **Find** the web servers already running on your PC, and fill in their folder and start command for you.
- **Watch ports**: see what is running, what is not responding, and which program holds a port before you start something on it.

It works with any local web app, such as a Vite dev server or a Python app.

## Getting started

Needs Node.js 22+ on Windows or macOS.

```bash
git clone https://github.com/ruridev/docket.git
cd docket
npm start
```

Open http://localhost:4600, create your account, then press **Add service** and pick a running server or enter an address. Details: [docs/setup.md](docs/setup.md).

## Security

docket runs the commands you register with your user's permissions, so register only commands you trust. It listens on `127.0.0.1` only. Don't run it on a PC you share with other people. Details: [docs/SECURITY.md](docs/SECURITY.md).

## Documentation

- [Setup](docs/setup.md): requirements, first run, options, troubleshooting
- [Usage](docs/usage.md): signing in, finding, starting, stopping and opening tools, data
- [Security](docs/SECURITY.md): what docket protects, and how to report a vulnerability
- [Development](docs/development.md): tests

## License

[MIT](LICENSE)
