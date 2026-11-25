# Git graph

A mod for Claude Code that draws your repository's git commit graph in a pane beside the chat. You see every branch, where each one splits off and merges back, and which commit you're on. It updates by itself while you work.

Made for Tonik's free video course **Claude Code for product designers**.

## Install

In a terminal:

```bash
claude plugin marketplace add tonik/claude-code-git-graph
```

```bash
claude plugin install git-graph@tonik
```

Then start a new session. Needs Claude Code 2.1.286 or newer.

## Use

- In a project that uses git, the pane opens by itself when a session starts.
- Type `/git-graph` to open it any time.
- Hover a commit to see its full message, author and date.
- It redraws every 10 seconds and right after Claude runs a command.

## What it does on your computer

It only reads your project's history with `git log`. It changes nothing and sends nothing anywhere.
