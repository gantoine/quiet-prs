# Quiet PRs for GitHub

[![Install for Chrome](https://img.shields.io/badge/Chrome-Install-4285F4?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/hangdlmlkjibcjmnhecohkkplkagnhip) [![Install for Firefox](https://img.shields.io/badge/Firefox-Install-FF7139?logo=firefoxbrowser&logoColor=white)](https://addons.mozilla.org/en-US/firefox/addon/pr-lanes-hide-bots-on-github/)

Bots comment on every pull request, and the two people arguing about the actual change get buried between coverage reports and CI summaries. Quiet PRs puts two buttons on the conversation (**Hide bots** and **Hide events**) and leaves what people wrote alone.

## What it does

What people say is never hidden. The two buttons turn off everything else, independently of each other, and stay where you leave them. Each one's tooltip says what a click will do, so a button offering **Show bots** means the bots are currently gone, and its icon is struck through while it hides.

**Hide bots** takes out everything posted by apps, CI and review bots: their comments, the timeline events they generate, and their rows in the **Reviewers** sidebar, so the list shows the people whose review you are actually waiting on. Suggested reviewers are left alone: nobody is waiting on a review that has not been asked for. A hidden bot comment does not vanish. It shrinks to a single line carrying the bot's avatar, its name and the opening of what it wrote, and back-to-back comments from the same bot share one line between them. Click it to read them; a **Hide** in the avatar gutter folds them away again. That Hide is there whenever a bot comment is showing, so you can fold one bot's run without putting every bot away.

**Hide events** takes out the timeline itself: labels, commits, reviews, merges, whoever caused them.

Press `b` and `e` to work the buttons from the keyboard; both are ignored while you are typing in a comment box. The bot filter also applies to inline review threads on the **Files changed** tab. Commits belong to nobody, so hiding bots never takes them and a push can still be read against the bot comment it answers. Nothing useful disappears: the pull request description and the comment box survive both buttons, and a thread a bot started but a person replied to counts as a person's, bot comment and all.

The extension is entirely local: `storage` for settings and host access to `github.com`, no other permission, no network calls, no background worker.

## Settings

Both buttons live on the conversation, not in here. These settings decide where they start and what else goes.

| Setting | Default | What it does |
| --- | --- | --- |
| Open with **Hide bots** on | on | Where the bots button sits on a conversation you have not touched |
| Collapse bot comments | on | A hidden bot comment shrinks to one line you can click. Turn this off and it goes altogether |
| Open with **Hide events** on | off | Where the events button sits on a conversation you have not touched. Events are labels, commits, reviews and merges |
| Remember per repository | off | Keep a separate choice for each repo instead of one setting everywhere |
| Hide resolved PR review threads | off | Threads somebody has already resolved drop out, whatever the buttons say |
| Extra bot accounts | none | Logins that post through a token and look human |
| Always treat as human | none | Overrides every bot signal |
| Name heuristics | on | Treat `*[bot]`, `*-bot`, `*-ci`, `*-app` logins as bots |

## How a bot is recognised

Authorship is decided in this order, and the first rule that matches wins:

1. The *Always treat as human* list.
2. A `name[bot]` login, or an author link pointing at `/apps/…`.
3. The built-in bot list.
4. A GitHub App avatar (`avatars.githubusercontent.com/in/…`).
5. A `bot` or `AI` badge next to the author.
6. The name heuristics, when they are on.

- Avatars inside a comment body are ignored, so a commenter cannot post a bot avatar to hide their own comment.
- Badges are read next to the author only, not anywhere in the row, so an event like "you requested a review from Copilot" survives **Hide bots**: it is your action, not the bot's.
- A comment box with no author of its own, such as a collapsed "Show resolved" thread, does not vote on who wrote the row it sits in.
- A review whose threads are still collapsed counts as a comment, not a timeline event, so a bot review is something you can open rather than something that simply goes.
- The "Mention @copilot in a comment to make changes" note GitHub parks on an agent's pull request has no author, but it goes with the bots.

Accounts that comment through a personal access token (some Codecov and internal release setups) carry no bot signal at all. Add those under *Extra bot accounts*.

## Development

```bash
npm test            # unit tests, then the headless-Chrome end-to-end test
npm run test:unit
npm run test:e2e    # needs Chrome; override with CHROME=/path/to/chrome
npm run test:serve  # serves the real content scripts against test/e2e-page.html to eyeball in a browser
npm run build
npm run sign:firefox -- --channel listed --dry-run
npm run publish:chrome -- --dry-run
```

`test/e2e.mjs` loads `content/classify.js` and `content/lanes.js` into a page with a stubbed extension API rather than installing the extension, because Chrome 137+ refuses `--load-extension` in branded builds. The manifest itself is checked with `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --pack-extension=dist/chrome`.

### Refreshing the Chrome Web Store token

When the release's Chrome job fails with `invalid_grant` ("Token has been expired or revoked"), `CHROME_REFRESH_TOKEN` needs replacing. The client id and secret stay the same.

1. Open this in a browser, signed in as the account that owns the Web Store item, with your client id filled in:

   ```
   https://accounts.google.com/o/oauth2/v2/auth?response_type=code&access_type=offline&prompt=consent&scope=https://www.googleapis.com/auth/chromewebstore&redirect_uri=http://localhost:8818&client_id=CLIENT_ID
   ```

   After you click **Allow**, the browser lands on a localhost page that does not load. Copy the `code` parameter from the address bar.
2. Exchange the code for a refresh token:

   ```bash
   curl -s https://oauth2.googleapis.com/token -d grant_type=authorization_code \
     -d client_id=CLIENT_ID -d client_secret=CLIENT_SECRET \
     -d redirect_uri=http://localhost:8818 -d code=CODE
   ```

   If the response includes `refresh_token_expires_in`, the app is still in Testing and the token will expire again.
3. Store the `refresh_token` from the response: replace `CHROME_REFRESH_TOKEN` in `.env`, then run `gh secret set CHROME_REFRESH_TOKEN` and paste it when prompted.
4. Re-run the failed job: `gh run rerun <run-id> --failed`.

## Licence

MIT. See [LICENSE](LICENSE).
