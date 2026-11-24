// Homepage copy of the article prototype.
// The transition is the same. Playback waits until the player
// is visible inside the homepage scroll.

const cfg = {
  lightsOut: 700,
  holdBlack: 80,
  lightsIn: 650,
  breakAt: 8,
  cueLead: 5,
  adDuration: 15,
  skipAfter: 5,
  frameDuration: 2,
  frameLead: 1,
};

const AD_SRC = {
  letterbox: "media/ad.mp4",
  frame: "frame-media/ad.mp4",
};

// Thumbnail designs for the "Thumbnail" version. A is the Intro Slate, B is the Static Cover.
const THUMBS = {
  a: {
    src: "frame-media/ad-frame.png",
    note: "Intro Slate. A darkened close-up with the headline centered and the Louis Vuitton mark at the bottom.",
  },
  b: {
    src: "thumbnails/thumbnail-b.jpg",
    note: "Static Cover. A wider street shot, with the headline and sponsor line in a black card at the top.",
  },
};
for (const design of Object.values(THUMBS)) new Image().src = design.src; // preload

const $ = (id) => document.getElementById(id);

const player = $("player");
const editorial = $("editorial");
const ad = $("ad");
const blackout = $("blackout");
const homeScroll = $("homeScroll");
const ui = {
  cueCount: $("cueCount"),
  adTimer: $("adTimer"),
  skip: $("skipBtn"),
  progressFill: $("progressFill"),
  progressKnob: $("progressKnob"),
  readout: $("readout"),
  playBtn: $("playBtn"),
};

let thumb = "a";
let version = "letterbox";
let segment = "editorial";
let playing = false;
let userWantsPlay = true;
let onScreen = false;
let transitioning = false;
let adPlayed = false;
let resumeAt = 0;
let generation = 0;
let playerError = false;
let simLoadTimer = 0;

const frame = {
  status: "done",
  accum: 0,
  tick: 0,
};

const scrollWatch = {
  top: 0,
  ts: 0,
  velocity: 0,
};

function setState(next) {
  player.dataset.state = next;
}

