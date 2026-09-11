# Putting GameCut on the internet

Written for someone who has never used git. Follow it in order; it only has to
be done once, and after that publishing is two double-clicks and two buttons.

Your site will be **https://joshthefrazer.github.io/GameCut/**
Your repo is **github.com/joshthefrazer/GameCut**

---

## Part 1 — get the folder onto your computer, connected to GitHub

**1. Install GitHub Desktop.** https://desktop.github.com — install it, open it,
sign in with your GitHub account.

**2. Clone your repo.** In GitHub Desktop: **File → Clone repository →**
pick **joshthefrazer/GameCut** → choose where to put it (the default,
`Documents\GitHub\GameCut`, is fine) → **Clone**.

You now have a folder on your computer that is *connected* to GitHub. Anything
you put in it, GitHub Desktop will offer to upload.

**3. Put GameCut in it.** Unzip the GameCut zip and copy everything inside it
into that folder. When Windows asks about `index.html`, choose **Replace**.

> That empty `index.html` you made on GitHub is not the website and was never
> needed — GameCut's own `index.html` takes its place, and *that* one is the
> editor. The website is built separately, into a `docs` folder. That is what
> Pages will serve.

GitHub Desktop will now show a long list of new files. Leave it for a moment.

---

## Part 2 — set up, once

**4. Double-click `FIRST-TIME-SETUP.bat`** in the folder.

It installs what it needs (a few minutes the first time) and makes your
**signing key**.

That key is what stops anyone but you sending an update to GameCut. The public
half goes inside the app; the private half is saved in your user folder under
`.gamecut`.

> **Treat the private key like a password.** Lose it and nothing breaks — make
> another and hand people one more installer. If someone *else* gets it, they
> can push code to every copy of GameCut you have ever handed out. Never put it
> in the GameCut folder, never upload it, never put it in a zip.

**5. Double-click `PUBLISH.bat`.**

The first run builds the Windows installer too, so give it about five minutes.
When it finishes it will tell you to go to GitHub Desktop.

**6. In GitHub Desktop:** type a message in the box at the bottom left — say
`First release` — click **Commit to main**, then click **Push origin** at the
top.

The 90MB installer makes this push take a few minutes. That is normal.

**7. Turn the website on.** Go to
**github.com/joshthefrazer/GameCut/settings/pages** and set:

- Source: **Deploy from a branch**
- Branch: **main**, folder: **`/docs`** ← *not* `/ (root)`
- **Save**

Wait a minute or two, then open **https://joshthefrazer.github.io/GameCut/**

> Capitals matter. `GameCut`, not `gamecut`.

That is it. Send people that link.

---

## Every release after that

**1.** Open `CHANGELOG.md` in Notepad. Add your new version at the top, in the
same shape as the ones already there:

```
## 1.6.0

- Plain sentences about what is different now.
- Written for the person using GameCut, not for you.
```

**2.** Open `package.json` in Notepad. Change `"version": "1.5.0"` near the top
to the same number.

**3.** Double-click **`PUBLISH.bat`**.

**4.** In GitHub Desktop: message, **Commit to main**, **Push origin**.

Done. Everyone running GameCut gets it within six hours, or straight away if
they click the version number in the top bar and press **Check now**.

`PUBLISH.bat` decides for itself whether a new `.exe` is needed. Most releases
only change the editor, and those install themselves with no download at all —
so most runs take seconds rather than minutes.

---

## What the messages mean

**"Nothing in the shell changed: this one installs by itself."**
Good — your friends get this one automatically, no installer involved.

**"This one needs a new GameCut.exe."**
You changed part of the app that a file swap is not allowed to replace.
`PUBLISH.bat` handles it; it just takes a few minutes. People will be asked to
download the installer once.

**"⚠ GameCut-x.y.z-x64.exe is 9x MB."**
GitHub refuses any single file over 100 MB and the push will fail. If it gets
there, put the `.exe` in a GitHub Release instead — see the bottom of this page.

**"⚠ docs/ is NNN MB."**
Git remembers every installer it has ever seen, even the ones no longer in the
folder, so the repository grows with each release that includes one. Same fix:
move the installer to a Release.

---

## If something goes wrong

**The site shows a 404.** Pages is not on `/docs` yet, or the address has the
wrong capitals. Check github.com/joshthefrazer/GameCut/settings/pages.

**The site shows a blank dark page.** Pages is set to `/ (root)` and is serving
the editor. Change it to `/docs`.

**Nobody is getting updates.** Open
https://joshthefrazer.github.io/GameCut/update.json in a browser. If that 404s,
the files are not published yet. If it shows a wall of gibberish text, it is
working — that is the signed manifest, and it is meant to look like that.

**A friend's copy says "Updates are off".** Their copy was built before you ran
`FIRST-TIME-SETUP.bat`, so it has no key in it. Send them the current installer
once and it will never happen again.

**You published something broken.** Put the old version number back in
`package.json`, run `PUBLISH.bat`, push. Anyone who already installed the bad
one can use **Go back to the built-in version** in the updates panel.

---

## Giving it to fewer people first

Open a terminal in the folder (right-click → Open in Terminal) and:

```
npm run release -- --rollout 0.25
```

A quarter of installs get it, chosen at random but consistently — nobody
flickers between having it and not. Run `PUBLISH.bat` normally to give it to
everyone.

```
npm run release -- --hold
```

Publishes the files but tells nobody. Useful for putting a build in place before
announcing it.

---

## Editing the page

| What | Where |
|---|---|
| Name, tagline, the paragraph under the headline | `site\site-config.json` |
| The six feature cards, the "your footage" section | `site\index.template.html` |
| Colours and type | `site\site.css` |
| Screenshots | `site\shots\` |
| Version, download link, changelog | filled in automatically — don't edit |

**Swap `site\shots\editor.png` for a screenshot of your own footage** when you
have one. Right now it is the colour-bar test clip — honest, but it looks like a
test pattern. Any 1600×940 screenshot with the Transitions panel open drops
straight in.

---

## Moving the installer to a GitHub Release

Do this when the repository starts feeling heavy.

1. On GitHub: **Releases → Draft a new release**. Tag it `v1.6.0`, drag the
   `.exe` from the `docs` folder onto the page, publish it.
2. Copy the download link GitHub gives you.
3. Open `site\site-config.json` and change `"installer": "folder"` to
   `"installer": "<that link>"`.
4. Delete the `.exe` from `docs`, run `PUBLISH.bat`, push.

The Download button now points at the Release, and the repository stops growing.
Everything else works exactly the same.

---

## When you buy a domain

```
npm run site:init https://yourdomain.com/
```

Then rebuild and publish once, point the domain's DNS at GitHub Pages, and set
the custom domain in the Pages settings. Copies of GameCut built before that
keep checking the old address, so leave the github.io site up for a while.
