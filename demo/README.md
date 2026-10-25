# Demo video

Records the live map in headless Chromium, renders title and architecture cards from `cards/card.html`, and cuts them together with ffmpeg. Output is `demo/out/earshot-demo.mp4`, 1920x1080, about 75 seconds. Nothing under `demo/out` is committed.

Needs: the bridge on :8080, vite on :5173, Playwright's Chromium (`~/.cache/ms-playwright/chromium-1248`, or set `CHROME`), ffmpeg with `libopenh264` (set `FFMPEG_VIDEO='-c:v libx264 -crf 18'` if yours has x264), a GPU for the 3D clips (`GL=swiftshader` works but drops to 8 fps).

```sh
node demo/record.mjs          # five app clips, or name some: node demo/record.mjs orbit xray
node demo/render-cards.mjs    # title, numbers, end, captions, architecture clip
node demo/build.mjs           # demo/out/earshot-demo.mp4
```

`storyboard.mjs` is the shot list: order, length, caption per shot, and the architecture steps. The number cards read `/api/dwell` at render time, so re-run the cards and the build whenever the nodes have been on for a while.

`probe.mjs` prints the frame rate the scene reaches with a given GL backend.