function setSegment(next) {
  segment = next;
  player.dataset.segment = next;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fadeBlack(opacity, ms) {
  return new Promise((resolve) => {
    if (ms <= 0) {
      blackout.style.transition = "none";
      blackout.style.opacity = String(opacity);
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      blackout.removeEventListener("transitionend", onEnd);
      resolve();
    };
    const onEnd = (event) => {
      if (event.propertyName === "opacity") finish();
    };
    blackout.addEventListener("transitionend", onEnd);
    blackout.style.transition = `opacity ${ms}ms ${opacity === 1 ? "ease-in" : "ease-out"}`;
    requestAnimationFrame(() => {
      blackout.style.opacity = String(opacity);
    });
    setTimeout(finish, ms + 80);
  });
}

function fmt(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return `0:${String(s).padStart(2, "0")}`;
}

function adElapsed() {
  return Math.max(0, ad.currentTime || 0);
}

function adLimit() {
  const available = Number.isFinite(ad.duration) ? ad.duration : cfg.adDuration;
  return Math.min(cfg.adDuration, available || cfg.adDuration);
}

function frameBlocking() {
  return version === "frame" && frame.status !== "done";
}

function videoMetrics() {
  const view = homeScroll.getBoundingClientRect();
  const rect = player.getBoundingClientRect();
  const visible = Math.min(rect.bottom, view.bottom) - Math.max(rect.top, view.top);
  return {
    gap: rect.top - view.bottom,
    visible: Math.max(0, visible),
    height: rect.height,
  };
}

function liveVelocity(now) {
  if (!scrollWatch.ts || now - scrollWatch.ts > 90) return 0;
  return scrollWatch.velocity;
}

function frameElapsed(now) {
  if (frame.status !== "showing" || !playing) return frame.accum;
  return frame.accum + (now - frame.tick);
}

function armFrame(now) {
  if (frame.status !== "waiting") return;
  frame.status = "showing";
  frame.accum = 0;
  frame.tick = now;
  setState("frame");
  editorial.pause();
  try { editorial.currentTime = 0; } catch (err) { /* not seekable yet */ }
}

function finishFrame() {
  if (frame.status === "done") return;
  frame.status = "done";
  setSegment("editorial");
  setState("editorial");
  renderPlayback();
}

function releaseFrame() {
  if (version !== "frame" || frame.status === "done") return;
  frame.status = "done";
  setSegment("editorial");
  setState("editorial");
}

function updateFrame(now) {
  if (version !== "frame" || frame.status === "done" || transitioning) return;

  const { gap, visible, height } = videoMetrics();

  if (frame.status === "waiting") {
    const velocity = liveVelocity(now);
    const leadMs = cfg.frameLead * 1000;
    const approaching = velocity > 0.08 && gap > 0 && (leadMs === 0 || gap / velocity <= leadMs);
    const arrived = gap <= 12 && visible > 0;
    if (approaching || arrived) armFrame(now);
    return;
  }

  const elapsed = frameElapsed(now);
  const inView = visible > height * 0.35;
  if (playing && elapsed >= cfg.frameDuration * 1000 && inView) finishFrame();
}

function setMuted(next) {
  editorial.muted = next;
  ad.muted = next;
  muteBtn.classList.toggle("is-muted", next);
  muteBtn.setAttribute("aria-pressed", String(next));
  muteBtn.setAttribute("aria-label", next ? "Unmute" : "Mute");
}

function setLoading(on) {
  if (playerError) return;
  player.classList.toggle("is-loading", on);
}

function playbackErrorMessage() {
  return navigator.onLine === false
    ? "Unable to play video. Please check your Internet connection and try again."
    : "Unable to play video. Please refresh to try again.";
}

function showError(message) {
  playerError = true;
  $("errorText").textContent = message;
  player.classList.remove("is-loading");
  player.classList.add("is-error");
  renderPlayback();
}

function clearError() {
  playerError = false;
  player.classList.remove("is-error");
}

function renderPlayback() {
  ui.playBtn.textContent = userWantsPlay ? "Pause" : "Play";
  if (playerError) {
    playing = false;
    editorial.pause();
    ad.pause();
    return;
  }
  if (transitioning) {
    playing = userWantsPlay && onScreen;
    if (!playing) {
      editorial.pause();
      ad.pause();
    }
    return;
  }
  if (frameBlocking()) {
    playing = userWantsPlay;
    player.classList.toggle("is-paused", false);
    editorial.pause();
    ad.pause();
    return;
  }
  const should = userWantsPlay && onScreen;
  playing = should;
  player.classList.toggle("is-paused", !userWantsPlay);
  const current = segment === "ad" ? ad : editorial;
  if (should) current.play().catch(() => {});
  else {
    editorial.pause();
    ad.pause();
  }
}

function setPlaying(next) {
  const now = performance.now();
  if (version === "frame" && frame.status === "showing") {
    if (userWantsPlay && !next) frame.accum += now - frame.tick;
    if (!userWantsPlay && next) frame.tick = now;
  }
  userWantsPlay = next;
  renderPlayback();
}

function resetExperience() {
  generation += 1;
  transitioning = false;
  adPlayed = false;
  resumeAt = 0;
  if (playerError) {
    clearError();
    if (editorial.error) editorial.load();
    setLoading(true);
  }
  editorial.pause();
  ad.pause();
  try { editorial.currentTime = 0; } catch (err) { /* ignore */ }
  try { ad.currentTime = 0; } catch (err) { /* ignore */ }
  blackout.style.transition = "none";
  blackout.style.opacity = "0";
  setSegment("editorial");
  if (version === "frame") {
    frame.status = "waiting";
    frame.accum = 0;
    frame.tick = 0;
    setState("waiting");
  } else {
    frame.status = "done";
    setState("editorial");
  }
  userWantsPlay = true;
  renderPlayback();
}

const LAYOUTS = {
  mobile: "Mobile. One column, and the video runs the full width of the screen.",
  tablet: "Tablet. The front page splits into a lead story and a side rail. The Style video sits beside the copy.",
  desktop: "Desktop. A wide front page, with the Style video in its own column.",
};

const windowView = document.documentElement.dataset.view === "window";

function applyLayout(next, { keepScroll = false } = {}) {
  const changed = document.body.dataset.layout !== next;
  document.body.dataset.layout = next;
  for (const name of Object.keys(LAYOUTS)) {
    const button = $(`layout${name.charAt(0).toUpperCase()}${name.slice(1)}`);
    const on = name === next;
    button.classList.toggle("is-on", on);
    button.setAttribute("aria-pressed", String(on));
  }
  $("layoutNote").textContent = (windowView ? "Follows the window width. " : "") + LAYOUTS[next];
  if (changed && !keepScroll) homeScroll.scrollTop = 0;
}

function applyVersion(next) {
  version = next;
  document.body.dataset.version = next;
  player.dataset.version = next;
  $("verLetterbox").classList.toggle("is-on", next === "letterbox");
  $("verFrame").classList.toggle("is-on", next === "frame");
  $("verLetterbox").setAttribute("aria-pressed", String(next === "letterbox"));
  $("verFrame").setAttribute("aria-pressed", String(next === "frame"));
  $("switchNote").textContent = next === "frame"
    ? "A sponsored thumbnail leads in for 2 seconds. The ad then fills the whole frame."
    : "No thumbnail. The story starts on its own, and the ad sits in the black bars.";
  if (ad.getAttribute("src") !== AD_SRC[next]) {
    ad.pause();
    ad.src = AD_SRC[next];
    ad.load();
  }
  resetExperience();
}

function applyThumb(next) {
  if (next === thumb) return;
  thumb = next;
  $("adFrame").querySelector("img").src = THUMBS[next].src;
  $("thumbA").classList.toggle("is-on", next === "a");
  $("thumbB").classList.toggle("is-on", next === "b");
  $("thumbA").setAttribute("aria-pressed", String(next === "a"));
  $("thumbB").setAttribute("aria-pressed", String(next === "b"));
  $("thumbNote").textContent = THUMBS[next].note;
  // Replay so the new thumbnail shows right away.
  if (version === "frame") resetExperience();
}

async function goTo(next) {
  if (transitioning || next === segment) return;
  const gen = ++generation;
  transitioning = true;
  setState("lights-out");

  await fadeBlack(1, cfg.lightsOut);
  if (gen !== generation) return;
  if (cfg.holdBlack > 0) await wait(cfg.holdBlack);
  if (gen !== generation) return;

  if (next === "ad") {
    resumeAt = editorial.currentTime || cfg.breakAt;
    editorial.pause();
    ad.currentTime = 0;
    setSegment("ad");
    if (playing) ad.play().catch(() => {});
  } else {
    ad.pause();
    adPlayed = true;
    setSegment("editorial");
    const resume = Math.min(resumeAt, (editorial.duration || resumeAt) - 0.05);
    editorial.currentTime = Math.max(0, resume);
    if (playing) editorial.play().catch(() => {});
  }

  setState("lights-in");
  await fadeBlack(0, cfg.lightsIn);
  if (gen !== generation) return;

  setState(segment === "ad" ? "ad" : "editorial");
  transitioning = false;
  renderPlayback();
}

function onEditorialTime() {
  if (transitioning || !playing || segment !== "editorial" || frameBlocking()) return;
  const t = editorial.currentTime || 0;
  if (!adPlayed && t >= cfg.breakAt) {
    goTo("ad");
    return;
  }
  const cueAt = cfg.breakAt - cfg.cueLead;
  if (!adPlayed && t >= cueAt) setState("cue");
  else if (player.dataset.state === "cue") setState("editorial");
}

function onAdTime() {
  if (transitioning || !playing || segment !== "ad") return;
  if (adElapsed() >= adLimit()) goTo("editorial");
}

function render() {
  const now = performance.now();
  updateFrame(now);

  const cueLeft = Math.max(1, Math.ceil(cfg.breakAt - (editorial.currentTime || 0)));
  ui.cueCount.textContent = cueLeft;
  ui.adTimer.textContent = fmt(adLimit() - adElapsed());

  const skipReady = segment === "ad" && adElapsed() >= cfg.skipAfter;
  ui.skip.classList.toggle("ready", skipReady);
  ui.skip.textContent = skipReady
    ? "Skip ad"
    : `Skip ad in ${Math.max(1, Math.ceil(cfg.skipAfter - adElapsed()))}`;

  let progress = 0;
  if (segment === "ad") {
    progress = adElapsed() / adLimit();
  } else if (version === "frame" && frame.status === "showing") {
    progress = Math.min(1, frameElapsed(now) / (cfg.frameDuration * 1000));
  } else if (editorial.duration) {
    progress = editorial.currentTime / editorial.duration;
  }
  const progressPct = Math.min(100, progress * 100);
  ui.progressFill.style.width = `${progressPct}%`;
  ui.progressKnob.style.left = `clamp(0px, calc(${progressPct}% - 8px), calc(100% - 16px))`;

  const phase = player.dataset.state;
  const frameLabel = version !== "frame"
    ? "off"
    : frame.status === "showing"
      ? `showing ${(frameElapsed(now) / 1000).toFixed(1)} / ${cfg.frameDuration.toFixed(1)}s`
      : frame.status;
  ui.readout.textContent =
    `screen       ${document.body.dataset.layout}\n` +
    `version      ${version}\n` +
    `phase        ${phase}\n` +
    `segment      ${segment}\n` +
    `thumbnail    ${frameLabel}\n` +
    `thumb design ${thumb === "a" ? "intro slate" : "static cover"}\n` +
    `on screen    ${onScreen ? "yes" : "no"}\n` +
    `editorial t  ${(editorial.currentTime || 0).toFixed(1)}s\n` +
    `ad t         ${adElapsed().toFixed(1)}s / ${adLimit().toFixed(0)}s\n` +
    `muted        ${editorial.muted ? "yes" : "no"}\n` +
    `break at     ${cfg.breakAt}s (cue at ${(cfg.breakAt - cfg.cueLead).toFixed(0)}s)\n` +
    `lights out   ${cfg.lightsOut}ms\n` +
    `hold black   ${cfg.holdBlack}ms\n` +
    `lights in    ${cfg.lightsIn}ms`;

  requestAnimationFrame(render);
}

ui.playBtn.addEventListener("click", () => setPlaying(!userWantsPlay));

// Tap behavior from the July 2026 spec:
// - While muted, the first tap unmutes (and taps on controls do too).
// - While unmuted, a tap on the video toggles play/pause.
player.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (button && button.id === "muteBtn") return; // handled by its own listener
  if (editorial.muted) {
    setMuted(false);
    return;
  }
  if (button && button.id !== "playToggle") return;
  setPlaying(!userWantsPlay);
});

