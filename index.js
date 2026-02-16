const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");
const admin = require("firebase-admin");

// ---- FIREBASE SETUP ----
const fs = require('fs');
const path = require('path');

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    // 1. Try Environment Variable (Production/Render)
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("✅ Firebase Admin initialized via Environment Variable.");
  } else if (fs.existsSync(path.join(__dirname, 'serviceAccountKey.json'))) {
    // 2. Try Local File (Development)
    const serviceAccount = require('./serviceAccountKey.json');
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("✅ Firebase Admin initialized via local serviceAccountKey.json.");
  } else {
    // 3. Try Default Credentials (Google Cloud)
    admin.initializeApp();
    console.log("⚠️ Attempting Firebase Admin initialization via Default Credentials...");
  }
} catch (e) {
  console.error("❌ Firebase Admin failed to initialize. Persistence is DISABLED.", e.message);
}

const db = admin.apps.length ? admin.firestore() : null; // Check if app initialized
const PARTIES_COLLECTION = "active_parties";

if (!db) {
  console.warn("\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
  console.warn("WARNING: Database is NOT connected.");
  console.warn("All parties will be lost when the server restarts.");
  console.warn("To fix: Set FIREBASE_SERVICE_ACCOUNT env var or add serviceAccountKey.json");
  console.warn("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n");
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// In-memory party store
const parties = new Map();

// ---- PERSISTENCE HELPERS ----
async function saveParty(party) {
  if (!db) return;
  try {
    const docData = {
      ...party,
      votesToSkip: Array.from(party.votesToSkip),
      members: Object.fromEntries(party.members),
      lastActiveAt: Date.now()
    };
    await db.collection(PARTIES_COLLECTION).doc(party.id).set(docData);
  } catch (e) {
    console.error(`Failed to save party ${party.id}:`, e.message);
  }
}

async function removeParty(partyId) {
  if (!db) return;
  try {
    await db.collection(PARTIES_COLLECTION).doc(partyId).delete();
  } catch (e) {
    console.error(`Failed to remove party ${partyId}:`, e.message);
  }
}

async function restoreParties() {
  if (!db) {
    console.log("ℹ️ Skipping restore: Database not initialized.");
    return;
  }
  console.log("Restoring parties from Firestore...");
  try {
    const snapshot = await db.collection(PARTIES_COLLECTION).get();
    if (snapshot.empty) return;

    snapshot.forEach(doc => {
      const data = doc.data();
      // Rehydrate Sets and Maps
      data.votesToSkip = new Set(); // Clear votes on restart
      data.members = new Map();     // Clear members (socket IDs invalid)
      data.isPlaying = false;       // Pause playback

      // Ensure hostUserId exists (migration for old parties)
      if (!data.hostUserId) {
        // If no hostUserId, we can't easily recover the original host.
        // They will have to claim it via some other means or party is orphaned.
        // For now, let's leave it null.
        data.hostUserId = null;
      }

      parties.set(data.id, data);
    });
    console.log(`Restored ${parties.size} parties.`);
  } catch (e) {
    console.error("Failed to restore parties:", e.message);
  }
}

// ---- HTTP Routes ----
// Track uptime
const serverStartedAt = Date.now();

app.get("/", (req, res) => {
  const uptimeSeconds = Math.floor((Date.now() - serverStartedAt) / 1000);
  const partyCount = parties.size;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sync Music Server</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #0f0f0f;
      color: #eaeaea;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
    }

    .container {
      max-width: 520px;
      background: #181818;
      padding: 36px;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
    }

    h1 {
      margin: 0 0 16px;
      font-size: 26px;
    }

    p {
      color: #aaa;
      line-height: 1.6;
      margin-bottom: 24px;
    }

    .info {
      display: inline-block;
      padding: 8px 14px;
      border-radius: 20px;
      background: #03dac6;
      color: #000;
      font-weight: 600;
      font-size: 14px;
      margin-bottom: 12px;
    }

    .stats {
      margin-top: 16px;
      font-size: 14px;
      color: #ccc;
    }

    .stats span {
      display: block;
      margin-top: 6px;
    }

    .meta {
      margin-top: 20px;
      font-size: 12px;
      color: #666;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Sync Music Backend</h1>
    <p>
      This server powers real-time music parties, handling live playback
      synchronization, voting, chat, and party management using Socket.IO
      and Firestore for persistence.
    </p>

    <div class="info">ℹ️ Server Running</div>

    <div class="stats">
      <span>👥 Active Parties: <strong id="partyCount">${partyCount}</strong></span>
      <span>⏱ Uptime: <strong id="uptime">${uptimeSeconds}</strong> seconds</span>
    </div>

    <div class="meta">
      Loaded at ${new Date().toLocaleString()}
    </div>
  </div>

  <script>
    let uptime = ${uptimeSeconds};

    setInterval(() => {
      uptime++;
      document.getElementById("uptime").textContent = uptime;
    }, 1000);
  </script>
</body>
</html>
  `;

  res.send(html);
});

app.get("/join/:partyId", (req, res) => {
  const partyId = req.params.partyId;
  const deepLink = `syncmusic://join/${partyId}`;
  const formLink = "https://forms.gle/8QbDmnZd2rXEk5W47";

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Join Sync Music Party</title>
  <style>
    body {
      background: #121212;
      color: white;
      font-family: sans-serif;
      text-align: center;
      padding: 40px 20px;
    }
    .btn {
      display: block;
      max-width: 320px;
      margin: 12px auto;
      background: #03DAC6;
      color: black;
      padding: 14px 24px;
      text-decoration: none;
      border-radius: 30px;
      font-weight: bold;
    }
    .btn.secondary {
      background: #333;
      color: white;
      border: 1px solid #444;
    }
    h2 {
      margin-top: 40px;
      font-size: 18px;
    }
    p {
      color: #ccc;
      max-width: 360px;
      margin: 0 auto 10px;
    }
    .note {
      font-size: 13px;
      color: #aaa;
      margin-top: 20px;
    }
  </style>
</head>
<body>

  <h1>🎵 Sync Music</h1>
  <p>Joining party: <strong>${partyId}</strong></p>

  <a href="${deepLink}" class="btn">
    Open Sync Music App
  </a>

  <h2>Not in Closed Testing Yet?</h2>
  <p>
    Sync Music is currently in <strong>Google Play Closed Testing</strong>.<br>
    Fill out the form below to get access.
  </p>

  <a href="${formLink}" class="btn secondary" target="_blank">
    📝 Join Closed Testing
  </a>

  <p class="note">
    Once approved, install the app from Play Store and return here to join the party.
  </p>

  <!-- Deep link reliability for Android browsers -->
  <iframe src="${deepLink}" style="display:none;"></iframe>

  <script>
    let userInteracted = false;

    document.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', () => {
        userInteracted = true;
      });
    });

    // Auto-attempt app open
    setTimeout(function () {
      if (!userInteracted) {
        window.location.href = "${deepLink}";
      }
    }, 2000);
  </script>

