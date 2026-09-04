const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- Token System ---
const TOKENS_FILE = path.join(__dirname, "tokens.json");
const MASTER_PASSWORD = "zoozi2026";

function loadTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
  } catch {
    return { tokens: [] };
  }
}

function saveTokens(data) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(data, null, 2));
}

function generateToken(label, type) {
  const token = crypto.randomBytes(16).toString("hex");
  const data = loadTokens();
  data.tokens.push({
    token,
    label: label || "Unnamed",
    type: type || "overlay",
    created: new Date().toISOString(),
    active: true,
  });
  saveTokens(data);
  return token;
}

function validateToken(token) {
  const data = loadTokens();
  const t = data.tokens.find((x) => x.token === token && x.active);
  if (!t) return null;
  return { label: t.label, type: t.type };
}

function revokeToken(token) {
  const data = loadTokens();
  const t = data.tokens.find((x) => x.token === token);
  if (t) {
    t.active = false;
    saveTokens(data);
  }
}

function requireToken(req, res, next) {
  const token = req.query.token;
  if (!token) return res.status(403).sendFile(path.join(__dirname, "public", "denied.html"));
  const info = validateToken(token);
  if (!info) return res.status(403).sendFile(path.join(__dirname, "public", "denied.html"));
  req.tokenInfo = info;
  next();
}

function requireMaster(req, res, next) {
  const pw = req.query.password || req.headers["x-master-password"];
  if (pw !== MASTER_PASSWORD) return res.status(403).send("Invalid password");
  next();
}

// --- Gift Value Map (TikTok coins) ---
const GIFT_VALUES = {
  "Rose": 1,
  "Heart": 1,
  "Flower": 1,
  "Paper Plane": 5,
  "Finger Heart": 5,
  "TikTok": 5,
  "Love": 10,
  "Heart Rockets": 10,
  "Crown": 10,
  "Ice Cream": 20,
  "Combo": 25,
  "Heart Me": 25,
  "Gift Box": 25,
  "Wishing Tree": 30,
  "Perfume": 50,
  "Pretty Flower": 50,
  "Cake": 50,
  "Music": 50,
  "Tractor": 50,
  "Guitar": 50,
  "Lions": 100,
  "Ride": 100,
  "Yacht": 100,
  "Bulldozer": 100,
  "Car": 200,
  "Rolls Royce": 300,
  "Rocket": 400,
  "Universe": 500,
  "TikTok Universe": 5000,
  "Planet": 15000,
};

function getGiftValue(name) {
  if (GIFT_VALUES[name] !== undefined) return GIFT_VALUES[name];
  const lower = name.toLowerCase();
  for (const [key, val] of Object.entries(GIFT_VALUES)) {
    if (key.toLowerCase() === lower) return val;
  }
  return 1;
}

// --- State ---
let state = {
  connected: false,
  targetUser: "",
  bidders: [],
  timer: { total: 120, remaining: 120, running: false, intervalId: null },
  snipeDelay: { enabled: false, seconds: 30, threshold: 10 },
  badge: { text: "538 VOUCHES", style: "default" },
  theme: {
    accent: "#a855f7",
    accentSecondary: "#6366f1",
    timerColor: "#facc15",
    textPrimary: "#ffffff",
    textSecondary: "#a1a1aa",
    bgPrimary: "rgba(15, 10, 25, 0.92)",
    bgSecondary: "rgba(30, 20, 50, 0.85)",
    bgCard: "rgba(20, 12, 40, 0.88)",
    borderGlow: "rgba(168, 85, 247, 0.5)",
    pillBg: "rgba(40, 20, 70, 0.9)",
    goldColor: "#facc15",
    silverColor: "#94a3b8",
    bronzeColor: "#d97706",
    overlayOpacity: 1,
  },
  branding: { title: "ZOOZI", subtitle: "ZOOZI.APP" },
};

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

function getState() {
  return {
    connected: state.connected,
    targetUser: state.targetUser,
    bidders: state.bidders,
    timer: { total: state.timer.total, remaining: state.timer.remaining, running: state.timer.running },
    snipeDelay: { enabled: state.snipeDelay.enabled, seconds: state.snipeDelay.seconds, threshold: state.snipeDelay.threshold },
    badge: state.badge,
    theme: state.theme,
    branding: state.branding,
    participantCount: state.bidders.length,
  };
}