$("replayBtn").addEventListener("click", () => resetExperience());

$("jumpBtn").addEventListener("click", () => {
  if (transitioning || segment === "ad") return;
  releaseFrame();
  const cueAt = Math.max(0, cfg.breakAt - cfg.cueLead);
  editorial.currentTime = cueAt;
  setState("cue");
  renderPlayback();
});

$("triggerBtn").addEventListener("click", () => {
  if (segment === "ad" || transitioning) return;
  releaseFrame();
  goTo("ad");
});

$("verLetterbox").addEventListener("click", () => {
  if (version !== "letterbox") applyVersion("letterbox");
});

$("verFrame").addEventListener("click", () => {
  if (version !== "frame") applyVersion("frame");
});

$("thumbA").addEventListener("click", () => applyThumb("a"));
$("thumbB").addEventListener("click", () => applyThumb("b"));

$("layoutMobile").addEventListener("click", () => applyLayout("mobile"));
$("layoutTablet").addEventListener("click", () => applyLayout("tablet"));
$("layoutDesktop").addEventListener("click", () => applyLayout("desktop"));

homeScroll.addEventListener("scroll", () => {
  const now = performance.now();
  const top = homeScroll.scrollTop;
  const dt = now - scrollWatch.ts;
  if (scrollWatch.ts && dt > 0 && dt < 120) {
    const instant = (top - scrollWatch.top) / dt;
    scrollWatch.velocity = scrollWatch.velocity * 0.35 + instant * 0.65;
  } else {
    scrollWatch.velocity = 0;
  }
  scrollWatch.top = top;
  scrollWatch.ts = now;
}, { passive: true });

