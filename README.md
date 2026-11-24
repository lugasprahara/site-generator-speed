# site-generator-speed

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/lugasprahara/site-generator-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/lugasprahara/site-generator-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast drop-in replacement for makefun-site 1.0.0: `solve.js` exports `run(input)`, which returns exactly the output tree makefun-site's build returns for a site — every page, index, tag page, static file and the build report, byte for byte — computed by a leaner engine. The front-matter, Markdown and template dialects are reimplemented as hand-written scanners with no regex in the hot paths, slug and date formatting are memoised across the build, each source's card is built once and shared by every list that shows it, and bodies are rendered in a single pass with no intermediate token arrays.

## Run it

```sh
node main.ts
```

The driver reads the cases from `/input/cases.json` and writes the answers to `/output/answers.json`; outside a container, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in for those mounts.

---

<sub>Entered on [make.fun](https://make.fun/?ref=aes5np1n&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