// --- Timer Logic ---
function clearTimer() {
  if (state.timer.intervalId) {
    clearInterval(state.timer.intervalId);
    state.timer.intervalId = null;
  }
}

function startTimer(durationOverride) {
  clearTimer();
  if (durationOverride !== undefined) state.timer.remaining = durationOverride;
  state.timer.running = true;
  broadcast({ type: "timer_sync", remaining: state.timer.remaining, running: true });
  state.timer.intervalId = setInterval(() => {
    if (state.timer.remaining > 0) {
      state.timer.remaining--;
      broadcast({ type: "timer_tick", remaining: state.timer.remaining });
      if (state.timer.remaining <= state.snipeDelay.threshold && state.snipeDelay.enabled) {
        broadcast({ type: "snipe_alert", message: "Snipe window active!" });
      }
    } else {
      clearTimer();
      state.timer.running = false;
      broadcast({ type: "timer_end", remaining: 0 });
    }
  }, 1000);
}

function pauseTimer() {
  clearTimer();
  state.timer.running = false;
  broadcast({ type: "timer_sync", remaining: state.timer.remaining, running: false });
}

function resetTimer(seconds) {
  clearTimer();
  state.timer.remaining = seconds !== undefined ? seconds : state.timer.total;
  state.timer.total = state.timer.remaining;
  state.timer.running = false;
  broadcast({ type: "timer_sync", remaining: state.timer.remaining, running: false });
}

function addSnipeTime() {
  state.timer.remaining += state.snipeDelay.seconds;
  broadcast({ type: "snipe_extend", remaining: state.timer.remaining, added: state.snipeDelay.seconds });
}

// --- Bidder Management ---
function addBid(username, coins, profilePic) {
  let bidder = state.bidders.find((b) => b.username.toLowerCase() === username.toLowerCase());
  if (bidder) {
    bidder.coins += coins;
    if (profilePic) bidder.profilePic = profilePic;
  } else {
    state.bidders.push({ username, coins, profilePic: profilePic || "", rank: 0 });
  }
  updateRanks();
  broadcast({ type: "bid_update", bidders: state.bidders, participantCount: state.bidders.length });
}

function addManualBid(username, coins, profilePic) {
  addBid(username, coins, profilePic || "https://ui-avatars.com/api/?name=" + encodeURIComponent(username) + "&background=3b1f6e&color=fff&size=128");
}

function subtractManualBid(username, amount) {
  let bidder = state.bidders.find((b) => b.username.toLowerCase() === username.toLowerCase());
  if (bidder) {
    bidder.coins = Math.max(0, bidder.coins - amount);
    updateRanks();
    broadcast({ type: "bid_update", bidders: state.bidders, participantCount: state.bidders.length });
  }
}

function updateRanks() {
  state.bidders.sort((a, b) => b.coins - a.coins);
  state.bidders.forEach((b, i) => (b.rank = i + 1));
}

function removeBidder(username) {
  state.bidders = state.bidders.filter((b) => b.username.toLowerCase() !== username.toLowerCase());
  updateRanks();
  broadcast({ type: "bid_update", bidders: state.bidders, participantCount: state.bidders.length });
}

function resetBids() {
  state.bidders = [];
  broadcast({ type: "bid_update", bidders: [], participantCount: 0 });
}

// --- Routes ---
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/overlay", requireToken, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "overlay.html"));
});

app.get("/admin", requireToken, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/token-manager", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "token-manager.html"));
});

// Token API
app.post("/api/tokens/generate", requireMaster, (req, res) => {
  const { label, type } = req.body;
  const token = generateToken(label, type);
  res.json({ success: true, token });
});

app.get("/api/tokens/list", requireMaster, (req, res) => {
  const data = loadTokens();
  res.json({ tokens: data.tokens });
});

app.post("/api/tokens/revoke", requireMaster, (req, res) => {
  const { token } = req.body;
  revokeToken(token);
  res.json({ success: true });
});

app.post("/api/tokens/validate", (req, res) => {
  const { token } = req.body;
  const info = validateToken(token);
  res.json({ valid: !!info, info });
});

// --- WebSocket ---
wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "init", ...getState() }));
  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      handleWsMessage(ws, data);
    } catch (e) {}
  });
});

