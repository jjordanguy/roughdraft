# Installing the fork

This fork is installed from a packed build, never from the npm registry. The command name stays `roughdraft`. These steps work the same on a Mac and on a Linux VPS. Nothing here creates a command named `rd`.

## Before the first install: keep the current version

```bash
mkdir -p ~/.roughdraft/releases
cp -a "$(npm root -g)/roughdraft" ~/.roughdraft/releases/roughdraft-0.1.10-installed
```

A fresh install of upstream 0.1.10 from the registry does not start under current npm (a package it needs is not installed with it), so this copy is the rollback.

## Build, prove, install

From the fork checkout:

```bash
pnpm install --frozen-lockfile && pnpm check
pnpm test:pack
npm pack --pack-destination ~/.roughdraft/releases
```

`pnpm test:pack` installs the tarball into a temporary folder and runs the installed command before anything touches the real install. Then:

```bash
roughdraft stop
npm i -g ~/.roughdraft/releases/roughdraft-<version>.tgz
roughdraft --version
roughdraft restart
```

`roughdraft stop` uses the old command to stop the old server. `roughdraft restart` after the install starts the new version; if a server of another version is still running, every command refuses to reuse it and says to run `roughdraft restart`.

Close Roughdraft windows that were open on the old server and open the documents again with their links; the links do not change.

## On the VPS

Copy the tarball to the VPS (for example with `scp`), then run the same stop, install, restart sequence there. The Tailscale link keeps its address; only the server behind it changes.

## Roll back

```bash
roughdraft stop
npm rm -g roughdraft
cp -a ~/.roughdraft/releases/roughdraft-0.1.10-installed "$(npm root -g)/roughdraft"
ln -sf ../lib/node_modules/roughdraft/packages/server/bin/roughdraft.mjs "$(npm bin -g 2>/dev/null || dirname "$(which roughdraft)")/roughdraft"
roughdraft --version
roughdraft start
```

Without the saved copy: `npm i -g roughdraft@0.1.10 yaml@2` (the extra package is what the registry build is missing).

## Checking what is running

```bash
roughdraft status --json
```

`serverVersion`, `cliVersion` and `versionMatches` say whether the server and the command agree.