ui.skip.addEventListener("click", () => {
  if (segment === "ad" && adElapsed() >= cfg.skipAfter) goTo("editorial");
});

const muteBtn = $("muteBtn");
muteBtn.addEventListener("click", () => setMuted(!editorial.muted));

$("ccBtn").addEventListener("click", () => {
  const on = $("ccBtn").getAttribute("aria-pressed") !== "true";
  $("ccBtn").setAttribute("aria-pressed", String(on));
  $("ccBtn").classList.toggle("is-on", on);
});

// Panel test buttons for the loading and error states.
$("loadingBtn").addEventListener("click", () => {
  if (playerError) return;
  setLoading(true);
  clearTimeout(simLoadTimer);
  simLoadTimer = setTimeout(() => setLoading(false), 2500);
});

$("errorBtn").addEventListener("click", () => showError(playbackErrorMessage()));

$("expandBtn").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else player.requestFullscreen().catch(() => {});
});

$("styleJump").addEventListener("click", () => {
  $("style").scrollIntoView({ behavior: "smooth", block: "start" });
});

editorial.addEventListener("timeupdate", onEditorialTime);
ad.addEventListener("timeupdate", onAdTime);

// Loading: spinner over a blurred frame while data is missing or stalled.
for (const video of [editorial, ad]) {
  video.addEventListener("waiting", () => setLoading(true));
  video.addEventListener("stalled", () => setLoading(true));
  for (const ready of ["loadeddata", "canplay", "playing"]) {
    video.addEventListener(ready, () => setLoading(false));
  }
  video.addEventListener("error", () => showError(playbackErrorMessage()));
}
ad.addEventListener("ended", () => {
  if (segment === "ad" && !transitioning) goTo("editorial");
});