function handleWsMessage(ws, data) {
  switch (data.type) {
    case "admin_connect_tiktok":
      connectToTikTok(data.username);
      break;
    case "admin_disconnect":
      disconnectTikTok();
      break;
    case "timer_start":
      startTimer(data.duration);
      break;
    case "timer_pause":
      pauseTimer();
      break;
    case "timer_reset":
      resetTimer(data.seconds);
      break;
    case "snipe_delay_update":
      state.snipeDelay.enabled = data.enabled !== undefined ? data.enabled : state.snipeDelay.enabled;
      state.snipeDelay.seconds = data.seconds !== undefined ? data.seconds : state.snipeDelay.seconds;
      state.snipeDelay.threshold = data.threshold !== undefined ? data.threshold : state.snipeDelay.threshold;
      broadcast({ type: "snipe_config", snipeDelay: { enabled: state.snipeDelay.enabled, seconds: state.snipeDelay.seconds, threshold: state.snipeDelay.threshold } });
      break;
    case "add_snipe_time":
      addSnipeTime();
      break;
    case "badge_update":
      state.badge.text = data.text || state.badge.text;
      broadcast({ type: "badge_sync", badge: state.badge });
      break;
    case "branding_update":
      state.branding.title = data.title || state.branding.title;
      state.branding.subtitle = data.subtitle || state.branding.subtitle;
      broadcast({ type: "branding_sync", branding: state.branding });
      break;
    case "theme_update":
      state.theme = { ...state.theme, ...data.theme };
      broadcast({ type: "theme_sync", theme: state.theme });
      break;
    case "manual_add":
      addManualBid(data.username, parseInt(data.coins) || 0, data.profilePic);
      break;
    case "manual_subtract":
      subtractManualBid(data.username, parseInt(data.amount) || 0);
      break;
    case "remove_bidder":
      removeBidder(data.username);
      break;
    case "reset_bids":
      resetBids();
      break;
  }
}

// --- TikTok Integration ---
let tiktokClient = null;

async function connectToTikTok(username) {
  disconnectTikTok();
  state.targetUser = username;

  try {
    const { WebcastPushConnection } = require("tiktok-live-connector");
    tiktokClient = new WebcastPushConnection(username, { enableRoomPolling: false });

    tiktokClient.connect().then((state_info) => {
      state.connected = true;
      broadcast({ type: "connection_status", connected: true, username });
    }).catch((err) => {
      state.connected = false;
      broadcast({ type: "connection_status", connected: false, error: err.message || "Failed to connect" });
    });

    tiktokClient.on("gift", (data) => {
      const giftName = data.giftName || "Gift";
      const coins = data.diamondCount || getGiftValue(giftName) * (data.repeatCount || 1);
      const user = data.uniqueId || data.nickname || "Anonymous";
      // Use userDetails.profilePictureUrl (or its URL array), fall back to top-level field
      const pic =
        (data.userDetails && (data.userDetails.profilePictureUrl || (data.userDetails.profilePictureUrls && data.userDetails.profilePictureUrls[0]))) ||
        data.profilePictureUrl ||
        "";

      addBid(user, coins, pic);

      broadcast({
        type: "gift_received",
        username: user,
        gift: giftName,
        coins,
        profilePic: pic,
      });
    });

    tiktokClient.on("disconnected", () => {
      state.connected = false;
      broadcast({ type: "connection_status", connected: false, error: "Disconnected" });
    });
  } catch (err) {
    state.connected = false;
    broadcast({ type: "connection_status", connected: false, error: err.message || "Connection error" });
  }
}

function disconnectTikTok() {
  if (tiktokClient) {
    try { tiktokClient.disconnect(); } catch (e) {}
    tiktokClient = null;
  }
  state.connected = false;
  state.targetUser = "";
  broadcast({ type: "connection_status", connected: false });
}

// --- Start ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`zoozi.app server running on http://localhost:${PORT}`);
  console.log(`  Website:       http://localhost:${PORT}/`);
  console.log(`  Overlay:       http://localhost:${PORT}/overlay?token=TOKEN`);
  console.log(`  Admin:         http://localhost:${PORT}/admin?token=TOKEN`);
  console.log(`  Token Manager: http://localhost:${PORT}/token-manager`);
  console.log(`  Master PW:     ${MASTER_PASSWORD}`);
});
