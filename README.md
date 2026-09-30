# Simul

[![Listed on laya.tools](https://laya.tools/badge.svg)](https://laya.tools/p/tholkappiargithubiosimul)

A civilisation simulator where every person and every government makes decisions with a small AI model running entirely in your browser.

**Live:** https://tholkappiar.github.io/simul/

## About

Each person has a personality, feelings, beliefs, family, friends and a country. They live their day, and a local AI model ([layaForWeb](https://github.com/vishalmysore/layaForWeb)) decides what they do and for how long. Drop a bomb or an earthquake and watch families grieve, people flee, and countries retaliate, send aid or go to war.

Nothing leaves your browser.

## How it works

- When someone finishes what they're doing, Laya picks what they do next and for how long.
- Decisions run in batches of up to 8. Reactions to events go first: governments, then people.
- Code only handles physics: hunger, injuries, money, blast damage and how fast news travels.

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:5173. The benchmark page is at `/perf/`.

## Deploy

Every push to `main` builds and publishes to GitHub Pages (`.github/workflows/deploy.yml`).
One-time setup: **Settings → Pages → Source: GitHub Actions**.

## Credits

Built on [Laya](https://huggingface.co/convaiinnovations/laya) by ConvAI Innovations and its browser port [layaForWeb](https://github.com/vishalmysore/layaForWeb), both Apache-2.0 (see `src/laya/LICENSE.txt`).