</body>
</html>
`;

  res.send(html);
});

// ---- Models ----
function createParty(hostSocketId, hostUserId, name, isPublic, mode) {
  return {
    id: uuidv4().slice(0, 6).toUpperCase(),
    hostId: hostSocketId, // The ACTIVE socket ID of the host
    hostUserId: hostUserId, // The PERMANENT ID of the host
    name: name || "Music Party",
    mode: mode || "party", // 'party' or 'movie'
    isPublic: isPublic === true,
    queue: [],
    currentIndex: 0,
    isPlaying: false,
    startedAt: null,
    elapsed: 0,
    votesToSkip: new Set(),
    members: new Map(),
    themeIndex: 0,
    settings: {
      guestControls: false,
      guestQueueing: true,
      voteSkip: true
    },
    createdAt: Date.now(),
    lastActiveAt: Date.now()
  };
}

// ---- Helpers ----
function getPartyOrError(socket, partyId) {
  const party = parties.get(partyId);
  if (!party) {
    socket.emit("ERROR", "Party not found");
    return null;
  }
  // Ensure settings exist (migration for old active parties)
  if (!party.settings) {
    party.settings = { guestControls: false, guestQueueing: true, voteSkip: true };
  }
  party.lastActiveAt = Date.now();
  saveParty(party);
  return party;
}

function getMembersList(party) {
  return Array.from(party.members.entries()).map(([id, user]) => ({
    id, // Socket ID
    username: user.username,
    avatar: user.avatar,
    isHost: user.userId === party.hostUserId // Check against persistent ID
  }));
}

function getPublicParties() {
  const publicParties = [];
  for (const party of parties.values()) {
    if (party.isPublic) {
      const currentTrack = party.queue[party.currentIndex];
      publicParties.push({
        id: party.id,
        name: party.name,
        memberCount: party.members.size,
        nowPlaying: currentTrack ? currentTrack.title : "Nothing playing"
      });
    }
  }
  return publicParties;
}

function emitVoteState(partyId, party) {
  const size = party.members.size;
  // Voting enabled if enough people AND setting is allowed
  const enabled = (size >= 5) && (party.settings ? party.settings.voteSkip : true);
  const required = enabled ? Math.ceil(size * 0.5) : 0; // 50% Threshold

  io.to(partyId).emit("VOTE_UPDATE", {
    votes: party.votesToSkip.size,
    required,
    enabled
  });
}

function broadcastPartySize(partyId) {
  const party = parties.get(partyId);
  if (!party) return;
  io.to(partyId).emit("PARTY_SIZE", { size: party.members.size });
}

function broadcastMembersList(partyId) {
  const party = parties.get(partyId);
  if (!party) return;
  io.to(partyId).emit("MEMBERS_LIST", getMembersList(party));
}

function broadcastTheme(partyId) {
  const party = parties.get(partyId);
  if (!party) return;
  io.to(partyId).emit("THEME_UPDATE", { themeIndex: party.themeIndex });
}

function isHost(party, socketId) {
  // Check if the socket is the currently active host socket
  if (party.hostId === socketId) return true;

  // Also check if the user associated with this socket is the hostUser
  const member = party.members.get(socketId);
  if (member && member.userId === party.hostUserId) return true;

  return false;
}

// ---- Socket Logic ----
io.on("connection", (socket) => {
  // console.log("Connected:", socket.id); // Too noisy, waiting for identification

  // ---------------- CREATE PARTY ----------------
  socket.on("CREATE_PARTY", async (data) => {
    const name = data ? data.name : null;
    const isPublic = data ? data.isPublic : false;
    const mode = data ? data.mode : "party";
    const username = data ? data.username : "Host";
    const avatar = data ? data.avatar : "👑";
    const userId = data ? data.userId : uuidv4(); // Fallback if not provided

    console.log(`✨ Created: ${username} (${socket.id}) -> Party ${name || 'Untitled'} [${mode}]`);

    const party = createParty(socket.id, userId, name, isPublic, mode);
    parties.set(party.id, party);
    // ... (rest of function)

    party.members.set(socket.id, { username, avatar, userId });
    await socket.join(party.id);

    socket.emit("PARTY_STATE", {
      ...party,
      isHost: true,
      size: party.members.size,
      members: getMembersList(party),
      serverTime: Date.now()
    });
    broadcastPartySize(party.id);
    broadcastMembersList(party.id);
    saveParty(party);
  });

  // ---------------- GET PUBLIC PARTIES ----------------
  socket.on("GET_PUBLIC_PARTIES", () => {
    socket.emit("PUBLIC_PARTIES_LIST", getPublicParties());
  });

  // ---------------- JOIN PARTY ----------------
  socket.on("JOIN_PARTY", async (data) => {
    let partyId, username, avatar, userId;

    if (typeof data === "string") {
      partyId = data;
      username = "Guest";
      avatar = "👤";
      userId = uuidv4();
    } else {
      partyId = data.partyId;
      username = data.username || "Guest";
      avatar = data.avatar || "👤";
      userId = data.userId || uuidv4();
    }

    const party = getPartyOrError(socket, partyId);
    if (!party) return;

    // Check if this user is the host returning
    const isReturningHost = party.hostUserId === userId;

    if (isReturningHost) {
      party.hostId = socket.id; // Reclaim active socket
      party.hostDisconnectedAt = null; // Host is back! Cancel transfer.
    }

    party.members.set(socket.id, { username, avatar, userId });
    await socket.join(partyId);

    console.log(`👋 Joined: ${username} (${socket.id}) -> Party ${partyId}`);

    socket.emit("PARTY_STATE", {
      ...party,
      isHost: isReturningHost,
      size: party.members.size,
      members: getMembersList(party),
      serverTime: Date.now()
    });

    if (isReturningHost) {
      io.to(partyId).emit("INFO", "The Host has reconnected!");
      io.to(partyId).emit("HOST_UPDATE", { hostId: socket.id });
    } else {
      io.to(partyId).emit("INFO", `${username} joined the party`);
    }

    broadcastPartySize(partyId);
    broadcastMembersList(partyId);
    emitVoteState(partyId, party);
    saveParty(party);
  });

  // ---------------- HOST RECLAIM (Explicit) ----------------
  socket.on("RECONNECT_AS_HOST", async (data) => {
    const partyId = data.partyId;
    const username = data.username || "Host";
    const avatar = data.avatar || "👑";
    const userId = data.userId;

    const party = getPartyOrError(socket, partyId);
    if (!party) return;

    if (party.hostUserId === userId) {
      // Success: It is the host
      party.hostId = socket.id;
      party.hostDisconnectedAt = null; // Host is back!
      party.members.set(socket.id, { username, avatar, userId });
      await socket.join(partyId);

      socket.emit("PARTY_STATE", {
        ...party,
        isHost: true,
        size: party.members.size,
        members: getMembersList(party),
        serverTime: Date.now()
      });

      io.to(partyId).emit("INFO", "The Host has reconnected!");
      io.to(partyId).emit("HOST_UPDATE", { hostId: socket.id });

      broadcastPartySize(partyId);
      broadcastMembersList(partyId);
      saveParty(party);
    } else {
      socket.emit("ERROR", "You are not authorized to be the host.");
    }
  });

  // ---------------- UPDATE SETTINGS ----------------
  socket.on("UPDATE_SETTINGS", ({ partyId, settings }) => {
    const party = getPartyOrError(socket, partyId);
    if (!party || !isHost(party, socket.id)) return;

    // Merge settings
    party.settings = { ...party.settings, ...settings };

    io.to(partyId).emit("SETTINGS_UPDATE", party.settings);
    emitVoteState(partyId, party); // Re-eval vote state
    saveParty(party);
  });

  // ---------------- KICK USER ----------------
  socket.on("KICK_USER", ({ partyId, targetId }) => {
    const party = getPartyOrError(socket, partyId);
    if (!party || !isHost(party, socket.id)) return;

    if (!party.members.has(targetId)) return;
    if (targetId === party.hostId) return; // Can't kick self (though logic prevents it)

    const kickedUser = party.members.get(targetId);
    party.members.delete(targetId);
    party.votesToSkip.delete(targetId);

    io.to(targetId).emit("KICKED", "You have been kicked by the host.");
    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) targetSocket.leave(partyId);

    io.to(partyId).emit("INFO", `${kickedUser.username} was kicked.`);
    broadcastPartySize(partyId);
    broadcastMembersList(partyId);
    emitVoteState(partyId, party);
    saveParty(party);
  });

  // ---------------- CHANGE THEME ----------------
  socket.on("CHANGE_THEME", ({ partyId, themeIndex }) => {
    const party = getPartyOrError(socket, partyId);
    if (!party || !isHost(party, socket.id)) return;

    party.themeIndex = themeIndex;
    broadcastTheme(partyId);
    saveParty(party);
  });

  // ---------------- CHANGE INDEX ----------------
  socket.on("CHANGE_INDEX", ({ partyId, newIndex }) => {
    const party = getPartyOrError(socket, partyId);
    if (!party) return;

    const canControl = isHost(party, socket.id) || (party.settings && party.settings.guestControls);
    if (!canControl) return;

    if (newIndex < 0 || newIndex >= party.queue.length) return;

    party.currentIndex = newIndex;
    party.isPlaying = true;
    party.startedAt = Date.now();
    party.elapsed = 0;
    party.votesToSkip.clear();

    emitVoteState(partyId, party);
    io.to(partyId).emit("PLAYBACK_UPDATE", { isPlaying: true, startedAt: party.startedAt, currentIndex: party.currentIndex, serverTime: Date.now() });
    saveParty(party);
  });

  // ---------------- ADD TRACK ----------------
  socket.on("ADD_TRACK", ({ partyId, track }) => {
    const party = getPartyOrError(socket, partyId);
    if (!party) return;

    const canAdd = isHost(party, socket.id) || (party.settings && party.settings.guestQueueing);
    if (!canAdd) {
      socket.emit("ERROR", "Host has disabled adding songs.");
      return;
    }

    party.queue.push({
      id: uuidv4(),
      url: track.url,
      title: track.title || track.url,
      addedBy: track.addedBy || "Guest",
      addedAt: Date.now()
    });

    io.to(partyId).emit("QUEUE_UPDATED", party.queue);
    saveParty(party);
  });

  // ---------------- REMOVE TRACK ----------------
  socket.on("REMOVE_TRACK", ({ partyId, trackId }) => {
    const party = getPartyOrError(socket, partyId);
    if (!party || !isHost(party, socket.id)) return;

    const index = party.queue.findIndex(t => t.id === trackId);
    if (index === -1) return;

    if (index < party.currentIndex) {
      party.currentIndex--;
    } else if (index === party.currentIndex) {
      party.isPlaying = false;
    }

    party.queue.splice(index, 1);
    if (party.currentIndex > party.queue.length) party.currentIndex = party.queue.length;

    io.to(partyId).emit("QUEUE_UPDATED", party.queue);
    io.to(partyId).emit("PLAYBACK_UPDATE", { isPlaying: party.isPlaying, startedAt: party.startedAt, currentIndex: party.currentIndex, serverTime: Date.now() });
    saveParty(party);
  });

  // ---------------- VOTE SKIP ----------------
  socket.on("VOTE_SKIP", ({ partyId }) => {
    const party = parties.get(partyId);
    if (!party) return;

    // Check setting
    if (party.settings && !party.settings.voteSkip) return;

    const size = party.members.size;
    if (size < 5) return;

    party.votesToSkip.add(socket.id);
    emitVoteState(partyId, party);

    const required = Math.ceil(size * 0.5); // 50% Threshold
    if (party.votesToSkip.size < required) {
      saveParty(party);
      return;
    }

    party.votesToSkip.clear();

    if (party.currentIndex < party.queue.length - 1) {
      party.currentIndex++;
      party.startedAt = Date.now();
      party.isPlaying = true;
    } else {
      party.isPlaying = false;
    }

    emitVoteState(partyId, party);
    io.to(partyId).emit("PLAYBACK_UPDATE", { isPlaying: party.isPlaying, startedAt: party.startedAt, currentIndex: party.currentIndex, serverTime: Date.now() });
    io.to(partyId).emit("INFO", "Skipped by vote!");
    saveParty(party);
  });

  // ---------------- PLAY / PAUSE / SEEK / ENDED ----------------
  socket.on("PLAY", ({ partyId }) => {
    const party = getPartyOrError(socket, partyId);
    if (!party) return;

    const canControl = isHost(party, socket.id) || (party.settings && party.settings.guestControls);
    if (!canControl) return;

    party.isPlaying = true;
    party.startedAt = Date.now() - (party.elapsed || 0);
    io.to(partyId).emit("PLAYBACK_UPDATE", { isPlaying: true, startedAt: party.startedAt, currentIndex: party.currentIndex, serverTime: Date.now() });
    saveParty(party);
  });

  socket.on("PAUSE", ({ partyId }) => {
    const party = getPartyOrError(socket, partyId);
    if (!party) return;

    const canControl = isHost(party, socket.id) || (party.settings && party.settings.guestControls);
    if (!canControl) return;

    party.isPlaying = false;
    party.elapsed = Date.now() - party.startedAt;
    io.to(partyId).emit("PLAYBACK_UPDATE", { isPlaying: false, serverTime: Date.now() });
    saveParty(party);
  });

  socket.on("SEEK", ({ partyId, position }) => {
    const party = getPartyOrError(socket, partyId);
    if (!party) return;

    const canControl = isHost(party, socket.id) || (party.settings && party.settings.guestControls);
    if (!canControl) return;

    party.elapsed = position * 1000; // Position in seconds -> ms
    if (party.isPlaying) {
      party.startedAt = Date.now() - party.elapsed;
    }

    io.to(partyId).emit("PLAYBACK_UPDATE", {
      isPlaying: party.isPlaying,
      startedAt: party.startedAt,
      currentIndex: party.currentIndex,
      serverTime: Date.now()
    });
    saveParty(party);
  });

  socket.on("TRACK_ENDED", ({ partyId }) => {
    const party = getPartyOrError(socket, partyId);
    if (!party || !isHost(party, socket.id)) return;

    party.currentIndex++;
    party.elapsed = 0;
    party.votesToSkip.clear();
    emitVoteState(partyId, party);

    if (party.currentIndex >= party.queue.length) {
      party.isPlaying = false;
    } else {
      party.isPlaying = true;
      party.startedAt = Date.now();
    }

    io.to(partyId).emit("PLAYBACK_UPDATE", { isPlaying: party.isPlaying, startedAt: party.startedAt, currentIndex: party.currentIndex, serverTime: Date.now() });
    saveParty(party);
  });

  // ---------------- END PARTY ----------------
  socket.on("END_PARTY", ({ partyId }) => {
    const party = parties.get(partyId);
    if (!party || !isHost(party, socket.id)) return;

    io.to(partyId).emit("PARTY_ENDED", { message: "The host has ended the party." });
    parties.delete(partyId);
    removeParty(partyId);
  });

  // ---------------- REACTIONS ----------------
  socket.on("SEND_REACTION", ({ partyId, emoji }) => {
    io.to(partyId).emit("REACTION", { emoji, senderId: socket.id });
  });

  // ---------------- CHAT ----------------
  socket.on("SEND_MESSAGE", ({ partyId, message, username, id }) => {
    if (!message || !message.trim()) return;
    io.to(partyId).emit("CHAT_MESSAGE", {
      id: id || uuidv4(),
      senderId: socket.id,
      username,
      text: message.trim(),
      timestamp: Date.now()
    });
  });

  // ---------------- SYNC PING ----------------
  socket.on("PING", (clientTime) => {
    socket.emit("PONG", { clientTime, serverTime: Date.now() });
  });

  // ---------------- SUPPORT ----------------
  socket.on("SUBMIT_TICKET", async (ticket) => {
    console.log("Support ticket received:", ticket);
    if (!db) {
      socket.emit("TICKET_ERROR", "Support system unavailable (Database offline).");
      return;
    }

    try {
      const ticketId = uuidv4();
      await db.collection("support_tickets").doc(ticketId).set({
        ...ticket,
        id: ticketId,
        createdAt: Date.now(),
        status: 'open',
        senderIp: socket.handshake.address // Optional: tracking
      });
      socket.emit("TICKET_SUBMITTED", { ticketId, message: "Ticket submitted successfully!" });
    } catch (e) {
      console.error("Failed to save ticket:", e);
      socket.emit("TICKET_ERROR", "Failed to submit ticket. Please try again.");
    }
  });

  // ---------------- DISCONNECT ----------------
  socket.on("disconnect", () => {
    let identified = false;
    for (const [partyId, party] of parties) {
      if (party.members.has(socket.id)) {
        const user = party.members.get(socket.id);
        console.log(`💨 Disconnected: ${user.username} (${socket.id}) from Party ${partyId}`);
        identified = true;

        // Remove from members list (visual)
        party.members.delete(socket.id);
        party.votesToSkip.delete(socket.id);

        broadcastPartySize(partyId);
        broadcastMembersList(partyId);
        emitVoteState(partyId, party);

        // CHECK IF HOST
        if (party.hostId === socket.id) {
          console.log(`Host of party ${partyId} disconnected. Starting grace period.`);
          // Start Grace Period
          party.hostDisconnectedAt = Date.now();
        }

        saveParty(party);
      }
    }
  });
});

// ---------------- SYNC LOOP ----------------
setInterval(() => {
  const now = Date.now();
  for (const [id, party] of parties) {
    if (party.isPlaying) {
      io.to(id).emit("SYNC", { serverTime: now, startedAt: party.startedAt, currentIndex: party.currentIndex });
    }

    // ---- 1. AUTO-CLAIM THRONE (If host is missing but members exist) ----
    if (!party.hostId && party.members.size > 0) {
      const nextSocketId = party.members.keys().next().value;
      const nextUser = party.members.get(nextSocketId);

      party.hostId = nextSocketId;
      party.hostUserId = nextUser.userId;
      party.hostDisconnectedAt = null;

      io.to(id).emit("HOST_UPDATE", { hostId: nextSocketId });
      io.to(id).emit("INFO", `Host position was empty. ${nextUser.username} is now the Host.`);
      broadcastMembersList(id);
      saveParty(party);
      continue;
    }

    // ---- 2. HOST PRESENCE CHECK ----
    // Only check if we HAVE a host assigned, and they are missing
    if (party.hostId && !party.members.has(party.hostId) && !party.hostDisconnectedAt) {
      console.log(`Party ${id}: Host socket ${party.hostId} not found in members. Starting grace period.`);
      party.hostDisconnectedAt = Date.now();
      saveParty(party);
    }

    // ---- 3. HOST GRACE PERIOD CHECK ----
    if (party.hostDisconnectedAt) {
      const gracePeriod = 120 * 1000; // 120 Seconds
      if (now - party.hostDisconnectedAt > gracePeriod) {
        console.log(`Party ${id}: Host grace period expired.`);

        if (party.members.size > 0) {
          // Transfer leadership
          const nextSocketId = party.members.keys().next().value;
          const nextUser = party.members.get(nextSocketId);

          party.hostId = nextSocketId;
          party.hostUserId = nextUser.userId;
          party.hostDisconnectedAt = null;

          io.to(id).emit("HOST_UPDATE", { hostId: nextSocketId });
          io.to(id).emit("INFO", `Host inactive. ${nextUser.username} is now the Host.`);
          broadcastMembersList(id);
          saveParty(party);
        } else {
          // No one left? Make party DORMANT (Hostless) instead of deleting.
          // This allows the original host to reclaim it later (within 24h).
          console.log(`Party ${id}: No members left. Setting to DORMANT (waiting for reclaim).`);
          party.hostId = null; // No active host
          party.hostDisconnectedAt = null; // Stop timer
          party.isPlaying = false; // Pause music

          saveParty(party);
        }
      }
    }

    // Cleanup old parties (24 Hours Inactivity)
    if (now - party.lastActiveAt > 24 * 60 * 60 * 1000) {
      io.to(id).emit("PARTY_ENDED", { message: "Party expired due to inactivity." });
      parties.delete(id);
      removeParty(id);
    }
  }
}, 5000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log("Server running on port", PORT);
  await restoreParties();
});