const TUNABLES = [
  { id: "lightsOut", label: (v) => `${v} ms` },
  { id: "holdBlack", label: (v) => `${v} ms` },
  { id: "lightsIn", label: (v) => `${v} ms` },
  { id: "breakAt", label: (v) => `${v} s` },
  { id: "cueLead", label: (v) => `${v} s` },
  { id: "adDuration", label: (v) => `${v} s` },
  { id: "skipAfter", label: (v) => `${v} s` },
  { id: "frameDuration", label: (v) => `${v} s` },
  { id: "frameLead", label: (v) => `${v} s` },
];

for (const tunable of TUNABLES) {
  const input = $(`s-${tunable.id}`);
  const output = $(`o-${tunable.id}`);
  const apply = () => {
    cfg[tunable.id] = Number(input.value);
    output.textContent = tunable.label(cfg[tunable.id]);
  };
  input.addEventListener("input", apply);
  apply();
}

const viewObserver = new IntersectionObserver((entries) => {
  onScreen = entries.some((entry) => entry.isIntersecting);
  renderPlayback();
}, { root: homeScroll, threshold: 0.2 });

viewObserver.observe(player);
editorial.addEventListener("loadeddata", () => renderPlayback());

// Full-window view: the layout follows the browser width, and the tuning
// panel is a bottom sheet that starts hidden.
if (windowView) {
  const sheetPanel = $("panel");
  const sheetTab = $("sheetTab");
  const sheetLabel = sheetTab.querySelector(".sheet-label");

  const layoutForWidth = (width) => (width < 700 ? "mobile" : width < 1100 ? "tablet" : "desktop");
  const syncLayout = () => applyLayout(layoutForWidth(window.innerWidth), { keepScroll: true });
  window.addEventListener("resize", syncLayout);
  syncLayout();

  const measureSheet = () => {
    const open = sheetPanel.classList.contains("is-open");
    document.documentElement.style.setProperty("--sheet-h", open ? `${sheetPanel.offsetHeight}px` : "0px");
  };

  const setSheet = (open) => {
    sheetPanel.classList.toggle("is-open", open);
    sheetPanel.inert = !open;
    sheetTab.setAttribute("aria-expanded", String(open));
    sheetLabel.textContent = open ? "Hide" : "Tuning";
    measureSheet();
  };

  sheetTab.addEventListener("click", () => setSheet(!sheetPanel.classList.contains("is-open")));
  $("panelClose").addEventListener("click", () => setSheet(false));
  window.addEventListener("resize", measureSheet);

  document.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Escape") setSheet(false);
    else if (event.key === "t" || event.key === "T") setSheet(!sheetPanel.classList.contains("is-open"));
  });

  setSheet(false);
}

setSegment("editorial");
setState("editorial");
requestAnimationFrame(render);
